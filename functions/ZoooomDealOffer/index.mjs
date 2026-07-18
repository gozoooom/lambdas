import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

// Initialize DynamoDB client
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

// Table names are resolved from the alias qualifier at runtime via tableSuffix()
// (defined below alongside currentInvokedQualifier). This lets a single published
// version serve Dev/Staging/Prod aliases without per-version env-var snapshots.
// We default to '_dev' when no qualifier is present, so unqualified test invocations
// can never accidentally write to staging or prod.

// Async fan-out to ZoooomOfferNotification (inbox + email).
// One-direction call; the notification Lambda doesn't invoke anything back,
// so there is no recursion risk. Uses InvocationType: 'Event' (fire-and-forget)
// so this API call returns fast even if SES is slow. Errors here are logged
// but never block the offer write — the deal/offer is already persisted.
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' });

// Qualifier passthrough: when this Lambda is invoked via an alias (Dev/Staging/Prod),
// we forward the same environment to ZoooomOfferNotification so prod data never leaks
// into staging/dev. Captured at the top of the handler from context.invokedFunctionArn
// because Lambda guarantees one invocation per container at a time, so a module-scoped
// var is safe and avoids threading context through every nested call site.
let currentInvokedQualifier; // 'Prod' | 'Staging' | 'Dev' | undefined ($LATEST)

// Maps DealOffer's PascalCase aliases to ZoooomOfferNotification's lowercase aliases.
// undefined means "use unqualified" (== $LATEST). Add Dev here if/when a Dev alias is
// published on ZoooomOfferNotification.
const NOTIFICATION_ALIAS_MAP = {
  Prod: 'prod',
  Staging: 'staging'
};

// DDB table suffix per alias. Default of '_dev' is intentional: unqualified test
// invocations should land in dev, not silently in prod.
const TABLE_SUFFIX_BY_QUALIFIER = {
  Dev: '_dev',
  Staging: '_staging',
  Prod: '_prod'
};
function tableSuffix() {
  return TABLE_SUFFIX_BY_QUALIFIER[currentInvokedQualifier] || '_dev';
}
function dealsTable()       { return `ZoooomDeals${tableSuffix()}`; }
function offersTable()      { return `ZoooomOffers${tableSuffix()}`; }
function invitationsTable() { return `ZoooomBuyerInvitation${tableSuffix()}`; }
function vehiclesTable()    { return `ZoooomVehicle${tableSuffix()}`; }
function listingsTable()    { return `ZoooomVehicleListing${tableSuffix()}`; }

// ── State-restriction gate ──────────────────────────────────────────────────
// Title-holding states where buying/selling is paused until lien payoff is
// supported. KEEP IN SYNC with the frontend config (src/config/restrictedStates)
// and the other gating Lambdas (ZoooomVehicleStatus, ZoooomStripeOps).
const RESTRICTED_STATES = new Set([
  'KY', 'MD', 'MI', 'MN', 'MO', 'MT', 'NY', 'OK', 'WI', 'WY'
]);
const RESTRICTED_STATE_MSG =
  "Zoooom can't support buying or selling in this state just yet — we're " +
  'working to add more states soon. You can still keep this car in your garage.';
const KYC_TABLE = process.env.KYC_TABLE || 'KycSession_dev';
const KYC_TENANT = process.env.TENANT_ID || 'zoooom';

function normalizeState(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  const m = raw.match(/\b([A-Za-z]{2})\b\s*\d{0,5}\s*$/);
  if (m) return m[1].toUpperCase();
  return null;
}
function firstRestrictedState(...vals) {
  for (const v of vals) {
    const c = normalizeState(v);
    if (c && RESTRICTED_STATES.has(c)) return c;
  }
  return null;
}
// Best-effort user state from latest VERIFIED KYC session. Fail-open (null on
// error) so a KYC hiccup never wrongly blocks; the vehicle-state check still
// governs where applicable.
async function userStateFromKyc(userId) {
  if (!userId) return null;
  try {
    const r = await docClient.send(new QueryCommand({
      TableName: KYC_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      FilterExpression: 'decision = :v',
      ExpressionAttributeValues: {
        ':pk': `${KYC_TENANT}#${userId}`, ':p': 'vfy#', ':v': 'VERIFIED'
      }
    }));
    const items = r.Items || [];
    if (!items.length) return null;
    items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return items[0].dlState || items[0].registrationState || null;
  } catch (e) {
    console.warn('[stateGate] KYC lookup failed (fail-open):', e?.message || e);
    return null;
  }
}

// True if the user has at least one VERIFIED KYC session. Used to show a
// "Verified" badge for deal participants/messengers in the Deal Center so the
// seller can see who's identity-verified. Fail-open returns false (no badge).
async function isUserKycVerified(userId) {
  if (!userId) return false;
  try {
    const r = await docClient.send(new QueryCommand({
      TableName: KYC_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      FilterExpression: 'decision = :v',
      ExpressionAttributeValues: {
        ':pk': `${KYC_TENANT}#${userId}`, ':p': 'vfy#', ':v': 'VERIFIED'
      },
      Limit: 1
    }));
    return (r.Items || []).length > 0;
  } catch (e) {
    console.warn('[kycVerified] lookup failed (treating as unverified):', e?.message || e);
    return false;
  }
}

// Attach a KYC-verified boolean (under `outKey`) to each item, resolving the
// user id from `idKey`. Runs in parallel.
async function attachVerified(items, idKey, outKey) {
  await Promise.all(items.map(async (it) => {
    it[outKey] = await isUserKycVerified(it[idKey]);
  }));
  return items;
}

function parseQualifierFromArn(arn) {
  if (!arn) return undefined;
  // arn:aws:lambda:REGION:ACCOUNT:function:NAME[:QUALIFIER]
  const parts = arn.split(':');
  return parts.length >= 8 ? parts[7] : undefined;
}

function resolveNotificationTarget() {
  // Manual override (e.g. for tests) wins over qualifier passthrough.
  if (process.env.OFFER_NOTIFICATION_FN) return process.env.OFFER_NOTIFICATION_FN;
  const downstream = NOTIFICATION_ALIAS_MAP[currentInvokedQualifier];
  return downstream
    ? `ZoooomOfferNotification:${downstream}`
    : 'ZoooomOfferNotification';
}

async function fireOfferNotification(payload) {
  const target = resolveNotificationTarget();
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: target,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload))
    }));
    console.log(`[fireOfferNotification] dispatched to ${target} (caller qualifier: ${currentInvokedQualifier || '$LATEST'})`);
  } catch (err) {
    console.warn(`[fireOfferNotification] invoke ${target} failed (non-blocking):`, err?.message || err);
  }
}

// Helper to generate IDs
const generateId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

// Helper to get current ISO timestamp
const now = () => new Date().toISOString();

// CORS headers
const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Response helper
const response = (statusCode, body) => ({
  statusCode,
  headers: corsHeaders,
  body: JSON.stringify(body),
});

// ============================================================================
// DynamoDB Helper Functions
// ============================================================================

async function getDeal(dealId) {
  const result = await docClient.send(new GetCommand({
    TableName: dealsTable(),
    Key: { id: dealId }
  }));
  return result.Item || null;
}

// ZoooomDeals GSIs key on vin (VinIndex), sellerId (bySellerIdIndex) and
// buyerId (byBuyerIdIndex). DynamoDB REJECTS an empty-string value for a GSI
// key attribute, so a deal created from an offer/listing without one of these
// (e.g. the marketplace posts no vin) made PutItem throw ValidationException →
// 500 → the offer was silently dropped and the seller never saw it. Strip empty
// GSI-key attrs before writing: the attribute is simply omitted (the row just
// isn't in that index until a real value is set) instead of crashing the write.
const DEAL_GSI_KEYS = ['vin', 'sellerId', 'buyerId'];
async function putDeal(deal) {
  const item = { ...deal };
  for (const k of DEAL_GSI_KEYS) {
    if (item[k] === '' || item[k] === null || item[k] === undefined) delete item[k];
  }
  await docClient.send(new PutCommand({
    TableName: dealsTable(),
    Item: item
  }));
}

async function getOffer(offerId) {
  const result = await docClient.send(new GetCommand({
    TableName: offersTable(),
    Key: { id: offerId }
  }));
  return result.Item || null;
}

async function putOffer(offer) {
  await docClient.send(new PutCommand({
    TableName: offersTable(),
    Item: offer
  }));
}

// Flip a marketplace listing into the "pending_sale" state. Best-effort:
// a failure here must not block the offer-accept response, since the deal
// is already persisted by the time we call this.
async function markListingPendingSale(listingId) {
  if (!listingId) return;
  try {
    await docClient.send(new UpdateCommand({
      TableName: listingsTable(),
      Key: { id: listingId },
      UpdateExpression: 'SET listingStatus = :s, updatedAt = :u',
      ExpressionAttributeValues: { ':s': 'pending_sale', ':u': now() }
    }));
  } catch (err) {
    console.error('[markListingPendingSale] Failed for listing', listingId, err);
  }
}

async function getOffersByDealId(dealId) {
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: offersTable(),
      IndexName: 'byDealIdIndex',
      KeyConditionExpression: 'dealId = :dealId',
      ExpressionAttributeValues: { ':dealId': dealId }
    }));
    return result.Items || [];
  } catch (error) {
    console.error('Error querying offers by dealId:', error);
    // Fallback to scan if index doesn't exist
    const scanResult = await docClient.send(new ScanCommand({
      TableName: offersTable(),
      FilterExpression: 'dealId = :dealId',
      ExpressionAttributeValues: { ':dealId': dealId }
    }));
    return scanResult.Items || [];
  }
}

async function getDealsBySellerId(sellerId) {
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: dealsTable(),
      IndexName: 'bySellerIdIndex',
      KeyConditionExpression: 'sellerId = :sellerId',
      ExpressionAttributeValues: { ':sellerId': sellerId }
    }));
    return result.Items || [];
  } catch (error) {
    console.error('Error querying by sellerId GSI, falling back to scan:', error.message);
    const scanResult = await docClient.send(new ScanCommand({
      TableName: dealsTable(),
      FilterExpression: 'sellerId = :sellerId',
      ExpressionAttributeValues: { ':sellerId': sellerId }
    }));
    return scanResult.Items || [];
  }
}

async function getDealsByBuyerId(buyerId) {
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: dealsTable(),
      IndexName: 'byBuyerIdIndex',
      KeyConditionExpression: 'buyerId = :buyerId',
      ExpressionAttributeValues: { ':buyerId': buyerId }
    }));
    return result.Items || [];
  } catch (error) {
    console.error('Error querying by buyerId GSI, falling back to scan:', error.message);
    const scanResult = await docClient.send(new ScanCommand({
      TableName: dealsTable(),
      FilterExpression: 'buyerId = :buyerId',
      ExpressionAttributeValues: { ':buyerId': buyerId }
    }));
    return scanResult.Items || [];
  }
}

// Get deals where the user has submitted offers (as a bidder)
// This covers the case where buyerId isn't set on the deal yet (pre-acceptance)
async function getDealsByBidderId(bidderId) {
  let offers = [];
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: offersTable(),
      IndexName: 'byBidderIdIndex',
      KeyConditionExpression: 'bidderId = :bidderId',
      ExpressionAttributeValues: { ':bidderId': bidderId }
    }));
    offers = result.Items || [];
  } catch (error) {
    console.warn('byBidderIdIndex GSI not available, falling back to scan:', error.message);
    const scanResult = await docClient.send(new ScanCommand({
      TableName: offersTable(),
      FilterExpression: 'bidderId = :bidderId',
      ExpressionAttributeValues: { ':bidderId': bidderId }
    }));
    offers = scanResult.Items || [];
  }

  if (offers.length === 0) return [];

  // Get unique deal IDs from the user's offers
  const dealIds = [...new Set(offers.map(o => o.dealId))];

  // Fetch each deal
  const deals = await Promise.all(
    dealIds.map(dealId => getDeal(dealId))
  );

  return deals.filter(Boolean);
}

async function getDealsForUser(userId, role) {
  if (role === 'SELLING') {
    return getDealsBySellerId(userId);
  }
  if (role === 'BUYING') {
    // Include deals with buyerId set, deals where user has active offers,
    // AND deals where user is a participant (e.g. accepted an invitation)
    const [buyerDeals, bidderDeals, participantDeals] = await Promise.all([
      getDealsByBuyerId(userId),
      getDealsByBidderId(userId),
      getDealsByParticipantId(userId)
    ]);

    const dealsMap = new Map();
    buyerDeals.forEach(d => dealsMap.set(d.id, d));
    bidderDeals.forEach(d => dealsMap.set(d.id, d));
    participantDeals.forEach(d => dealsMap.set(d.id, d));
    return Array.from(dealsMap.values());
  }

  const [sellingDeals, buyingDeals, bidderDeals, participantDeals] = await Promise.all([
    getDealsBySellerId(userId),
    getDealsByBuyerId(userId),
    getDealsByBidderId(userId),
    getDealsByParticipantId(userId)
  ]);

  const dealsMap = new Map();
  sellingDeals.forEach(d => dealsMap.set(d.id, d));
  buyingDeals.forEach(d => dealsMap.set(d.id, d));
  bidderDeals.forEach(d => dealsMap.set(d.id, d));
  participantDeals.forEach(d => dealsMap.set(d.id, d));

  return Array.from(dealsMap.values());
}

// ============================================================================
// Invitation Helper Functions
// ============================================================================

async function getInvitationByToken(token) {
  const result = await docClient.send(new ScanCommand({
    TableName: invitationsTable(),
    FilterExpression: '#tk = :token',
    ExpressionAttributeNames: { '#tk': 'token' },
    ExpressionAttributeValues: { ':token': token }
  }));
  return (result.Items && result.Items.length > 0) ? result.Items[0] : null;
}

async function updateInvitation(invitation) {
  await docClient.send(new PutCommand({
    TableName: invitationsTable(),
    Item: invitation
  }));
}

async function getInvitationsByDealId(dealId) {
  const result = await docClient.send(new ScanCommand({
    TableName: invitationsTable(),
    FilterExpression: 'dealId = :dealId',
    ExpressionAttributeValues: { ':dealId': dealId }
  }));
  return result.Items || [];
}

// Accept a PENDING invitation by dealId + buyer email (called when buyer interacts)
async function acceptInvitationByEmail(dealId, email, userId, userName) {
  const invitations = await getInvitationsByDealId(dealId);
  const pending = invitations.find(
    inv => inv.email === email.toLowerCase() && inv.status === 'PENDING'
  );
  if (!pending) return null;

  pending.status = 'ACCEPTED';
  pending.acceptedAt = now();
  pending.acceptedBy = userId;
  pending.acceptedByName = userName;
  await updateInvitation(pending);
  return pending;
}

// ============================================================================
// Participant Helper Functions
// ============================================================================

async function getDealsByParticipantId(userId) {
  // DynamoDB `contains` doesn't support matching inside nested objects in a list,
  // so we scan with an attribute_exists filter and post-filter in JavaScript.
  const result = await docClient.send(new ScanCommand({
    TableName: dealsTable(),
    FilterExpression: 'attribute_exists(participants)',
  }));
  const allDeals = result.Items || [];
  return allDeals.filter(deal =>
    Array.isArray(deal.participants) &&
    deal.participants.some(p => p.id === userId)
  );
}

// Helper to add a participant to a deal (used internally)
// Returns true if participant was added, false if already exists
async function addParticipantToDeal(dealId, participantId, participantName, participantEmail, source) {
  try {
    const deal = await getDeal(dealId);
    if (!deal) {
      console.error(`[addParticipantToDeal] Deal not found: ${dealId}`);
      return false;
    }

    const existingParticipants = deal.participants || [];
    const alreadyExists = existingParticipants.some(p => p.id === participantId);

    if (alreadyExists) {
      console.log(`[addParticipantToDeal] Participant ${participantId} already exists in deal ${dealId}`);
      return false;
    }

    const newParticipant = {
      id: participantId,
      name: participantName,
      ...(participantEmail && { email: participantEmail }),
      source: source || 'CHAT',
      addedAt: now(),
    };

    await docClient.send(new UpdateCommand({
      TableName: dealsTable(),
      Key: { id: dealId },
      UpdateExpression: 'SET participants = list_append(if_not_exists(participants, :empty), :newItem)',
      ExpressionAttributeValues: {
        ':empty': [],
        ':newItem': [newParticipant],
      },
    }));

    console.log(`[addParticipantToDeal] Added participant ${participantId} (${participantName}) to deal ${dealId}`);
    return true;
  } catch (error) {
    console.error('[addParticipantToDeal] Error:', error);
    return false;
  }
}

// ============================================================================
// Invitation Route Handlers
// ============================================================================

// GET /invitations/:token — validate an invitation token (public, no auth)
async function handleValidateInvitation(token) {
  try {
    const invitation = await getInvitationByToken(token);

    if (!invitation) {
      return response(404, { valid: false, error: 'Invitation not found' });
    }

    if (invitation.status === 'ACCEPTED') {
      return response(200, {
        valid: false,
        error: 'This invitation has already been accepted',
        dealId: invitation.dealId
      });
    }

    if (invitation.status === 'CANCELLED') {
      return response(200, { valid: false, error: 'This invitation has been cancelled' });
    }

    // Check expiry
    if (invitation.expiresAt && new Date(invitation.expiresAt) < new Date()) {
      return response(200, { valid: false, error: 'This invitation has expired' });
    }

    // Get deal info for preview
    const deal = await getDeal(invitation.dealId);

    return response(200, {
      valid: true,
      invitation: {
        id: invitation.id,
        dealId: invitation.dealId,
        email: invitation.email,
        invitedByName: invitation.invitedByName,
        personalMessage: invitation.personalMessage,
        status: invitation.status,
      },
      preview: deal ? {
        vehicleTitle: deal.vehicleTitle,
        thumbnailUrl: deal.thumbnailUrl,
        listedPrice: deal.listedPrice,
        sellerName: deal.sellerName,
      } : null
    });
  } catch (error) {
    console.error('[handleValidateInvitation] Error:', error);
    return response(500, { valid: false, error: 'Failed to validate invitation' });
  }
}

// POST /invitations/:token/accept — accept an invitation and become a deal participant
async function handleAcceptInvitation(token, body) {
  try {
    const { userId, userName, userEmail } = body;

    if (!userId) {
      return response(400, { success: false, error: 'userId is required' });
    }

    const invitation = await getInvitationByToken(token);

    if (!invitation) {
      return response(404, { success: false, error: 'Invitation not found' });
    }

    if (invitation.status === 'ACCEPTED') {
      // Already accepted — return the deal ID so frontend can redirect
      return response(200, { success: true, dealId: invitation.dealId, alreadyAccepted: true });
    }

    if (invitation.status === 'CANCELLED') {
      return response(400, { success: false, error: 'This invitation has been cancelled' });
    }

    if (invitation.expiresAt && new Date(invitation.expiresAt) < new Date()) {
      return response(400, { success: false, error: 'This invitation has expired' });
    }

    // Mark invitation as accepted
    invitation.status = 'ACCEPTED';
    invitation.acceptedBy = userId;
    invitation.acceptedByName = userName || '';
    invitation.acceptedAt = now();
    await updateInvitation(invitation);

    // Add buyer as a participant on the deal
    await addParticipantToDeal(
      invitation.dealId,
      userId,
      userName || userEmail || 'Buyer',
      userEmail || invitation.email,
      'INVITATION'
    );

    // Get the deal for the response
    const deal = await getDeal(invitation.dealId);

    return response(200, {
      success: true,
      dealId: invitation.dealId,
      deal: deal ? {
        ...deal,
        role: 'BUYING'
      } : null,
      welcomeMessage: `You've been added to the deal for ${deal?.vehicleTitle || 'this vehicle'}.`
    });
  } catch (error) {
    console.error('[handleAcceptInvitation] Error:', error);
    return response(500, { success: false, error: 'Failed to accept invitation' });
  }
}

// GET /deals/:dealId/invitations — list invitations for a deal (seller only)
async function handleGetDealInvitations(dealId, event) {
  try {
    const sellerId = event.queryStringParameters?.sellerId;
    const deal = await getDeal(dealId);

    if (!deal) {
      return response(404, { error: 'Deal not found' });
    }

    if (sellerId && deal.sellerId !== sellerId) {
      return response(403, { error: 'Only the seller can view invitations' });
    }

    const invitations = await getInvitationsByDealId(dealId);

    return response(200, {
      invitations: invitations.map(inv => ({
        id: inv.id,
        dealId: inv.dealId,
        email: inv.email,
        personalMessage: inv.personalMessage,
        invitedBy: inv.invitedBy,
        invitedByName: inv.invitedByName,
        invitedAt: inv.invitedAt,
        acceptedAt: inv.acceptedAt,
        acceptedBy: inv.acceptedBy,
        acceptedByName: inv.acceptedByName,
        status: inv.status,
        token: inv.token,
        expiresAt: inv.expiresAt,
      }))
    });
  } catch (error) {
    console.error('[handleGetDealInvitations] Error:', error);
    return response(500, { error: 'Failed to fetch invitations' });
  }
}

// POST /deals/:dealId/accept-invitation — mark invitation as accepted when buyer interacts
async function handleAcceptInvitationByInteraction(dealId, body) {
  const { email, userId, userName } = body;

  if (!email) {
    return response(400, { error: 'email is required' });
  }

  try {
    const accepted = await acceptInvitationByEmail(dealId, email, userId, userName);
    if (accepted) {
      return response(200, { success: true, invitation: accepted });
    }
    // No matching PENDING invitation — not an error (buyer may not have been invited)
    return response(200, { success: true, noInvitation: true });
  } catch (error) {
    console.error('[handleAcceptInvitationByInteraction] Error:', error);
    return response(500, { error: 'Failed to accept invitation' });
  }
}

// ============================================================================
// Timeline & Formatting Helpers
// ============================================================================

function generateTimeline(deal) {
  const statuses = ['LISTED', 'NEGOTIATING', 'OFFER_ACCEPTED', 'INSPECTION_PENDING', 'PAYMENT', 'COMPLETED'];
  const currentIndex = statuses.indexOf(deal.status);

  return [
    {
      id: 't1',
      label: 'Listed',
      at: formatDate(deal.createdAt),
      status: currentIndex >= 0 ? 'DONE' : 'UPCOMING'
    },
    {
      id: 't2',
      label: 'Negotiating',
      at: currentIndex >= 1 ? formatDate(deal.updatedAt || deal.createdAt) : 'Pending',
      status: currentIndex === 1 ? 'CURRENT' : currentIndex > 1 ? 'DONE' : 'UPCOMING'
    },
    {
      id: 't3',
      label: 'Offer Accepted',
      at: deal.acceptedAt ? formatDate(deal.acceptedAt) : 'Pending',
      status: currentIndex === 2 ? 'CURRENT' : currentIndex > 2 ? 'DONE' : 'UPCOMING'
    },
    {
      id: 't4',
      label: 'Inspection',
      at: currentIndex >= 3 ? formatDate(deal.updatedAt || '') : 'Pending',
      status: currentIndex === 3 ? 'CURRENT' : currentIndex > 3 ? 'DONE' : 'UPCOMING'
    },
    {
      id: 't5',
      label: 'Payment',
      at: currentIndex >= 4 ? formatDate(deal.updatedAt || '') : 'Pending',
      status: currentIndex === 4 ? 'CURRENT' : currentIndex > 4 ? 'DONE' : 'UPCOMING'
    },
    {
      id: 't6',
      label: 'Completed',
      at: currentIndex >= 5 ? formatDate(deal.updatedAt || '') : 'Pending',
      status: currentIndex === 5 ? 'CURRENT' : 'UPCOMING'
    }
  ];
}

function formatDate(isoString) {
  if (!isoString) return 'Pending';
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getAvatarColor(id) {
  const colors = ['bg-blue-500', 'bg-emerald-500', 'bg-purple-500', 'bg-orange-500', 'bg-pink-500'];
  const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
}

// ============================================================================
// Route Handlers
// ============================================================================

// GET /deals - List deals for user
async function handleGetDeals(event) {
  const userId = event.queryStringParameters?.userId;
  const role = event.queryStringParameters?.role;

  if (!userId) {
    return response(400, { error: 'userId is required' });
  }

  const userDeals = await getDealsForUser(userId, role);
  const dealsWithRole = userDeals.map(deal => ({
    ...deal,
    role: deal.sellerId === userId ? 'SELLING' : 'BUYING'
  }));

  return response(200, { deals: dealsWithRole });
}

// GET /deals/:dealId - Get deal detail
async function handleGetDealDetail(dealId, event) {
  const userId = event.queryStringParameters?.userId;

  const deal = await getDeal(dealId);
  if (!deal) {
    return response(404, { error: 'Deal not found' });
  }

  const dealOffersList = await getOffersByDealId(dealId);
  // Tag each offer's bidder with their KYC-verified status for the Deal Center.
  await attachVerified(dealOffersList, 'bidderId', 'bidderVerified');

  const dealDetail = {
    ...deal,
    role: deal.sellerId === userId ? 'SELLING' : 'BUYING',
    offers: dealOffersList,
    documents: [],
    timeline: generateTimeline(deal)
  };

  return response(200, { deal: dealDetail });
}

// GET /deals/:dealId/participants - Get participants
// Merges chat-based participants (deal.participants[]) with offer-based participants
async function handleGetParticipants(dealId) {
  const deal = await getDeal(dealId);
  if (!deal) {
    return response(404, { error: 'Deal not found' });
  }

  const dealOffersList = await getOffersByDealId(dealId);
  const chatParticipants = deal.participants || [];
  const participantsMap = new Map();

  // 1. Add chat-based participants first
  chatParticipants.forEach(cp => {
    participantsMap.set(cp.id, {
      id: cp.id,
      name: cp.name,
      email: cp.email,
      avatarColor: getAvatarColor(cp.id),
      source: cp.source || 'CHAT',
      unreadCount: 0,
      conversationId: `${deal.sellerId}&${cp.id}&${deal.vin}`,
      latestMessageAt: cp.addedAt,
    });
  });

  // 2. Merge offer-based participants (enrich existing or add new)
  dealOffersList.forEach(offer => {
    const existing = participantsMap.get(offer.bidderId);

    if (existing) {
      // Buyer already registered via chat — enrich with offer data
      if (!existing.offerAmount || offer.amount > existing.offerAmount) {
        existing.offerAmount = offer.amount;
        existing.isHighestOffer = offer.isHighest;
      }
      // Keep name/email from offer if chat entry was missing them
      if (!existing.name && offer.bidderName) existing.name = offer.bidderName;
      if (!existing.email && offer.bidderEmail) existing.email = offer.bidderEmail;
    } else {
      // New participant from offers only
      participantsMap.set(offer.bidderId, {
        id: offer.bidderId,
        name: offer.bidderName,
        email: offer.bidderEmail,
        avatarColor: getAvatarColor(offer.bidderId),
        offerAmount: offer.amount,
        isHighestOffer: offer.isHighest,
        source: 'OFFER',
        unreadCount: 0,
        conversationId: `${deal.sellerId}&${offer.bidderId}&${deal.vin}`,
      });
    }
  });

  // 3. Recalculate isHighestOffer across all participants
  let highestAmount = 0;
  participantsMap.forEach(p => {
    if (p.offerAmount && p.offerAmount > highestAmount) {
      highestAmount = p.offerAmount;
    }
  });
  if (highestAmount > 0) {
    participantsMap.forEach(p => {
      if (p.offerAmount) {
        p.isHighestOffer = p.offerAmount === highestAmount;
      }
    });
  }

  // 4. Sort: offers first (highest amount), then by activity time
  const participants = Array.from(participantsMap.values());
  participants.sort((a, b) => {
    if (a.offerAmount && !b.offerAmount) return -1;
    if (!a.offerAmount && b.offerAmount) return 1;
    if (a.offerAmount && b.offerAmount) return b.offerAmount - a.offerAmount;
    const timeA = a.latestMessageAt ? new Date(a.latestMessageAt).getTime() : 0;
    const timeB = b.latestMessageAt ? new Date(b.latestMessageAt).getTime() : 0;
    return timeB - timeA;
  });

  // 5. Resolve each participant's KYC-verified status so the seller can see who
  //    is identity-verified (offer-based participants are always verified —
  //    KYC is required to offer — but chat-only messengers may not be).
  await attachVerified(participants, 'id', 'isVerified');

  return response(200, { participants });
}

// POST /deals/:dealId/participants - Add a participant to a deal
// Used when a buyer sends a chat message (without making an offer)
async function handleAddParticipant(dealId, body) {
  const { participantId, participantName, participantEmail, source } = body;

  if (!participantId || !participantName) {
    return response(400, { error: 'participantId and participantName are required' });
  }

  try {
    // Get current deal to check for duplicates
    const deal = await getDeal(dealId);
    if (!deal) {
      return response(404, { error: 'Deal not found' });
    }

    const existingParticipants = deal.participants || [];
    const alreadyExists = existingParticipants.some(p => p.id === participantId);

    if (alreadyExists) {
      return response(200, { success: true, existing: true });
    }

    // Append new participant to the deal's participants array
    const newParticipant = {
      id: participantId,
      name: participantName,
      ...(participantEmail && { email: participantEmail }),
      source: source || 'CHAT',
      addedAt: now(),
    };

    await docClient.send(new UpdateCommand({
      TableName: dealsTable(),
      Key: { id: dealId },
      UpdateExpression: 'SET participants = list_append(if_not_exists(participants, :empty), :newItem)',
      ExpressionAttributeValues: {
        ':empty': [],
        ':newItem': [newParticipant],
      },
    }));

    return response(200, { success: true });
  } catch (error) {
    console.error('[handleAddParticipant] Error:', error);
    return response(500, { error: 'Failed to add participant' });
  }
}

// GET /deals/:dealId/offers - Get offers for a deal
async function handleGetDealOffers(dealId) {
  const dealOffersList = await getOffersByDealId(dealId);
  return response(200, { offers: dealOffersList });
}

// POST /deals - Create a new deal from listing
// UPDATED: Now accepts buyerId, buyerName, buyerEmail and adds buyer as participant
async function handleCreateDealFromListing(body) {
  const {
    listingId,
    vin,
    vehicleTitle,
    thumbnailUrl,
    listedPrice,
    sellerId,
    sellerName,
    mileage,
    location,
    latitude,
    longitude,
    exteriorColor,
    interiorColor,
    // NEW: Extract buyer info from request body
    buyerId,
    buyerName,
    buyerEmail
  } = body;

  console.log('Creating deal from listing:', { listingId, vin, sellerId, buyerId, buyerName, buyerEmail });

  if (!listingId || !sellerId) {
    return response(400, { error: 'Missing required fields: listingId, sellerId' });
  }

  // Check if deal already exists for this listing
  const existingDeals = await getDealsBySellerId(sellerId);
  const existingDeal = existingDeals.find(d =>
    d.listingId === listingId &&
    d.status !== 'CANCELLED' &&
    d.status !== 'UNLISTED'
  );

  if (existingDeal) {
    console.log('Deal already exists for listing:', existingDeal.id);

    // NEW: If buyer info is provided and deal already exists, add buyer as participant
    if (buyerId && buyerName) {
      await addParticipantToDeal(
        existingDeal.id,
        buyerId,
        buyerName,
        buyerEmail,
        'CHAT'
      );
    }

    return response(200, { success: true, deal: existingDeal, existing: true });
  }

  // Create new deal - NOTE: buyerId and buyerName on the deal itself are only set when an offer is accepted
  // However, we now add the buyer as a participant so they appear in the deal's participant list
  const deal = {
    id: generateId(),
    listingId,
    vin: vin || '',
    vehicleTitle: vehicleTitle || 'Vehicle',
    thumbnailUrl: thumbnailUrl || '',
    listedPrice: listedPrice || 0,
    mileage: mileage || 0,
    location: location || '',
    latitude: latitude || null,
    longitude: longitude || null,
    exteriorColor: exteriorColor || '',
    interiorColor: interiorColor || '',
    activeOfferCount: 0,
    highestOffer: 0,
    status: 'LISTED',
    sellerId,
    sellerName: sellerName || '',
    // NEW: If buyer info is provided, initialize participants array with the buyer
    participants: (buyerId && buyerName) ? [{
      id: buyerId,
      name: buyerName,
      ...(buyerEmail && { email: buyerEmail }),
      source: 'CHAT',
      addedAt: now(),
    }] : [],
    createdAt: now(),
    updatedAt: now()
  };

  if (vin && sellerId) {
    try {
      await docClient.send(new UpdateCommand({
        TableName: vehiclesTable(),
        Key: {
          vin: vin,
          userId: sellerId
        },
        UpdateExpression: 'SET dealId = :dealId, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':dealId': deal.id,
          ':updatedAt': now()
        }
      }));

      console.log(`Updated vehicle ${vin} with dealId: ${deal.id}`);
    } catch (error) {
      console.error('Error updating vehicle with dealId:', error);
    }
  }

  await putDeal(deal);
  console.log('Created new deal:', deal.id, 'with participants:', deal.participants);

  return response(201, { success: true, deal });
}

// POST /offers - Create new offer
// UPDATED: Now also adds the bidder as a participant on the deal
async function handleCreateOffer(body) {
  const { dealId, listingId, vin, amount, paymentMethod, note, meetLocation, canPickUpAnyTime, bidderId, bidderName, bidderEmail, cashAmount } = body;
  // Split payment (cash + card/Klarna): the buyer's intended cash portion at
  // offer time. The remainder is paid online. Buyer can adjust at checkout.
  const cashPortion = Math.max(0, Math.min(Number(cashAmount) || 0, Number(amount) || 0));

  if (!amount || !paymentMethod || !bidderId) {
    return response(400, { error: 'Missing required fields: amount, paymentMethod, bidderId' });
  }

  // Get or create deal
  let deal = dealId ? await getDeal(dealId) : null;
  let dealCreated = false;

  // State-restriction gate (buyer side): block making an offer when the car's
  // state OR the bidder's KYC state is restricted. Runs before any deal is
  // created so we never leave an orphan deal behind a blocked offer.
  {
    const bidderState = await userStateFromKyc(bidderId);
    const restricted = firstRestrictedState(deal?.location, body.location, bidderState);
    if (restricted) {
      console.log(`[stateGate] offer blocked — restricted state ${restricted}`);
      return response(403, {
        code: 'STATE_RESTRICTED',
        restrictedState: restricted,
        message: RESTRICTED_STATE_MSG
      });
    }
  }

  if (!deal && listingId) {
    // Create deal - include bidder as first participant
    deal = {
      id: generateId(),
      listingId,
      vin: vin || '',
      vehicleTitle: body.vehicleTitle || 'Vehicle',
      thumbnailUrl: body.thumbnailUrl || '',
      listedPrice: body.listedPrice || 0,
      location: body.location || '',
      latitude: body.latitude || null,
      longitude: body.longitude || null,
      exteriorColor: body.exteriorColor || '',
      interiorColor: body.interiorColor || '',
      activeOfferCount: 0,
      highestOffer: 0,
      status: 'NEGOTIATING',
      sellerId: body.sellerId || '',
      sellerName: body.sellerName || '',
      // NEW: Initialize participants with the bidder
      participants: [{
        id: bidderId,
        name: bidderName || 'Anonymous',
        ...(bidderEmail && { email: bidderEmail }),
        source: 'OFFER',
        addedAt: now(),
      }],
      createdAt: now(),
      updatedAt: now()
    };
    await putDeal(deal);
    dealCreated = true;
    console.log('Created new deal with bidder as participant:', deal.id);
  }

  if (!deal) {
    return response(404, { error: 'Deal not found and no listingId provided to create one' });
  }

  // NEW: If deal already existed, add bidder as participant (if not already)
  if (!dealCreated && bidderId && bidderName) {
    await addParticipantToDeal(
      deal.id,
      bidderId,
      bidderName || 'Anonymous',
      bidderEmail,
      'OFFER'
    );
  }

  // Create the offer
  const offer = {
    id: generateId(),
    dealId: deal.id,
    bidderId,
    bidderName: bidderName || 'Anonymous',
    ...(bidderEmail && { bidderEmail }),
    amount,
    isHighest: false,
    paymentMethod,
    cashAmount: cashPortion,
    splitPayment: cashPortion > 0,
    note,
    meetLocation,
    canPickUpAnyTime,
    status: 'OPEN',
    createdAt: now()
  };

  // Get existing offers to update highest offer tracking
  const existingOffers = await getOffersByDealId(deal.id);
  const allOffers = [...existingOffers, offer];

  // Find highest offer
  let highestAmount = 0;
  let highestOfferId = '';
  allOffers.forEach(o => {
    if (o.amount > highestAmount) {
      highestAmount = o.amount;
      highestOfferId = o.id;
    }
  });

  // Update isHighest for existing offers if needed
  for (const o of existingOffers) {
    if (o.isHighest && o.id !== highestOfferId) {
      o.isHighest = false;
      await putOffer(o);
    }
  }

  offer.isHighest = offer.id === highestOfferId;
  await putOffer(offer);

  // Update deal
  deal.highestOffer = highestAmount;
  deal.activeOfferCount = allOffers.length;
  deal.status = 'NEGOTIATING';
  deal.updatedAt = now();
  await putDeal(deal);

  // Fan out to notification Lambda (async — won't block this response)
  await fireOfferNotification({
    eventType: 'OFFER_CREATED',
    offer,
    deal,
    buyerName: bidderName,
    buyerEmail: bidderEmail
  });

  return response(201, { success: true, offer, deal });
}

// POST /offers/:offerId/accept - Accept an offer
async function handleAcceptOffer(offerId, body) {
  const { sellerId } = body;

  const offer = await getOffer(offerId);
  if (!offer) {
    return response(404, { error: 'Offer not found' });
  }

  // If this offer is a seller's counter, the BUYER is accepting it — delegate to
  // the buyer-accept path (different actor + buyer* recipient fields). This lets
  // the buyer reuse the EXISTING /offers/:id/accept route, so no new API Gateway
  // resource is required.
  if (offer.bidderName === 'Counter' && offer.buyerId) {
    return handleAcceptCounter(offerId, {
      userId: body.userId || body.sellerId
    });
  }

  const deal = await getDeal(offer.dealId);
  if (!deal) {
    return response(404, { error: 'Deal not found' });
  }

  if (deal.sellerId !== sellerId) {
    return response(403, { error: 'Only the seller can accept offers' });
  }

  // State-restriction gate (seller side): block accepting an offer when the
  // car's state OR the seller's KYC state is restricted.
  {
    const sellerState = await userStateFromKyc(sellerId);
    const restricted = firstRestrictedState(deal.location, sellerState);
    if (restricted) {
      console.log(`[stateGate] accept blocked — restricted state ${restricted}`);
      return response(403, {
        code: 'STATE_RESTRICTED',
        restrictedState: restricted,
        message: RESTRICTED_STATE_MSG
      });
    }
  }

  const acceptedAt = now();

  // Accept the offer
  offer.status = 'ACCEPTED';
  offer.acceptedAt = acceptedAt;
  offer.updatedAt = acceptedAt;
  await putOffer(offer);

  // Decline all other open offers
  const allOffers = await getOffersByDealId(deal.id);
  for (const otherOffer of allOffers) {
    if (otherOffer.id !== offerId && otherOffer.status === 'OPEN') {
      otherOffer.status = 'DECLINED';
      otherOffer.declinedAt = acceptedAt;
      otherOffer.updatedAt = acceptedAt;
      await putOffer(otherOffer);
    }
  }

  // Update deal - NOW we set buyerId and buyerName (they have actual values)
  deal.status = 'OFFER_ACCEPTED';
  deal.acceptedOffer = offer.amount;
  deal.acceptedAt = acceptedAt;
  deal.buyerId = offer.bidderId;
  deal.buyerName = offer.bidderName;
  deal.paymentMethod = offer.paymentMethod;
  // Carry the buyer's intended cash/online split onto the deal so the seller
  // sees it and it shows in the deal center. The checkout (Stripe metadata →
  // webhook) overwrites these with the actual amounts once the buyer pays.
  deal.cashAmount = offer.cashAmount || 0;
  deal.stripeAmount = Math.max(0, (offer.amount || 0) - (offer.cashAmount || 0));
  deal.splitPayment = !!offer.splitPayment;
  deal.updatedAt = acceptedAt;
  await putDeal(deal);

  // Flip the marketplace listing into "pending_sale" so the car shows the
  // Pending Sale badge and other buyers can't message/offer. Final transition
  // to "sold" happens later in the seller_mark_sold / buyer_confirm_sold flow.
  await markListingPendingSale(deal.listingId);

  const updatedOffers = await getOffersByDealId(deal.id);

  // Fan out to notification Lambda (notifies the buyer their offer was accepted)
  await fireOfferNotification({
    eventType: 'OFFER_ACCEPTED',
    offer,
    deal
  });

  // Pending-sale notification to BOTH parties: safe-meeting guidance + wire-cutoff
  // timing. (OFFER_ACCEPTED above is the buyer's acceptance confirmation; this is
  // the "arrange a safe handoff" nudge to seller + buyer.)
  await fireOfferNotification({
    eventType: 'PENDING_SALE',
    dealId: deal.id,
    deal
  });

  return response(200, {
    success: true,
    deal: {
      ...deal,
      offers: updatedOffers,
      timeline: generateTimeline(deal)
    }
  });
}

// POST /offers/:offerId/counter - Counter an offer
async function handleCounterOffer(offerId, body) {
  const { counterAmount, note, userId } = body;

  const originalOffer = await getOffer(offerId);
  if (!originalOffer) {
    return response(404, { error: 'Offer not found' });
  }

  // State-restriction gate (counter is a buy/sell negotiation action): block
  // when the deal's vehicle state OR the actor's KYC state is restricted. Runs
  // before any offer mutation.
  {
    const gateDeal = await getDeal(originalOffer.dealId);
    const actorState = await userStateFromKyc(userId);
    const restricted = firstRestrictedState(gateDeal?.location, actorState);
    if (restricted) {
      console.log(`[stateGate] counter blocked — restricted state ${restricted}`);
      return response(403, {
        code: 'STATE_RESTRICTED',
        restrictedState: restricted,
        message: RESTRICTED_STATE_MSG
      });
    }
  }

  // Update original offer status
  originalOffer.status = 'COUNTERED';
  originalOffer.updatedAt = now();
  await putOffer(originalOffer);
  const isBidder = userId === originalOffer.bidderId;

  const counterOffer = {
      id: generateId(),
      dealId: originalOffer.dealId,
      bidderId: userId,
      bidderName: 'Counter',
      amount: counterAmount,
      isHighest: counterAmount > (originalOffer.amount || 0),
      paymentMethod: originalOffer.paymentMethod,
      note,
      status: 'OPEN',
      createdAt: now(),
      buyerId: isBidder ? originalOffer.buyerId : originalOffer.bidderId,
      buyerName: isBidder ? originalOffer.buyerName : originalOffer.bidderName,
      buyerEmail: isBidder ? (originalOffer.buyerEmail || '') : (originalOffer.bidderEmail || ''),
      bidderVerified: originalOffer.bidderVerified || false,
      counteredOfferId: offerId,
      cashAmount: originalOffer.cashAmount || 0,
      splitPayment: originalOffer.splitPayment || false
  };
  await putOffer(counterOffer);

  // Fan out to notification Lambda (notifies the original bidder).
  // We need the deal for the email/inbox payload, so fetch it best-effort.
  try {
    const counterDeal = await getDeal(originalOffer.dealId);
    if (counterDeal) {
      await fireOfferNotification({
        eventType: 'OFFER_COUNTERED',
        originalOffer,
        counterOffer,
        deal: counterDeal
      });
    }
  } catch (err) {
    console.warn('[handleCounterOffer] notification dispatch failed (non-blocking):', err?.message || err);
  }

  return response(200, { success: true, offer: counterOffer });
}

// POST /offers/:offerId/accept-counter - Buyer accepts the seller's counter offer
async function handleAcceptCounter(offerId, body) {
  const { userId } = body;

  const counterOffer = await getOffer(offerId);
  if (!counterOffer) {
    return response(404, { error: 'Counter offer not found' });
  }
  // Must be a seller counter awaiting the buyer's response.
  if (counterOffer.bidderName !== 'Counter' || !counterOffer.buyerId) {
    return response(400, { error: 'Not a counter offer' });
  }
  if (counterOffer.status !== 'OPEN') {
    return response(400, { error: 'This counter offer is no longer open' });
  }
  // Only the buyer the counter was sent to can accept it.
  if (counterOffer.buyerId !== userId) {
    return response(403, { error: 'Only the buyer can accept this counter offer' });
  }

  const deal = await getDeal(counterOffer.dealId);
  if (!deal) {
    return response(404, { error: 'Deal not found' });
  }

  // State-restriction gate (buyer side): block when the car's state OR the
  // buyer's KYC state is restricted.
  {
    const buyerState = await userStateFromKyc(userId);
    const restricted = firstRestrictedState(deal.location, buyerState);
    if (restricted) {
      console.log(`[stateGate] accept-counter blocked — restricted state ${restricted}`);
      return response(403, {
        code: 'STATE_RESTRICTED',
        restrictedState: restricted,
        message: RESTRICTED_STATE_MSG
      });
    }
  }

  const acceptedAt = now();

  // Accept the counter offer
  counterOffer.status = 'ACCEPTED';
  counterOffer.acceptedAt = acceptedAt;
  counterOffer.updatedAt = acceptedAt;
  await putOffer(counterOffer);

  // Decline all other still-open offers on the deal
  const allOffers = await getOffersByDealId(deal.id);
  for (const other of allOffers) {
    if (other.id !== offerId && other.status === 'OPEN') {
      other.status = 'DECLINED';
      other.declinedAt = acceptedAt;
      other.updatedAt = acceptedAt;
      await putOffer(other);
    }
  }

  // Move the deal to OFFER_ACCEPTED at the counter price. buyer* come from the
  // counter's recipient fields (NOT bidderId, which is the seller).
  deal.status = 'OFFER_ACCEPTED';
  deal.acceptedOffer = counterOffer.amount;
  deal.acceptedAt = acceptedAt;
  deal.buyerId = counterOffer.buyerId;
  deal.buyerName = counterOffer.buyerName;
  deal.paymentMethod = counterOffer.paymentMethod;
  deal.cashAmount = counterOffer.cashAmount || 0;
  deal.stripeAmount = Math.max(0, (counterOffer.amount || 0) - (counterOffer.cashAmount || 0));
  deal.splitPayment = !!counterOffer.splitPayment;
  deal.updatedAt = acceptedAt;
  await putDeal(deal);

  // Flip the listing to pending_sale (same as a normal accept).
  await markListingPendingSale(deal.listingId);

  const updatedOffers = await getOffersByDealId(deal.id);

  // Notify the SELLER that the buyer accepted their counter (the counter's
  // bidder is the seller, so OFFER_ACCEPTED routes to them), then the
  // safe-meeting / wire-timing nudge to both parties.
  await fireOfferNotification({
    eventType: 'OFFER_ACCEPTED',
    offer: counterOffer,
    deal
  });
  await fireOfferNotification({
    eventType: 'PENDING_SALE',
    dealId: deal.id,
    deal
  });

  return response(200, {
    success: true,
    deal: {
      ...deal,
      offers: updatedOffers,
      timeline: generateTimeline(deal)
    }
  });
}

// POST /offers/:offerId/decline - Decline an offer
async function handleDeclineOffer(offerId) {
  const offer = await getOffer(offerId);
  if (!offer) {
    return response(404, { error: 'Offer not found' });
  }

  offer.status = 'DECLINED';
  offer.declinedAt = now();
  offer.updatedAt = now();
  await putOffer(offer);

  // Fan out to notification Lambda (notifies the bidder their offer was declined).
  try {
    const declinedDeal = await getDeal(offer.dealId);
    if (declinedDeal) {
      await fireOfferNotification({
        eventType: 'OFFER_DECLINED',
        offer,
        deal: declinedDeal
      });
    }
  } catch (err) {
    console.warn('[handleDeclineOffer] notification dispatch failed (non-blocking):', err?.message || err);
  }

  return response(200, { success: true });
}

// POST /deals/:dealId/cancel - Cancel a deal
async function handleCancelDeal(dealId) {
  const deal = await getDeal(dealId);
  if (!deal) {
    return response(404, { error: 'Deal not found' });
  }

  deal.status = 'CANCELLED';
  deal.updatedAt = now();
  await putDeal(deal);

  return response(200, { success: true });
}

// POST /deals/:dealId/unlist - Unlist a deal
async function handleUnlistDeal(dealId, body) {
  const { sellerId } = body;

  const deal = await getDeal(dealId);
  if (!deal) {
    return response(404, { error: 'Deal not found' });
  }

  if (deal.sellerId !== sellerId) {
    return response(403, { error: 'Only the seller can unlist this deal' });
  }

  deal.status = 'UNLISTED';
  deal.updatedAt = now();
  await putDeal(deal);

  return response(200, { success: true });
}

// POST /deals/:dealId/price - Seller updates the listing price.
// Updates BOTH the deal's listedPrice and the underlying listing row's
// price/price_listed with partial UpdateExpressions (so we never overwrite
// the rest of the listing — unlike the full re-list path in ZoooomVehicleStatus).
// Only allowed while the deal is still LISTED (no accepted offer yet); once an
// offer is accepted the agreed price governs the payout, so the listed price is
// frozen. Both the vehicle detail page and the deal page call this with the
// dealId carried on the vehicle/deal row.
async function handleUpdateDealPrice(dealId, body) {
  const { sellerId } = body;
  const price = Number(body.price);

  if (!Number.isFinite(price) || price <= 0) {
    return response(400, { error: 'A positive numeric price is required' });
  }

  const deal = await getDeal(dealId);
  if (!deal) {
    return response(404, { error: 'Deal not found' });
  }
  if (deal.sellerId !== sellerId) {
    return response(403, { error: 'Only the seller can change the price' });
  }
  if (deal.status !== 'LISTED') {
    return response(409, {
      error: 'Price can only be changed while the deal is LISTED (no accepted offer)',
      status: deal.status,
    });
  }

  const ts = now();

  // 1) Deal row (partial — only listedPrice + updatedAt).
  await docClient.send(new UpdateCommand({
    TableName: dealsTable(),
    Key: { id: dealId },
    UpdateExpression: 'SET listedPrice = :p, updatedAt = :u',
    ExpressionAttributeValues: { ':p': price, ':u': ts },
  }));

  // 2) Listing row (partial — only price fields). Best-effort: a deal should
  // always have a listingId, but if it's missing we still return the updated
  // deal rather than failing the price change.
  if (deal.listingId) {
    try {
      await docClient.send(new UpdateCommand({
        TableName: listingsTable(),
        Key: { id: deal.listingId },
        UpdateExpression: 'SET price = :p, price_listed = :p, updatedAt = :u, lastUpdated = :u',
        ExpressionAttributeValues: { ':p': price, ':u': ts },
      }));
    } catch (err) {
      console.error(`[handleUpdateDealPrice] listing ${deal.listingId} price update failed:`, err);
    }
  }

  return response(200, { success: true, deal: { ...deal, listedPrice: price, updatedAt: ts } });
}

// ============================================================================
// Main Handler
// ============================================================================

export const handler = async (event, context) => {
  // Capture the alias this invocation came in through, so fireOfferNotification
  // can forward to the matching ZoooomOfferNotification alias.
  currentInvokedQualifier = parseQualifierFromArn(context?.invokedFunctionArn);

  console.log(
    `[handler] caller qualifier: ${currentInvokedQualifier || '$LATEST'}; ` +
    `tables: ${dealsTable()}, ${offersTable()}, ${invitationsTable()}, ${vehiclesTable()}; ` +
    `downstream: ${resolveNotificationTarget()}`
  );
  console.log('Deals API received event:', JSON.stringify(event, null, 2));

  const method = event.httpMethod || event.requestContext?.http?.method || 'GET';
  const path = event.path || event.rawPath || '';
  const pathParts = path.split('/').filter(Boolean);

  // Remove stage name from path if present
  if (pathParts[0] === 'prod' || pathParts[0] === 'dev' || pathParts[0] === 'staging' || pathParts[0] === 'Dev') {
    pathParts.shift();
  }

  // Handle OPTIONS for CORS
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  try {
    let body = {};
    if (event.body) {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    }

    // Route handling
    if (method === 'GET' && pathParts[0] === 'deals' && !pathParts[1]) {
      return await handleGetDeals(event);
    }

    if (method === 'GET' && pathParts[0] === 'deals' && pathParts[1] && !pathParts[2]) {
      return await handleGetDealDetail(pathParts[1], event);
    }

    if (method === 'GET' && pathParts[0] === 'deals' && pathParts[2] === 'participants') {
      return await handleGetParticipants(pathParts[1]);
    }

    if (method === 'GET' && pathParts[0] === 'deals' && pathParts[2] === 'offers') {
      return await handleGetDealOffers(pathParts[1]);
    }

    if (method === 'POST' && pathParts[0] === 'deals' && !pathParts[1]) {
      return await handleCreateDealFromListing(body);
    }

    // POST /deals/:dealId/participants - Add a chat participant
    if (method === 'POST' && pathParts[0] === 'deals' && pathParts[2] === 'participants') {
      return await handleAddParticipant(pathParts[1], body);
    }

    // POST /deals/:dealId/accept-invitation - Mark invitation accepted when buyer interacts
    if (method === 'POST' && pathParts[0] === 'deals' && pathParts[2] === 'accept-invitation') {
      return await handleAcceptInvitationByInteraction(pathParts[1], body);
    }

    if (method === 'POST' && pathParts[0] === 'deals' && pathParts[2] === 'cancel') {
      return await handleCancelDeal(pathParts[1]);
    }

    if (method === 'POST' && pathParts[0] === 'deals' && pathParts[2] === 'price') {
      return await handleUpdateDealPrice(pathParts[1], body);
    }

    if (method === 'POST' && pathParts[0] === 'deals' && pathParts[2] === 'unlist') {
      return await handleUnlistDeal(pathParts[1], body);
    }

    if (method === 'POST' && pathParts[0] === 'offers' && !pathParts[1]) {
      return await handleCreateOffer(body);
    }

    if (method === 'POST' && pathParts[0] === 'offers' && pathParts[2] === 'accept') {
      return await handleAcceptOffer(pathParts[1], body);
    }

    if (method === 'POST' && pathParts[0] === 'offers' && pathParts[2] === 'counter') {
      return await handleCounterOffer(pathParts[1], body);
    }

    if (method === 'POST' && pathParts[0] === 'offers' && pathParts[2] === 'decline') {
      return await handleDeclineOffer(pathParts[1]);
    }

    // --- Invitation routes ---

    // GET /invitations/:token — validate invitation (public)
    if (method === 'GET' && pathParts[0] === 'invitations' && pathParts[1] && !pathParts[2]) {
      return await handleValidateInvitation(pathParts[1]);
    }

    // POST /invitations/:token/accept — accept invitation
    if (method === 'POST' && pathParts[0] === 'invitations' && pathParts[2] === 'accept') {
      return await handleAcceptInvitation(pathParts[1], body);
    }

    // GET /deals/:dealId/invitations — list invitations for a deal
    if (method === 'GET' && pathParts[0] === 'deals' && pathParts[2] === 'invitations') {
      return await handleGetDealInvitations(pathParts[1], event);
    }

    return response(404, { error: 'Route not found', path, method, pathParts });

  } catch (error) {
    console.error('Deals API error:', error);
    return response(500, { error: 'Internal server error', message: error.message });
  }
};

/**
 * ZoooomMessaging Lambda v2 — Node.js 22
 *
 * Unified messaging & notification Lambda for the Zoooom platform.
 * Consolidates chat messaging, system notifications, inbox management,
 * and notification preferences into a single Lambda.
 *
 * Operations:
 *   Chat:          SENDMESSAGE, GETMESSAGE, READMESSAGE, DELETEMESSAGE, USERINFO
 *   Notifications: SENDNOTIFICATION
 *   Inbox:         GETINBOX, MARKMESSAGES, DELETEINBOX
 *   Preferences:   GETPREFS, SETPREFS
 *
 * DynamoDB Tables:
 *   INBOX_TABLE   (default: ZoooomUserInbox_dev)
 *     PK: Id (userId)
 *     Stores per-user inbox with Chat/Notification maps and Metadata.
 *       Chat:         Record<conversationId, Record<messageId, InboxEntry>>
 *       Notification: Record<conversationId, Record<messageId, InboxEntry>>
 *
 *   MESSAGE_TABLE (default: ZoooomUserInboxMessage_dev)
 *     PK: Id (conversationId — format: "sellerId&buyerId&vin")
 *     SK: MessageId
 *     Stores individual messages for both chat and notifications.
 *
 *   USERS_TABLE   (default: ZoooomUser_dev)
 *     PK: Id (userId)
 *     Used to fetch recipient email/name for notifications and preferences.
 *
 *   DEALS_TABLE   (default: ZoooomDeals_dev)
 *     PK: id
 *     GSI: VinIndex (vin → id)
 *     Used to fetch vehicle title and deal URL for email notifications.
 *
 * API Gateway: POST /messaging/{userId}
 * Authorization: Cognito User Pool Authorizer (idToken in Authorization header)
 * Lambda Proxy Integration: ENABLED
 *
 * Environment Variables:
 *   INBOX_TABLE                  — DynamoDB inbox table name
 *   MESSAGE_TABLE                — DynamoDB messages table name
 *   USERS_TABLE                  — DynamoDB users table name
 *   DEALS_TABLE                  — DynamoDB deals table name
 *   AWS_ORIGIN_DOMAINS           — Semicolon-separated allowed origins for CORS
 *   SES_FROM_EMAIL               — Verified SES sender email (default: noreply@zoooom.me)
 *   FRONTEND_URL                 — Frontend URL for email links (default: https://dev.zoooom.me)
 *   ENABLE_EMAIL_NOTIFICATIONS   — Set to 'true' to enable email notifications
 *
 * Notification Event Types:
 *   OFFER_CREATED, OFFER_ACCEPTED, OFFER_DECLINED, OFFER_COUNTERED,
 *   INVITE_SENT, INVITE_ACCEPTED, RECALL_ALERT, SERVICE_REMINDER,
 *   ACCOUNT_UPDATE, PRICE_CHANGE, SYSTEM
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { randomUUID } from 'node:crypto';

// ─── AWS Clients ───────────────────────────────────────────────────────────────
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});
const sesClient = new SESClient({ region: process.env.AWS_REGION || 'us-west-2' });

// ─── Config ────────────────────────────────────────────────────────────────────
const INBOX_TABLE = process.env.INBOX_TABLE || 'ZoooomUserInbox_dev';
const MESSAGE_TABLE = process.env.MESSAGE_TABLE || 'ZoooomUserInboxMessage_dev';
const USERS_TABLE = process.env.USERS_TABLE || 'ZoooomUser_dev';
const DEALS_TABLE = process.env.DEALS_TABLE || 'ZoooomDeals_dev';
const ALLOWED_ORIGINS = process.env.AWS_ORIGIN_DOMAINS || '';
const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || 'noreply@zoooom.app';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dev.zoooom.me';
const ENABLE_EMAIL_NOTIFICATIONS = process.env.ENABLE_EMAIL_NOTIFICATIONS === 'true';
const MODERATION_REVIEW_TABLE =
  process.env.MODERATION_REVIEW_TABLE || 'ZoooomModerationReview_dev';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

// ─── Chat content moderation ────────────────────────────────────────────────────
// Conservative word list of slurs / harassment / obvious off-platform-payment
// scam bait. Word-boundary, case-insensitive. Comprehend-ready: swap
// matchBlockedTerms() for a Comprehend DetectToxicContent call later. Only chat
// (user-authored) messages are moderated — system notifications are skipped.
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const BLOCKED_TERMS = [
  'fuck', 'shit', 'bitch', 'asshole', 'cunt', 'dickhead', 'motherfucker',
  'nigger', 'faggot', 'retard', 'whore', 'slut',
  'kill yourself', 'kys',
  // off-platform / scam bait
  'wire the money first', 'send a gift card', 'gift card', 'western union',
  'pay outside zoooom', 'cash app me', 'venmo me first', 'zelle me first',
];
function matchBlockedTerms(text) {
  if (!text) return [];
  const found = new Set();
  for (const term of BLOCKED_TERMS) {
    if (new RegExp(`\\b${escapeRe(term)}\\b`, 'i').test(text)) found.add(term);
  }
  return [...found];
}

// Block + flag the sender via the fraud-review pattern (writes a PENDING record
// to ZoooomModerationReview and sets moderation flags on the user). Mirrors
// ZoooomAddVehicleImage.flagUserForModeration. Non-fatal — the caller has
// already decided to block the message; a failure here must not throw.
async function flagUserForChatModeration({ userId, recipientId, conversationId, message, matched }) {
  const reviewId = randomUUID();
  const ts = now();
  let email = '';
  try {
    const q = await docClient.send(new QueryCommand({
      TableName: USERS_TABLE,
      KeyConditionExpression: 'IdUser = :id',
      ExpressionAttributeValues: { ':id': userId },
      Limit: 1,
    }));
    email = q.Items?.[0]?.email || '';
  } catch (err) {
    console.error('[moderation] user lookup failed:', err?.message);
  }
  try {
    await docClient.send(new PutCommand({
      TableName: MODERATION_REVIEW_TABLE,
      Item: {
        reviewId, userId, userEmail: email,
        reason: 'inappropriate_chat_message', severity: 'medium',
        conversationId: conversationId || '', recipientId: recipientId || '',
        details: { message, matchedTerms: matched },
        status: 'PENDING', createdAt: ts, updatedAt: ts,
        reviewedAt: '', reviewNotes: '', reviewedBy: '',
        ttl: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
      },
    }));
  } catch (err) {
    console.error('[moderation] failed to write chat review record:', err?.message);
    return;
  }
  if (email) {
    try {
      await docClient.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { IdUser: userId, email },
        UpdateExpression:
          'SET moderationReviewPending = :flag, moderationReviewId = :rid, moderationFlagCount = if_not_exists(moderationFlagCount, :zero) + :one, lastModerationAt = :now',
        ExpressionAttributeValues: { ':flag': true, ':rid': reviewId, ':zero': 0, ':one': 1, ':now': ts },
      }));
    } catch (err) {
      console.error('[moderation] failed to flag user:', err?.message);
    }
  }
}

/**
 * Format a full name as "FirstName L." (first name + last initial).
 * Matches the frontend's formatNameWithInitial() in ChatWindow.tsx.
 *
 * Examples:
 *   "John Doe"      → "John D."
 *   "Jane"          → "Jane"
 *   "Alice Bob Cat" → "Alice C."
 *   ""              → ""
 */
function formatSenderName(fullName) {
  if (!fullName) return '';
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const firstName = parts[0];
  const lastInitial = parts[parts.length - 1].charAt(0).toUpperCase();
  return `${firstName} ${lastInitial}.`;
}

/**
 * Format currency amount for display.
 */
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Map event type to a human-readable service label.
 */
function eventToServiceLabel(event) {
  const map = {
    'OFFER_CREATED': 'Offer',
    'OFFER_ACCEPTED': 'Offer',
    'OFFER_DECLINED': 'Offer',
    'OFFER_COUNTERED': 'Offer',
    'OFFER_MADE': 'Offer',
    'INVITE_SENT': 'Invite',
    'INVITE_ACCEPTED': 'Invite',
    'RECALL_ALERT': 'Recall',
    'SERVICE_REMINDER': 'Service',
    'ACCOUNT_UPDATE': 'Account',
    'PRICE_CHANGE': 'Price',
    'MESSAGE_SENT': 'Chat',
    'SYSTEM': 'System',
  };
  return map[event] || 'Notification';
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,GET,OPTIONS,DELETE',
    'Access-Control-Allow-Credentials': 'true',
  };
}

function respond(statusCode, body, origin) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
    body: JSON.stringify(body),
  };
}

/**
 * Check if an origin is allowed.
 * Supports wildcard patterns in AWS_ORIGIN_DOMAINS:
 *   - Exact match:    "https://dev-marketplace.zoooom.me"
 *   - Wildcard:       "https://*.zoooom.me"       — matches any subdomain
 *   - Double wild:    "https://*.amplifyapp.com"   — matches any Amplify deploy
 */
function isOriginAllowed(origin) {
  if (!origin || !ALLOWED_ORIGINS) return false;

  const patterns = ALLOWED_ORIGINS.split(';').map((s) => s.trim()).filter(Boolean);

  for (const pattern of patterns) {
    if (pattern === origin) return true;

    if (pattern.includes('*')) {
      const escaped = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]+');
      const regex = new RegExp(`^${escaped}$`);
      if (regex.test(origin)) return true;
    }
  }

  return false;
}

// ─── User & Deal Lookup ────────────────────────────────────────────────────────

/**
 * Get user details by ID (for email and name lookup).
 */
async function getUserById(userId) {
  if (!userId) return null;
  try {
    // ZoooomUser has a COMPOSITE key (IdUser HASH + email RANGE). Query by the
    // partition key and take the first row — a GetItem would require both keys
    // (we don't know the email up front), which is why the old {Id} GetItem
    // always threw ValidationException and no recipient email ever resolved.
    const result = await docClient.send(new QueryCommand({
      TableName: USERS_TABLE,
      KeyConditionExpression: 'IdUser = :id',
      ExpressionAttributeValues: { ':id': userId },
      Limit: 1,
    }));
    const user = result.Items?.[0] || null;
    // Records store firstName/lastName, not name. Synthesize `name` so the
    // existing user.name consumers (email greetings, formatSenderName) work.
    if (user && !user.name && (user.firstName || user.lastName)) {
      user.name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
    }
    return user;
  } catch (error) {
    console.error('[getUserById] Error:', error);
    return null;
  }
}

/**
 * Get deal details by VIN for email context.
 */
async function getDealByVin(vin) {
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: DEALS_TABLE,
      IndexName: 'VinIndex',
      KeyConditionExpression: 'vin = :vin',
      ExpressionAttributeValues: { ':vin': vin },
      Limit: 1,
    }));
    return result.Items?.[0] || null;
  } catch (error) {
    console.error('[getDealByVin] Error:', error);
    return null;
  }
}

/**
 * Check if user has email notifications enabled.
 */
async function shouldSendEmailNotification(userId) {
  try {
    const user = await getUserById(userId);
    if (!user) return false;

    const prefs = user.notificationPreferences || user.preferences || {};
    if (prefs.emailNotifications === false || prefs.chatEmailNotifications === false) {
      return false;
    }
    return true;
  } catch (error) {
    console.error('[shouldSendEmailNotification] Error:', error);
    return true;
  }
}

// ─── Handler ───────────────────────────────────────────────────────────────────

export const handler = async (event) => {
  console.log('[Messaging] Event keys:', Object.keys(event));

  // ── CORS preflight ──
  const origin = event.headers?.origin || event.headers?.Origin || '';
  // console.log('origin: ', origin)
  // console.log('event details: ', event)

  if (event.httpMethod === 'OPTIONS') {
    return respond(200, {}, origin);
  }

  // ── Origin check ──
  if (!isOriginAllowed(origin)) {
    console.warn('[Messaging] Origin rejected:', origin);
    return respond(403, { message: 'Forbidden: origin not allowed' }, origin);
  }

  // ── Parse body ──
  if (!event.body) {
    console.error('[Messaging] No body in request');
    return respond(400, { message: 'Request body is required' }, origin);
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body);
  } catch (err) {
    console.error('[Messaging] JSON parse error:', err.message);
    return respond(400, { message: 'Invalid JSON body' }, origin);
  }

  // ── Validate Cognito claims ──
  const claims = event.requestContext?.authorizer?.claims;
  const cognitoSub = claims?.sub;

  const action = (parsed.action || parsed.operation || '').toUpperCase();

  console.log('[Messaging] Action:', action, 'UserId:', parsed.userId, 'CognitoSub:', cognitoSub);

  // Log userId / cognitoSub mismatch (but don't block)
  if (cognitoSub && parsed.userId && parsed.userId !== cognitoSub) {
    console.warn('[Messaging] userId mismatch: body=', parsed.userId, 'cognito=', cognitoSub);
  }

  // ── Handle batch operations ──
  if (Array.isArray(parsed.messages)) {
    return handleBatch(parsed.messages, action, origin);
  }

  // ── Route single operation ──
  try {
    switch (action) {
      // ── Existing chat operations ──
      case 'SENDMESSAGE':
        return await handleSendMessage(parsed, origin);
      case 'GETMESSAGE':
        return await handleGetMessage(parsed, origin);
      case 'READMESSAGE':
        return await handleReadMessage(parsed, origin);
      case 'DELETEMESSAGE':
        return await handleDeleteMessage(parsed, origin);
      case 'USERINFO':
        return await handleUserInfo(parsed, origin);

      // ── New notification operations ──
      case 'SENDNOTIFICATION':
        return await handleSendNotification(parsed, origin);

      // ── Inbox management (replaces InboxSubscription) ──
      case 'GETINBOX':
      case 'LIST':
        return await handleGetInbox(parsed, origin);
      case 'MARKMESSAGES':
      case 'MARK':
        return await handleMarkMessages(parsed, origin);
      case 'DELETEINBOX':
      case 'DELETE':
        return await handleDeleteInbox(parsed, origin);

      // ── Notification preferences ──
      case 'GETPREFS':
      case 'GET_PREFS':
        return await handleGetPrefs(parsed, origin);
      case 'SETPREFS':
      case 'SET_PREFS':
        return await handleSetPrefs(parsed, origin);

      default:
        console.warn('[Messaging] Unknown action:', action);
        return respond(400, { message: `Unknown action: ${action}` }, origin);
    }
  } catch (error) {
    console.error('[Messaging] Unhandled error:', error);
    return respond(500, {
      message: 'Internal server error',
      error: error.message,
    }, origin);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  SENDMESSAGE — Chat messages between buyers and sellers
// ═══════════════════════════════════════════════════════════════════════════════

async function handleSendMessage(body, origin) {
  const {
    userId,
    sellerId,
    buyerId,
    vin,
    message,
    subject,
    event: msgEvent,
    seller,
    buyer,
    category = 'chat',
    createdDate,
  } = body;

  if (!userId || !message) {
    return respond(400, { message: 'userId and message are required' }, origin);
  }

  if (!sellerId || !buyerId || !vin) {
    return respond(400, { message: 'sellerId, buyerId, and vin are required' }, origin);
  }

  const messageId = randomUUID();
  const conversationId = `${sellerId}&${buyerId}&${vin}`;
  const timestamp = createdDate || now();

  // Determine recipient
  const recipientId = userId === sellerId ? buyerId : sellerId;

  // ── Content moderation (chat only) ──
  // Block inappropriate user-authored chat messages BEFORE persisting, and flag
  // the sender for review. Notifications/system messages (category !== 'chat')
  // are not user-authored, so they're never moderated.
  if ((category || 'chat') === 'chat') {
    const matched = matchBlockedTerms(`${message} ${subject || ''}`);
    if (matched.length > 0) {
      await flagUserForChatModeration({
        userId, recipientId, conversationId, message, matched,
      }).catch((e) => console.error('[moderation] flag failed:', e?.message));
      return respond(
        400,
        {
          message:
            'Your message contains inappropriate content and was not sent. Repeated violations may limit your account.',
          moderation: { blocked: true },
        },
        origin
      );
    }
  }

  // Resolve sender name: use provided seller/buyer name, or look up from DB
  let senderFullName = userId === sellerId ? (seller || '') : (buyer || '');
  if (!senderFullName) {
    const senderUser = await getUserById(userId);
    senderFullName = senderUser?.name || senderUser?.Name || '';
  }
  const senderName = formatSenderName(senderFullName);

  // ── 1. Store message in MESSAGE_TABLE ──
  const messageItem = {
    Id: conversationId,
    MessageId: messageId,
    UserId: userId,
    RecipientId: recipientId,
    Message: message,
    Subject: subject || '',
    Seller: seller || '',
    Buyer: buyer || '',
    SenderName: senderName,
    VehicleId: vin,
    Event: msgEvent || '',
    Category: category,
    IsUnread: true,
    CreatedAt: timestamp,
  };

  console.log('[SENDMESSAGE] Storing message:', messageId, 'conversation:', conversationId);

  await docClient.send(new PutCommand({
    TableName: MESSAGE_TABLE,
    Item: messageItem,
  }));

  // ── 2. Build inbox entries ──
  const baseEntry = {
    MessageId: messageId,
    Message: message,
    Seller: seller || '',
    Buyer: buyer || '',
    SenderName: senderName,
    Subject: subject || '',
    Event: msgEvent || '',
    Service: eventToServiceLabel(msgEvent || 'MESSAGE_SENT'),
    Category: category,
    CreatedAt: timestamp,
  };

  // ── 3. Update sender's inbox (IsUnread: false for sender) ──
  const senderEntry = { ...baseEntry, IsUnread: false };
  await updateInbox(userId, conversationId, messageId, senderEntry, false, category);

  // ── 4. Update recipient's inbox (IsUnread: true for recipient) ──
  const recipientEntry = { ...baseEntry, IsUnread: true };
  await updateInbox(recipientId, conversationId, messageId, recipientEntry, true, category);

  // ── 5. Send email notification to recipient (async, non-blocking) ──
  sendChatEmailNotification({
    senderId: userId,
    recipientId,
    message,
    vin,
    senderName: senderFullName,
    vehicleTitle: subject || undefined,
  }).then(result => {
    if (result.success && !result.skipped) {
      console.log('[SENDMESSAGE] Email notification sent:', result.messageId);
    } else if (result.skipped) {
      console.log('[SENDMESSAGE] Email skipped:', result.reason);
    } else {
      console.warn('[SENDMESSAGE] Email failed:', result.error);
    }
  }).catch(err => {
    console.error('[SENDMESSAGE] Email notification error:', err);
  });

  console.log('[SENDMESSAGE] Complete. messageId:', messageId);

  return respond(200, {
    message: 'ok',
    responses: [{
      messageId,
      conversationId,
      success: true,
    }],
  }, origin);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SENDNOTIFICATION — System/platform notifications
// ═══════════════════════════════════════════════════════════════════════════════

async function handleSendNotification(body, origin) {
  const {
    userId,
    message,
    subject,
    event: eventType,
    service,
    senderName: rawSenderName,
    metadata = {},
    sellerId,
    buyerId,
    vin,
    sendEmail = false,
  } = body;

  if (!userId) {
    return respond(400, { message: 'userId is required' }, origin);
  }
  if (!message && !subject) {
    return respond(400, { message: 'message or subject is required' }, origin);
  }

  const notificationId = randomUUID();
  const timestamp = now();

  // Build conversation ID for grouping
  let conversationId;
  if (sellerId && buyerId && vin) {
    conversationId = `${sellerId}&${buyerId}&${vin}`;
  } else {
    conversationId = `system&${userId}&${eventType || 'SYSTEM'}`;
  }

  const senderName = formatSenderName(rawSenderName || '');
  const serviceLabel = service || eventToServiceLabel(eventType || 'SYSTEM');

  // ── 1. Build notification entry for inbox ──
  const notificationEntry = {
    MessageId: notificationId,
    Message: message || subject || '',
    Subject: subject || '',
    Body: message || '',
    IsUnread: true,
    SenderName: senderName,
    Seller: body.sellerName || '',
    Buyer: body.buyerName || '',
    Event: eventType || 'SYSTEM',
    Service: serviceLabel,
    Category: 'notification',
    CreatedAt: timestamp,
    Metadata: metadata,
  };

  console.log('[SENDNOTIFICATION] Storing notification:', notificationId, 'for user:', userId, 'event:', eventType);

  // ── 2. Store in MESSAGE_TABLE for audit trail ──
  const messageItem = {
    Id: conversationId,
    MessageId: notificationId,
    UserId: 'system',
    RecipientId: userId,
    Message: message || subject || '',
    Subject: subject || '',
    SenderName: senderName,
    Seller: body.sellerName || '',
    Buyer: body.buyerName || '',
    VehicleId: vin || '',
    Event: eventType || 'SYSTEM',
    Service: serviceLabel,
    Category: 'notification',
    IsUnread: true,
    CreatedAt: timestamp,
    Metadata: metadata,
  };

  await docClient.send(new PutCommand({
    TableName: MESSAGE_TABLE,
    Item: messageItem,
  }));

  // ── 3. Update recipient's inbox (Notification map) ──
  await updateInbox(userId, conversationId, notificationId, notificationEntry, true, 'notification');

  // ── 4. Optionally send email notification ──
  let emailResult = null;
  if (sendEmail && ENABLE_EMAIL_NOTIFICATIONS) {
    emailResult = await sendNotificationEmail({
      recipientId: userId,
      subject: subject || '',
      message: message || '',
      eventType: eventType || 'SYSTEM',
      senderName: rawSenderName || '',
      vehicleTitle: metadata.vehicleTitle || '',
      dealUrl: metadata.dealUrl || `${FRONTEND_URL}/dashboard/inbox`,
      offerAmount: metadata.offerAmount,
      counterAmount: metadata.counterAmount,
    });
  }

  console.log('[SENDNOTIFICATION] Complete. notificationId:', notificationId);

  return respond(200, {
    message: 'ok',
    responses: [{
      notificationId,
      conversationId,
      success: true,
      emailResult,
    }],
  }, origin);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GETMESSAGE — Retrieve messages for a conversation
// ═══════════════════════════════════════════════════════════════════════════════

async function handleGetMessage(body, origin) {
  const { conversationId, messageId, category } = body;

  if (!conversationId) {
    return respond(400, { message: 'conversationId is required' }, origin);
  }

  console.log('[GETMESSAGE] conversationId:', conversationId, 'messageId:', messageId);

  if (messageId) {
    const result = await docClient.send(new GetCommand({
      TableName: MESSAGE_TABLE,
      Key: { Id: conversationId, MessageId: messageId },
    }));

    return respond(200, {
      message: 'ok',
      responses: [{ Items: result.Item ? [result.Item] : [] }],
    }, origin);
  }

  // Get all messages in conversation
  const result = await docClient.send(new QueryCommand({
    TableName: MESSAGE_TABLE,
    KeyConditionExpression: 'Id = :id',
    ExpressionAttributeValues: { ':id': conversationId },
    ScanIndexForward: true,
  }));

  const items = result.Items || [];
  const filtered = category
    ? items.filter((item) => item.Category === category)
    : items;

  console.log('[GETMESSAGE] Returned', filtered.length, 'messages');

  return respond(200, {
    message: 'ok',
    responses: [{ Items: filtered }],
  }, origin);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  READMESSAGE — Mark specific message as read
// ═══════════════════════════════════════════════════════════════════════════════

async function handleReadMessage(body, origin) {
  const { userId, conversationId, messageId, category, unreadChats, unreadNotifications } = body;

  if (!userId) {
    return respond(400, { message: 'userId is required' }, origin);
  }

  console.log('[READMESSAGE] userId:', userId, 'convId:', conversationId, 'msgId:', messageId);

  // ── Update unread counts only ──
  if (unreadChats !== undefined || unreadNotifications !== undefined) {
    await updateInboxMetadata(userId, unreadChats, unreadNotifications);
    return respond(200, { message: 'ok', responses: [{ success: true }] }, origin);
  }

  // ── Mark specific message as read ──
  if (conversationId && messageId) {
    // Update message table
    try {
      await docClient.send(new UpdateCommand({
        TableName: MESSAGE_TABLE,
        Key: { Id: conversationId, MessageId: messageId },
        UpdateExpression: 'SET IsUnread = :false',
        ExpressionAttributeValues: { ':false': false },
      }));
    } catch (err) {
      console.warn('[READMESSAGE] Could not update message table:', err.message);
    }

    // Update inbox entry (Chat or Notification map)
    const categoryKey = (category === 'notification') ? 'Notification' : 'Chat';
    try {
      await docClient.send(new UpdateCommand({
        TableName: INBOX_TABLE,
        Key: { Id: userId },
        UpdateExpression: 'SET #cat.#conv.#msg.IsUnread = :false, UpdatedAt = :now',
        ExpressionAttributeNames: {
          '#cat': categoryKey,
          '#conv': conversationId,
          '#msg': messageId,
        },
        ExpressionAttributeValues: {
          ':false': false,
          ':now': now(),
        },
      }));
    } catch (err) {
      console.warn('[READMESSAGE] Could not update inbox:', err.message);
    }
  }

  return respond(200, { message: 'ok', responses: [{ success: true }] }, origin);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DELETEMESSAGE — Delete a specific message
// ═══════════════════════════════════════════════════════════════════════════════

async function handleDeleteMessage(body, origin) {
  const { userId, messageId, conversationId } = body;

  if (!userId || !messageId) {
    return respond(400, { message: 'userId and messageId are required' }, origin);
  }

  console.log('[DELETEMESSAGE] userId:', userId, 'messageId:', messageId);

  // Delete from message table
  if (conversationId) {
    try {
      await docClient.send(new DeleteCommand({
        TableName: MESSAGE_TABLE,
        Key: { Id: conversationId, MessageId: messageId },
      }));
    } catch (err) {
      console.warn('[DELETEMESSAGE] Could not delete from message table:', err.message);
    }
  }

  // Remove from inbox — search BOTH Chat and Notification maps
  try {
    const inbox = await docClient.send(new GetCommand({
      TableName: INBOX_TABLE,
      Key: { Id: userId },
    }));

    if (inbox.Item) {
      let found = false;

      // Search Chat map
      if (inbox.Item.Chat) {
        for (const [convId, messages] of Object.entries(inbox.Item.Chat)) {
          if (messages[messageId]) {
            await docClient.send(new UpdateCommand({
              TableName: INBOX_TABLE,
              Key: { Id: userId },
              UpdateExpression: 'REMOVE #map.#conv.#msg SET UpdatedAt = :now',
              ExpressionAttributeNames: {
                '#map': 'Chat',
                '#conv': convId,
                '#msg': messageId,
              },
              ExpressionAttributeValues: { ':now': now() },
            }));
            found = true;
            break;
          }
        }
      }

      // Search Notification map if not found in Chat
      if (!found && inbox.Item.Notification) {
        for (const [convId, messages] of Object.entries(inbox.Item.Notification)) {
          if (messages[messageId]) {
            await docClient.send(new UpdateCommand({
              TableName: INBOX_TABLE,
              Key: { Id: userId },
              UpdateExpression: 'REMOVE #map.#conv.#msg SET UpdatedAt = :now',
              ExpressionAttributeNames: {
                '#map': 'Notification',
                '#conv': convId,
                '#msg': messageId,
              },
              ExpressionAttributeValues: { ':now': now() },
            }));
            break;
          }
        }
      }
    }
  } catch (err) {
    console.warn('[DELETEMESSAGE] Could not remove from inbox:', err.message);
  }

  return respond(200, { message: 'ok', responses: [{ success: true }] }, origin);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  USERINFO — Get user's inbox data
// ═══════════════════════════════════════════════════════════════════════════════

async function handleUserInfo(body, origin) {
  const { userId } = body;

  if (!userId) {
    return respond(400, { message: 'userId is required' }, origin);
  }

  console.log('[USERINFO] userId:', userId);

  const result = await docClient.send(new GetCommand({
    TableName: INBOX_TABLE,
    Key: { Id: userId },
  }));

  if (!result.Item) {
    const emptyInbox = {
      Id: userId,
      Chat: {},
      Notification: {},
      Metadata: {
        UnreadChats: 0,
        UnreadNotifications: 0,
        UpdatedAt: now(),
      },
      CreatedAt: now(),
      UpdatedAt: now(),
    };

    return respond(200, {
      message: 'ok',
      responses: [emptyInbox],
    }, origin);
  }

  return respond(200, {
    message: 'ok',
    responses: [result.Item],
  }, origin);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GETINBOX — Unified inbox listing (replaces InboxSubscription "list")
// ═══════════════════════════════════════════════════════════════════════════════

async function handleGetInbox(body, origin) {
  const { userId } = body;

  if (!userId) {
    return respond(400, { message: 'userId is required' }, origin);
  }

  console.log('[GETINBOX] userId:', userId);

  const result = await docClient.send(new GetCommand({
    TableName: INBOX_TABLE,
    Key: { Id: userId },
  }));

  const inbox = result.Item;

  if (!inbox) {
    // Empty inbox for new users
    return respond(200, {
      items: {
        Chat: {},
        Notification: [],
        messages: [],
        Metadata: {
          UnreadChats: 0,
          UnreadNotifications: 0,
          UpdatedAt: now(),
        },
      },
      nextToken: null,
    }, origin);
  }

  // Transform Notification map into the flat messages[] array the Inbox page expects
  // Input:  Notification: { [conversationId]: { [messageId]: { Subject, Body/Message, IsUnread, ... } } }
  // Output: messages: [ { id, createdAt, service, subject, body, isRead } ]
  const messages = [];

  if (inbox.Notification && typeof inbox.Notification === 'object') {
    for (const [conversationId, messagesMap] of Object.entries(inbox.Notification)) {
      if (messagesMap && typeof messagesMap === 'object') {
        // Check if this is a nested structure (convId -> { msgId -> entry })
        // or a flat structure (notificationId -> entry with MessageId)
        const firstValue = Object.values(messagesMap)[0];

        if (firstValue && typeof firstValue === 'object' && firstValue.MessageId) {
          // Flat structure: { notificationId: { MessageId, Subject, Body, ... } }
          // This handles the legacy offer-notification-lambda format
          for (const [msgId, entry] of Object.entries(messagesMap)) {
            messages.push({
              id: entry.MessageId || msgId,
              createdAt: entry.CreatedAt || '',
              service: entry.Service || entry.Metadata?.type || 'Notification',
              subject: entry.Subject || '',
              body: entry.Body || entry.Message || '',
              isRead: entry.IsUnread === false,
              senderName: entry.SenderName || '',
              event: entry.Event || '',
              metadata: entry.Metadata || {},
            });
          }
        } else if (firstValue && typeof firstValue === 'object') {
          // Nested structure: { conversationId: { messageId: { ... } } }
          for (const [msgId, entry] of Object.entries(messagesMap)) {
            if (entry && typeof entry === 'object' && entry.MessageId) {
              messages.push({
                id: entry.MessageId || msgId,
                createdAt: entry.CreatedAt || '',
                service: entry.Service || eventToServiceLabel(entry.Event || '') || 'Notification',
                subject: entry.Subject || '',
                body: entry.Body || entry.Message || '',
                isRead: entry.IsUnread === false,
                senderName: entry.SenderName || '',
                event: entry.Event || '',
                metadata: entry.Metadata || {},
              });
            }
          }
        }
      }
    }
  }

  // Also merge in entries from the canonical `messages` array on the inbox
  // row. This is where newer notification writers (welcome, seller-invite,
  // accept, listing-live, offer-events, etc.) append using
  // UpdateExpression `list_append(if_not_exists(messages, :empty), :new)`.
  // Older code wrote to the `Notification` map (handled above); we read both
  // sources and de-dupe by id so notifications don't get lost or doubled.
  if (Array.isArray(inbox.messages)) {
    for (const entry of inbox.messages) {
      if (!entry || typeof entry !== 'object') continue;
      messages.push({
        id: entry.id || entry.MessageId || '',
        createdAt: entry.createdAt || entry.CreatedAt || '',
        service: entry.service || entry.Service || 'Notification',
        subject: entry.subject || entry.Subject || '',
        body: entry.body || entry.Body || entry.Message || '',
        isRead: entry.isRead === true,
        senderName: entry.senderName || entry.SenderName || '',
        event: entry.event || entry.Event || '',
        metadata: entry.metadata || entry.Metadata || {},
      });
    }
  }

  // De-dupe by id (in case the same notification got written to both slots).
  const seen = new Set();
  const merged = [];
  for (const m of messages) {
    if (m.id && seen.has(m.id)) continue;
    if (m.id) seen.add(m.id);
    merged.push(m);
  }

  // Sort messages by date (newest first)
  merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return respond(200, {
    items: {
      Chat: inbox.Chat || {},
      Notification: [],
      messages: merged,
      Metadata: inbox.Metadata || {
        UnreadChats: 0,
        UnreadNotifications: 0,
        UpdatedAt: now(),
      },
    },
    nextToken: null,
  }, origin);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MARKMESSAGES — Bulk mark read/unread (replaces InboxSubscription "mark")
// ═══════════════════════════════════════════════════════════════════════════════

async function handleMarkMessages(body, origin) {
  const { userId, messageIds = [], chatIds = [], isRead } = body;

  if (!userId) {
    return respond(400, { message: 'userId is required' }, origin);
  }

  console.log('[MARKMESSAGES] userId:', userId, 'messageIds:', messageIds.length, 'chatIds:', chatIds.length, 'isRead:', isRead);

  const inbox = await docClient.send(new GetCommand({
    TableName: INBOX_TABLE,
    Key: { Id: userId },
  }));

  if (!inbox.Item) {
    return respond(200, { message: 'ok', success: true }, origin);
  }

  const inboxData = inbox.Item;
  let modified = false;

  // ── Mark notification items ──
  // for (const notifId of messageIds) {
  //   if (inboxData.Notification && typeof inboxData.Notification === 'object') {
  //     // Search all conversation groups for this notification
  //     for (const [convId, messagesMap] of Object.entries(inboxData.Notification)) {
  //       if (messagesMap && typeof messagesMap === 'object') {
  //         // Check nested structure
  //         if (messagesMap[notifId]) {
  //           messagesMap[notifId].IsUnread = !isRead;
  //           modified = true;
  //         }
  //         // Check if this IS the notification (flat legacy structure)
  //         if (messagesMap.MessageId === notifId) {
  //           messagesMap.IsUnread = !isRead;
  //           modified = true;
  //         }
  //       }
  //     }
  //   }
  // }
  // ── Mark notification items ──
  if (messageIds.length > 0 && Array.isArray(inboxData.messages)) {
    for (const msg of inboxData.messages) {
      if (messageIds.includes(msg.id)) {
        msg.isRead = isRead;  // note: lowercase, matches your schema
        modified = true;
      }
    }
  }

  // ── Mark chat items ──
  // chatIds format: "conversationId;messageId"
  for (const chatIdStr of chatIds) {
    const parts = chatIdStr.split(';');
    if (parts.length >= 2) {
      const conversationId = parts[0];
      const msgId = parts[1];

      if (inboxData.Chat?.[conversationId]?.[msgId]) {
        inboxData.Chat[conversationId][msgId].IsUnread = !isRead;
        modified = true;
      }
    }
  }

  if (modified) {
    // Recalculate unread counts
    const counts = recalculateUnreadCounts(inboxData);
    inboxData.Metadata = {
      ...inboxData.Metadata,
      UnreadChats: counts.unreadChats,
      UnreadNotifications: counts.unreadNotifications,
      UpdatedAt: now(),
    };
    inboxData.UpdatedAt = now();

    await docClient.send(new PutCommand({
      TableName: INBOX_TABLE,
      Item: inboxData,
    }));
  }

  return respond(200, { message: 'ok', success: true }, origin);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DELETEINBOX — Bulk delete from inbox (replaces InboxSubscription "delete")
// ═══════════════════════════════════════════════════════════════════════════════

async function handleDeleteInbox(body, origin) {
  const { userId, ids = [] } = body;

  if (!userId) {
    return respond(400, { message: 'userId is required' }, origin);
  }

  console.log('[DELETEINBOX] userId:', userId, 'ids:', ids.length);
  console.log("ID:", ids)

  const inbox = await docClient.send(new GetCommand({
    TableName: INBOX_TABLE,
    Key: { Id: userId },
  }));

  if (!inbox.Item) {
    return respond(200, { message: 'ok', success: true }, origin);
  }

  const inboxData = inbox.Item;
  let modified = false;

  for (const idStr of ids) {
    if (idStr.startsWith('Notification;')) {
      // Delete notification by ID
      const notifId = idStr.replace('Notification;', '');
      if (inboxData.Notification && typeof inboxData.Notification === 'object') {
        for (const [convId, messagesMap] of Object.entries(inboxData.Notification)) {
          if (messagesMap && typeof messagesMap === 'object') {
            if (messagesMap[notifId]) {
              delete messagesMap[notifId];
              // Clean up empty conversation group
              if (Object.keys(messagesMap).length === 0) {
                delete inboxData.Notification[convId];
              }
              modified = true;
              break;
            }
          }
        }
      }
    } else if (idStr.startsWith('Conversation;')) {
      // Delete chat conversation entry
      // Format: "Conversation;conversationId;messageId"
      const rest = idStr.replace('Conversation;', '');
      const semiIdx = rest.lastIndexOf(';');
      if (semiIdx > 0) {
        const conversationId = rest.substring(0, semiIdx);
        const msgId = rest.substring(semiIdx + 1);

        if (inboxData.Chat?.[conversationId]?.[msgId]) {
          delete inboxData.Chat[conversationId][msgId];
          // Clean up empty conversation group
          if (Object.keys(inboxData.Chat[conversationId]).length === 0) {
            delete inboxData.Chat[conversationId];
          }
          modified = true;
        }
      }
    } else {
      // Bare ID — try to find in notifications (backward compatibility)
      if (inboxData.Notification && typeof inboxData.Notification === 'object') {
        for (const [convId, messagesMap] of Object.entries(inboxData.Notification)) {
          if (messagesMap && typeof messagesMap === 'object' && messagesMap[idStr]) {
            delete messagesMap[idStr];
            if (Object.keys(messagesMap).length === 0) {
              delete inboxData.Notification[convId];
            }
            modified = true;
            break;
          }
        }
      }
    }

    if (Array.isArray(inboxData.messages)) {
      console.log('[DELETEINBOX] messages array length:', inboxData.messages.length);
      const before = inboxData.messages.length;
      const bareId = idStr.startsWith('Notification;')
        ? idStr.replace('Notification;', '')
        : idStr;
      console.log('[DELETEINBOX] looking for bareId:', bareId);
      inboxData.messages = inboxData.messages.filter(m =>
        (m.id || m.MessageId) !== bareId
      );
      console.log('[DELETEINBOX] messages after filter:', inboxData.messages.length);
      if (inboxData.messages.length < before) modified = true;
    }
  }

  if (modified) {
    // Recalculate unread counts
    const counts = recalculateUnreadCounts(inboxData);
    inboxData.Metadata = {
      ...inboxData.Metadata,
      UnreadChats: counts.unreadChats,
      UnreadNotifications: counts.unreadNotifications,
      UpdatedAt: now(),
    };
    inboxData.UpdatedAt = now();

    await docClient.send(new PutCommand({
      TableName: INBOX_TABLE,
      Item: inboxData,
    }));
  }

  return respond(200, { message: 'ok', success: true }, origin);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GETPREFS — Get notification preferences (replaces InboxSubscription "get_prefs")
// ═══════════════════════════════════════════════════════════════════════════════

async function handleGetPrefs(body, origin) {
  const { userId, token } = body;
  const lookupId = userId || token;

  if (!lookupId) {
    return respond(400, { message: 'userId or token is required' }, origin);
  }

  console.log('[GETPREFS] lookupId:', lookupId);

  try {
    const user = await getUserById(lookupId);

    if (!user) {
      // Return defaults for unknown users
      return respond(200, {
        optOutService: false,
        optOutMarketing: false,
      }, origin);
    }

    const prefs = user.notificationPreferences || user.preferences || {};

    return respond(200, {
      optOutService: prefs.optOutService === true || prefs.emailServiceAnnounce === true || false,
      optOutMarketing: prefs.optOutMarketing === true || prefs.emailSubscribe === true || false,
    }, origin);
  } catch (error) {
    console.error('[GETPREFS] Error:', error);
    return respond(500, { message: 'Failed to load preferences' }, origin);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SETPREFS — Set notification preferences (replaces InboxSubscription "set_prefs")
// ═══════════════════════════════════════════════════════════════════════════════

async function handleSetPrefs(body, origin) {
  const { userId, token, email: bodyEmail, optOutService, optOutMarketing, emailServiceAnnounce, emailSubscribe } = body;
  const lookupId = userId || token;

  if (!lookupId) {
    return respond(400, { message: 'userId or token is required' }, origin);
  }

  console.log('[SETPREFS] lookupId:', lookupId);

  // Accept both new and legacy field names
  const serviceOpt = optOutService !== undefined ? optOutService : (emailServiceAnnounce || false);
  const marketingOpt = optOutMarketing !== undefined ? optOutMarketing : (emailSubscribe || false);

  // ZoooomUser is a COMPOSITE key (IdUser HASH + email RANGE). The old code wrote
  // Key:{Id:lookupId}, which ALWAYS threw ValidationException (wrong key schema) →
  // prefs never actually persisted. Resolve the full row to get IdUser + email so
  // the write uses the real composite key (same pattern as flagUserForChatModeration).
  const user = await getUserById(lookupId);
  const idUser = user?.IdUser || userId || lookupId;
  const email = bodyEmail || user?.email;
  if (!email) {
    console.warn('[SETPREFS] could not resolve email for', lookupId, '— cannot write composite key');
    return respond(404, { message: 'User not found' }, origin);
  }

  try {
    await docClient.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { IdUser: idUser, email },
      UpdateExpression: 'SET #prefs.#os = :os, #prefs.#om = :om, #prefs.#esa = :os, #prefs.#es = :om, UpdatedAt = :now',
      ExpressionAttributeNames: {
        '#prefs': 'notificationPreferences',
        '#os': 'optOutService',
        '#om': 'optOutMarketing',
        '#esa': 'emailServiceAnnounce',
        '#es': 'emailSubscribe',
      },
      ExpressionAttributeValues: {
        ':os': serviceOpt,
        ':om': marketingOpt,
        ':now': now(),
      },
    }));

    return respond(200, {
      message: 'ok',
      optOutService: serviceOpt,
      optOutMarketing: marketingOpt,
    }, origin);
  } catch (error) {
    // If notificationPreferences map doesn't exist yet, create it
    if (error.name === 'ValidationException') {
      try {
        await docClient.send(new UpdateCommand({
          TableName: USERS_TABLE,
          Key: { IdUser: idUser, email },
          UpdateExpression: 'SET #prefs = :prefs, UpdatedAt = :now',
          ExpressionAttributeNames: { '#prefs': 'notificationPreferences' },
          ExpressionAttributeValues: {
            ':prefs': {
              optOutService: serviceOpt,
              optOutMarketing: marketingOpt,
              emailServiceAnnounce: serviceOpt,
              emailSubscribe: marketingOpt,
            },
            ':now': now(),
          },
        }));

        return respond(200, {
          message: 'ok',
          optOutService: serviceOpt,
          optOutMarketing: marketingOpt,
        }, origin);
      } catch (retryError) {
        console.error('[SETPREFS] Retry error:', retryError);
        return respond(500, { message: 'Failed to update preferences' }, origin);
      }
    }

    console.error('[SETPREFS] Error:', error);
    return respond(500, { message: 'Failed to update preferences' }, origin);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BATCH — Process array of messages
// ═══════════════════════════════════════════════════════════════════════════════

async function handleBatch(messages, batchAction, origin) {
  console.log('[BATCH] Processing', messages.length, 'messages, action:', batchAction);

  const responses = [];

  for (const msg of messages) {
    const action = (msg.operation || msg.action || batchAction || '').toUpperCase();

    try {
      switch (action) {
        case 'READMESSAGE': {
          const { userId, conversationId, messageId, category, unreadChats, unreadNotifications } = msg;

          if (unreadChats !== undefined || unreadNotifications !== undefined) {
            await updateInboxMetadata(userId, unreadChats, unreadNotifications);
          } else if (conversationId && messageId) {
            try {
              await docClient.send(new UpdateCommand({
                TableName: MESSAGE_TABLE,
                Key: { Id: conversationId, MessageId: messageId },
                UpdateExpression: 'SET IsUnread = :false',
                ExpressionAttributeValues: { ':false': false },
              }));
            } catch (err) {
              console.warn('[BATCH READMESSAGE] message table error:', err.message);
            }

            const categoryKey = (category === 'notification') ? 'Notification' : 'Chat';
            try {
              await docClient.send(new UpdateCommand({
                TableName: INBOX_TABLE,
                Key: { Id: userId },
                UpdateExpression: 'SET #cat.#conv.#msg.IsUnread = :false',
                ExpressionAttributeNames: {
                  '#cat': categoryKey,
                  '#conv': conversationId,
                  '#msg': messageId,
                },
                ExpressionAttributeValues: { ':false': false },
              }));
            } catch (err) {
              console.warn('[BATCH READMESSAGE] inbox error:', err.message);
            }
          }
          responses.push({ success: true });
          break;
        }

        case 'SENDMESSAGE': {
          const result = await handleSendMessage(msg, origin);
          const resultBody = JSON.parse(result.body);
          responses.push(resultBody.responses?.[0] || { success: true });
          break;
        }

        case 'SENDNOTIFICATION': {
          const result = await handleSendNotification(msg, origin);
          const resultBody = JSON.parse(result.body);
          responses.push(resultBody.responses?.[0] || { success: true });
          break;
        }

        case 'DELETEMESSAGE': {
          const result = await handleDeleteMessage(msg, origin);
          const resultBody = JSON.parse(result.body);
          responses.push(resultBody.responses?.[0] || { success: true });
          break;
        }

        default:
          console.warn('[BATCH] Unknown action in batch:', action);
          responses.push({ success: false, error: `Unknown action: ${action}` });
      }
    } catch (error) {
      console.error('[BATCH] Error processing message:', error);
      responses.push({ success: false, error: error.message });
    }
  }

  return respond(200, {
    message: 'ok',
    responses,
  }, origin);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Inbox Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Update a user's inbox with a new message/notification entry.
 * Creates the inbox record if it doesn't exist.
 *
 * @param {string} userId        — Target user ID
 * @param {string} conversationId — Conversation grouping key
 * @param {string} messageId     — Unique message/notification ID
 * @param {object} entry         — The inbox entry to store
 * @param {boolean} isRecipient  — true to increment unread count
 * @param {string} category      — 'chat' or 'notification'
 */
async function updateInbox(userId, conversationId, messageId, entry, isRecipient, category = 'chat') {
  const ts = now();
  const mapKey = category === 'notification' ? 'Notification' : 'Chat';
  const unreadKey = category === 'notification' ? 'UnreadNotifications' : 'UnreadChats';

  try {
    const result = await docClient.send(new GetCommand({
      TableName: INBOX_TABLE,
      Key: { Id: userId },
    }));

    if (result.Item) {
      const inbox = result.Item;

      // Ensure map exists
      if (!inbox[mapKey]) inbox[mapKey] = {};
      if (!inbox[mapKey][conversationId]) inbox[mapKey][conversationId] = {};
      inbox[mapKey][conversationId][messageId] = entry;

      // Update metadata
      if (!inbox.Metadata) {
        inbox.Metadata = { UnreadChats: 0, UnreadNotifications: 0, UpdatedAt: ts };
      }
      if (isRecipient) {
        inbox.Metadata[unreadKey] = (inbox.Metadata[unreadKey] || 0) + 1;
      }
      inbox.Metadata.UpdatedAt = ts;
      inbox.UpdatedAt = ts;

      await docClient.send(new PutCommand({
        TableName: INBOX_TABLE,
        Item: inbox,
      }));
    } else {
      // New inbox
      const otherMapKey = category === 'notification' ? 'Chat' : 'Notification';
      await docClient.send(new PutCommand({
        TableName: INBOX_TABLE,
        Item: {
          Id: userId,
          [mapKey]: {
            [conversationId]: {
              [messageId]: entry,
            },
          },
          [otherMapKey]: {},
          Metadata: {
            UnreadChats: (category === 'chat' && isRecipient) ? 1 : 0,
            UnreadNotifications: (category === 'notification' && isRecipient) ? 1 : 0,
            UpdatedAt: ts,
          },
          CreatedAt: ts,
          UpdatedAt: ts,
        },
      }));
    }

    console.log('[updateInbox] Updated inbox for', userId, 'map:', mapKey, 'isRecipient:', isRecipient);
  } catch (error) {
    console.error('[updateInbox] Error updating inbox for', userId, ':', error);
    throw error;
  }
}

/**
 * Update inbox metadata (unread counts) for a user.
 */
async function updateInboxMetadata(userId, unreadChats, unreadNotifications) {
  const updateParts = ['UpdatedAt = :now'];
  const exprValues = { ':now': now() };
  const exprNames = {};

  if (unreadChats !== undefined) {
    updateParts.push('#meta.#uc = :uc');
    exprValues[':uc'] = unreadChats;
    exprNames['#meta'] = 'Metadata';
    exprNames['#uc'] = 'UnreadChats';
  }

  if (unreadNotifications !== undefined) {
    updateParts.push('#meta.#un = :un');
    exprValues[':un'] = unreadNotifications;
    exprNames['#meta'] = 'Metadata';
    exprNames['#un'] = 'UnreadNotifications';
  }

  try {
    await docClient.send(new UpdateCommand({
      TableName: INBOX_TABLE,
      Key: { Id: userId },
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length > 0 && { ExpressionAttributeNames: exprNames }),
    }));
    console.log('[updateInboxMetadata] Updated for', userId, 'chats:', unreadChats, 'notifs:', unreadNotifications);
  } catch (error) {
    console.error('[updateInboxMetadata] Error:', error);
  }
}

/**
 * Recalculate unread counts from the inbox data.
 * Used after bulk mark/delete operations.
 */
function recalculateUnreadCounts(inboxData) {
  let unreadChats = 0;
  let unreadNotifications = 0;

  // Count unread chats
  if (inboxData.Chat && typeof inboxData.Chat === 'object') {
    for (const messagesMap of Object.values(inboxData.Chat)) {
      if (messagesMap && typeof messagesMap === 'object') {
        for (const entry of Object.values(messagesMap)) {
          if (entry && entry.IsUnread) {
            unreadChats++;
          }
        }
      }
    }
  }

  // Count unread notifications
  if (inboxData.Notification && typeof inboxData.Notification === 'object') {
    for (const messagesMap of Object.values(inboxData.Notification)) {
      if (messagesMap && typeof messagesMap === 'object') {
        // Handle nested structure
        if (messagesMap.IsUnread !== undefined) {
          // Flat/legacy entry
          if (messagesMap.IsUnread) unreadNotifications++;
        } else {
          for (const entry of Object.values(messagesMap)) {
            if (entry && typeof entry === 'object' && entry.IsUnread) {
              unreadNotifications++;
            }
          }
        }
      }
    }
  }

  return { unreadChats, unreadNotifications };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Email Notification Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send email notification for a new chat message.
 */
async function sendChatEmailNotification({ senderId, recipientId, message, vin, senderName, vehicleTitle }) {
  if (!ENABLE_EMAIL_NOTIFICATIONS) {
    return { success: true, skipped: true, reason: 'disabled' };
  }

  try {
    const shouldSend = await shouldSendEmailNotification(recipientId);
    if (!shouldSend) {
      return { success: true, skipped: true, reason: 'user_disabled' };
    }

    const [sender, recipient] = await Promise.all([
      senderId === 'system' ? null : getUserById(senderId),
      getUserById(recipientId),
    ]);

    if (!recipient?.email) {
      return { success: false, error: 'no_recipient_email' };
    }

    let finalVehicleTitle = vehicleTitle;
    let dealId = null;

    if (!finalVehicleTitle && vin) {
      const deal = await getDealByVin(vin);
      if (deal) {
        finalVehicleTitle = deal.vehicleTitle || deal.title || 'a vehicle';
        dealId = deal.id;
      }
    }
    finalVehicleTitle = finalVehicleTitle || 'a vehicle';

    const dealUrl = dealId
      ? `${FRONTEND_URL}/dashboard/deals/${dealId}`
      : `${FRONTEND_URL}/dashboard/active-deals`;

    const recipientName = recipient.name || recipient.Name || 'there';
    const finalSenderName = senderName || sender?.name || sender?.Name || 'A Zoooom user';

    const htmlBody = generateChatEmailHtml({
      recipientName,
      senderName: finalSenderName,
      vehicleTitle: finalVehicleTitle,
      messagePreview: message,
      dealUrl,
    });

    const textBody = generateChatEmailText({
      recipientName,
      senderName: finalSenderName,
      vehicleTitle: finalVehicleTitle,
      messagePreview: message,
      dealUrl,
    });

    const result = await sesClient.send(new SendEmailCommand({
      Source: SES_FROM_EMAIL,
      Destination: { ToAddresses: [recipient.email] },
      Message: {
        Subject: {
          Data: `${finalSenderName} sent you a message about ${finalVehicleTitle}`,
          Charset: 'UTF-8',
        },
        Body: {
          Html: { Data: htmlBody, Charset: 'UTF-8' },
          Text: { Data: textBody, Charset: 'UTF-8' },
        },
      },
    }));

    console.log(`[Email] Sent to ${recipient.email}, MessageId: ${result.MessageId}`);
    return { success: true, messageId: result.MessageId };
  } catch (error) {
    console.error('[Email] Error sending chat notification:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Send email notification for system/platform notifications.
 */
async function sendNotificationEmail({ recipientId, subject, message, eventType, senderName, vehicleTitle, dealUrl, offerAmount, counterAmount }) {
  if (!ENABLE_EMAIL_NOTIFICATIONS) {
    return { success: true, skipped: true, reason: 'disabled' };
  }

  try {
    const shouldSend = await shouldSendEmailNotification(recipientId);
    if (!shouldSend) {
      return { success: true, skipped: true, reason: 'user_disabled' };
    }

    const recipient = await getUserById(recipientId);
    if (!recipient?.email) {
      return { success: false, error: 'no_recipient_email' };
    }

    const recipientName = recipient.name || recipient.Name || 'there';

    // For offer events, use the offer email template
    if (eventType && eventType.startsWith('OFFER_')) {
      const htmlBody = generateOfferEmailHtml({
        recipientName,
        eventType,
        vehicleTitle: vehicleTitle || 'a vehicle',
        offerAmount: offerAmount || 0,
        buyerName: senderName || 'A buyer',
        sellerName: senderName || 'The seller',
        dealUrl: dealUrl || `${FRONTEND_URL}/dashboard/active-deals`,
        counterAmount,
      });

      const textBody = generateOfferEmailText({
        recipientName,
        eventType,
        vehicleTitle: vehicleTitle || 'a vehicle',
        offerAmount: offerAmount || 0,
        buyerName: senderName || 'A buyer',
        sellerName: senderName || 'The seller',
        dealUrl: dealUrl || `${FRONTEND_URL}/dashboard/active-deals`,
        counterAmount,
      });

      const result = await sesClient.send(new SendEmailCommand({
        Source: SES_FROM_EMAIL,
        Destination: { ToAddresses: [recipient.email] },
        Message: {
          Subject: { Data: subject || `Update on your Zoooom deal`, Charset: 'UTF-8' },
          Body: {
            Html: { Data: htmlBody, Charset: 'UTF-8' },
            Text: { Data: textBody, Charset: 'UTF-8' },
          },
        },
      }));

      return { success: true, messageId: result.MessageId };
    }

    // For generic notifications, use the generic email template
    const htmlBody = generateGenericEmailHtml({
      recipientName,
      subject: subject || 'Update from Zoooom',
      body: message,
      ctaUrl: dealUrl || `${FRONTEND_URL}/dashboard/inbox`,
      ctaText: 'View Details',
    });

    const textBody = `Hi ${recipientName},\n\n${message}\n\nView details: ${dealUrl || `${FRONTEND_URL}/dashboard/inbox`}\n\n---\n© Zoooom. All rights reserved.`;

    const result = await sesClient.send(new SendEmailCommand({
      Source: SES_FROM_EMAIL,
      Destination: { ToAddresses: [recipient.email] },
      Message: {
        Subject: { Data: subject || 'Update from Zoooom', Charset: 'UTF-8' },
        Body: {
          Html: { Data: htmlBody, Charset: 'UTF-8' },
          Text: { Data: textBody, Charset: 'UTF-8' },
        },
      },
    }));

    return { success: true, messageId: result.MessageId };
  } catch (error) {
    console.error('[Email] Error sending notification email:', error);
    return { success: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Email Templates
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Chat notification email (HTML)
 */
function generateChatEmailHtml({ recipientName, senderName, vehicleTitle, messagePreview, dealUrl }) {
  const truncatedMessage = messagePreview.length > 150 ? messagePreview.substring(0, 150) + '...' : messagePreview;

  return `<!DOCTYPE html>
<html lang="en" style="margin: 0; padding: 0;">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>New Message on Zoooom</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f5;">
        <tr>
            <td align="center" style="padding: 20px 0;">
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                    <tr>
                        <td style="background-color: #316CFF; padding: 32px 40px; text-align: left;">
                            <img src="https://zoooom.me/ZoooomLogoWhite.png" alt="Zoooom Logo" style="height: 28px; margin-bottom: 16px;" />
                            <h1 style="margin: 0; color: #ffffff; font-size: 24px;">New Message</h1>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 40px; color: #4a5568; background-color: #ffffff;">
                            <p style="margin-top: 0; font-size: 16px; line-height: 1.6;">Hi ${recipientName},</p>
                            <p style="margin: 16px 0; font-size: 16px; line-height: 1.6;">
                                <strong>${senderName}</strong> sent you a message about <strong>${vehicleTitle}</strong>.
                            </p>
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
                                <tr>
                                    <td style="padding: 20px; background-color: #f8fafc; border-left: 4px solid #316CFF; border-radius: 0 8px 8px 0;">
                                        <p style="margin: 0 0 8px 0; font-size: 13px; font-weight: 600; color: #64748b; text-transform: uppercase;">Message Preview</p>
                                        <p style="margin: 0; font-size: 15px; color: #334155; line-height: 1.5;">"${truncatedMessage}"</p>
                                    </td>
                                </tr>
                            </table>
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 32px 0 24px 0;">
                                <tr>
                                    <td align="center">
                                        <a href="${dealUrl}" style="display: inline-block; padding: 16px 32px; background-color: #316CFF; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; border-radius: 8px;">View &amp; Reply</a>
                                    </td>
                                </tr>
                            </table>
                            <p style="margin: 0; font-size: 14px; color: #64748b; text-align: center;">Click the button above to view the full conversation and reply.</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 24px 40px; border-top: 1px solid #e2e8f0; font-size: 13px; color: #718096; background-color: #ffffff;">
                            <p style="margin: 0 0 12px 0;">Have a question? Visit <a href="https://zoooom.me/contact" style="color: #316CFF; text-decoration: none;">Contact Us</a>.</p>
                            <p style="margin: 0 0 12px 0;">13017 Artesia Blvd, D230<br />Cerritos, CA 90703</p>
                            <p style="margin: 0;">&copy; Zoooom. All rights reserved.</p>
                        </td>
                    </tr>
                </table>
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; max-width: 600px;">
                    <tr>
                        <td style="padding: 20px 40px; text-align: center; font-size: 12px; color: #94a3b8;">
                            <p style="margin: 0;">You received this email because you have an active deal on Zoooom.<br />
                            <a href="${FRONTEND_URL}/settings/notifications" style="color: #64748b; text-decoration: underline;">Manage notification preferences</a></p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

/**
 * Chat notification email (plain text)
 */
function generateChatEmailText({ recipientName, senderName, vehicleTitle, messagePreview, dealUrl }) {
  const truncatedMessage = messagePreview.length > 150 ? messagePreview.substring(0, 150) + '...' : messagePreview;

  return `Hi ${recipientName},

${senderName} sent you a message about ${vehicleTitle}.

Message:
"${truncatedMessage}"

View and reply: ${dealUrl}

---
Questions? Visit https://zoooom.me/contact
© Zoooom. All rights reserved.

Manage notification preferences: ${FRONTEND_URL}/settings/notifications`;
}

/**
 * Offer notification email (HTML)
 */
function generateOfferEmailHtml({ recipientName, eventType, vehicleTitle, offerAmount, buyerName, sellerName, dealUrl, counterAmount }) {
  const formattedAmount = formatCurrency(offerAmount);
  const formattedCounter = counterAmount ? formatCurrency(counterAmount) : '';

  let headerText = '';
  let bodyText = '';
  let ctaText = '';

  switch (eventType) {
    case 'OFFER_CREATED':
      headerText = 'New Offer Received!';
      bodyText = `<strong>${buyerName}</strong> submitted an offer of <strong>${formattedAmount}</strong> for your <strong>${vehicleTitle}</strong>.`;
      ctaText = 'View Offer';
      break;
    case 'OFFER_ACCEPTED':
      headerText = 'Offer Accepted!';
      bodyText = `Great news! <strong>${sellerName}</strong> accepted your offer of <strong>${formattedAmount}</strong> for the <strong>${vehicleTitle}</strong>.`;
      ctaText = 'View Deal';
      break;
    case 'OFFER_DECLINED':
      headerText = 'Offer Update';
      bodyText = `<strong>${sellerName}</strong> has declined your offer of <strong>${formattedAmount}</strong> for the <strong>${vehicleTitle}</strong>. You can submit a new offer if you're still interested.`;
      ctaText = 'View Listing';
      break;
    case 'OFFER_COUNTERED':
      headerText = 'Counter Offer Received!';
      bodyText = `<strong>${sellerName}</strong> has countered your offer of <strong>${formattedAmount}</strong> with <strong>${formattedCounter}</strong> for the <strong>${vehicleTitle}</strong>.`;
      ctaText = 'Respond to Counter';
      break;
    default:
      headerText = 'Offer Update';
      bodyText = `There's an update on your offer for <strong>${vehicleTitle}</strong>.`;
      ctaText = 'View Details';
  }

  return `<!DOCTYPE html>
<html lang="en" style="margin: 0; padding: 0;">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${headerText}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f5;">
        <tr>
            <td align="center" style="padding: 20px 0;">
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                    <tr>
                        <td style="background-color: #316CFF; padding: 32px 40px; text-align: left;">
                            <img src="https://zoooom.me/ZoooomLogoWhite.png" alt="Zoooom Logo" style="height: 28px; margin-bottom: 16px;" />
                            <h1 style="margin: 0; color: #ffffff; font-size: 24px;">${headerText}</h1>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 40px; color: #4a5568; background-color: #ffffff;">
                            <p style="margin-top: 0; font-size: 16px; line-height: 1.6;">Hi ${recipientName},</p>
                            <p style="margin: 16px 0; font-size: 16px; line-height: 1.6;">${bodyText}</p>
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0; background-color: #f8fafc; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0;">
                                <tr>
                                    <td style="padding: 20px;">
                                        <p style="margin: 0 0 8px 0; font-size: 14px; color: #64748b;">Vehicle</p>
                                        <p style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #1a202c;">${vehicleTitle}</p>
                                        <p style="margin: 0 0 8px 0; font-size: 14px; color: #64748b;">Offer Amount</p>
                                        <p style="margin: 0; font-size: 24px; font-weight: 700; color: #316CFF;">${formattedAmount}</p>
                                        ${counterAmount ? `
                                        <p style="margin: 16px 0 8px 0; font-size: 14px; color: #64748b;">Counter Amount</p>
                                        <p style="margin: 0; font-size: 24px; font-weight: 700; color: #10b981;">${formattedCounter}</p>
                                        ` : ''}
                                    </td>
                                </tr>
                            </table>
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 32px 0 24px 0;">
                                <tr>
                                    <td align="center">
                                        <a href="${dealUrl}" style="display: inline-block; padding: 16px 32px; background-color: #316CFF; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; border-radius: 8px;">${ctaText}</a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 24px 40px; border-top: 1px solid #e2e8f0; font-size: 13px; color: #718096; background-color: #ffffff;">
                            <p style="margin: 0 0 12px 0;">Have a question? Visit <a href="https://zoooom.me/contact" style="color: #316CFF; text-decoration: none;">Contact Us</a>.</p>
                            <p style="margin: 0 0 12px 0;">13017 Artesia Blvd, D230<br />Cerritos, CA 90703</p>
                            <p style="margin: 0;">&copy; Zoooom. All rights reserved.</p>
                        </td>
                    </tr>
                </table>
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; max-width: 600px;">
                    <tr>
                        <td style="padding: 20px 40px; text-align: center; font-size: 12px; color: #94a3b8;">
                            <p style="margin: 0;">You received this email because you have an active deal on Zoooom.<br />
                            <a href="${FRONTEND_URL}/settings/notifications" style="color: #64748b; text-decoration: underline;">Manage notification preferences</a></p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

/**
 * Offer notification email (plain text)
 */
function generateOfferEmailText({ recipientName, eventType, vehicleTitle, offerAmount, buyerName, sellerName, dealUrl, counterAmount }) {
  const formattedAmount = formatCurrency(offerAmount);
  const formattedCounter = counterAmount ? formatCurrency(counterAmount) : '';

  let text = `Hi ${recipientName},\n\n`;

  switch (eventType) {
    case 'OFFER_CREATED':
      text += `${buyerName} submitted an offer of ${formattedAmount} for your ${vehicleTitle}.\n\n`;
      break;
    case 'OFFER_ACCEPTED':
      text += `Great news! ${sellerName} accepted your offer of ${formattedAmount} for the ${vehicleTitle}.\n\n`;
      break;
    case 'OFFER_DECLINED':
      text += `${sellerName} has declined your offer of ${formattedAmount} for the ${vehicleTitle}. You can submit a new offer if you're still interested.\n\n`;
      break;
    case 'OFFER_COUNTERED':
      text += `${sellerName} has countered your offer of ${formattedAmount} with ${formattedCounter} for the ${vehicleTitle}.\n\n`;
      break;
    default:
      text += `There's an update on your offer for ${vehicleTitle}.\n\n`;
  }

  text += `View details: ${dealUrl}\n\n`;
  text += `---\n`;
  text += `Questions? Visit https://zoooom.me/contact\n`;
  text += `© Zoooom. All rights reserved.\n\n`;
  text += `Manage notification preferences: ${FRONTEND_URL}/settings/notifications`;

  return text;
}

/**
 * Generic notification email (HTML) — for recall, service, invite, account, price change
 */
function generateGenericEmailHtml({ recipientName, subject, body, ctaUrl, ctaText }) {
  return `<!DOCTYPE html>
<html lang="en" style="margin: 0; padding: 0;">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f5;">
        <tr>
            <td align="center" style="padding: 20px 0;">
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                    <tr>
                        <td style="background-color: #316CFF; padding: 32px 40px; text-align: left;">
                            <img src="https://zoooom.me/ZoooomLogoWhite.png" alt="Zoooom Logo" style="height: 28px; margin-bottom: 16px;" />
                            <h1 style="margin: 0; color: #ffffff; font-size: 24px;">${subject}</h1>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 40px; color: #4a5568; background-color: #ffffff;">
                            <p style="margin-top: 0; font-size: 16px; line-height: 1.6;">Hi ${recipientName},</p>
                            <p style="margin: 16px 0; font-size: 16px; line-height: 1.6;">${body}</p>
                            ${ctaUrl ? `
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 32px 0 24px 0;">
                                <tr>
                                    <td align="center">
                                        <a href="${ctaUrl}" style="display: inline-block; padding: 16px 32px; background-color: #316CFF; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; border-radius: 8px;">${ctaText || 'View Details'}</a>
                                    </td>
                                </tr>
                            </table>
                            ` : ''}
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 24px 40px; border-top: 1px solid #e2e8f0; font-size: 13px; color: #718096; background-color: #ffffff;">
                            <p style="margin: 0 0 12px 0;">Have a question? Visit <a href="https://zoooom.me/contact" style="color: #316CFF; text-decoration: none;">Contact Us</a>.</p>
                            <p style="margin: 0 0 12px 0;">13017 Artesia Blvd, D230<br />Cerritos, CA 90703</p>
                            <p style="margin: 0;">&copy; Zoooom. All rights reserved.</p>
                        </td>
                    </tr>
                </table>
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; max-width: 600px;">
                    <tr>
                        <td style="padding: 20px 40px; text-align: center; font-size: 12px; color: #94a3b8;">
                            <p style="margin: 0;">
                            <a href="${FRONTEND_URL}/settings/notifications" style="color: #64748b; text-decoration: underline;">Manage notification preferences</a></p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

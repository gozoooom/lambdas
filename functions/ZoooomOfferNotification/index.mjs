import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { randomUUID } from 'node:crypto';

// Initialize DynamoDB client
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

// Initialize SES client
const sesClient = new SESClient({ region: process.env.AWS_REGION || 'us-west-2' });

// Per-env config (table names, frontend URL) is resolved from the alias qualifier
// at runtime via tableSuffix() / frontendUrl() so a single published version can
// serve staging / prod aliases (and $LATEST = dev). Default is dev when no qualifier
// is present (unqualified test invocations) — fail-safe, never silently writes to prod.
let currentInvokedQualifier; // 'staging' | 'prod' | undefined ($LATEST → dev)

const TABLE_SUFFIX_BY_QUALIFIER = {
  staging: '_staging',
  prod: '_prod'
};
function tableSuffix() {
  return TABLE_SUFFIX_BY_QUALIFIER[currentInvokedQualifier] || '_dev';
}
function dealsTable()       { return `ZoooomDeals${tableSuffix()}`; }
function offersTable()      { return `ZoooomOffers${tableSuffix()}`; }
function invitationsTable() { return `ZoooomBuyerInvitation${tableSuffix()}`; }
function usersTable()       { return `ZoooomUser${tableSuffix()}`; }
function inboxTable()       { return `ZoooomUserInbox${tableSuffix()}`; }
function vehiclesTable()    { return `ZoooomVehicle${tableSuffix()}`; }

const FRONTEND_URL_BY_QUALIFIER = {
  staging: 'https://staging.zoooom.me',
  prod:    'https://zoooom.me'
};
function frontendUrl() {
  return FRONTEND_URL_BY_QUALIFIER[currentInvokedQualifier] || 'https://dev.zoooom.me';
}

function parseQualifierFromArn(arn) {
  if (!arn) return undefined;
  const parts = arn.split(':');
  return parts.length >= 8 ? parts[7] : undefined;
}

// SES sender stays on env var (same address across envs).
const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || 'noreply@zoooom.app';
// Emails are ON by default. Set ENABLE_EMAIL_NOTIFICATIONS=false on $LATEST and
// republish + move aliases to disable in an emergency.
const ENABLE_EMAIL_NOTIFICATIONS = process.env.ENABLE_EMAIL_NOTIFICATIONS !== 'false';

// Shared guidance copy (kept here so every sale email is consistent).
const SAFE_MEETING_GUIDANCE =
  'For your safety, meet in a well-lit, public place — in front of a police station, a city hall, or a busy downtown area — during daylight hours, and consider bringing someone with you. Many police departments offer designated "safe exchange zones" for private vehicle sales.';
const WIRE_TIMING_NOTE =
  'If paying by bank wire, initiate the transfer before 2 PM PT so it can settle the same day (it can take a couple of hours); wires started after 2 PM PT settle the next business day.';

// If the buyer is splitting payment (part cash at handoff + part online),
// describe it for the seller. Returns '' for full-online deals.
function splitNote(deal) {
  if (!deal || !deal.splitPayment || !(deal.cashAmount > 0)) return '';
  const cash = formatCurrency(deal.cashAmount);
  const online = formatCurrency(deal.stripeAmount != null ? deal.stripeAmount : ((deal.acceptedOffer || 0) - (deal.cashAmount || 0)));
  return `Split payment: the buyer is paying ${online} online (card/Klarna) and bringing ${cash} in cash at the handoff. Zoooom's platform fee is included in the online charge.`;
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

// Format currency helper
const formatCurrency = (amount) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
}).format(amount);

// ============================================================================
// User & Notification Helper Functions
// ============================================================================

async function getUserById(userId) {
  if (!userId) return null;
  try {
    // ZoooomUser has a COMPOSITE key (IdUser HASH + email RANGE). We don't know
    // the email up front, so Query by the partition key and take the first row
    // rather than GetItem (which would require both keys).
    const result = await docClient.send(new QueryCommand({
      TableName: usersTable(),
      KeyConditionExpression: 'IdUser = :id',
      ExpressionAttributeValues: { ':id': userId },
      Limit: 1
    }));
    return (result.Items && result.Items[0]) || null;
  } catch (error) {
    console.error('[getUserById] Error:', error);
    return null;
  }
}

// User records store firstName/lastName/email (not name/Name). Normalize.
function userDisplayName(user, fallback) {
  if (!user) return fallback;
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return full || user.name || user.Name || fallback;
}
function userEmail(user) {
  return user?.email || user?.Email || null;
}

async function shouldSendEmailNotification(userId) {
  try {
    const user = await getUserById(userId);
    if (!user) return false;
    const prefs = user.notificationPreferences || user.preferences || {};
    if (prefs.emailNotifications === false || prefs.offerEmailNotifications === false) {
      return false;
    }
    return true;
  } catch (error) {
    console.error('[shouldSendEmailNotification] Error:', error);
    return true;
  }
}

/**
 * Append a notification onto the user's inbox row. Per the shared schema
 * (one row per user, with `messages: [...]` inside), we use UpdateCommand
 * + list_append so multiple notifications stack instead of overwriting.
 * The frontend Inbox page renders entries from `messages`.
 */
async function addInboxNotification({ userId, subject, body, metadata, service }) {
  const notificationId = randomUUID();
  const timestamp = now();

  const newMsg = {
    id: notificationId,
    createdAt: timestamp,
    service: service || 'deal',
    subject,
    body,
    isRead: false,
    metadata: metadata || {}
  };

  try {
    await docClient.send(new UpdateCommand({
      TableName: inboxTable(),
      Key: { Id: userId },
      UpdateExpression:
        'SET messages = list_append(if_not_exists(messages, :empty), :new), UpdatedAt = :now',
      ExpressionAttributeValues: {
        ':new': [newMsg],
        ':empty': [],
        ':now': timestamp
      }
    }));
    console.log('[addInboxNotification] Appended notification for user:', userId);
    return { success: true, notificationId };
  } catch (error) {
    console.error('[addInboxNotification] Error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Generate and send offer notification email
 */
async function sendOfferNotificationEmail({
  recipientEmail,
  recipientName,
  eventType,
  vehicleTitle,
  offerAmount,
  buyerName,
  sellerName,
  note,
  dealUrl,
  counterAmount,
  recipientRole,        // 'seller' | 'buyer' — drives payment-event copy
  amountLabel = 'Offer Amount',
  infoText,             // optional highlighted "what happens next" box (e.g. wire timing)
  ctaTextOverride,      // optional CTA button label override (sale-lifecycle events)
}) {
  const formattedAmount = formatCurrency(offerAmount);
  const formattedCounter = counterAmount ? formatCurrency(counterAmount) : '';

  let subject = '';
  let headerText = '';
  let bodyText = '';
  let ctaText = '';

  switch (eventType) {
    case 'OFFER_CREATED':
      subject = `New offer: ${formattedAmount} for your ${vehicleTitle}`;
      headerText = 'New Offer Received!';
      bodyText = `<strong>${buyerName}</strong> submitted an offer of <strong>${formattedAmount}</strong> for your <strong>${vehicleTitle}</strong>.`;
      ctaText = 'View Offer';
      break;
    case 'OFFER_ACCEPTED':
      subject = `Offer accepted for ${vehicleTitle}!`;
      headerText = 'Offer Accepted!';
      bodyText = `Great news! <strong>${sellerName}</strong> accepted your offer of <strong>${formattedAmount}</strong> for the <strong>${vehicleTitle}</strong>.`;
      ctaText = 'View Deal';
      break;
    case 'OFFER_DECLINED':
      subject = `Offer update for ${vehicleTitle}`;
      headerText = 'Offer Update';
      bodyText = `<strong>${sellerName}</strong> has declined your offer of <strong>${formattedAmount}</strong> for the <strong>${vehicleTitle}</strong>. You can submit a new offer if you're still interested.`;
      ctaText = 'View Listing';
      break;
    case 'OFFER_COUNTERED':
      subject = `Counter offer received for ${vehicleTitle}`;
      headerText = 'Counter Offer Received!';
      bodyText = `<strong>${sellerName}</strong> has countered your offer of <strong>${formattedAmount}</strong> with <strong>${formattedCounter}</strong> for the <strong>${vehicleTitle}</strong>.`;
      ctaText = 'Respond to Counter';
      break;
    case 'PAYMENT_PROCESSING':
      if (recipientRole === 'seller') {
        subject = `Payment on the way for your ${vehicleTitle}`;
        headerText = 'Payment On The Way';
        bodyText = `Good news — the buyer has sent a payment of <strong>${formattedAmount}</strong> for your <strong>${vehicleTitle}</strong>. The funds are now in transit.`;
      } else {
        subject = `We're processing your payment for ${vehicleTitle}`;
        headerText = 'Payment Processing';
        bodyText = `We've received your payment of <strong>${formattedAmount}</strong> for the <strong>${vehicleTitle}</strong> and it's now being processed.`;
      }
      ctaText = 'View Deal';
      break;
    case 'PAYMENT_RECEIVED':
      if (recipientRole === 'seller') {
        subject = `Payment received for your ${vehicleTitle}`;
        headerText = 'Payment Received!';
        bodyText = `The payment of <strong>${formattedAmount}</strong> for your <strong>${vehicleTitle}</strong> has cleared and is confirmed. You're all set to arrange handoff and complete the sale.`;
      } else {
        subject = `Your payment cleared for ${vehicleTitle}`;
        headerText = 'Payment Confirmed!';
        bodyText = `Your payment of <strong>${formattedAmount}</strong> for the <strong>${vehicleTitle}</strong> has cleared. The seller has been notified — congratulations!`;
      }
      ctaText = 'View Deal';
      break;
    case 'PAYMENT_CANNOT_BE_PROCESSED':
      if (recipientRole === 'seller') {
        subject = `Payment couldn't be completed for your ${vehicleTitle}`;
        headerText = 'Payment Could Not Be Completed';
        bodyText = `We couldn't complete the payout for your <strong>${vehicleTitle}</strong>, so the buyer's payment of <strong>${formattedAmount}</strong> was refunded and the sale was not completed. Please review your payout details in Payments so future sales can pay out, and the buyer can try again.`;
      } else {
        subject = `Your payment was refunded for ${vehicleTitle}`;
        headerText = 'Payment Refunded';
        bodyText = `We're sorry — we couldn't complete your purchase of the <strong>${vehicleTitle}</strong>, so your payment of <strong>${formattedAmount}</strong> has been refunded in full. You can try again or contact support if you need help.`;
      }
      ctaText = 'View Deal';
      break;
    case 'PENDING_SALE':
      if (recipientRole === 'seller') {
        subject = `Your ${vehicleTitle} is now pending sale`;
        headerText = 'Pending Sale — Arrange a Safe Handoff';
        bodyText = `You accepted an offer of <strong>${formattedAmount}</strong> for your <strong>${vehicleTitle}</strong>. It's now marked <strong>pending sale</strong>. Coordinate with the buyer on when and where to meet.`;
      } else {
        subject = `Your offer was accepted — next steps for ${vehicleTitle}`;
        headerText = 'Offer Accepted — Arrange a Safe Handoff';
        bodyText = `Your offer of <strong>${formattedAmount}</strong> for the <strong>${vehicleTitle}</strong> was accepted. Coordinate with the seller on when and where to meet, and complete payment.`;
      }
      ctaText = 'View Deal';
      break;
    case 'CONFIRM_SALE_REQUEST':
      subject = `Action needed: confirm your sale of ${vehicleTitle}`;
      headerText = 'Please Confirm the Sale';
      bodyText = recipientRole === 'seller'
        ? `The buyer has confirmed the sale of the <strong>${vehicleTitle}</strong> is complete. Please confirm on your side too.`
        : `The seller has confirmed the sale of the <strong>${vehicleTitle}</strong> is complete. Please confirm on your side too.`;
      ctaText = 'Confirm Sale Complete';
      break;
    case 'SALE_COMPLETED':
    case 'SALE_AUTO_COMPLETED':
      if (recipientRole === 'seller') {
        subject = `Sale complete — ${vehicleTitle}`;
        headerText = 'Sale Complete';
        bodyText = `The sale of your <strong>${vehicleTitle}</strong> for <strong>${formattedAmount}</strong> is complete. The vehicle and its service history have been transferred to the buyer's Garage, and your listing is now marked <strong>Sold</strong>.`;
      } else {
        subject = `It's yours — ${vehicleTitle} transferred to your Garage`;
        headerText = 'Sale Complete';
        bodyText = `The sale of the <strong>${vehicleTitle}</strong> is complete. It's now in your Zoooom Garage, along with its service history. Congratulations!`;
      }
      ctaText = 'View Deal';
      break;
    case 'LISTING_WITHDRAWN':
      subject = `A listing you were interested in was removed`;
      headerText = 'Listing No Longer Available';
      bodyText = `<strong>${sellerName}</strong> removed the listing for <strong>${vehicleTitle}</strong>, so it's no longer available on Zoooom. Plenty of other vehicles are waiting — browse the marketplace to find your next one.`;
      ctaText = 'Browse Marketplace';
      break;
    default:
      subject = `Offer update for ${vehicleTitle}`;
      headerText = 'Offer Update';
      bodyText = `There's an update on your offer for <strong>${vehicleTitle}</strong>.`;
      ctaText = 'View Details';
  }
  if (ctaTextOverride) ctaText = ctaTextOverride;

  const noteSection = note ? `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
      <tr><td style="padding: 20px; background-color: #f8fafc; border-left: 4px solid #316CFF; border-radius: 0 8px 8px 0;">
        <p style="margin: 0 0 8px 0; font-size: 13px; font-weight: 600; color: #64748b; text-transform: uppercase;">Note</p>
        <p style="margin: 0; font-size: 15px; color: #334155; line-height: 1.5;">"${note}"</p>
      </td></tr>
    </table>` : '';

  const infoSection = infoText ? `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
      <tr><td style="padding: 20px; background-color: #eff6ff; border-left: 4px solid #316CFF; border-radius: 0 8px 8px 0;">
        <p style="margin: 0 0 8px 0; font-size: 13px; font-weight: 600; color: #1e40af; text-transform: uppercase;">What happens next</p>
        <div style="font-size: 15px; color: #1e3a5f; line-height: 1.6;">${infoText}</div>
      </td></tr>
    </table>` : '';

  const htmlBody = `<!DOCTYPE html>
<html lang="en" style="margin: 0; padding: 0;">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${headerText}</title></head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f5;">
  <tr><td align="center" style="padding: 20px 0;">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
      <tr><td style="background-color: #316CFF; padding: 32px 40px; text-align: left;">
        <img src="https://zoooom.me/ZoooomLogoWhite.png" alt="Zoooom Logo" style="height: 28px; margin-bottom: 16px;" />
        <h1 style="margin: 0; color: #ffffff; font-size: 24px;">${headerText}</h1>
      </td></tr>
      <tr><td style="padding: 40px; color: #4a5568; background-color: #ffffff;">
        <p style="margin-top: 0; font-size: 16px; line-height: 1.6;">Hi ${recipientName},</p>
        <p style="margin: 16px 0; font-size: 16px; line-height: 1.6;">${bodyText}</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0; background-color: #f8fafc; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0;">
          <tr><td style="padding: 20px;">
            <p style="margin: 0 0 8px 0; font-size: 14px; color: #64748b;">Vehicle</p>
            <p style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #1a202c;">${vehicleTitle}</p>
            <p style="margin: 0 0 8px 0; font-size: 14px; color: #64748b;">${amountLabel}</p>
            <p style="margin: 0; font-size: 24px; font-weight: 700; color: #316CFF;">${formattedAmount}</p>
            ${counterAmount ? `<p style="margin: 16px 0 8px 0; font-size: 14px; color: #64748b;">Counter Amount</p><p style="margin: 0; font-size: 24px; font-weight: 700; color: #10b981;">${formattedCounter}</p>` : ''}
          </td></tr>
        </table>
        ${infoSection}
        ${noteSection}
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 32px 0 24px 0;">
          <tr><td align="center">
            <a href="${dealUrl}" style="display: inline-block; padding: 16px 32px; background-color: #316CFF; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; border-radius: 8px;">${ctaText}</a>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding: 24px 40px; border-top: 1px solid #e2e8f0; font-size: 13px; color: #718096; background-color: #ffffff;">
        <p style="margin: 0 0 12px 0;">Have a question? Visit <a href="https://zoooom.me/contact" style="color: #316CFF; text-decoration: none;">Contact Us</a>.</p>
        <p style="margin: 0 0 12px 0;">13017 Artesia Blvd, D230<br />Cerritos, CA 90703</p>
        <p style="margin: 0;">&copy; Zoooom. All rights reserved.</p>
      </td></tr>
    </table>
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; max-width: 600px;">
      <tr><td style="padding: 20px 40px; text-align: center; font-size: 12px; color: #94a3b8;">
        <p style="margin: 0;">You received this email because you have an active deal on Zoooom.<br />
        <a href="${frontendUrl()}/settings/notifications" style="color: #64748b; text-decoration: underline;">Manage notification preferences</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  const textBody = `Hi ${recipientName},\n\n${bodyText.replace(/<[^>]*>/g, '')}\n\nVehicle: ${vehicleTitle}\n${amountLabel}: ${formattedAmount}${counterAmount ? `\nCounter Amount: ${formattedCounter}` : ''}${infoText ? `\n\nWhat happens next:\n${infoText.replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim()}` : ''}${note ? `\n\nNote: "${note}"` : ''}\n\nView details: ${dealUrl}\n\n---\nQuestions? Visit https://zoooom.me/contact\n© Zoooom. All rights reserved.\n\nManage notification preferences: ${frontendUrl()}/settings/notifications`;

  try {
    const result = await sesClient.send(new SendEmailCommand({
      Source: SES_FROM_EMAIL,
      Destination: { ToAddresses: [recipientEmail] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: htmlBody, Charset: 'UTF-8' },
          Text: { Data: textBody, Charset: 'UTF-8' },
        },
      },
    }));
    console.log(`[sendOfferNotificationEmail] Sent to ${recipientEmail}, MessageId: ${result.MessageId}`);
    return { success: true, messageId: result.MessageId };
  } catch (error) {
    console.error(`[sendOfferNotificationEmail] Error:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Send notifications for offer events (fire and forget)
 */
// Notify buyers (deal participants) that the seller withdrew/removed the
// listing. The delete-vehicle flow dispatches this with the participant list
// (id/name/email) taken from the deal. Inbox + email, per-participant.
async function notifyListingWithdrawn(event) {
  const participants = Array.isArray(event.participants) ? event.participants : [];
  const vehicleTitle = event.vehicleTitle || 'a vehicle';
  const sellerName = event.sellerName || 'The seller';
  const dealUrl = `${frontendUrl()}/marketplace`;
  for (const p of participants) {
    if (!p || !p.id) continue;
    const recipientName = p.name || 'there';
    try {
      await addInboxNotification({
        userId: p.id,
        subject: `Listing removed: ${vehicleTitle}`,
        body: `${sellerName} removed the listing for ${vehicleTitle}. It's no longer available on the marketplace.`,
        metadata: { type: 'listing_withdrawn', dealId: event.dealId, vehicleTitle },
      });
    } catch (e) {
      console.error(`[listing_withdrawn] inbox failed for ${p.id}:`, e);
    }
    if (ENABLE_EMAIL_NOTIFICATIONS && p.email) {
      try {
        if (await shouldSendEmailNotification(p.id)) {
          await sendOfferNotificationEmail({
            recipientEmail: p.email,
            recipientName,
            eventType: 'LISTING_WITHDRAWN',
            vehicleTitle,
            sellerName,
            dealUrl,
          });
        }
      } catch (e) {
        console.error(`[listing_withdrawn] email failed for ${p.id}:`, e);
      }
    }
  }
}

async function notifyOfferEvent({ eventType, offer, deal, originalOffer, counterOffer, buyerName, dealId, paymentAmount, paymentMethodType }) {
  console.log(`[notifyOfferEvent] ${eventType} for offer:`, offer?.id || counterOffer?.id || dealId);

  // ── Payment events (dispatched by ZoooomStripeWebhook) ──────────────────────
  // Notify BOTH parties: the seller (who is waiting on the money — and needs the
  // wire-transfer timing) and the buyer (payment confirmation). The webhook only
  // passes dealId + amount, so resolve the rest from the deal record.
  if (eventType === 'PAYMENT_RECEIVED' || eventType === 'PAYMENT_PROCESSING' || eventType === 'PAYMENT_CANNOT_BE_PROCESSED') {
    await notifyPaymentEvent({ eventType, deal, dealId, paymentAmount, paymentMethodType });
    return;
  }

  try {
    let recipientId, recipientName, recipientEmail;
    let sellerName = '';
    const dealUrl = `${frontendUrl()}/dashboard/deals/${deal.id}`;

    // Get seller info
    const seller = await getUserById(deal.sellerId);
    sellerName = userDisplayName(seller, deal.sellerName || 'Seller');

    if (eventType === 'OFFER_CREATED') {
      // Notify seller about new offer
      recipientId = deal.sellerId;
      recipientName = sellerName;
      recipientEmail = userEmail(seller);
      buyerName = buyerName || offer.bidderName || 'A buyer';

      // Add inbox notification
      await addInboxNotification({
        userId: recipientId,
        subject: `New offer: ${formatCurrency(offer.amount)} for ${deal.vehicleTitle}`,
        body: `${buyerName} submitted an offer of ${formatCurrency(offer.amount)} for your ${deal.vehicleTitle}. Click to view and respond.`,
        metadata: { type: 'offer_created', offerId: offer.id, dealId: deal.id, offerAmount: offer.amount, buyerId: offer.bidderId, buyerName, vehicleTitle: deal.vehicleTitle, dealUrl },
      });

      // Send email
      if (ENABLE_EMAIL_NOTIFICATIONS && recipientEmail && await shouldSendEmailNotification(recipientId)) {
        await sendOfferNotificationEmail({
          recipientEmail, recipientName, eventType, vehicleTitle: deal.vehicleTitle,
          offerAmount: offer.amount, buyerName, sellerName, note: offer.note, dealUrl,
        });
      }
    } else {
      // For accepted/declined/countered, notify the buyer
      const buyer = await getUserById(offer?.bidderId || originalOffer?.bidderId);
      recipientId = offer?.bidderId || originalOffer?.bidderId;
      recipientName = userDisplayName(buyer, offer?.bidderName || originalOffer?.bidderName || 'Buyer');
      recipientEmail = userEmail(buyer);
      buyerName = recipientName;

      let inboxSubject = '';
      let inboxBody = '';

      if (eventType === 'OFFER_ACCEPTED') {
        inboxSubject = `Offer accepted for ${deal.vehicleTitle}!`;
        inboxBody = `Great news! ${sellerName} accepted your offer of ${formatCurrency(offer.amount)} for the ${deal.vehicleTitle}.`;
      } else if (eventType === 'OFFER_DECLINED') {
        inboxSubject = `Offer update for ${deal.vehicleTitle}`;
        inboxBody = `${sellerName} has declined your offer of ${formatCurrency(offer.amount)} for the ${deal.vehicleTitle}. You can submit a new offer if you're still interested.`;
      } else if (eventType === 'OFFER_COUNTERED') {
        inboxSubject = `Counter offer received for ${deal.vehicleTitle}`;
        inboxBody = `${sellerName} has countered your offer of ${formatCurrency(originalOffer.amount)} with ${formatCurrency(counterOffer.amount)} for the ${deal.vehicleTitle}.`;
      }

      // Add inbox notification
      await addInboxNotification({
        userId: recipientId,
        subject: inboxSubject,
        body: inboxBody,
        metadata: {
          type: eventType.toLowerCase(),
          offerId: offer?.id || originalOffer?.id,
          counterOfferId: counterOffer?.id,
          dealId: deal.id,
          offerAmount: offer?.amount || originalOffer?.amount,
          counterAmount: counterOffer?.amount,
          sellerId: deal.sellerId,
          sellerName,
          vehicleTitle: deal.vehicleTitle,
          dealUrl,
        },
      });

      // Send email
      if (ENABLE_EMAIL_NOTIFICATIONS && recipientEmail && await shouldSendEmailNotification(recipientId)) {
        await sendOfferNotificationEmail({
          recipientEmail, recipientName, eventType, vehicleTitle: deal.vehicleTitle,
          offerAmount: offer?.amount || originalOffer?.amount,
          counterAmount: counterOffer?.amount,
          buyerName, sellerName, note: counterOffer?.note, dealUrl,
        });
      }
    }
  } catch (error) {
    console.error('[notifyOfferEvent] Error (non-blocking):', error);
  }
}

/**
 * Payment-event notifications (PAYMENT_PROCESSING / PAYMENT_RECEIVED) dispatched
 * by ZoooomStripeWebhook. Notifies BOTH the seller and the buyer (inbox + email,
 * same template standard as offer events). The seller's copy carries the wire-
 * transfer timing so they know when to expect the funds.
 */
async function notifyPaymentEvent({ eventType, deal, dealId, paymentAmount, paymentMethodType }) {
  try {
    const resolvedDeal = deal || (dealId ? await getDeal(dealId) : null);
    if (!resolvedDeal) {
      console.warn('[notifyPaymentEvent] deal not found:', dealId);
      return;
    }

    const dealUrl = `${frontendUrl()}/dashboard/deals/${resolvedDeal.id}`;
    const vehicleTitle = resolvedDeal.vehicleTitle || 'your vehicle';

    // Stripe amounts arrive in cents; the deal's accepted price is in dollars.
    const amount = resolvedDeal.acceptedOffer != null
      ? resolvedDeal.acceptedOffer
      : (paymentAmount != null ? paymentAmount / 100 : 0);
    const formattedAmount = formatCurrency(amount);

    // Only bank transfers (wires/ACH) carry the "up to one business day" promise.
    const BANK_METHODS = new Set([
      'us_bank_transfer', 'customer_balance', 'ach_debit', 'ach_credit_transfer',
      'us_bank_account', 'sepa_debit', 'bank_transfer'
    ]);
    const isBankTransfer = paymentMethodType ? BANK_METHODS.has(paymentMethodType) : false;

    let sellerTiming, buyerTiming;
    if (eventType === 'PAYMENT_PROCESSING') {
      if (isBankTransfer) {
        sellerTiming = `Bank wire transfers typically clear within one business day — the same business day if the buyer sent it before their bank's cutoff, otherwise the next business day. We'll email you the moment the funds settle and the payment is confirmed.`;
        buyerTiming = `Bank transfers take up to one business day to clear. We'll let you know as soon as your payment settles.`;
      } else {
        sellerTiming = `This usually completes within a few minutes. We'll email you as soon as the payment is confirmed.`;
        buyerTiming = `This usually completes within a few minutes. We'll confirm as soon as it's done.`;
      }
    }

    // Resolve both parties from the deal record.
    const seller = await getUserById(resolvedDeal.sellerId);
    const sellerName = userDisplayName(seller, resolvedDeal.sellerName || 'Seller');
    const sellerEmail = userEmail(seller);

    const buyer = resolvedDeal.buyerId ? await getUserById(resolvedDeal.buyerId) : null;
    const buyerName = userDisplayName(buyer, resolvedDeal.buyerName || 'Buyer');
    const buyerEmail = userEmail(buyer);

    const recipients = [];
    if (resolvedDeal.sellerId) {
      recipients.push({
        role: 'seller', userId: resolvedDeal.sellerId, name: sellerName, email: sellerEmail,
        subject: eventType === 'PAYMENT_CANNOT_BE_PROCESSED'
          ? `Payment couldn't be completed for your ${vehicleTitle}`
          : eventType === 'PAYMENT_RECEIVED'
            ? `Payment received for your ${vehicleTitle}`
            : `Payment on the way for your ${vehicleTitle}`,
        inboxBody: eventType === 'PAYMENT_CANNOT_BE_PROCESSED'
          ? `We couldn't complete the payout for your ${vehicleTitle}, so the buyer's payment of ${formattedAmount} was refunded and the sale was not completed. Please review your payout details in Payments so future sales can pay out.`
          : eventType === 'PAYMENT_RECEIVED'
            ? `The payment of ${formattedAmount} for your ${vehicleTitle} has cleared and is confirmed. You're all set to arrange handoff and complete the sale.`
            : `The buyer has sent a payment of ${formattedAmount} for your ${vehicleTitle}. ${sellerTiming}`,
        infoText: eventType === 'PAYMENT_PROCESSING' ? sellerTiming : undefined,
      });
    }
    if (resolvedDeal.buyerId) {
      recipients.push({
        role: 'buyer', userId: resolvedDeal.buyerId, name: buyerName, email: buyerEmail,
        subject: eventType === 'PAYMENT_CANNOT_BE_PROCESSED'
          ? `Your payment was refunded for ${vehicleTitle}`
          : eventType === 'PAYMENT_RECEIVED'
            ? `Your payment cleared for ${vehicleTitle}`
            : `We're processing your payment for ${vehicleTitle}`,
        inboxBody: eventType === 'PAYMENT_CANNOT_BE_PROCESSED'
          ? `We couldn't complete your purchase of the ${vehicleTitle}, so your payment of ${formattedAmount} has been refunded in full. You can try again or contact support if you need help.`
          : eventType === 'PAYMENT_RECEIVED'
            ? `Your payment of ${formattedAmount} for the ${vehicleTitle} has cleared. The seller has been notified — congratulations!`
            : `We've received your payment of ${formattedAmount} for the ${vehicleTitle} and it's being processed. ${buyerTiming}`,
        infoText: eventType === 'PAYMENT_PROCESSING' ? buyerTiming : undefined,
      });
    }

    const metaType = eventType === 'PAYMENT_CANNOT_BE_PROCESSED' ? 'payment_voided'
      : eventType === 'PAYMENT_RECEIVED' ? 'payment_received' : 'payment_processing';

    for (const r of recipients) {
      await addInboxNotification({
        userId: r.userId,
        subject: r.subject,
        body: r.inboxBody,
        metadata: {
          type: metaType, dealId: resolvedDeal.id, vehicleTitle,
          paymentAmount: amount, paymentMethodType: paymentMethodType || null, dealUrl,
        },
      });

      if (ENABLE_EMAIL_NOTIFICATIONS && r.email && await shouldSendEmailNotification(r.userId)) {
        await sendOfferNotificationEmail({
          recipientEmail: r.email, recipientName: r.name, eventType,
          vehicleTitle, offerAmount: amount, dealUrl,
          recipientRole: r.role, amountLabel: 'Payment Amount', infoText: r.infoText,
        });
      }
    }
  } catch (error) {
    console.error('[notifyPaymentEvent] Error (non-blocking):', error);
  }
}

/**
 * Sale-lifecycle notifications (PENDING_SALE / CONFIRM_SALE_REQUEST /
 * SALE_COMPLETED / SALE_AUTO_COMPLETED) dispatched by ZoooomDealOffer (on accept)
 * and ZoooomSaleComplete. Same template standard. Resolves both parties from the
 * deal; CONFIRM_SALE_REQUEST targets a single role and carries the confirm CTA.
 */
async function notifySaleEvent(payload) {
  try {
    const { eventType, dealId, deal: dealArg, role, confirmUrl, confirmEmailUrl, autoCloseHours = 24 } = payload;
    const deal = dealArg || (dealId ? await getDeal(dealId) : null);
    if (!deal) { console.warn('[notifySaleEvent] deal not found:', dealId); return; }

    const dealUrl = `${frontendUrl()}/dashboard/deals/${deal.id}`;
    const vehicleTitle = deal.vehicleTitle || 'your vehicle';
    const amount = deal.acceptedOffer != null ? deal.acceptedOffer
                 : (deal.acceptedAmount != null ? deal.acceptedAmount : (deal.listedPrice || deal.price || 0));

    const seller = await getUserById(deal.sellerId);
    const buyer  = await getUserById(deal.buyerId);
    const parties = {
      seller: { id: deal.sellerId, name: userDisplayName(seller, deal.sellerName || 'Seller'), email: userEmail(seller) },
      buyer:  { id: deal.buyerId,  name: userDisplayName(buyer,  deal.buyerName  || 'Buyer'),  email: userEmail(buyer) },
    };
    const targets = eventType === 'CONFIRM_SALE_REQUEST' ? [role || 'buyer'] : ['seller', 'buyer'];

    for (const t of targets) {
      const p = parties[t];
      if (!p || !p.id) continue;

      let inboxSubject = '', inboxBody = '', infoText, ctaUrl = dealUrl, ctaTextOverride;
      if (eventType === 'PENDING_SALE') {
        inboxSubject = t === 'seller' ? `Pending sale: ${vehicleTitle}` : `Offer accepted: ${vehicleTitle}`;
        inboxBody = t === 'seller'
          ? `You accepted an offer of ${formatCurrency(amount)} for your ${vehicleTitle}. It's now pending sale — coordinate a safe meeting with the buyer.`
          : `Your offer of ${formatCurrency(amount)} for the ${vehicleTitle} was accepted. Coordinate a safe meeting with the seller and complete payment.`;
        // Render as separate short paragraphs (not one long block) and bold the
        // wire cut-off time so it's unmissable.
        infoText = [splitNote(deal), SAFE_MEETING_GUIDANCE, WIRE_TIMING_NOTE]
          .filter(Boolean)
          .map(t => t.replace(/2 PM PT/g, '<strong>2 PM PT</strong>'))
          .map(t => `<p style="margin: 0 0 12px 0;">${t}</p>`)
          .join('');
      } else if (eventType === 'CONFIRM_SALE_REQUEST') {
        inboxSubject = `Confirm your sale of ${vehicleTitle}`;
        inboxBody = `The other party confirmed the sale of the ${vehicleTitle} is complete. Please confirm too — we'll automatically close this sale as completed in ${autoCloseHours} hours if we don't hear from you.`;
        infoText = `Use the button to confirm. If we don't hear from you within ${autoCloseHours} hours, we'll close this sale as completed automatically.`;
        ctaUrl = confirmEmailUrl || confirmUrl || dealUrl;
        ctaTextOverride = 'Confirm Sale Complete';
      } else { // SALE_COMPLETED / SALE_AUTO_COMPLETED
        inboxSubject = `Sale complete: ${vehicleTitle}`;
        inboxBody = t === 'seller'
          ? `The sale of your ${vehicleTitle} is complete. The vehicle and service history transferred to the buyer; your listing is now marked Sold.`
          : `The sale of the ${vehicleTitle} is complete. It's now in your Garage with its service history. Congratulations!`;
        if (eventType === 'SALE_AUTO_COMPLETED') infoText = 'This sale was closed automatically because the 24-hour confirmation window elapsed.';
      }

      await addInboxNotification({
        userId: p.id, subject: inboxSubject, body: inboxBody,
        metadata: { type: eventType.toLowerCase(), dealId: deal.id, vehicleTitle, dealUrl },
      });

      if (ENABLE_EMAIL_NOTIFICATIONS && p.email && await shouldSendEmailNotification(p.id)) {
        await sendOfferNotificationEmail({
          recipientEmail: p.email, recipientName: p.name, eventType, vehicleTitle,
          offerAmount: amount, dealUrl: ctaUrl, recipientRole: t,
          amountLabel: 'Sale Price', infoText, ctaTextOverride,
        });
      }
    }
  } catch (error) {
    console.error('[notifySaleEvent] Error (non-blocking):', error);
  }
}

// ============================================================================
// Service maintenance reminders (dispatched by ZoooomServiceReminder sweep)
// ============================================================================

// Opt-in gate for service reminders. Reuses the "Service Notifications" category
// (Settings.tsx) — honored on the backend via the user's notificationPreferences:
//   - emailNotifications === false      → global email off
//   - optOutService === true            → the email-link Service opt-out (UnsubscribedPage)
//   - serviceReminderEmails/serviceNotifications === false → granular off
// Defaults to ON (the UI category defaults on and its copy promises reminders).
// Fails CLOSED on lookup error — a new, non-transactional channel shouldn't
// email on uncertainty.
async function shouldSendServiceReminderEmail(userId) {
  try {
    const user = await getUserById(userId);
    if (!user) return false;
    const prefs = user.notificationPreferences || user.preferences || {};
    if (prefs.emailNotifications === false) return false;
    if (prefs.optOutService === true) return false;
    if (prefs.serviceReminderEmails === false || prefs.serviceNotifications === false) return false;
    return true;
  } catch (error) {
    console.error('[shouldSendServiceReminderEmail] Error:', error);
    return false;
  }
}

function serviceReminderEmailHtml({ recipientName, vehicleTitle, serviceLabel, dueDate, dueMileage, currentMileage, daysRemaining, overdue, garageUrl }) {
  const headerText = overdue ? 'Maintenance Overdue' : 'Maintenance Reminder';
  const whenLine = overdue
    ? `Your <strong>${vehicleTitle}</strong> is past due for <strong>${serviceLabel}</strong> (was due ${dueDate}).`
    : (daysRemaining <= 0
        ? `Your <strong>${vehicleTitle}</strong> is due for <strong>${serviceLabel}</strong> today.`
        : `Your <strong>${vehicleTitle}</strong> is coming up for <strong>${serviceLabel}</strong> in about <strong>${daysRemaining} day${daysRemaining === 1 ? '' : 's'}</strong> (around ${dueDate}).`);
  const mileageRow = dueMileage != null
    ? `<p style="margin: 0 0 8px 0; font-size: 14px; color: #64748b;">Estimated due mileage</p>
       <p style="margin: 0; font-size: 20px; font-weight: 700; color: #316CFF;">${Number(dueMileage).toLocaleString()} mi${currentMileage != null ? ` <span style="font-size:13px;font-weight:400;color:#94a3b8;">(now ~${Number(currentMileage).toLocaleString()} mi)</span>` : ''}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en" style="margin: 0; padding: 0;">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${headerText}</title></head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f5;">
  <tr><td align="center" style="padding: 20px 0;">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
      <tr><td style="background-color: ${overdue ? '#dc2626' : '#316CFF'}; padding: 32px 40px; text-align: left;">
        <img src="https://zoooom.me/ZoooomLogoWhite.png" alt="Zoooom Logo" style="height: 28px; margin-bottom: 16px;" />
        <h1 style="margin: 0; color: #ffffff; font-size: 24px;">${headerText}</h1>
      </td></tr>
      <tr><td style="padding: 40px; color: #4a5568; background-color: #ffffff;">
        <p style="margin-top: 0; font-size: 16px; line-height: 1.6;">Hi ${recipientName},</p>
        <p style="margin: 16px 0; font-size: 16px; line-height: 1.6;">${whenLine}</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0; background-color: #f8fafc; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0;">
          <tr><td style="padding: 20px;">
            <p style="margin: 0 0 8px 0; font-size: 14px; color: #64748b;">Service</p>
            <p style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #1a202c;">${serviceLabel}</p>
            ${mileageRow}
          </td></tr>
        </table>
        <p style="margin: 16px 0; font-size: 15px; line-height: 1.6; color: #64748b;">Staying on schedule protects your warranty, resale value, and your Zoooom vehicle report. We estimate this from your uploaded service records and typical mileage — actual timing may vary.</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 32px 0 24px 0;">
          <tr><td align="center">
            <a href="${garageUrl}" style="display: inline-block; padding: 16px 32px; background-color: #316CFF; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; border-radius: 8px;">View Service Schedule</a>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding: 24px 40px; border-top: 1px solid #e2e8f0; font-size: 13px; color: #718096; background-color: #ffffff;">
        <p style="margin: 0 0 12px 0;">Have a question? Visit <a href="https://zoooom.me/contact" style="color: #316CFF; text-decoration: none;">Contact Us</a>.</p>
        <p style="margin: 0 0 12px 0;">13017 Artesia Blvd, D230<br />Cerritos, CA 90703</p>
        <p style="margin: 0;">&copy; Zoooom. All rights reserved.</p>
      </td></tr>
    </table>
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; max-width: 600px;">
      <tr><td style="padding: 20px 40px; text-align: center; font-size: 12px; color: #94a3b8;">
        <p style="margin: 0;">You received this because service reminders are on for your Zoooom account.<br />
        <a href="${frontendUrl()}/settings/notifications" style="color: #64748b; text-decoration: underline;">Manage notification preferences</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendServiceReminderEmail(args) {
  const { recipientEmail, recipientName, vehicleTitle, serviceLabel, dueDate, overdue } = args;
  const subject = overdue
    ? `Overdue: ${serviceLabel} on your ${vehicleTitle}`
    : `Reminder: ${serviceLabel} coming up for your ${vehicleTitle}`;
  const htmlBody = serviceReminderEmailHtml(args);
  const textBody =
    `Hi ${recipientName},\n\n` +
    (overdue
      ? `Your ${vehicleTitle} is past due for ${serviceLabel} (was due ${dueDate}).`
      : `Your ${vehicleTitle} is coming up for ${serviceLabel} (due around ${dueDate}).`) +
    `\n\nView your service schedule: ${args.garageUrl}\n\n---\n© Zoooom. All rights reserved.\n` +
    `Manage notification preferences: ${frontendUrl()}/settings/notifications`;
  try {
    const result = await sesClient.send(new SendEmailCommand({
      Source: SES_FROM_EMAIL,
      Destination: { ToAddresses: [recipientEmail] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: htmlBody, Charset: 'UTF-8' },
          Text: { Data: textBody, Charset: 'UTF-8' },
        },
      },
    }));
    console.log(`[sendServiceReminderEmail] Sent to ${recipientEmail}, MessageId: ${result.MessageId}`);
    return { success: true, messageId: result.MessageId };
  } catch (error) {
    console.error('[sendServiceReminderEmail] Error:', error);
    return { success: false, error: error.message };
  }
}

// Dispatched by the ZoooomServiceReminder daily sweep. Always writes an in-app
// inbox notification; sends the email only when the Service Notifications opt-in
// allows it. Non-blocking.
async function notifyServiceReminder(payload) {
  try {
    const {
      userId, vin, vehicleTitle = 'your vehicle', serviceLabel,
      dueDate, dueMileage, currentMileage, milesRemaining, daysRemaining, basis, overdue,
    } = payload;
    if (!userId || !serviceLabel) { console.warn('[notifyServiceReminder] missing userId/serviceLabel'); return; }

    const user = await getUserById(userId);
    const email = userEmail(user);
    const name = userDisplayName(user, 'there');
    const garageUrl = `${frontendUrl()}/dashboard/garage`;

    const when = overdue
      ? `was due ${dueDate}`
      : (daysRemaining <= 0 ? 'is due today'
         : daysRemaining === 1 ? 'is due tomorrow'
         : `is due in about ${daysRemaining} days (around ${dueDate})`);
    const milesPhrase = (dueMileage != null && milesRemaining != null)
      ? (milesRemaining > 0
          ? ` — about ${Number(milesRemaining).toLocaleString()} miles away (~${Number(dueMileage).toLocaleString()} mi)`
          : ` — about ${Math.abs(Number(milesRemaining)).toLocaleString()} miles past ~${Number(dueMileage).toLocaleString()} mi`)
      : '';

    await addInboxNotification({
      userId,
      service: 'maintenance',
      subject: overdue ? `Overdue: ${serviceLabel}` : `Upcoming: ${serviceLabel}`,
      body: `${serviceLabel} for your ${vehicleTitle} ${when}${milesPhrase}.`,
      metadata: { type: 'service_reminder', vin, serviceLabel, dueDate, dueMileage, basis, garageUrl },
    });

    if (ENABLE_EMAIL_NOTIFICATIONS && email && await shouldSendServiceReminderEmail(userId)) {
      await sendServiceReminderEmail({
        recipientEmail: email, recipientName: name, vehicleTitle, serviceLabel,
        dueDate, dueMileage, currentMileage, daysRemaining, overdue, basis, garageUrl,
      });
    }
  } catch (error) {
    console.error('[notifyServiceReminder] Error (non-blocking):', error);
  }
}

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

async function putDeal(deal) {
  await docClient.send(new PutCommand({
    TableName: dealsTable(),
    Item: deal
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
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: invitationsTable(),
      FilterExpression: 'dealId = :dealId',
      ExpressionAttributeValues: { ':dealId': dealId }
    }));
    return result.Items || [];
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      console.warn(`[getInvitationsByDealId] Table ${invitationsTable()} not found - invitations feature not yet deployed`);
      return [];
    }
    throw error;
  }
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
// Participant Scan Helper
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
    await handleAddParticipant(invitation.dealId, {
      participantId: userId,
      participantName: userName || userEmail || 'Buyer',
      participantEmail: userEmail || invitation.email,
      source: 'INVITATION',
    });

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

  // Return documents from deal record, with PII redaction for non-sellers
  const isSeller = deal.sellerId === userId;
  const PII_FIELDS = ['inspectorName', 'inspectorPhone', 'inspectorEmail', 'inspectorAddress', 'shopName', 'customerName', 'customerContact'];
  const documents = (deal.documents || []).map(doc => {
    if (isSeller || !doc.parsedData) return doc;
    // Redact PII for buyer view
    const redactedParsedData = { ...doc.parsedData };
    PII_FIELDS.forEach(field => delete redactedParsedData[field]);
    return { ...doc, parsedData: redactedParsedData };
  });

  const dealDetail = {
    ...deal,
    role: isSeller ? 'SELLING' : 'BUYING',
    offers: dealOffersList,
    documents,
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
    exteriorColor,
    interiorColor
  } = body;

  console.log('Creating deal from listing:', { listingId, vin, sellerId });

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
    return response(200, { success: true, deal: existingDeal, existing: true });
  }

  // Create new deal - NOTE: buyerId and buyerName are intentionally OMITTED (not set to null)
  // DynamoDB GSIs cannot have null values for indexed attributes
  const deal = {
    id: generateId(),
    listingId,
    vin: vin || '',
    vehicleTitle: vehicleTitle || 'Vehicle',
    thumbnailUrl: thumbnailUrl || '',
    listedPrice: listedPrice || 0,
    mileage: mileage || 0,
    location: location || '',
    exteriorColor: exteriorColor || '',
    interiorColor: interiorColor || '',
    activeOfferCount: 0,
    highestOffer: 0,
    status: 'LISTED',
    sellerId,
    sellerName: sellerName || '',
    // buyerId and buyerName will be added when an offer is accepted
    createdAt: now(),
    updatedAt: now()
  };

  if (vin && sellerId) {
    try {
      const VEHICLES_TABLE = vehiclesTable();

      await docClient.send(new UpdateCommand({
        TableName: VEHICLES_TABLE,
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
  console.log('Created new deal:', deal.id);

  return response(201, { success: true, deal });
}

// POST /offers - Create new offer
async function handleCreateOffer(body) {
  const { dealId, listingId, vin, amount, paymentMethod, note, meetLocation, canPickUpAnyTime, bidderId, bidderName } = body;

  if (!amount || !paymentMethod || !bidderId) {
    return response(400, { error: 'Missing required fields: amount, paymentMethod, bidderId' });
  }

  // Get or create deal
  let deal = dealId ? await getDeal(dealId) : null;
  if (!deal && listingId) {
    // Create deal without buyerId/buyerName (omit, don't set to null)
    deal = {
      id: generateId(),
      listingId,
      vin: vin || '',
      vehicleTitle: body.vehicleTitle || 'Vehicle',
      thumbnailUrl: body.thumbnailUrl || '',
      listedPrice: body.listedPrice || 0,
      exteriorColor: body.exteriorColor || '',
      interiorColor: body.interiorColor || '',
      activeOfferCount: 0,
      highestOffer: 0,
      status: 'NEGOTIATING',
      sellerId: body.sellerId || '',
      sellerName: body.sellerName || '',
      createdAt: now(),
      updatedAt: now()
    };
    await putDeal(deal);
  }

  if (!deal) {
    return response(404, { error: 'Deal not found and no listingId provided to create one' });
  }

  // Create the offer
  const offer = {
    id: generateId(),
    dealId: deal.id,
    bidderId,
    bidderName: bidderName || 'Anonymous',
    amount,
    isHighest: false,
    paymentMethod,
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

  // Send notifications (fire and forget - don't block the response)
  notifyOfferEvent({
    eventType: 'OFFER_CREATED',
    offer,
    deal,
    buyerName: bidderName,
  }).catch(err => console.error('[handleCreateOffer] Notification error:', err));

  return response(201, { success: true, offer, deal });
}

// POST /offers/:offerId/accept - Accept an offer
async function handleAcceptOffer(offerId, body) {
  const { sellerId } = body;

  const offer = await getOffer(offerId);
  if (!offer) {
    return response(404, { error: 'Offer not found' });
  }

  const deal = await getDeal(offer.dealId);
  if (!deal) {
    return response(404, { error: 'Deal not found' });
  }

  if (deal.sellerId !== sellerId) {
    return response(403, { error: 'Only the seller can accept offers' });
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
  deal.updatedAt = acceptedAt;
  await putDeal(deal);

  const updatedOffers = await getOffersByDealId(deal.id);

  // Send notification to buyer (fire and forget)
  notifyOfferEvent({
    eventType: 'OFFER_ACCEPTED',
    offer,
    deal,
  }).catch(err => console.error('[handleAcceptOffer] Notification error:', err));

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

  // Get the deal for notifications
  const deal = await getDeal(originalOffer.dealId);

  // Update original offer status
  originalOffer.status = 'COUNTERED';
  originalOffer.updatedAt = now();
  await putOffer(originalOffer);

  // Create counter offer
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
    createdAt: now()
  };

  await putOffer(counterOffer);

  // Send notification to original bidder (fire and forget)
  if (deal) {
    notifyOfferEvent({
      eventType: 'OFFER_COUNTERED',
      originalOffer,
      counterOffer,
      deal,
    }).catch(err => console.error('[handleCounterOffer] Notification error:', err));
  }

  return response(200, { success: true, offer: counterOffer });
}

// POST /offers/:offerId/decline - Decline an offer
async function handleDeclineOffer(offerId) {
  const offer = await getOffer(offerId);
  if (!offer) {
    return response(404, { error: 'Offer not found' });
  }

  // Get the deal for notifications
  const deal = await getDeal(offer.dealId);

  offer.status = 'DECLINED';
  offer.declinedAt = now();
  offer.updatedAt = now();
  await putOffer(offer);

  // Send notification to buyer (fire and forget)
  if (deal) {
    notifyOfferEvent({
      eventType: 'OFFER_DECLINED',
      offer,
      deal,
    }).catch(err => console.error('[handleDeclineOffer] Notification error:', err));
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

// ============================================================================
// Document Handlers
// ============================================================================

// POST /deals/:dealId/documents — upload a document to a deal
async function handleUploadDocument(dealId, body) {
  const { name, type, s3Key, parsedData, uploadedBy } = body;

  if (!name || !uploadedBy) {
    return response(400, { error: 'name and uploadedBy are required' });
  }

  try {
    const deal = await getDeal(dealId);
    if (!deal) {
      return response(404, { error: 'Deal not found' });
    }

    // Only the seller can upload documents
    if (deal.sellerId !== uploadedBy) {
      return response(403, { error: 'Only the seller can upload documents' });
    }

    const document = {
      id: generateId(),
      name,
      type: type || 'INSPECTION',
      s3Key: s3Key || '',
      parsedData: parsedData || null,
      uploadedAt: now(),
      uploadedBy,
    };

    // Append document to the deal's documents array
    await docClient.send(new UpdateCommand({
      TableName: dealsTable(),
      Key: { id: dealId },
      UpdateExpression: 'SET documents = list_append(if_not_exists(documents, :empty), :newDoc), updatedAt = :now',
      ExpressionAttributeValues: {
        ':empty': [],
        ':newDoc': [document],
        ':now': now(),
      },
    }));

    return response(201, { success: true, document });
  } catch (error) {
    console.error('[handleUploadDocument] Error:', error);
    return response(500, { error: 'Failed to upload document' });
  }
}

// GET /deals/:dealId/documents — get documents for a deal (with PII redaction for buyers)
async function handleGetDocuments(dealId, event) {
  const userId = event.queryStringParameters?.userId;

  try {
    const deal = await getDeal(dealId);
    if (!deal) {
      return response(404, { error: 'Deal not found' });
    }

    const isSeller = deal.sellerId === userId;
    const PII_FIELDS = ['inspectorName', 'inspectorPhone', 'inspectorEmail', 'inspectorAddress', 'shopName', 'customerName', 'customerContact'];
    const documents = (deal.documents || []).map(doc => {
      if (isSeller || !doc.parsedData) return doc;
      const redactedParsedData = { ...doc.parsedData };
      PII_FIELDS.forEach(field => delete redactedParsedData[field]);
      return { ...doc, parsedData: redactedParsedData };
    });

    return response(200, { documents });
  } catch (error) {
    console.error('[handleGetDocuments] Error:', error);
    return response(500, { error: 'Failed to fetch documents' });
  }
}

// ============================================================================
// Main Handler
// ============================================================================

export const handler = async (event, context) => {
  // Capture the alias this invocation came in through. All per-env config (table
  // names, frontend URL) is then resolved on demand via the *Table()/frontendUrl()
  // helpers — so a single published version serves staging/prod/$LATEST(=dev).
  currentInvokedQualifier = parseQualifierFromArn(context?.invokedFunctionArn);

  console.log(
    `[handler] caller qualifier: ${currentInvokedQualifier || '$LATEST'}; ` +
    `tables: ${dealsTable()}, ${offersTable()}, ${usersTable()}, ${inboxTable()}; ` +
    `frontend: ${frontendUrl()}`
  );
  console.log('Deals API received event:', JSON.stringify(event, null, 2));

  // Direct (non-HTTP) invoke: a notification event dispatched by ZoooomDealOffer
  // (offer events) or ZoooomStripeWebhook (payment events). These payloads carry
  // an `eventType` and no HTTP envelope, so route them straight to the notifier
  // instead of the HTTP router (which would 404). This is the ONLY path that
  // actually sends offer/payment emails + inbox notifications in production.
  if (event && event.eventType && !event.httpMethod && !event.requestContext && !event.path && !event.rawPath) {
    const SALE_EVENTS = new Set(['PENDING_SALE', 'CONFIRM_SALE_REQUEST', 'SALE_COMPLETED', 'SALE_AUTO_COMPLETED']);
    if (event.eventType === 'SERVICE_REMINDER') {
      await notifyServiceReminder(event);
    } else if (SALE_EVENTS.has(event.eventType)) {
      await notifySaleEvent(event);
    } else if (event.eventType === 'LISTING_WITHDRAWN') {
      await notifyListingWithdrawn(event);
    } else {
      await notifyOfferEvent(event);
    }
    return { ok: true, eventType: event.eventType };
  }

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

    // --- Document routes ---

    // POST /deals/:dealId/documents — upload a document to a deal
    if (method === 'POST' && pathParts[0] === 'deals' && pathParts[2] === 'documents') {
      return await handleUploadDocument(pathParts[1], body);
    }

    // GET /deals/:dealId/documents — get documents for a deal
    if (method === 'GET' && pathParts[0] === 'deals' && pathParts[2] === 'documents') {
      return await handleGetDocuments(pathParts[1], event);
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
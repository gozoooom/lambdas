/**
 * ZoooomInternalInbox — the inbox that belongs to INTERNAL STAFF.
 *
 * Not to be confused with `ZoooomInternalGetUserInbox`, which despite its name
 * reads the CONSUMER inbox (`ZoooomUserInbox_{env}`) for a customer id passed in
 * the request — i.e. a support view of someone else's mail. That distinction is
 * why this function exists: staff had no inbox of their own anywhere in the
 * account, and no table to put one in.
 *
 * Sources of staff mail:
 *   missed-chat     a support conversation escalated to a human that nobody
 *                   answered. Implemented here.
 *   support-email   mail sent to the Support address (currently a Gmail account,
 *                   not yet connected). The `broadcast` action is the seam it will
 *                   plug into — no Gmail work is done or implied here.
 *
 * WHO GETS IT: every internal user, enumerated from the **Cognito staff pool**
 * for this environment — NOT from `ZoooomInternalUser_{env}`. That table is
 * unreliable as a roster: prod holds 0 rows while the prod staff pool has 2 real
 * users, so broadcasting from the table would silently reach nobody in prod.
 *
 * IDEMPOTENCE: every message carries a deterministic `messageId`
 * (`missed-chat#<conversationId>#<lastUserMsgId>`), and broadcast checks the
 * byMessage index before writing. The sweeper can therefore run on a schedule,
 * be re-run by hand, and be retried by EventBridge without ever double-posting.
 *
 * Env:
 *   INBOX_TABLE            ZoooomInternalUserInbox_{env}
 *   SUPPORT_CHAT_TABLE     ZoooomSupportChat_{env}
 *   STAFF_POOL_ID          Cognito internal-user pool for THIS env
 *   MISSED_AFTER_MINUTES   default 15 — grace period before an unanswered
 *                          escalation counts as missed
 *   LIST_LIMIT             default 50
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { randomUUID } from "crypto";

const REGION = process.env.AWS_REGION || "us-west-2";
const INBOX_TABLE = process.env.INBOX_TABLE || "ZoooomInternalUserInbox_dev";
const CHAT_TABLE = process.env.SUPPORT_CHAT_TABLE || "ZoooomSupportChat_dev";
const STAFF_POOL_ID = process.env.STAFF_POOL_ID || "";
const MISSED_AFTER_MINUTES = Number(process.env.MISSED_AFTER_MINUTES || "15");
const LIST_LIMIT = Number(process.env.LIST_LIMIT || "50");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const idp = new CognitoIdentityProviderClient({ region: REGION });

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

/**
 * The staff member this request belongs to, from the VERIFIED token claim only.
 * The internal API now carries a Cognito authorizer, so a claim is always present
 * for browser traffic; anything without one is refused rather than defaulted,
 * because an inbox keyed off a caller-supplied identity is an inbox anyone can read.
 */
function claims(event) {
  const rc = event.requestContext || {};
  return rc.authorizer?.claims || rc.authorizer?.jwt?.claims || null;
}
function staffFromClaim(event) {
  const c = claims(event);
  const email = c?.email || c?.["cognito:username"] || "";
  return email ? String(email).trim().toLowerCase() : null;
}

/** Roster = the Cognito staff pool. See header for why not ZoooomInternalUser. */
async function allStaff() {
  if (!STAFF_POOL_ID) throw new Error("STAFF_POOL_ID not configured");
  const out = [];
  let token;
  do {
    const r = await idp.send(new ListUsersCommand({
      UserPoolId: STAFF_POOL_ID, Limit: 60, PaginationToken: token,
    }));
    for (const u of r.Users || []) {
      const email = (u.Attributes || []).find((a) => a.Name === "email")?.Value || u.Username;
      // Disabled accounts are former staff — mail to them is noise nobody reads.
      if (email && u.Enabled !== false) out.push(String(email).trim().toLowerCase());
    }
    token = r.PaginationToken;
  } while (token);
  return [...new Set(out)];
}

async function recipientsOf(messageId) {
  const r = await ddb.send(new QueryCommand({
    TableName: INBOX_TABLE, IndexName: "byMessage",
    KeyConditionExpression: "messageId = :m",
    ExpressionAttributeValues: { ":m": messageId },
  }));
  return r.Items || [];
}

/**
 * Fan a message out to every staff inbox. Returns which recipients were newly
 * written so a caller (and the logs) can tell a real delivery from a no-op re-run.
 */
async function broadcast({ subject, body, source, link, messageId, meta, actorId }) {
  const id = messageId || `${source || "system"}#${randomUUID()}`;
  const already = new Set((await recipientsOf(id)).map((i) => i.staffId));
  const createdAt = new Date().toISOString();
  const staff = await allStaff();
  const delivered = [];
  for (const staffId of staff) {
    if (already.has(staffId)) continue;
    await ddb.send(new PutCommand({
      TableName: INBOX_TABLE,
      Item: {
        staffId,
        msgSort: `${createdAt}#${id}`,
        messageId: id,
        source: source || "system",
        subject: subject || "(no subject)",
        body: body || "",
        link: link || undefined,
        isRead: false,
        createdAt,
        createdBy: actorId || "system",
        ...(meta || {}),
      },
      // Belt to byMessage's braces: two concurrent sweeps cannot both write the
      // same (staffId, msgSort) row.
      ConditionExpression: "attribute_not_exists(staffId) AND attribute_not_exists(msgSort)",
    })).catch((e) => {
      if (e.name !== "ConditionalCheckFailedException") throw e;
    });
    delivered.push(staffId);
  }
  return { messageId: id, delivered, skipped: [...already], staffCount: staff.length };
}

/**
 * A conversation is MISSED when the customer asked for a human and no human
 * answered. "assistant" is the AI and does not count as answered — the whole
 * point of an escalation is that the AI was not enough. A human reply is
 * role "agent" (written by the Slack relay).
 */
function isMissed(meta, msgs, nowMs) {
  if (!meta || meta.status !== "escalated") return null;
  const sorted = [...msgs].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const lastUser = [...sorted].reverse().find((m) => m.role === "user");
  if (!lastUser) return null;
  const answered = sorted.some((m) => m.role === "agent" && String(m.createdAt) > String(lastUser.createdAt));
  if (answered) return null;
  const waitedMs = nowMs - Date.parse(lastUser.createdAt || "");
  if (!(waitedMs >= MISSED_AFTER_MINUTES * 60000)) return null;
  return { lastUser, waitedMinutes: Math.floor(waitedMs / 60000) };
}

async function sweepMissedChats(actorId) {
  const metas = [];
  let key;
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: CHAT_TABLE,
      FilterExpression: "sk = :meta AND #s = :esc",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":meta": "META", ":esc": "escalated" },
      ExclusiveStartKey: key,
    }));
    metas.push(...(r.Items || []));
    key = r.LastEvaluatedKey;
  } while (key);

  const now = Date.now();
  const results = [];
  for (const meta of metas) {
    const msgsRes = await ddb.send(new QueryCommand({
      TableName: CHAT_TABLE,
      KeyConditionExpression: "conversationId = :c AND begins_with(sk, :p)",
      ExpressionAttributeValues: { ":c": meta.conversationId, ":p": "MSG#" },
    }));
    const missed = isMissed(meta, msgsRes.Items || [], now);
    if (!missed) continue;
    const who = meta.userName || meta.userEmail || meta.userId || "a visitor";
    const r = await broadcast({
      source: "missed-chat",
      // Deterministic: same conversation + same unanswered message => same id,
      // so this is safe to run every few minutes forever.
      messageId: `missed-chat#${meta.conversationId}#${missed.lastUser.msgId}`,
      subject: `Missed support chat from ${who}`,
      body: `${missed.lastUser.text || "(no text)"}\n\nWaiting ${missed.waitedMinutes} min with no human reply. App: ${meta.app || "?"}.`,
      meta: {
        conversationId: meta.conversationId,
        customerEmail: meta.userEmail || "",
        customerName: meta.userName || "",
        app: meta.app || "",
        waitedMinutes: missed.waitedMinutes,
      },
      actorId,
    });
    results.push({ conversationId: meta.conversationId, ...r });
  }
  return { escalatedScanned: metas.length, missedFound: results.length, results };
}

export const handler = async (event = {}) => {
  // Direct invoke (EventBridge / another lambda): no HTTP envelope, no claim.
  if (!event.httpMethod && !event.requestContext) {
    if (event.action === "sweepMissedChats" || !event.action) return await sweepMissedChats("system");
    if (event.action === "broadcast") return await broadcast({ ...event, actorId: event.actorId || "system" });
    return { ok: false, error: `unknown action '${event.action}'` };
  }

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const staffId = staffFromClaim(event);
  if (!staffId) {
    return reply(401, { success: false, error: "no verified staff identity on this request" });
  }

  try {
    if (event.httpMethod === "GET") {
      const r = await ddb.send(new QueryCommand({
        TableName: INBOX_TABLE,
        KeyConditionExpression: "staffId = :s",
        ExpressionAttributeValues: { ":s": staffId },
        ScanIndexForward: false, // newest first
        Limit: LIST_LIMIT,
      }));
      const items = r.Items || [];
      return reply(200, {
        success: true,
        staffId,
        unreadCount: items.filter((i) => !i.isRead).length,
        count: items.length,
        messages: items,
      });
    }

    if (event.httpMethod === "POST") {
      const b = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
      const action = b.action;

      if (action === "markRead" || action === "markUnread") {
        if (!b.messageId) return reply(400, { success: false, error: "messageId required" });
        // Only ever touch THIS staff member's copy — one person reading their mail
        // must not clear it from everyone else's inbox.
        const mine = (await recipientsOf(b.messageId)).filter((i) => i.staffId === staffId);
        if (!mine.length) return reply(404, { success: false, error: "message not in your inbox" });
        const isRead = action === "markRead";
        for (const it of mine) {
          await ddb.send(new UpdateCommand({
            TableName: INBOX_TABLE,
            Key: { staffId, msgSort: it.msgSort },
            UpdateExpression: "SET isRead = :r, readAt = :t, updatedBy = :u, updatedAt = :t",
            ExpressionAttributeValues: { ":r": isRead, ":t": new Date().toISOString(), ":u": staffId },
          }));
        }
        return reply(200, { success: true, messageId: b.messageId, isRead });
      }

      if (action === "broadcast") {
        if (!b.subject && !b.body) return reply(400, { success: false, error: "subject or body required" });
        const r = await broadcast({ ...b, actorId: staffId });
        return reply(200, { success: true, ...r });
      }

      if (action === "sweepMissedChats") {
        return reply(200, { success: true, ...(await sweepMissedChats(staffId)) });
      }

      return reply(400, { success: false, error: `unknown action '${action}'` });
    }

    return reply(405, { success: false, error: "method not allowed" });
  } catch (e) {
    console.error("[internalInbox] failed:", e);
    return reply(500, { success: false, error: e.message });
  }
};

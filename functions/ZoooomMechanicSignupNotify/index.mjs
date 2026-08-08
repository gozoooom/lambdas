/**
 * ZoooomMechanicSignupNotify — tells #new-mechanics the moment a shop signs up.
 *
 * TRIGGER  DynamoDB stream (INSERT only) on ZoooomMechanicUser_{dev,staging,prod}.
 *
 * WHY THE STREAM AND NOT THE SIGNUP LAMBDA: two different lambdas write that
 * table — ZoooomAddMechanicUser (legacy shop) and ZoooomAddMasterMechanicUser
 * (master-mechanic system) — and both are live, under active development, and
 * on the parity allow-list. Editing either to bolt on a Slack call means two
 * code changes, six alias promotions, and a chance of breaking a working signup
 * path for the sake of a notification. The stream sits behind ALL of them: any
 * present or future write to the user table gets announced, and a Slack outage
 * can never fail a mechanic's signup.
 *
 * ONE FUNCTION, ALL THREE ENVS. The environment is read from the stream ARN
 * (…/table/ZoooomMechanicUser_prod/stream/…), not from a per-alias env var, so
 * there is no per-env code or version to keep in sync and no way for the wrong
 * table to resolve to the wrong channel. Same spirit as ZoooomServiceReminder's
 * qualifier-based resolution.
 *
 * PROD IS THE ONLY ENV WITH A CHANNEL. dev and staging carry e2e signups; a
 * test account landing in #new-mechanics trains the team to ignore the channel.
 * With no channel configured for an env this renders to CloudWatch instead —
 * the same fail-quiet rule as ZoooomListingReview, so a missing variable can
 * never post to the wrong place.
 *
 * Env:
 *   MECHANIC_SIGNUP_CHANNEL_PROD      Slack channel ID for prod signups.
 *   MECHANIC_SIGNUP_CHANNEL_STAGING   empty => log only.
 *   MECHANIC_SIGNUP_CHANNEL_DEV       empty => log only.
 *   SLACK_SECRET_ID                   default zoooom/slack/support-bot.
 *   MECHANIC_DASHBOARD_URL            optional; adds an "open" link per signup.
 *
 * Manual invokes:
 *   {dryRun:true}            render the last-seen shape to logs, post nothing
 *   {env:"prod", testPost:true}  send one clearly-labelled test line
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const REGION = process.env.AWS_REGION || "us-west-2";
const SLACK_SECRET_ID = process.env.SLACK_SECRET_ID || "zoooom/slack/support-bot";
const DASHBOARD_URL = process.env.MECHANIC_DASHBOARD_URL || "";

const CHANNEL_BY_ENV = {
  prod: process.env.MECHANIC_SIGNUP_CHANNEL_PROD || "",
  staging: process.env.MECHANIC_SIGNUP_CHANNEL_STAGING || "",
  dev: process.env.MECHANIC_SIGNUP_CHANNEL_DEV || "",
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sm = new SecretsManagerClient({ region: REGION });

const USER_TABLE = (env) => `ZoooomMechanicUser_${env}`;
const JUNCTION_TABLE = (env) => `ZoooomMechanicUserShop_${env}`;
const MASTER_TABLE = (env) => `ZoooomMasterMechanic_${env}`;
const LEGACY_TABLE = (env) => `ZoooomMechanic_${env}`;

/** arn:…:table/ZoooomMechanicUser_prod/stream/… -> "prod". */
function envFromStreamArn(arn) {
  const m = /table\/ZoooomMechanicUser_(dev|staging|prod)\//.exec(arn || "");
  return m ? m[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Slack ────────────────────────────────────────────────────────────────────
let cachedToken = null;
async function slackToken() {
  if (cachedToken) return cachedToken;
  const sec = await sm.send(new GetSecretValueCommand({ SecretId: SLACK_SECRET_ID }));
  cachedToken = JSON.parse(sec.SecretString || "{}").botToken || null;
  return cachedToken;
}

async function postSlack(channel, text) {
  if (!channel) {
    console.warn("[mechanicSignup] no channel for this env — not posting. Would have sent:\n" + text);
    return { ok: false, reason: "no_channel" };
  }
  const token = await slackToken();
  if (!token) {
    console.warn("[mechanicSignup] no Slack botToken — skipping");
    return { ok: false, reason: "no_token" };
  }
  // One retry: a stream record that fails to post is gone for good (we never
  // throw, see handler), so the cheap retry is worth more than it costs.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ channel, text, unfurl_links: false }),
      });
      const j = await r.json();
      if (j.ok) return j;
      console.warn(`[mechanicSignup] Slack post failed (attempt ${attempt}):`, j.error);
      // Bad token/channel won't fix itself on a retry.
      if (["invalid_auth", "not_in_channel", "channel_not_found", "token_revoked"].includes(j.error)) return j;
    } catch (e) {
      console.warn(`[mechanicSignup] Slack post threw (attempt ${attempt}):`, e.message);
    }
    if (attempt === 1) await sleep(700);
  }
  return { ok: false, reason: "post_failed" };
}

// ── Rendering ────────────────────────────────────────────────────────────────
const clean = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

function displayName(u) {
  const name = clean(u.name) || `${clean(u.firstName)} ${clean(u.lastName)}`.trim();
  return name || clean(u.email) || "unnamed";
}

function locationLine(u, shop) {
  const city = clean(u.city) || clean(shop?.city) || clean(shop?.mechanicCity);
  const state = clean(u.state) || clean(shop?.state) || clean(shop?.mechanicState);
  const zip = clean(u.zipCode) || clean(shop?.mechanicZip);
  return [city, state].filter(Boolean).join(", ") + (zip ? ` ${zip}` : "");
}

/**
 * A mechanic who signs up and then waits for the shop owner to approve them is
 * NOT a new shop — surfacing them identically would inflate the number the team
 * reads off this channel. So the role/status line says which one it is.
 */
function roleLine(link) {
  if (!link) return "_no shop linked yet_";
  const role = clean(link.role) || "member";
  const status = clean(link.status) || "active";
  if (status === "pending") return `${role} — *pending owner approval* (joining an existing shop)`;
  if (role === "owner") return `${role} — first user of this shop`;
  return `${role} — ${status}`;
}

function render(env, u, shop, link) {
  const marketing = u.initialMarketingConsent === true ? "yes" : u.initialMarketingConsent === false ? "no" : "—";
  const lines = [
    `:wrench: *New mechanic signup* — ${displayName(u)}`,
    `• Shop: *${clean(u.shopName) || clean(shop?.name) || clean(shop?.shopName) || clean(shop?.mechanicName) || "not given"}*`,
    `• Role: ${roleLine(link)}`,
  ];
  const where = locationLine(u, shop);
  if (where) lines.push(`• Where: ${where}`);
  const contact = [clean(u.email), clean(u.phone) || clean(u.phoneNumber)].filter(Boolean).join(" · ");
  if (contact) lines.push(`• Contact: ${contact}`);
  lines.push(`• Source: ${clean(u.consentSource) || "unknown"} · marketing opt-in: ${marketing}`);
  if (DASHBOARD_URL && u.pk) lines.push(`• <${DASHBOARD_URL}?userId=${encodeURIComponent(u.pk)}|open in dashboard>`);
  if (env !== "prod") lines.push(`_(${env})_`);
  return lines.join("\n");
}

// ── Enrichment ───────────────────────────────────────────────────────────────
/**
 * The shop link is written by a SECOND request right after the user record, so
 * at stream time it usually isn't there yet. One short wait-and-retry turns
 * "no shop linked yet" into the actual role for the common case; we never block
 * the alert on it.
 */
async function findShopLink(env, userId) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // userId is the junction table's own partition key — no GSI needed, and a
      // consistent read so a link written milliseconds ago is actually visible.
      const r = await ddb.send(new QueryCommand({
        TableName: JUNCTION_TABLE(env),
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId },
        ConsistentRead: true,
      }));
      const items = r.Items || [];
      if (items.length) return items.find((i) => i.status === "active") || items[0];
    } catch (e) {
      console.warn("[mechanicSignup] shop-link lookup failed:", e.message);
      return null;
    }
    if (attempt === 1) await sleep(2500);
  }
  return null;
}

async function findShop(env, u, link) {
  const masterId = clean(u.masterMechanicId) || clean(link?.masterMechanicId) || clean(link?.mechanicId);
  if (masterId) {
    try {
      const r = await ddb.send(new GetCommand({ TableName: MASTER_TABLE(env), Key: { masterMechanicId: masterId } }));
      if (r.Item) return r.Item;
    } catch (e) {
      console.warn("[mechanicSignup] master-shop lookup failed:", e.message);
    }
  }
  const legacyId = clean(u.idMechanic);
  if (legacyId) {
    try {
      const r = await ddb.send(new GetCommand({ TableName: LEGACY_TABLE(env), Key: { idMechanic: legacyId } }));
      if (r.Item) return r.Item;
    } catch (e) {
      console.warn("[mechanicSignup] legacy-shop lookup failed:", e.message);
    }
  }
  return null;
}

/**
 * Streams retry a failed batch, and the record they hand back the second time
 * still looks brand new — so "have we already announced this one?" has to be
 * asked of the table, not of the record. The marker also makes a duplicate
 * signup row visibly distinct from a redelivery in the logs.
 */
async function alreadyAnnounced(env, userId) {
  try {
    const r = await ddb.send(new GetCommand({
      TableName: USER_TABLE(env),
      Key: { pk: userId },
      ProjectionExpression: "slackSignupTs",
    }));
    return !!r.Item?.slackSignupTs;
  } catch (e) {
    console.warn("[mechanicSignup] announce-marker read failed:", e.message);
    return false; // Better a possible duplicate than a silently dropped signup.
  }
}

async function markAnnounced(env, userId, ts) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: USER_TABLE(env),
      Key: { pk: userId },
      UpdateExpression: "SET slackSignupTs = :t",
      ExpressionAttributeValues: { ":t": ts || new Date().toISOString() },
    }));
  } catch (e) {
    console.warn("[mechanicSignup] could not write announce marker:", e.message);
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────
export const handler = async (event = {}) => {
  // Manual: one labelled test line, so wiring can be proved without a real signup.
  if (event.testPost) {
    const env = event.env || "prod";
    const res = await postSlack(CHANNEL_BY_ENV[env], `:test_tube: *ZoooomMechanicSignupNotify* wiring test (${env}) — ignore. Real signups will look like the message format below.`);
    return { ok: !!res.ok, mode: "testPost", env, error: res.error || res.reason };
  }

  const records = Array.isArray(event.Records)
    ? event.Records.filter((r) => r.eventSource === "aws:dynamodb")
    : [];
  if (!records.length) return { ok: true, mode: "noop", reason: "no dynamodb records" };

  let posted = 0;
  let skipped = 0;
  for (const rec of records) {
    // Never throw: an exception fails the whole batch and DynamoDB will replay
    // it, wedging the shard behind one bad record.
    try {
      if (rec.eventName !== "INSERT") { skipped++; continue; }
      const env = envFromStreamArn(rec.eventSourceARN);
      if (!env) {
        console.warn("[mechanicSignup] unrecognised stream ARN, skipping:", rec.eventSourceARN);
        skipped++;
        continue;
      }
      const u = rec.dynamodb?.NewImage ? unmarshall(rec.dynamodb.NewImage) : null;
      if (!u?.pk) { skipped++; continue; }

      const channel = CHANNEL_BY_ENV[env];
      if (event.dryRun) {
        console.log(`[mechanicSignup] dryRun ${env}:\n` + render(env, u, null, null));
        skipped++;
        continue;
      }
      if (channel && (await alreadyAnnounced(env, u.pk))) {
        console.log(`[mechanicSignup] ${env} ${u.pk} already announced — skipping redelivery`);
        skipped++;
        continue;
      }

      const link = await findShopLink(env, u.pk);
      const shop = await findShop(env, u, link);
      const text = render(env, u, shop, link);

      const res = await postSlack(channel, text);
      if (res.ok) {
        posted++;
        await markAnnounced(env, u.pk, res.ts);
      }
    } catch (e) {
      console.error("[mechanicSignup] record failed (not retrying the batch):", e);
      skipped++;
    }
  }
  return { ok: true, mode: "alert", seen: records.length, posted, skipped };
};

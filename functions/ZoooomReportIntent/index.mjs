/**
 * ZoooomReportIntent — first-report intent capture (own-DB analytics sink).
 *
 * POST /report-intent  (API Gateway proxy integration, ZoooomAPI-{env})
 * Body: { vin, intent, timeframe, completed, dismissedAtStep, deviceId, loggedIn }
 *
 * Append-only event log for top-of-funnel segmentation: what brought a viewer to a
 * Verified Report (buying / selling / own / curious) and how soon they're moving.
 * Anonymous-friendly — deviceId carries logged-out viewers; Cognito claims (when the
 * request is authenticated) attach userId/email. Fires alongside the client pixel
 * layer (GTM + Mixpanel); this is the queryable raw store.
 *
 * Table (ZoooomReportIntent_{env}):
 *   vin (HASH)  ·  sk = "<capturedAt>#<uuid>" (RANGE)  ·  GSI DeviceIndex(deviceId, capturedAt)
 *
 * Env resolution mirrors the report stack: explicit REPORT_INTENT_TABLE per version,
 * else derive the suffix from the invoked alias qualifier (Dev/Staging/Prod), else _dev.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const REGION = process.env.REGION || "us-west-2";
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const INTENTS = new Set(["buying", "selling", "own", "curious"]);
const TIMEFRAMES = new Set(["this_week", "this_month", "researching"]);

/** Resolve the per-env table name from env var, else the invoked alias qualifier. */
function resolveTable(context) {
  if (process.env.REPORT_INTENT_TABLE) return process.env.REPORT_INTENT_TABLE;
  const arn = context?.invokedFunctionArn || "";
  const qualifier = arn.split(":").pop() || "";
  const suffix = /staging/i.test(qualifier)
    ? "_staging"
    : /prod/i.test(qualifier)
    ? "_prod"
    : "_dev";
  return `ZoooomReportIntent${suffix}`;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Content-Type": "application/json",
};

const reply = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

/** Clamp a free-text field so junk/oversized values can't bloat the table. */
const str = (v, max = 120) => (typeof v === "string" ? v.slice(0, max) : undefined);

/**
 * Best-effort identity for attribution. The route is auth NONE (like the sibling
 * report/inspection routes), so there's no authorizer.claims — decode the forwarded
 * id token's payload. NOT signature-verified: analytics attribution only, never a
 * security decision. Returns {} when no/garbled token.
 */
function identityFromEvent(event) {
  const claims = event?.requestContext?.authorizer?.claims;
  if (claims?.sub) return { userId: claims.sub, email: claims.email || null };
  const h = event?.headers || {};
  const raw = h.Authorization || h.authorization || "";
  const jwt = raw.replace(/^Bearer\s+/i, "").trim();
  const parts = jwt.split(".");
  if (parts.length !== 3) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return { userId: payload.sub || null, email: payload.email || null };
  } catch {
    return {};
  }
}

export const handler = async (event, context) => {
  // CORS preflight (harmless even behind a same-origin proxy).
  if (event?.httpMethod === "OPTIONS" || event?.requestContext?.http?.method === "OPTIONS") {
    return reply(200, { ok: true });
  }

  let body = {};
  try {
    body = typeof event?.body === "string" ? JSON.parse(event.body) : event?.body || {};
  } catch {
    return reply(400, { error: "invalid JSON body" });
  }

  const vinRaw = str(body.vin, 20);
  const vin = vinRaw ? vinRaw.toUpperCase().trim() : null;
  if (!vin) return reply(400, { error: "vin required" });

  const intent = INTENTS.has(body.intent) ? body.intent : null;
  const timeframe = TIMEFRAMES.has(body.timeframe) ? body.timeframe : null;

  // Best-effort identity (unverified JWT payload — analytics attribution only).
  const { userId = null, email = null } = identityFromEvent(event);

  const capturedAt = new Date().toISOString();
  const item = {
    vin,
    sk: `${capturedAt}#${randomUUID()}`,
    capturedAt,
    intent,
    timeframe,
    completed: body.completed === true,
    dismissedAtStep: Number.isFinite(body.dismissedAtStep) ? body.dismissedAtStep : undefined,
    deviceId: str(body.deviceId, 80) || "anon",
    loggedIn: body.loggedIn === true || !!userId,
    userId: userId || undefined,
    email: email || undefined,
    source: str(body.source, 40) || "report",
  };

  const TableName = resolveTable(context);
  try {
    await docClient.send(new PutCommand({ TableName, Item: item }));
  } catch (e) {
    console.error("[ZoooomReportIntent] put failed:", e?.message, "table:", TableName);
    return reply(500, { error: "could not record intent" });
  }

  return reply(200, { ok: true });
};

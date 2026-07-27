/**
 * ZoooomVehicleReport — assembles a Verified Vehicle Report for a VIN.
 * Composes Vehicle Databases (title/sales/stolen) + FEMA flood + NHTSA known issues +
 * state/transfer rules into the summary.js shape. Caches by VIN.
 *
 * Access (the growth funnel):
 *   - Logged-out / no entitlement  → a redacted PREVIEW (score + per-category status),
 *     `locked:true` + a "create free account" CTA.
 *   - Logged-in + entitlement granted (free promo until Oct 1 2026) → the FULL report.
 *   Login is the gate; the promo grants every logged-in caller with no Stripe path reached.
 *   Flip-to-paid later = a write to ZoooomFeatureConfig (no deploy).
 *
 * GET /vehicles/{vin}/report          (vin in pathParameters)
 *   optional query overrides: state, year, make, model (used if sales history lacks them)
 *
 * Env: VEHICLE_DB_API_KEY (same credential as ZoooomVINDecodeVDB), VD_API_BASE_URL,
 *      REPORTS_TABLE (optional cache), FEATURE_CONFIG_TABLE (optional; free-default if unset),
 *      REPORT_TTL_DAYS, REGION
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { getSalesHistory, latestLocation } from "./vehicleDatabasesClient.mjs";
import { getTitleCheckCached } from "./titleCheckCache.mjs";
// Theft signal lives in its own lambda (new license key + centralized monthly cache).
import { getStolenCheck } from "./stolenCheckClient.mjs";
import { assessFlood } from "./femaFlood.mjs";
import { getKnownIssues } from "./knownIssues.mjs";
import { buildSummary } from "./summary.mjs";
import { loadFeatureConfig, resolveEntitlement } from "./entitlement.mjs";
import {
  checkAndReserveReport,
  listUserReports,
  getReportCredits,
  grantReportCredits,
  spendReportCredit,
  releaseReport,
} from "./usage.mjs";
import { createCheckoutSession, retrieveCheckoutSession, stripeConfigured } from "./stripeCheckout.mjs";
import { redactToPreview } from "./preview.mjs";
import { monthlyMarketValue } from "./marketValue.mjs";
import { getOwnerOdometer } from "./ownerOdometer.mjs";
import { buildTaxTable } from "./taxRules.mjs";

const REGION = process.env.REGION || "us-west-2";
const REPORTS_TABLE = process.env.REPORTS_TABLE || null; // e.g. ZoooomVehicleReports_dev
const FEATURE_CONFIG_TABLE = process.env.FEATURE_CONFIG_TABLE || null; // e.g. ZoooomFeatureConfig_dev
const INSPECTIONS_TABLE = process.env.INSPECTIONS_TABLE || null; // e.g. ZoooomVehicleInspections_dev (AI walkaround)
const MARKET_VALUE_TABLE = process.env.MARKET_VALUE_TABLE || null; // e.g. ZoooomMarketValue_dev (per-VIN, history)
const REPORT_USAGE_TABLE = process.env.REPORT_USAGE_TABLE || null; // e.g. ZoooomReportUsage_dev (free-report cap + fraud guard)
const SERVICE_RECORDS_TABLE = process.env.SERVICE_RECORDS_TABLE || null; // e.g. ZoooomServiceRecord_dev (user-uploaded service records, keyed by vehicleId=VIN)
// CROSS-ENV (no _dev/_prod suffix — one VIN, all envs share), same as ZoooomStolenChecks.
// Caches the slow/variable VD title-check so it stops aborting on the 20s budget.
const TITLE_CHECKS_TABLE = process.env.TITLE_CHECKS_TABLE || null; // e.g. ZoooomTitleChecks
// VDB advanced-decode MMYT catalog (cross-env, no suffix). SK="VEHICLE" holds
// VDB's NORMALIZED powertrain in data.fuel_type (Gas|Hybrid|Electric|Plug-in
// Hybrid) — authoritative over NHTSA and over the raw specifications.fuel.type
// (which reads "Gasoline" even for a hybrid). Keyed by the decoded make/year/
// model/trim so powertrain stays consistent with the identity we display.
const MMYT_SPEC_TABLE = process.env.MMYT_SPEC_TABLE || "ZoooomMMYTSpec";
// Once-per-month generation gate (requirement): a fresh report (and a fresh market-value
// pull) for the same VIN happens at most every REGEN_DAYS. In between, the stored report
// (kept in REPORTS_TABLE with its generatedAt timestamp) is served.
const REGEN_DAYS = Number(process.env.REPORT_REGEN_DAYS || "30");
// Garage/listing rows — the odometer the OWNER entered when they added or listed
// the car. Read-only here; it's what the Market Value section prices against.
const VEHICLE_TABLE = process.env.VEHICLE_TABLE || null; // e.g. ZoooomVehicle_dev

const docClient = (REPORTS_TABLE || FEATURE_CONFIG_TABLE || INSPECTIONS_TABLE || MARKET_VALUE_TABLE || REPORT_USAGE_TABLE || SERVICE_RECORDS_TABLE || TITLE_CHECKS_TABLE || VEHICLE_TABLE)
  ? DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } })
  : null;

/**
 * User-uploaded service records for a VIN (from the garage), keyed by vehicleId=VIN
 * so ALL records for the car are returned regardless of who uploaded them. The report
 * surfaces the SUMMARY only (date/service/mileage) — scanned receipt images stay gated
 * to the uploader by the garage's own image endpoint. See docs/gating-spec.md.
 */
async function getVinServiceRecords(vin) {
  if (!docClient || !SERVICE_RECORDS_TABLE) return [];
  try {
    const r = await docClient.send(new QueryCommand({
      TableName: SERVICE_RECORDS_TABLE,
      IndexName: "vehicleId-index",
      KeyConditionExpression: "vehicleId = :v",
      ExpressionAttributeValues: { ":v": vin },
    }));
    return r.Items || [];
  } catch (e) {
    console.warn("⚠️ service records fetch failed:", e.message);
    return [];
  }
}

/**
 * Collapse near-duplicate service records for display. Scanned/parsed uploads
 * routinely produce several rows for ONE job (same date + same odometer, wording
 * varies — "Head Gasket Replacement" / "Headgasket Job" / "Head Gasket R&R"). We
 * treat records with the SAME date AND mileage AND a fuzzy-similar summary
 * (char-trigram Jaccard ≥ 0.35) as one, keeping the most detailed. This is the
 * upload de-dup rule (mileage + service date + fuzzy summary) applied at read time
 * so the report never looks padded with duplicates.
 */
function normDate(d) {
  if (!d) return null;
  const s = String(d).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return s.slice(0, 10);
}
// Odometer 0/1/null = not captured on the scan → treat as unknown (fall back to
// date + fuzzy summary) rather than letting junk mileage split a real duplicate.
function mileEq(a, b) {
  const junk = (x) => x == null || Number(x) <= 1;
  if (junk(a) || junk(b)) return true;
  return Number(a) === Number(b);
}
function trigrams(s) {
  const n = String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (n.length < 3) return new Set([n]);
  const t = new Set();
  for (let i = 0; i < n.length - 2; i++) t.add(n.slice(i, i + 3));
  return t;
}
function fuzzySim(a, b) {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return String(a).toLowerCase() === String(b).toLowerCase() ? 1 : 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  // Overlap coefficient (intersection / smaller set): a short summary fully
  // contained in a longer one (same oil change parsed two ways) scores high,
  // where Jaccard would be diluted by the longer summary's extra tokens.
  return inter / Math.min(A.size, B.size);
}
function dedupeServiceHistory(list) {
  const kept = [];
  for (const r of list) {
    const dup = kept.find(
      (k) => k.date === r.date && mileEq(k.mileage, r.mileage) && fuzzySim(k.service, r.service) >= 0.5
    );
    if (dup) {
      if (String(r.service || "").length > String(dup.service || "").length) Object.assign(dup, r);
      continue;
    }
    kept.push({ ...r });
  }
  return kept;
}

/** Latest AI walkaround inspection for a VIN (populates the Condition card). */
async function getInspection(vin) {
  if (!docClient || !INSPECTIONS_TABLE) return null;
  try {
    const r = await docClient.send(new GetCommand({ TableName: INSPECTIONS_TABLE, Key: { vin } }));
    return r?.Item?.status === "complete" ? r.Item.report || null : null;
  } catch (e) {
    console.warn("⚠️ Inspection read failed:", e.message);
    return null;
  }
}

/** Best-effort decode of a JWT payload (no signature check). */
function decodeJwtPayload(token) {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Pull the Cognito identity for this request. Two paths:
 *   1. behind an API Gateway Cognito authorizer → requestContext.authorizer.claims
 *   2. behind a Lambda Function URL (no authorizer) → decode the Bearer id token
 * Returns null when the caller is anonymous → forces the preview path.
 *
 * NOTE: during the free promo the gate is a SIGNUP growth mechanism, not a security
 * boundary (the report is free), so a token decode is sufficient for dev. Harden with
 * JWKS signature verification before the report becomes paid (entitlement flip).
 */
function getCaller(event) {
  const rc = event?.requestContext || {};
  let claims = rc.authorizer?.claims || rc.authorizer?.jwt?.claims || null;
  if (!claims) {
    const h = event?.headers || {};
    const auth = h.authorization || h.Authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (token) claims = decodeJwtPayload(token);
  }
  const sub = claims?.sub;
  if (!sub) return null;
  const role = (event?.queryStringParameters?.role || "buyer").toLowerCase();
  return { userId: sub, role: role === "seller" ? "seller" : "buyer", email: claims?.email || null };
}

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};
const success = (data) => ({ statusCode: 200, headers: CORS, body: JSON.stringify(data) });
const error = (statusCode, message) => ({ statusCode, headers: CORS, body: JSON.stringify({ error: message }) });

/**
 * Free NHTSA VIN decode for basic identity (year/make/model/trim). Fallback when
 * Vehicle Databases sales history doesn't carry it — so every report names the car
 * and can run recall / known-issue lookups (which key off make/model/year).
 * Best-effort: returns {} on any failure; never blocks the report.
 */
// NHTSA reports a hybrid as FuelTypePrimary "Gasoline" + FuelTypeSecondary
// "Electric" with an ElectrificationLevel of "HEV"/"PHEV" (BEVs carry "BEV"),
// so reading only the primary fuel mislabels every hybrid and EV. This folds
// the secondary fuel + electrification level into one correct powertrain label.
function derivePowertrain(r) {
  const primary = String(r?.FuelTypePrimary || "").trim();
  const secondary = String(r?.FuelTypeSecondary || "").trim();
  const elec = String(r?.ElectrificationLevel || "").toLowerCase();
  const hasElec = /electric/i.test(secondary) || /electric/i.test(primary);
  const hasComb = /(gasoline|diesel|flex|e85|cng|propane)/i.test(primary) ||
    /(gasoline|diesel|flex|e85|cng|propane)/i.test(secondary);
  if (elec.includes("phev") || elec.includes("plug-in")) return "Plug-in Hybrid";
  if (elec.includes("hev") || (hasElec && hasComb)) return "Hybrid";
  if (elec.includes("bev") || (/electric/i.test(primary) && !hasComb)) return "Electric";
  return primary || null;
}

// Authoritative powertrain from the already-pulled VDB MMYT catalog. Returns
// the normalized label (Gas|Hybrid|Electric|Plug-in Hybrid) or null when the
// decoded MMYT isn't in the catalog (caller then falls back to NHTSA).
async function powertrainFromCatalog({ year, make, model, trim }) {
  if (!docClient || !MMYT_SPEC_TABLE || !year || !make || !model || !trim) return null;
  const pk = `MMYT:${year}#${make}#${model}#${trim}`;
  try {
    const r = await docClient.send(new GetCommand({
      TableName: MMYT_SPEC_TABLE,
      Key: { PK: pk, SK: "VEHICLE" },
    }));
    const ft = r?.Item?.data?.fuel_type;
    return ft ? String(ft).trim() : null;
  } catch (e) {
    console.warn("⚠️ MMYT catalog powertrain lookup failed:", e.message);
    return null;
  }
}

async function decodeIdentity(vin) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${encodeURIComponent(vin)}?format=json`,
      { signal: ctrl.signal }
    );
    if (!res.ok) return {};
    const r = (await res.json())?.Results?.[0] || {};
    const titleCase = (s) => (s || "").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
    return {
      year: r.ModelYear ? Number(r.ModelYear) : null,
      make: r.Make ? titleCase(r.Make) : null,
      model: r.Model || null,
      trim: r.Trim || r.Series || null,
      powertrain: derivePowertrain(r), // Gasoline|Diesel|Hybrid|Plug-in Hybrid|Electric
    };
  } catch {
    return {};
  } finally {
    clearTimeout(t);
  }
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{11,17}$/i; // no I/O/Q

// ── Paid report packs (buy more after the 3 free) ─────────────────────────────
function reportPackOffer(config) {
  return {
    single: { pack: "single", credits: 1, priceCents: Number(config?.reportSinglePriceCents ?? 199), label: "1 report" },
    pack3: { pack: "pack3", credits: 3, priceCents: Number(config?.reportPack3PriceCents ?? 500), label: "3 reports" },
  };
}

/** GET /reports/mine — the "Your reports" history (VINs unlocked) + credit balance. */
async function handleListMine(event) {
  const caller = getCaller(event);
  if (!caller) return error(401, "Sign in to view your reports.");
  const rows = await listUserReports({ docClient, table: REPORT_USAGE_TABLE, userId: caller.userId, limit: 20 });
  const credits = await getReportCredits({ docClient, table: REPORT_USAGE_TABLE, userId: caller.userId });
  const reports = [];
  for (const row of rows) {
    let vehicle = null, score = null, band = null;
    if (docClient && REPORTS_TABLE) {
      try {
        const c = await docClient.send(new GetCommand({ TableName: REPORTS_TABLE, Key: { vin: row.vin } }));
        const rep = c?.Item?.report;
        if (rep) { vehicle = rep.vehicle || null; score = rep.headline?.score ?? null; band = rep.headline?.band ?? null; }
      } catch { /* best-effort enrichment */ }
    }
    reports.push({ vin: row.vin, ts: row.ts, vehicle, score, band });
  }
  return success({ reports, credits });
}

/** POST /reports/checkout {pack:"single"|"pack3", returnUrl} — a Stripe-hosted
 *  Checkout Session to buy report credits (payment TO Zoooom; no Connect). */
async function handleReportCheckout(event) {
  const caller = getCaller(event);
  if (!caller) return error(401, "Sign in to buy reports.");
  if (!stripeConfigured()) return error(503, "Report purchases aren't available right now.");
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { /* ignore */ }
  const config = await loadFeatureConfig(docClient, FEATURE_CONFIG_TABLE);
  const offer = reportPackOffer(config);
  const sel = body.pack === "pack3" ? offer.pack3 : offer.single;
  // Only allow returning to a zoooom.me page (avoid open-redirect); strip query/hash.
  const returnUrl =
    typeof body.returnUrl === "string" && /^https:\/\/[\w.-]*zoooom\.me\//.test(body.returnUrl)
      ? body.returnUrl.replace(/[?#].*$/, "")
      : "https://dev.zoooom.me/report";
  const session = await createCheckoutSession({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: sel.priceCents,
          product_data: { name: sel.credits === 3 ? "3 Zoooom Vehicle Reports" : "1 Zoooom Vehicle Report" },
        },
      },
    ],
    success_url: `${returnUrl}?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${returnUrl}?purchase=cancel`,
    client_reference_id: caller.userId,
    ...(caller.email ? { customer_email: caller.email } : {}),
    metadata: { userId: caller.userId, pack: sel.pack, credits: String(sel.credits), product: "vehicle_report_pack" },
  });
  if (session?.error) return error(502, session.error.message || "Could not start checkout.");
  return success({ url: session.url, sessionId: session.id });
}

/** POST /reports/confirm {sessionId} — verify a paid Checkout Session (server-side,
 *  via Stripe) and grant the credits. Idempotent per session. */
async function handleReportConfirm(event) {
  const caller = getCaller(event);
  if (!caller) return error(401, "Sign in.");
  if (!stripeConfigured()) return error(503, "Unavailable.");
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { /* ignore */ }
  const sessionId = body.sessionId;
  if (!sessionId) return error(400, "sessionId required.");
  const session = await retrieveCheckoutSession(sessionId);
  if (session?.error) return error(502, session.error.message || "Could not verify the purchase.");
  if (session.payment_status !== "paid") return success({ granted: false, paid: false });
  if (session.client_reference_id && session.client_reference_id !== caller.userId) {
    return error(403, "This purchase belongs to another account.");
  }
  const count = parseInt(session.metadata?.credits || "0", 10) || 0;
  if (count <= 0) {
    return success({ granted: false, credits: await getReportCredits({ docClient, table: REPORT_USAGE_TABLE, userId: caller.userId }) });
  }
  const result = await grantReportCredits({ docClient, table: REPORT_USAGE_TABLE, userId: caller.userId, count, sessionId });
  return success({ granted: result.granted, already: result.already || false, credits: result.credits });
}

export const handler = async (event) => {
  if (event?.requestContext?.http?.method === "OPTIONS" || event?.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }
  // Non-VIN routes (no vin in the path) — dispatch before the VIN validation.
  const reqPath = event?.rawPath || event?.requestContext?.http?.path || event?.path || "";
  if (/\/reports\/mine\/?$/.test(reqPath)) return await handleListMine(event);
  if (/\/reports\/checkout\/?$/.test(reqPath)) return await handleReportCheckout(event);
  if (/\/reports\/confirm\/?$/.test(reqPath)) return await handleReportConfirm(event);

  const vin = (event?.pathParameters?.vin || event?.queryStringParameters?.vin || "").toUpperCase().trim();
  const q = event?.queryStringParameters || {};
  if (!VIN_RE.test(vin)) return error(400, "Invalid or missing VIN.");

  console.log(`📊 Vehicle report requested for VIN ${vin}`);

  // 0. Entitlement: who's asking + is the report free/unlocked for them right now.
  //    Anonymous (no Cognito claims) always lands on the preview path — login is the gate.
  const caller = getCaller(event);
  // Raw bearer token — forwarded to the (Cognito-protected) garage market-value endpoint.
  const authToken = ((event?.headers?.authorization || event?.headers?.Authorization || "").replace(/^Bearer\s+/i, "").trim()) || null;
  const deviceId = event?.headers?.["x-device-id"] || event?.headers?.["X-Device-Id"] || null;
  const ip = event?.requestContext?.http?.sourceIp || event?.requestContext?.identity?.sourceIp || null;
  const config = await loadFeatureConfig(docClient, FEATURE_CONFIG_TABLE);
  const entitlement = caller
    ? resolveEntitlement({
        featureKey: "vehicle_report",
        vin,
        caller,
        now: new Date().toISOString(),
        config,
      })
    : { access: "preview", reason: "anonymous" };

  // Free-report cap + anti-fraud: only the promo grant is metered (cached/subscription/
  // purchase bypass the cap). Over the per-user cap or flagged for device/IP abuse → fall
  // back to the locked preview with a message. Fails open on any usage-table error.
  let limitInfo = null;
  // Did THIS request reserve a free-cap slot? If the report then turns out to
  // have no data, we release it so a not-found VIN never costs a free report.
  let reservedThisRequest = false;
  if (caller && entitlement.access === "granted" && entitlement.reason === "promo") {
    const usage = await checkAndReserveReport({
      docClient,
      table: REPORT_USAGE_TABLE,
      userId: caller.userId,
      vin,
      deviceId,
      ip,
      perUserLimit: config.freeReportsPerUser ?? 3,
      config, // guardMode (monitor/enforce) + prefixRatePerHour + dailyReportBudget
      now: new Date(),
    });
    if (usage.allowed && usage.reason === "reserved") reservedThisRequest = true;
    if (!usage.allowed) {
      // Free cap reached → try a PAID credit (bought after the 3 free) before
      // falling back to the preview + a buy-more offer.
      if (usage.reason === "per_user_limit") {
        const spent = await spendReportCredit({ docClient, table: REPORT_USAGE_TABLE, userId: caller.userId, vin });
        if (spent) {
          console.log(`💳 paid report credit spent → unlocked (user ${caller.userId}, vin ${vin})`);
        } else {
          entitlement.access = "preview";
          entitlement.reason = usage.reason;
          limitInfo = { reason: usage.reason, message: usage.message, buy: reportPackOffer(config) };
        }
      } else {
        entitlement.access = "preview";
        entitlement.reason = usage.reason;
        limitInfo = { reason: usage.reason, message: usage.message };
      }
      console.log(`🔒 free-report cap/fraud: ${usage.reason} (user ${caller.userId}, vin ${vin})`);
    }
  }

  const unlocked = entitlement.access === "granted";
  // One place that turns a full summary into the right response for this caller.
  const respond = (full, extra = {}) =>
    unlocked
      ? success({ ...full, ...extra, locked: false })
      : success({ ...redactToPreview(full, { promoEndsAt: config.freeUntil }), ...(limitInfo ? { limit: limitInfo } : {}), ...extra });

  // 0b. Odometer the owner entered in the garage / listing wizard. Resolved before
  //     the cache gate because a changed odometer must invalidate a stored report —
  //     the whole point is that the report prices against the CURRENT mileage.
  const owner = await getOwnerOdometer({ docClient, vin });
  const ownerMileage = owner?.mileage ?? null;
  if (ownerMileage) console.log(`🚗 owner odometer ${ownerMileage} mi (${owner.listed ? "listed" : "garage"})`);

  // 1. Cache (by VIN) — return a fresh report if we have one.
  if (docClient && REPORTS_TABLE) {
    try {
      const cached = await docClient.send(new GetCommand({ TableName: REPORTS_TABLE, Key: { vin } }));
      const r = cached?.Item;
      const cachedMileage = r?.mileageUsed ?? null;
      const mileageChanged = (cachedMileage ?? null) !== (ownerMileage ?? null);
      // Once-per-month gate: serve the stored report until it's REGEN_DAYS old —
      // unless the odometer moved since it was built (new listing, updated garage
      // mileage), which makes the stored market value wrong for this car.
      if (r?.report && r.generatedAt && (Date.now() - new Date(r.generatedAt).getTime()) / 86400000 < REGEN_DAYS && !mileageChanged) {
        console.log(`✅ Returning stored report (${unlocked ? "full" : "preview"}) — generated ${r.generatedAt}`);
        return respond(r.report, { cached: true });
      }
      if (r?.report && mileageChanged) {
        console.log(`♻️ Odometer changed (${cachedMileage ?? "none"} → ${ownerMileage ?? "none"}) — regenerating report`);
      }
    } catch (e) {
      console.warn("⚠️ Report cache read failed:", e.message);
    }
  }

  // 2. Fetch sources in parallel; each degrades to null on failure.
  // decodeIdentity (NHTSA) rides along here — it only needs the VIN, so running
  // it in parallel adds NO latency to the hot path while always giving us the
  // powertrain (hybrid/EV) plus a year/make/model fallback.
  const [title, stolen, sales, id] = await Promise.all([
    getTitleCheckCached({ docClient, table: TITLE_CHECKS_TABLE, vin }),
    getStolenCheck(vin),
    getSalesHistory(vin),
    decodeIdentity(vin),
  ]);

  // 3. Resolve vehicle identity + location.
  let year = sales?.year || (q.year ? Number(q.year) : null);
  let make = sales?.make || q.make || null;
  let model = sales?.model || q.model || null;
  let trim = sales?.trim || null;
  // Identity fallback fills only gaps; powertrain always comes from the decode
  // (fetched in parallel above). Recall/known-issue lookups below need m/m/y.
  year = year || id.year;
  make = make || id.make;
  model = model || id.model;
  trim = trim || id.trim;
  // Powertrain: prefer the VDB MMYT catalog (authoritative, keyed by the decoded
  // make/year/model/trim), fall back to the NHTSA-derived label only when the
  // decoded MMYT isn't in the catalog.
  const powertrain =
    (await powertrainFromCatalog({ year, make, model, trim })) ||
    id.powertrain ||
    null;
  const loc = latestLocation(sales);
  const state = (q.state || loc.state || owner?.state || "").toUpperCase() || null;
  // Odometer precedence: an explicit ?mileage= (the report's manual prompt) beats
  // the owner's garage/listing entry, which beats the VD sales-history reading —
  // that last one is the odometer at some PAST sale, so it's the least current.
  const salesMileage = sales?.entries?.find((e) => e.odometerMi)?.odometerMi || null;
  const mileage = Number(q.mileage) > 0 ? Number(q.mileage) : (ownerMileage || salesMileage || null);

  // 4. Flood + known issues + AI inspection + market value (parallel).
  // Market value was previously awaited serially AFTER this block; folding it in
  // keeps a slow VD title-check (block 2) and the market lookup from stacking
  // toward the 29s API Gateway integration ceiling. state/mileage are already
  // resolved above, so it has everything it needs here.
  const [flood, knownIssues, inspection, marketValue] = await Promise.all([
    assessFlood(title, sales),
    getKnownIssues(make, model, year),
    getInspection(vin),
    monthlyMarketValue({
      docClient, table: MARKET_VALUE_TABLE, vin, state, mileage,
      userId: caller?.userId, authToken, regenDays: REGEN_DAYS,
    }),
  ]);

  // No-data guard: if we couldn't identify the vehicle (no year/make/model from
  // VD or NHTSA) AND have no title record, no sales history, and no inspection,
  // there's nothing to build a report from. Tell the user honestly, DON'T charge
  // a free-report slot, and DON'T cache an empty report. (A vehicle we CAN
  // identify but with no adverse history is a clean car — that still gets a
  // normal report; this only fires when the VIN resolves to nothing at all.)
  const identified = !!(year && make && model);
  const hasSubstance =
    identified ||
    title != null ||
    (Array.isArray(sales?.entries) && sales.entries.length > 0) ||
    inspection != null;
  if (!hasSubstance) {
    if (reservedThisRequest && caller) {
      await releaseReport({ docClient, table: REPORT_USAGE_TABLE, userId: caller.userId, vin });
    }
    console.log(`🚫 No data found for VIN ${vin} — returning not-found (free of charge).`);
    return success({
      vin,
      notFound: true,
      free: true,
      vehicle: null,
      message:
        "We're sorry — we couldn't find any records associated with this VIN. There's no charge for this. Please double-check the VIN, or try a different one.",
    });
  }

  // Sales history (surface the VD sales history we already fetched). Market value
  // is resolved above in the parallel block (same source as the Garage's "Market
  // Price Guide", monthly-cached with history).
  const salesHistory = (sales?.entries || []).slice(0, 50).map((e) => ({
    date: e.date ? String(e.date).slice(0, 10) : null,
    location: [e.city, e.state].filter(Boolean).join(", ") || null,
    price: e.listingPrice || null,
    currency: e.currency || "USD",
    odometer: e.odometerMi || null,
    sellerType: e.sellerType || null,
    damage: [e.primaryDamage, e.secondaryDamage].filter(Boolean).join("; ") || null,
  }));

  // User-uploaded service records (garage). ALL records for the VIN, summary-only,
  // with near-duplicate uploads collapsed (same date+mileage+fuzzy summary).
  const serviceRecordsRaw = await getVinServiceRecords(vin);
  const serviceHistory = dedupeServiceHistory(
    serviceRecordsRaw
      .map((r) => ({
        date: normDate(r.date),
        service: Array.isArray(r.serviceDetails) ? r.serviceDetails.filter(Boolean).join("; ") : (r.serviceType || null),
        serviceType: r.serviceType || null,
        mileage: r.mileage != null && r.mileage !== "" ? Number(r.mileage) : null,
        shop: r.shopName || r.shop || (r.mechanicId && r.mechanicId !== "NONE" ? "Mechanic on file" : null),
      }))
      .filter((r) => r.service && String(r.service).trim())
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
  );

  // 5. Build the signals object summary.buildSummary expects.
  const have = ["Title", "History", "Flood", "Theft"];
  if (knownIssues) have.push("Recalls", "Known issues");
  if (inspection) have.push("Walkaround");
  if (salesHistory.length) have.push("Sales history");
  if (serviceHistory.length) have.push("Service history");
  if (marketValue) have.push("Market value");
  const signals = {
    vin,
    vehicle: [year, make, model, trim].filter(Boolean).join(" ") || `VIN ${vin}`,
    vehicleYear: year,
    powertrain, // Gasoline|Diesel|Hybrid|Plug-in Hybrid|Electric (from NHTSA decode)
    mileage: mileage || 0,
    state,
    // checked=false means the title-brand source didn't respond (null) — summary
    // must NOT render that as a "Clean title" (false-clear); it shows "not verified".
    title: { checked: title != null, salvage: !!title?.salvage, floodBrand: flood.verdict === "FLOOD_TITLE", salvageDetails: Array.isArray(title?.salvage_details) ? title.salvage_details : [] },
    flood: { verdict: flood.verdict },
    theft: { possibleStolen: !!stolen?.possibleStolen, checkedAt: stolen?.checkedAt || null, available: stolen != null },
    recalls: { open: knownIssues?.recallCount || 0 }, // model-level; VIN-specific open status is a follow-up (VD recalls)
    knownIssues: {
      top: (knownIssues?.topIssues || []).map((i) => ({ component: i.component, count: i.count, addressed: false, severe: i.severe })),
    },
    inspection, // AI walkaround (ZoooomVideoInspect) when present, else null
    salesHistory, // VD sales/listing history timeline
    marketValue, // garage Market Price Guide (monthly-cached, history kept)
    salesTax: { table: buildTaxTable(), defaultStateCode: state }, // buyer DMV tax (per-state, universal reference)
    // User-uploaded service records for the VIN (summary-only; images stay gated in the garage).
    maintenance: { noRecords: serviceHistory.length === 0, recordCount: serviceHistory.length },
    serviceHistory,
    coverage: {
      have,
      missing: [...(serviceHistory.length ? [] : ["Service history"]), ...(inspection ? [] : ["Walkaround"]), "Mechanical inspection"],
    },
  };

  const summary = buildSummary(signals);
  summary.generatedAt = new Date().toISOString();
  summary.images = flood.images; // historical photos for the future vision pass

  // --- Benchmark "evidence of quality" (CARFAX/AutoCheck/carVertical pattern) ---
  // Show WHICH datasets we checked, WHEN each was last retrieved, and HOW MANY
  // concrete records we found for THIS vin. Honest per-VIN counts — no inflated
  // "millions of records" marketing. Drives: "Latest report as of <date>", the
  // sources/freshness panel, and the "we found N records" reassurance hook.
  const gen = summary.generatedAt;
  const sourcesChecked = [
    { name: "Title brand & salvage", provider: "Vehicle Databases", status: title != null ? "checked" : "unavailable", lastRetrieved: gen },
    { name: "Theft / stolen record", provider: "Vehicle Databases", status: stolen != null ? "checked" : "pending", lastRetrieved: stolen?.checkedAt || null },
    { name: "Sales & listing history", provider: "Vehicle Databases", status: sales != null ? "checked" : "unavailable", lastRetrieved: gen },
    { name: "Open recalls & known issues", provider: "NHTSA", status: knownIssues != null ? "checked" : "unavailable", lastRetrieved: gen },
    { name: "Flood risk", provider: "FEMA", status: flood ? "checked" : "unavailable", lastRetrieved: gen },
    { name: "Market value", provider: "Zoooom Market Price Guide", status: marketValue != null ? "checked" : "unavailable", lastRetrieved: marketValue?.asOf || gen },
    { name: "AI walkaround inspection", provider: "Zoooom", status: inspection != null ? "checked" : "not provided", lastRetrieved: inspection ? gen : null },
  ];
  const recordsFound =
    (salesHistory?.length || 0) +
    (Array.isArray(stolen?.records) ? stolen.records.length : 0) +
    (knownIssues?.recallCount || 0) +
    ((knownIssues?.topIssues || []).length) +
    (title?.salvage ? 1 : 0) +
    (inspection ? 1 : 0);
  summary.evidence = {
    sourcesChecked,
    sourcesCheckedCount: sourcesChecked.filter((x) => x.status === "checked").length,
    recordsFound,
    dataAsOf: gen,
    nextRefreshEligible: new Date(Date.now() + REGEN_DAYS * 86400000).toISOString(),
    accessNote: `Your report stays current for ${REGEN_DAYS} days — we refresh the data if you return within that window.`,
    coverageNote: "Records reflect data available to Zoooom from NHTSA, FEMA, and Vehicle Databases. As with any history report, not every event is reported to these sources.",
  };

  // 6. Cache write (best-effort). We cache the FULL summary; the gate decides what
  //    each caller sees, so a preview request still warms the cache for later logins.
  if (docClient && REPORTS_TABLE) {
    try {
      // mileageUsed is what the cache gate above compares against, so a later
      // odometer change (relist, garage edit) rebuilds instead of serving stale.
      await docClient.send(new PutCommand({
        TableName: REPORTS_TABLE,
        Item: { vin, report: summary, generatedAt: summary.generatedAt, mileageUsed: ownerMileage ?? null },
      }));
    } catch (e) {
      console.warn("⚠️ Report cache write failed:", e.message);
    }
  }

  console.log(`✅ Report assembled for ${vin}: ${summary.headline?.band} ${summary.headline?.score} (${unlocked ? "full" : "preview"})`);
  return respond(summary);
};

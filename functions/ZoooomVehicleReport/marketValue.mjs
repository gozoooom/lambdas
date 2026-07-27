/**
 * Market value for the Vehicle Report — reuses the EXACT same source the Garage uses.
 *
 * The Garage's "Market Price Guide" comes from the deployed ZoooomGetMarketValue lambda
 * (behind {CONSUMER_BASE_URL}/vehicle/get_market_value). We call that same endpoint so the
 * report shows identical numbers to the garage, then:
 *   - store per-VIN with a timestamp in ZoooomMarketValue (one item per fetch → full HISTORY),
 *   - refresh at most ONCE PER MONTH per vehicle (requirement), reusing the stored value in between.
 *
 * Requires mileage (the endpoint prices by odometer) + an auth token (the endpoint is
 * Cognito-protected, same as the garage). No mileage or no token → returns null (no section).
 */
import { QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const CONSUMER_BASE_URL =
  process.env.CONSUMER_BASE_URL || "https://pabikbpzo5.execute-api.us-west-2.amazonaws.com/Dev";
const TIMEOUT_MS = Number(process.env.MARKET_TIMEOUT_MS || "12000");
// Preferred path: invoke the market-value lambda through its per-env ALIAS
// (ZoooomGetMarketValue:Dev|Staging|Prod). The HTTP route it also sits behind is
// on a REST API whose Cognito authorizer is method-level and pinned to the PROD
// pool, so a dev/staging token 401s there — the reason market value never
// appeared outside prod. A direct invoke skips that (and a gateway hop); the
// report lambda has already authenticated the caller.
const MARKET_VALUE_FN = process.env.MARKET_VALUE_FN || null;
const lambdaClient = MARKET_VALUE_FN ? new LambdaClient({ region: process.env.REGION || "us-west-2" }) : null;

// Garage condition labels (CarDetailClient maps the VD ratings to these).
const CONDITION_MAP = { Outstanding: "Excellent", Clean: "Good", Average: "Fair", Rough: "Poor" };

/** Pull market_value_data[0]["market value"] from whatever wrapper shape we got.
 *  The service answers {source, data:{market_value:{market_value_data}}}; older
 *  stored rows keep the inner blob directly. Miss the wrapper and the section
 *  silently disappears even though the fetch succeeded — check every shape. */
function normalizeDisplay(blob) {
  const mvd =
    blob?.market_value_data ||
    blob?.market_value?.market_value_data ||
    blob?.market?.market_value_data ||
    blob?.data?.market_value?.market_value_data ||
    blob?.data?.market_value_data;
  const rows = Array.isArray(mvd) ? mvd[0]?.["market value"] : null;
  if (!Array.isArray(rows)) return null;
  return rows.map((r) => ({
    condition: CONDITION_MAP[r.Condition] || r.Condition,
    privateParty: r["Private Party"] || null,
    dealerRetail: r["Dealer Retail"] || null,
    tradeIn: r["Trade-In"] || null,
  }));
}

/** Latest stored market value for a VIN (newest fetch first). */
async function loadLatest(docClient, table, vin) {
  try {
    const r = await docClient.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: "vin = :v",
      ExpressionAttributeValues: { ":v": vin },
      ScanIndexForward: false, // newest fetchedAt first
      Limit: 1,
    }));
    return r?.Items?.[0] || null;
  } catch (e) {
    console.warn("⚠️ MarketValue read failed:", e.message);
    return null;
  }
}

/** Direct alias invoke of the same lambda the garage's Market Price Guide uses. */
async function invokeMarketValueLambda({ vin, state, mileage, userId }) {
  try {
    const res = await lambdaClient.send(new InvokeCommand({
      FunctionName: MARKET_VALUE_FN,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ vin, userId, state, mileage })),
    }));
    const raw = JSON.parse(Buffer.from(res.Payload || []).toString("utf8") || "{}");
    if (raw?.statusCode && raw.statusCode >= 400) {
      console.warn(`⚠️ ${MARKET_VALUE_FN} → ${raw.statusCode}`);
      return null;
    }
    const blob = raw?.body ? (typeof raw.body === "string" ? JSON.parse(raw.body) : raw.body) : raw;
    return blob || null;
  } catch (e) {
    console.warn("❌ market-value invoke error:", e.message);
    return null;
  }
}

/** Call the SAME endpoint the garage uses; returns the parsed market blob or null. */
async function fetchFromGarageService({ vin, state, mileage, userId, authToken }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${CONSUMER_BASE_URL}/vehicle/get_market_value`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
      body: JSON.stringify({ userId, vin, state, mileage }),
      signal: ctrl.signal,
    });
    if (!res.ok) { console.warn(`⚠️ get_market_value → ${res.status}`); return null; }
    const data = await res.json();
    // Deployed lambda is non-proxy: { statusCode, body: "<json string>" }. Unwrap defensively.
    const blob = data?.body ? (typeof data.body === "string" ? JSON.parse(data.body) : data.body) : data;
    return blob || null;
  } catch (e) {
    console.warn("❌ get_market_value error:", e.message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

const shape = (item) => item && ({
  asOf: item.fetchedAt,
  mileageUsed: item.mileage,
  state: item.state,
  conditions: item.display || normalizeDisplay(item.market),
  cached: true,
});

/**
 * Monthly-cached market value. Reuses the stored value if it's < regenDays old, else
 * refreshes from the garage endpoint and appends a new history item.
 * @returns report-shaped { asOf, mileageUsed, state, conditions:[{condition,privateParty,dealerRetail,tradeIn}] } | null
 */
export async function monthlyMarketValue({ docClient, table, vin, state, mileage, userId, authToken, regenDays = 30 }) {
  if (!mileage) return null; // can't price without odometer (requirement #4)
  const latest = docClient && table ? await loadLatest(docClient, table, vin) : null;
  // Reuse the stored value only if it priced the SAME odometer — a monthly cache
  // keyed on VIN alone would keep quoting the old mileage after the owner
  // updates it (or lists the car), which is the number they came here to see.
  const sameMileage = latest && Number(latest.mileage) === Number(mileage);
  if (latest && sameMileage && (Date.now() - new Date(latest.fetchedAt).getTime()) / 86400000 < regenDays) {
    return { ...shape(latest) }; // within the month — reuse stored (no paid call)
  }
  // Direct alias invoke needs no caller token; the HTTP fallback still does.
  if (!MARKET_VALUE_FN && (!userId || !authToken)) {
    // Can't fetch (endpoint needs auth) — fall back to the most recent stored value if any.
    return latest ? { ...shape(latest), stale: true } : null;
  }
  const blob = MARKET_VALUE_FN
    ? await invokeMarketValueLambda({ vin, state, mileage, userId: userId || `report:${vin}` })
    : await fetchFromGarageService({ vin, state, mileage, userId, authToken });
  const display = normalizeDisplay(blob);
  if (!display) return latest ? { ...shape(latest), stale: true } : null;

  const item = { vin, fetchedAt: new Date().toISOString(), mileage, state: state || null, market: blob, display };
  if (docClient && table) {
    try {
      await docClient.send(new PutCommand({ TableName: table, Item: item })); // append → history kept
    } catch (e) {
      console.warn("⚠️ MarketValue write failed:", e.message);
    }
  }
  return { asOf: item.fetchedAt, mileageUsed: mileage, state: item.state, conditions: display, cached: false };
}

/**
 * ZoooomInternalCustomerSearch — staff search for ANY customer by first name,
 * last name or email.
 *
 * GET|POST /customers/search?q=<term>            (behind ZoooomInternalStaffAuth)
 *   optional: &firstName= &lastName= &email=     exact-field substring search
 *             &limit=25 (default), max 200
 *
 * ── WHY A NEW FUNCTION ───────────────────────────────────────────────────────
 * The internal API's `/SearchConsumer` routes to `ZoooomSearchForConsumers`, which
 * **requires `mechanicId` and returns 400 without it** — it is a MECHANIC-scoped
 * search ("customers who had service done by this mechanic"), and the mechanic app
 * depends on it (`ZoooomMechanics POST /searchforconsumers`). So staff searching a
 * customer by name got a 400, not a result set: the feature could not work, and
 * repurposing that function would have broken the mechanic app.
 *
 * `ZoooomInternalSearchForUser` exists and is closer in intent, but is **not routed
 * anywhere** and caps its Scan at `Limit: 100` items with no paging — on a growing
 * table that returns "no results" for a customer who is definitely there. Neither
 * was salvageable without breaking something or shipping a known dead end.
 *
 * ── MATCHING ─────────────────────────────────────────────────────────────────
 * Case-insensitive substring across firstName, lastName, email AND the combined
 * name. Multi-word queries are matched **order-independently**, so "wang sheng"
 * finds "Sheng Wang" — staff type names in whichever order they have them, and a
 * search that only understands "first last" quietly fails half the time.
 *
 * ── COMPLETENESS ─────────────────────────────────────────────────────────────
 * DynamoDB cannot do case-insensitive substring matching server-side (`contains`
 * is case-sensitive), so filtering happens here — which means the scan must be
 * EXHAUSTED, not sampled. `ZoooomUser_prod` is 137 rows / 26 KB today so this is
 * cheap; the loop is bounded by SCAN_CAP and the response carries `truncated` so a
 * partial answer can never masquerade as "no such customer". That failure mode is
 * the whole reason this function exists.
 *
 * Env: USER_TABLE, SCAN_CAP (default 20000), DEFAULT_LIMIT (25)
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-west-2";
const USER_TABLE = process.env.USER_TABLE || "ZoooomUser_dev";
const SCAN_CAP = Number(process.env.SCAN_CAP || "20000");
const DEFAULT_LIMIT = Number(process.env.DEFAULT_LIMIT || "25");
const MAX_LIMIT = 200;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

function staffClaim(event) {
  const rc = event.requestContext || {};
  const c = rc.authorizer?.claims || rc.authorizer?.jwt?.claims || null;
  return c ? (c.email || c["cognito:username"] || c.sub || null) : null;
}

const lc = (v) => String(v ?? "").toLowerCase().trim();
const proper = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase());

/**
 * Every token must appear somewhere in the customer's searchable text. Requiring
 * ALL tokens (rather than any) keeps "sheng wang" from returning every Wang and
 * every Sheng, while the order-independence keeps it from missing the right one.
 */
function matches(user, tokens, fields) {
  const first = lc(user.firstName), last = lc(user.lastName), email = lc(user.email);
  if (fields.firstName && !first.includes(fields.firstName)) return false;
  if (fields.lastName && !last.includes(fields.lastName)) return false;
  if (fields.email && !email.includes(fields.email)) return false;
  if (!tokens.length) return true;
  const haystack = `${first} ${last} ${email} ${lc(user.phone)}`;
  return tokens.every((t) => haystack.includes(t));
}

export const handler = async (event = {}) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const staff = staffClaim(event);
  if (!staff && (event.httpMethod || event.requestContext)) {
    return reply(401, { success: false, error: "no verified staff identity on this request" });
  }

  let body = {};
  if (event.body) {
    try { body = typeof event.body === "string" ? JSON.parse(event.body) : event.body; }
    catch { return reply(400, { success: false, error: "invalid JSON body" }); }
  }
  const qs = event.queryStringParameters || {};
  const q = lc(qs.q ?? qs.query ?? qs.searchTerm ?? body.q ?? body.query ?? body.searchTerm ?? "");
  const fields = {
    firstName: lc(qs.firstName ?? body.firstName ?? ""),
    lastName: lc(qs.lastName ?? body.lastName ?? ""),
    email: lc(qs.email ?? body.email ?? ""),
  };
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(qs.limit ?? body.limit ?? DEFAULT_LIMIT)));
  const hasField = !!(fields.firstName || fields.lastName || fields.email);

  // Two characters is the shortest query that narrows anything useful; a 1-char
  // search would return most of the table and read as "search is broken".
  if (!hasField && q.length < 2) {
    return reply(400, {
      success: false,
      error: "provide q (>=2 chars) or one of firstName / lastName / email",
    });
  }
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];

  try {
    const found = [];
    let key, scanned = 0, truncated = false;
    do {
      const r = await ddb.send(new ScanCommand({ TableName: USER_TABLE, ExclusiveStartKey: key }));
      scanned += r.ScannedCount || 0;
      for (const u of r.Items || []) if (matches(u, tokens, fields)) found.push(u);
      key = r.LastEvaluatedKey;
      if (scanned >= SCAN_CAP) { truncated = !!key; break; }
    } while (key);

    // Deterministic order so paging by limit is stable and two staff looking at the
    // same query see the same list.
    found.sort((a, b) =>
      `${lc(a.lastName)}${lc(a.firstName)}${lc(a.email)}`.localeCompare(
        `${lc(b.lastName)}${lc(b.firstName)}${lc(b.email)}`
      )
    );

    const customers = found.slice(0, limit).map((u) => ({
      id: u.IdUser,
      firstName: proper(u.firstName),
      lastName: proper(u.lastName),
      name: `${proper(u.firstName)} ${proper(u.lastName)}`.trim() || null,
      email: u.email ?? null,
      phone: u.phone ?? null,
      createdAt: u.createdAt ?? null,
      // Cheap to compute and it tells staff which result is the active account.
      vehicleCount: Array.isArray(u.vehicles) ? u.vehicles.length : 0,
    }));

    return reply(200, {
      success: true,
      query: q || null,
      fields: hasField ? fields : undefined,
      count: customers.length,
      totalMatches: found.length,
      // True only when SCAN_CAP stopped us mid-table. Callers must surface this —
      // "no results" and "no results so far" are different answers.
      truncated,
      scanned,
      customers,
      // `records` + `totalCount` are the shape the deployed dashboard already reads
      // (`JSON.parse(body).records`) — it was written against ZoooomInternalSearchForUser
      // while the route pointed at the mechanic-scoped lambda. Emitting both names makes
      // this a drop-in replacement, so the existing build works with no frontend deploy.
      records: customers,
      totalCount: customers.length,
      // The old mechanic-scoped response carried these; kept so any caller reading
      // them gets null rather than undefined-shaped surprises.
      lastEvaluatedKey: null,
      searchedBy: staff || "system",
    });
  } catch (e) {
    console.error("[customerSearch] failed:", e);
    return reply(500, { success: false, error: e.message });
  }
};

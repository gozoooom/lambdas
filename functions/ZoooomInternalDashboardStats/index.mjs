/**
 * ZoooomInternalDashboardStats — the numbers on the internal dashboard landing page.
 *
 *   GET /dashboard/stats
 *
 * Two kinds of number, and the distinction matters to a support agent:
 *   TOTALS  how big the business is (users, vehicles, listings, mechanics, reports)
 *   QUEUES  how much work is waiting right now — these drive the badges and are
 *           the reason someone opens this page at all.
 *
 * Every table name comes from the environment with NO fallback. A hardcoded
 * default is how the fraud lambda ended up letting staging write to production
 * users, so an unset variable must break loudly instead.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.REGION || process.env.AWS_REGION || "us-west-2";
const T = {
  users: process.env.USERS_TABLE,
  vehicles: process.env.VEHICLES_TABLE,
  listings: process.env.LISTINGS_TABLE,
  mechanics: process.env.MECHANICS_TABLE,
  reports: process.env.REPORT_USAGE_TABLE,
  kyc: process.env.KYC_TABLE,
  ownership: process.env.FRAUD_TABLE,
  moderation: process.env.MODERATION_TABLE,
};
for (const [k, v] of Object.entries(T)) {
  if (!v) throw new Error(`table env for '${k}' is not set — refusing to start rather than guess.`);
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};
const respond = (statusCode, body) => ({
  statusCode,
  headers: { ...CORS, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Paginated COUNT. DynamoDB returns Count PER PAGE, so taking the first page's
 * Count silently under-reports any table past ~1MB — which is most of them.
 */
async function count(TableName, extra = {}) {
  let total = 0, ExclusiveStartKey;
  do {
    const r = await ddb.send(new ScanCommand({ TableName, Select: "COUNT", ...extra, ExclusiveStartKey }));
    total += r.Count || 0;
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return total;
}

async function scanAll(TableName, extra = {}) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(new ScanCommand({ TableName, ...extra, ExclusiveStartKey }));
    items.push(...(r.Items || []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * Open seller verifications. KycSession has no disposition column, so "open" is
 * derived: a seller who re-verified successfully on their own carries a newer
 * KYC#STATUS and is NOT work. Counting raw REVIEW rows would inflate this badge
 * with cases that already resolved themselves.
 */
async function openListingReviews() {
  const rows = await scanAll(T.kyc, {
    ProjectionExpression: "pk, sk, #d, verified, verifiedAt, createdAt, updatedAt",
    ExpressionAttributeNames: { "#d": "decision" },
  });
  const done = new Map();
  for (const r of rows) if (r.sk === "KYC#STATUS" && r.verified) done.set(r.pk, r.verifiedAt || "");
  return rows.filter(
    (r) =>
      String(r.sk || "").startsWith("vfy#") &&
      r.decision === "REVIEW" &&
      !((done.get(r.pk) || "") > (r.updatedAt || r.createdAt || ""))
  ).length;
}

/** Users flagged for fraud that nobody has dispositioned yet. */
const openFraudUsers = () =>
  count(T.users, {
    FilterExpression: "isFlagged = :t AND (attribute_not_exists(reviewedAt) OR reviewedAt = :empty)",
    ExpressionAttributeValues: { ":t": true, ":empty": "" },
  });

const openPending = (TableName) =>
  count(TableName, {
    FilterExpression: "#s = :p",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":p": "PENDING" },
  });

export const handler = async (event = {}) => {
  const method = event.httpMethod || event.requestContext?.http?.method || "GET";
  if (method === "OPTIONS") return respond(200, {});

  try {
    const [
      users, vehicles, listings, mechanics, reports,
      listingReviews, fraudUsers, ownership, moderation,
    ] = await Promise.all([
      count(T.users),
      count(T.vehicles),
      count(T.listings),
      count(T.mechanics),
      // Matches the daily Slack digest's definition of "reports run" so the two
      // never disagree: usage rows whose sort key is a VIN entry.
      count(T.reports, {
        FilterExpression: "begins_with(sk, :v)",
        ExpressionAttributeValues: { ":v": "VIN#" },
      }),
      openListingReviews(),
      openFraudUsers(),
      openPending(T.ownership),
      openPending(T.moderation),
    ]);

    const queues = {
      listingReviews,
      fraudUsers,
      ownershipReviews: ownership,
      photoReviews: moderation,
    };
    return respond(200, {
      totals: { users, vehicles, listings, mechanics, reports },
      queues: { ...queues, total: Object.values(queues).reduce((a, b) => a + b, 0) },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[dashboardStats]", e);
    return respond(500, { error: e.message || "Server error" });
  }
};

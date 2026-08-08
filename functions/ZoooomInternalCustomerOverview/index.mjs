/**
 * ZoooomInternalCustomerOverview — everything staff need about one customer, in one call.
 *
 * GET /GetConsumerDetail/{customerId}/overview   (behind ZoooomInternalStaffAuth)
 *
 * Backs the customer dashboard: garage, listings, wishlist, offers made, cars sold,
 * cars purchased. Every section returns BOTH `count` and `items` because the same
 * six sections are shown as stat tiles in some places and list views in others —
 * one response serves both, instead of the UI making a second round trip to turn a
 * number into a list.
 *
 * WHY A NEW ENDPOINT rather than extending ZoooomInternalGetCustomerDetail: that
 * function is live in all three envs and returns {customer, vehicles}; widening its
 * response risks a working screen for the sake of five new sections. This one is
 * additive, so nothing that works today can break.
 *
 * ── Two honesty rules this endpoint follows ──────────────────────────────────
 *
 * 1. `truncated` is reported per section. Wishlist has no GSI on userId (it is the
 *    SORT key) so it needs a bounded Scan. A bounded scan that stops quietly is how
 *    staff conclude "this customer has no wishlist" when they actually have one —
 *    the same class of bug as the search-by-page-one problem. If a cap is hit we say so.
 *
 * 2. Sold/purchased are keyed on `completedAt`, NOT on status. The ZoooomDeals status
 *    vocabulary (LISTED/ARCHIVED/UNLISTED/NEGOTIATING/PENDING_LISTING/CANCELLED) has
 *    **no terminal SOLD state**, so status cannot answer "did this sell?". Exactly one
 *    of 26 prod deals carries completedAt, which means these counts will read low until
 *    the sale-completion flow writes a terminal state. `awaitingConfirmation` surfaces
 *    the dual-confirm middle ground (one side confirmed) so a sale in flight is visible
 *    rather than invisible.
 *
 * Env: USER_TABLE, VEHICLE_TABLE, LISTING_TABLE, WISHLIST_TABLE, OFFERS_TABLE,
 *      DEALS_TABLE, SCAN_CAP (default 5000 items per bounded scan)
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-west-2";
const USER_TABLE = process.env.USER_TABLE || "ZoooomUser_dev";
const VEHICLE_TABLE = process.env.VEHICLE_TABLE || "ZoooomVehicle_dev";
const LISTING_TABLE = process.env.LISTING_TABLE || "ZoooomVehicleListing_dev";
const WISHLIST_TABLE = process.env.WISHLIST_TABLE || "ZoooomWishlist_dev";
const OFFERS_TABLE = process.env.OFFERS_TABLE || "ZoooomOffers_dev";
const DEALS_TABLE = process.env.DEALS_TABLE || "ZoooomDeals_dev";
const SCAN_CAP = Number(process.env.SCAN_CAP || "5000");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};
const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

function staffClaim(event) {
  const rc = event.requestContext || {};
  const c = rc.authorizer?.claims || rc.authorizer?.jwt?.claims || null;
  return c ? (c.email || c["cognito:username"] || c.sub || null) : null;
}

/** Query every page of an index — a customer's own records are bounded and small. */
async function queryAll(params) {
  const items = [];
  let key;
  do {
    const r = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey: key }));
    items.push(...(r.Items || []));
    key = r.LastEvaluatedKey;
  } while (key && items.length < SCAN_CAP);
  return items;
}

/** Bounded scan. Returns {items, truncated} — never pretends a partial list is whole. */
async function scanFiltered(TableName, FilterExpression, ExpressionAttributeValues) {
  const items = [];
  let key, scanned = 0;
  do {
    const r = await ddb.send(new ScanCommand({
      TableName, FilterExpression, ExpressionAttributeValues, ExclusiveStartKey: key,
    }));
    items.push(...(r.Items || []));
    scanned += r.ScannedCount || 0;
    key = r.LastEvaluatedKey;
    if (scanned >= SCAN_CAP) return { items, truncated: !!key };
  } while (key);
  return { items, truncated: false };
}

const num = (v) => (v === undefined || v === null ? null : Number(v));

const vehicleView = (v) => ({
  vin: v.vin,
  // Some rows are skeletons — `{vin, userId, dealId, …}` with no year/make/model,
  // created by a flow that never decoded the VIN (3 of 12 dev vehicles). Rendering
  // three nulls looks like a broken dashboard, so give the UI a usable title and say
  // plainly that the record was never enriched.
  title: [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ") || v.vin,
  enriched: !!(v.year || v.make || v.model),
  year: v.year ?? null,
  make: v.make ?? null,
  model: v.model ?? null,
  trim: v.trim ?? null,
  mileage: num(v.mileage),
  licensePlate: v.license ?? null,
  state: v.state ?? null,
  isListed: v.isListed ?? null,
  listingStatus: v.listingStatus ?? null,
  // A count, not the records themselves: the dashboard shows "3 service records"
  // and the vehicle-detail endpoint is where the records themselves belong.
  serviceRecordCount: Array.isArray(v.serviceRecords) ? v.serviceRecords.length : 0,
});

const listingView = (l) => ({
  id: l.id,
  title: l.title ?? `${l.year ?? ""} ${l.make ?? ""} ${l.model ?? ""}`.trim(),
  price: num(l.price ?? l.price_listed),
  listingStatus: l.listingStatus ?? null,
  isVerified: l.isVerified ?? null,
  mileage: num(l.mileage ?? l.odometer),
  createdAt: l.createdAt ?? l.postedAt ?? null,
  views: num(l.views),
});

const wishlistView = (w) => ({
  wishlistId: w.wishlistId,
  year: w.year ?? null, make: w.make ?? null, model: w.model ?? null, trim: w.trim ?? null,
  vin: w.vin ?? null, price: num(w.price), status: w.status ?? null,
  priceStatus: w.priceStatus ?? null, createdAt: w.createdAt ?? null,
});

/** A deal counts as done only when completedAt exists — see header note 2. */
const dealSplit = (deals) => {
  const completed = deals.filter((d) => !!d.completedAt);
  const awaiting = deals.filter(
    (d) => !d.completedAt && (!!d.sellerConfirmedAt !== !!d.buyerConfirmedAt)
  );
  return { completed, awaiting };
};

const dealView = (d, counterpartyField) => ({
  dealId: d.id,
  vin: d.vin ?? null,
  vehicleTitle: d.vehicleTitle ?? null,
  amount: num(d.stripeAmount ?? d.cashAmount ?? d.highestOffer ?? d.listedPrice),
  status: d.status ?? null,
  completedAt: d.completedAt ?? null,
  counterparty: d[counterpartyField] ?? null,
  updatedAt: d.updatedAt ?? null,
});

export const handler = async (event = {}) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const staff = staffClaim(event);
  if (!staff && (event.httpMethod || event.requestContext)) {
    return reply(401, { success: false, error: "no verified staff identity on this request" });
  }

  const customerId =
    event.pathParameters?.customerId ||
    event.queryStringParameters?.customerId ||
    event.customerId;
  if (!customerId) return reply(400, { success: false, error: "customerId required" });

  try {
    // ZoooomUser is PK IdUser + SK email, so a Query on the partition key alone is
    // correct and cheap — a Get would need the email we do not have yet.
    const userRes = await ddb.send(new QueryCommand({
      TableName: USER_TABLE,
      KeyConditionExpression: "IdUser = :u",
      ExpressionAttributeValues: { ":u": customerId },
      Limit: 1,
    }));
    const customer = (userRes.Items || [])[0];
    if (!customer) return reply(404, { success: false, error: "customer not found", customerId });

    const [garage, listings, wl, offers, sellerDeals, buyerDeals] = await Promise.all([
      queryAll({ TableName: VEHICLE_TABLE, IndexName: "userId-index",
                 KeyConditionExpression: "userId = :u", ExpressionAttributeValues: { ":u": customerId } }),
      // Sparse index: imported craigslist listings carry no userId and so correctly
      // never appear in a customer's own list.
      queryAll({ TableName: LISTING_TABLE, IndexName: "userId-index",
                 KeyConditionExpression: "userId = :u", ExpressionAttributeValues: { ":u": customerId } }),
      scanFiltered(WISHLIST_TABLE, "userId = :u", { ":u": customerId }),
      queryAll({ TableName: OFFERS_TABLE, IndexName: "byBidderIdIndex",
                 KeyConditionExpression: "bidderId = :u", ExpressionAttributeValues: { ":u": customerId } }),
      queryAll({ TableName: DEALS_TABLE, IndexName: "bySellerIdIndex",
                 KeyConditionExpression: "sellerId = :u", ExpressionAttributeValues: { ":u": customerId } }),
      queryAll({ TableName: DEALS_TABLE, IndexName: "byBuyerIdIndex",
                 KeyConditionExpression: "buyerId = :u", ExpressionAttributeValues: { ":u": customerId } }),
    ]);

    // Offers carry no vehicle description, so pull the titles from their deals in one
    // batch — a list of bare amounts is not something staff can act on.
    const dealIds = [...new Set(offers.map((o) => o.dealId).filter(Boolean))];
    const dealTitles = {};
    for (let i = 0; i < dealIds.length; i += 100) {
      const chunk = dealIds.slice(i, i + 100);
      const r = await ddb.send(new BatchGetCommand({
        RequestItems: { [DEALS_TABLE]: { Keys: chunk.map((id) => ({ id })) } },
      }));
      for (const d of r.Responses?.[DEALS_TABLE] || []) {
        dealTitles[d.id] = { vehicleTitle: d.vehicleTitle ?? null, vin: d.vin ?? null };
      }
    }

    const sold = dealSplit(sellerDeals);
    const purchased = dealSplit(buyerDeals);

    return reply(200, {
      success: true,
      customer: {
        id: customer.IdUser,
        firstName: customer.firstName ?? null,
        lastName: customer.lastName ?? null,
        name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || null,
        email: customer.email ?? null,
        phone: customer.phone ?? null,
        createdAt: customer.createdAt ?? null,
      },
      // An archived vehicle is a DELETED one (ZoooomDeleteVehicle archives rather than
      // hard-deletes), so it must not be counted as sitting in the customer's garage.
      // Staff still need to see it exists, hence a separate count rather than a silent drop.
      garage: {
        count: garage.filter((v) => v.archived !== true).length,
        archivedCount: garage.filter((v) => v.archived === true).length,
        items: garage.filter((v) => v.archived !== true).map(vehicleView),
        archivedItems: garage.filter((v) => v.archived === true).map(vehicleView),
      },
      listings: { count: listings.length, items: listings.map(listingView) },
      wishlist: { count: wl.items.length, items: wl.items.map(wishlistView) },
      offersMade: {
        count: offers.length,
        items: offers
          .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
          .map((o) => ({
            id: o.id,
            amount: num(o.amount ?? o.cashAmount),
            status: o.status ?? null,
            dealId: o.dealId ?? null,
            createdAt: o.createdAt ?? null,
            vehicleTitle: dealTitles[o.dealId]?.vehicleTitle ?? null,
            vin: dealTitles[o.dealId]?.vin ?? null,
          })),
      },
      sold: {
        count: sold.completed.length,
        awaitingConfirmation: sold.awaiting.length,
        items: sold.completed.map((d) => dealView(d, "buyerName")),
      },
      purchased: {
        count: purchased.completed.length,
        awaitingConfirmation: purchased.awaiting.length,
        items: purchased.completed.map((d) => dealView(d, "sellerName")),
      },
      // Only ever true when a cap actually stopped us — see header note 1.
      truncated: { wishlist: wl.truncated },
      viewedBy: staff || "system",
    });
  } catch (e) {
    console.error("[customerOverview] failed:", e);
    return reply(500, { success: false, error: e.message });
  }
};

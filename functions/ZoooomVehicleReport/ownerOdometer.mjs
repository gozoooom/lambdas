/**
 * Owner-entered odometer for a VIN (garage / listing).
 *
 * WHY: the report used to price a car off the odometer in Vehicle Databases'
 * SALES HISTORY — a reading taken at some past sale, and null for most VINs.
 * When there's no reading the Market Value section falls back to asking the
 * viewer to type state + mileage by hand. But the owner ALREADY entered the
 * odometer when they added or listed the car, so the report should use it.
 *
 * ZoooomVehicle_<env> is keyed (vin HASH, userId RANGE), so one Query by VIN is
 * cheap and needs no index. The listing wizard writes the odometer straight onto
 * that row (same value that lands on ZoooomVehicleListing_<env>), so the garage
 * row covers listed and unlisted cars alike — no listing-table scan needed.
 */
import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const VEHICLE_TABLE = process.env.VEHICLE_TABLE || null;
// Listing rows carry the odometer typed into the sell wizard. Only consulted when
// the garage row itself has none (some listing paths write mileage to the listing
// but leave the garage row at 0) — fetched by id off the garage row, never scanned.
const LISTING_TABLE = process.env.LISTING_TABLE || null;

const isListed = (r) => (r.isListed === true || !!r.listingId ? 1 : 0);
const ts = (r) => new Date(r.updatedAt || 0).getTime() || 0;

/**
 * @returns {{mileage:number, state:string|null, listed:boolean, updatedAt:string|null}|null}
 */
export async function getOwnerOdometer({ docClient, vin }) {
  if (!docClient || !VEHICLE_TABLE || !vin) return null;
  try {
    const r = await docClient.send(new QueryCommand({
      TableName: VEHICLE_TABLE,
      KeyConditionExpression: "vin = :v",
      ExpressionAttributeValues: { ":v": vin },
    }));
    // A VIN can sit in several garages (prior owner, claim in review). Prefer the
    // row that's actually listed — that odometer is the published one — then the
    // most recently touched. Archived rows never win.
    const live = (r?.Items || []).filter((i) => !i.archived);
    const rows = live
      .filter((i) => Number(i.mileage) > 0)
      .sort((a, b) => isListed(b) - isListed(a) || ts(b) - ts(a));
    const top = rows[0];
    if (top) {
      return {
        mileage: Number(top.mileage),
        state: (top.state || "").toUpperCase() || null,
        listed: isListed(top) === 1,
        updatedAt: top.updatedAt || null,
      };
    }
    // No garage odometer — try the listing the seller published, if there is one.
    const withListing = live
      .filter((i) => i.listingId)
      .sort((a, b) => ts(b) - ts(a))[0];
    if (!withListing || !LISTING_TABLE) return null;
    const l = await docClient.send(new GetCommand({
      TableName: LISTING_TABLE,
      Key: { id: String(withListing.listingId) },
    }));
    const mileage = Number(l?.Item?.mileage); // stored as a string on some rows
    if (!(mileage > 0)) return null;
    return {
      mileage,
      state: (l.Item.state || withListing.state || "").toUpperCase() || null,
      listed: true,
      updatedAt: l.Item.updatedAt || withListing.updatedAt || null,
    };
  } catch (e) {
    console.warn("⚠️ Owner odometer read failed:", e.message);
    return null;
  }
}

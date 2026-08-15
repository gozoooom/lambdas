/**
 * Recalls the OWNER has checked off in the garage ("I got this one fixed").
 *
 * WHY: the garage recall list has a checkbox that writes
 * `notification_status: "acknowledged"` onto that recall entry of the garage row
 * (ZoooomUpdateRecall). The report's open-recall count, though, came straight
 * from NHTSA's model-level campaign list and never saw the acknowledgement — so
 * a car whose recalls were all repaired still read "2 open recalls" and still
 * carried the recall deduction in its score. Checking the box did nothing.
 *
 * Both sides key off the SAME identifier, so they match exactly: the garage
 * recall rows are built by ZoooomMidnightCheckRecall from NHTSA
 * recallsByVehicle with `recall_number` = `NHTSACampaignNumber`, which is what
 * knownIssues.mjs collects as `campaigns`. Normalized for case/punctuation only.
 *
 * Read-only, and the same single Query-by-VIN as ownerOdometer.mjs
 * (ZoooomVehicle_<env> is keyed vin HASH / userId RANGE, so no index needed).
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

const VEHICLE_TABLE = process.env.VEHICLE_TABLE || null;

/** "23V-123 000" → "23V123000" so formatting differences never miss a match. */
export const normCampaign = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * @returns {Promise<string[]>} sorted, de-duplicated normalized campaign numbers
 *   the owner marked repaired. Sorted so the joined value is a stable cache key.
 */
export async function getOwnerRecallAcks({ docClient, vin }) {
  if (!docClient || !VEHICLE_TABLE || !vin) return [];
  try {
    const r = await docClient.send(new QueryCommand({
      TableName: VEHICLE_TABLE,
      KeyConditionExpression: "vin = :v",
      ExpressionAttributeValues: { ":v": vin },
    }));
    const acks = new Set();
    for (const row of r?.Items || []) {
      // A VIN can sit in several garages (prior owner, claim in review). An
      // archived row is a car the user removed — its check-offs don't count.
      if (row.archived) continue;
      for (const rc of Array.isArray(row.recall) ? row.recall : []) {
        // "acknowledged" = owner ticked it off; "archived" = they then filed it
        // away. Both mean the same thing for the report — the repair happened —
        // so archiving must never make a recall look open again.
        const st = rc?.notification_status;
        if ((st === "acknowledged" || st === "archived") && rc?.recall_number) {
          acks.add(normCampaign(rc.recall_number));
        }
      }
    }
    return [...acks].filter(Boolean).sort();
  } catch (e) {
    console.warn("⚠️ Owner recall acknowledgements read failed:", e.message);
    return [];
  }
}

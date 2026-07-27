/**
 * Title-check cache.
 *
 * WHY: Vehicle Databases' /title-check is slow AND highly variable — measured
 * 10.4s / 14.1s / 20.2s on three consecutive calls for the same VIN. With
 * VD_TIMEOUT_MS=20000 sitting inside that distribution, ~23% of prod report
 * requests (33/142 over 14 days) aborted the title lookup and rendered
 * "Title brand & salvage — unavailable" on cars whose title was actually clean.
 * The whole report then got frozen into REPORTS_TABLE for 30 days.
 *
 * Mirrors the ZoooomStolenChecks pattern: ONE cross-env table (PK `vin`, no
 * _dev/_prod suffix — one VIN, all envs share), at most one live call per VIN
 * per TITLE_REGEN_DAYS, every record carries `checkedAt`.
 *
 * Two rules carried over from the stolen-check lambda:
 *   1. Only a genuine success is ever cached. A timeout/401/5xx is NEVER
 *      frozen in as a false "clean title".
 *   2. On a live failure we fall back to a STALE cached record if we have one.
 *      Title brands change rarely, so month-old truth beats "unavailable" —
 *      and it means a VIN we've ever successfully checked never regresses
 *      because of a vendor blip.
 */

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getTitleCheck } from "./vehicleDatabasesClient.mjs";

const REGEN_DAYS = Number(process.env.TITLE_REGEN_DAYS || "30");

const ageDays = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;

/** Shape stored in DynamoDB → the same shape vehicleDatabasesClient.getTitleCheck returns. */
function toTitle(row) {
  if (!row) return null;
  return {
    salvage: !!row.salvage,
    salvage_details: Array.isArray(row.salvage_details) ? row.salvage_details : [],
    checkedAt: row.checkedAt || null,
  };
}

/**
 * Cached title/salvage lookup.
 * @returns {Promise<{salvage:boolean, salvage_details:Array, checkedAt:string|null,
 *                    cached?:boolean, stale?:boolean} | null>}
 *   null ONLY when we have neither a live answer nor any cached record — the
 *   caller must keep rendering that as "not verified", never as "clean".
 */
export async function getTitleCheckCached({ docClient, table, vin, regenDays = REGEN_DAYS }) {
  // No table configured → straight passthrough (preserves today's behaviour).
  if (!docClient || !table) return getTitleCheck(vin);

  // 1. Fresh cache hit → skip the 10–20s call entirely.
  let row = null;
  try {
    const res = await docClient.send(new GetCommand({ TableName: table, Key: { vin } }));
    row = res?.Item || null;
    if (row?.checkedAt && ageDays(row.checkedAt) < regenDays) {
      console.log(`✅ title-check cache HIT ${vin} (checked ${row.checkedAt})`);
      return { ...toTitle(row), cached: true };
    }
  } catch (e) {
    console.warn("⚠️ title-check cache read failed:", e.message);
  }

  // 2. Miss or stale → live call.
  const live = await getTitleCheck(vin);

  if (live) {
    const checkedAt = new Date().toISOString();
    try {
      await docClient.send(new PutCommand({
        TableName: table,
        Item: {
          vin,
          salvage: !!live.salvage,
          salvage_details: Array.isArray(live.salvage_details) ? live.salvage_details : [],
          checkedAt,
        },
      }));
    } catch (e) {
      console.warn("⚠️ title-check cache write failed:", e.message);
    }
    return { ...live, checkedAt, cached: false };
  }

  // 3. Live call failed. Serve stale rather than regressing to "unavailable".
  if (row?.checkedAt) {
    console.warn(`⚠️ title-check live call failed for ${vin} — serving STALE (${row.checkedAt})`);
    return { ...toTitle(row), cached: true, stale: true };
  }

  // 4. Nothing live, nothing cached → honest "not verified".
  return null;
}

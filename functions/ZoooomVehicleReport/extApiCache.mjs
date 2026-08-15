/**
 * Persistent last-good cache for slow external APIs (FEMA flood, NHTSA known
 * issues). When an upstream HANGS or errors, we serve the PREVIOUS good result
 * instead of degrading the report section to empty. Stored in the report cache
 * table under an `EXT#...` partition key (real VINs never collide). Best-effort:
 * these helpers never throw, so a cache miss/error just falls through.
 */
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

export async function readExtCache(cache, key) {
  if (!cache?.docClient || !cache?.table) return null;
  try {
    const r = await cache.docClient.send(
      new GetCommand({ TableName: cache.table, Key: { vin: `EXT#${key}` } })
    );
    return r.Item?.value ? JSON.parse(r.Item.value) : null;
  } catch {
    return null;
  }
}

export async function writeExtCache(cache, key, value, ttlDays = 45) {
  if (!cache?.docClient || !cache?.table) return;
  try {
    await cache.docClient.send(
      new PutCommand({
        TableName: cache.table,
        Item: {
          vin: `EXT#${key}`,
          value: JSON.stringify(value),
          cachedAt: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + ttlDays * 86400,
        },
      })
    );
  } catch {
    /* best-effort — a failed write must never break report generation */
  }
}

/**
 * Free-report usage + anti-fraud guard for the Verified Vehicle Report.
 *
 * v2 (prod-oriented, June 30 2026) — see GUARD-DESIGN.md. Replaces the old
 * NAT-hostile "≥N lifetime accounts per exact IP" block. Now:
 *   - the per-user 3-VIN cap (the real free-tier limit) is ENFORCED in all modes;
 *   - abuse is bounded by COST, not identity: a windowed, TTL'd rate per coarse
 *     IP PREFIX (v4 /24, v6 /48) + a global daily report budget;
 *   - `guardMode: "monitor"` (default) computes every decision and LOGS what it
 *     WOULD block, but allows everything — shadow mode for gathering real firing
 *     rates (incl. NAT false positives) before enforcing;
 *   - `guardMode: "enforce"` applies the soft denials (caller serves the preview);
 *   - fail-open on any table error.
 *
 * Table (REPORT_USAGE_TABLE, schema pk:S / sk:S, DynamoDB TTL on `expiresAt`):
 *   U#<userId>   / VIN#<vin>   -> a VIN this user unlocked (lifetime; the cap)   {ip, prefix, ts}
 *   U#<userId>   / META        -> firstSeen/lastSeen (account-age proxy)
 *   PFX#<prefix> / H#<hour>    -> windowed report-grant count for an IP prefix    {count, expiresAt}
 *   BUDGET#<day> / TOTAL       -> daily report-grant count (cost backstop)        {count, expiresAt}
 *
 * The old lifetime `IP#<ip>` / `D#<deviceId>` account-count rows are NO LONGER
 * written or read (they never decayed → a busy NAT blocked forever).
 */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const sanitize = (s) => String(s || "").replace(/[^A-Za-z0-9._:/-]/g, "").slice(0, 128);
const epochSec = (ms) => Math.floor(ms / 1000);
const dayKey = (d) => d.toISOString().slice(0, 10);

/** Coarse IP prefix so shared/NAT/CGNAT clients aggregate instead of each user
 *  looking like a distinct "IP". v4 → /24, v6 → /48. */
function ipPrefix(ip) {
  const s = sanitize(ip);
  if (!s) return null;
  if (s.includes(":")) return `v6:${s.split(":").slice(0, 3).join(":")}::/48`;
  const o = s.split(".");
  return o.length === 4 ? `v4:${o[0]}.${o[1]}.${o[2]}.0/24` : `v4:${s}`;
}

async function countItems(docClient, table, pk) {
  const r = await docClient.send(
    new QueryCommand({ TableName: table, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, Select: "COUNT" })
  );
  return r?.Count ?? 0;
}

/** Atomically increment a windowed counter and return the new value; sets a TTL
 *  (epoch seconds) on first write so the window auto-decays. */
async function bumpCounter(docClient, table, pk, sk, ttlSec) {
  const r = await docClient.send(
    new UpdateCommand({
      TableName: table,
      Key: { pk, sk },
      UpdateExpression: "ADD #c :one SET expiresAt = if_not_exists(expiresAt, :ttl)",
      ExpressionAttributeNames: { "#c": "count" },
      ExpressionAttributeValues: { ":one": 1, ":ttl": ttlSec },
      ReturnValues: "UPDATED_NEW",
    })
  );
  return r?.Attributes?.count ?? 1;
}

const softMessage = (reason) =>
  reason === "daily_budget"
    ? "Free reports are at capacity for today — please try again later."
    : "You're generating reports faster than our free tier allows — please try again shortly.";

/**
 * Decide whether to grant a FREE full report for (userId, vin) and record it.
 * Returns { allowed, already, reason, message, count, wouldBlock }.
 *   - already=true     → previously unlocked this VIN; always allowed, no charge against the cap.
 *   - allowed=false    → per_user_limit (all modes) OR, in enforce mode, prefix_rate / daily_budget.
 *   - wouldBlock       → in monitor mode, the reason the guard WOULD have soft-denied (else null).
 */
export async function checkAndReserveReport({
  docClient,
  table,
  userId,
  vin,
  deviceId,
  ip,
  perUserLimit = 3,
  config = {},
  now = new Date(),
}) {
  if (!docClient || !table || !userId || !vin) return { allowed: true, reason: "no_table" };

  const mode = config.guardMode === "enforce" ? "enforce" : "monitor";
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const uId = sanitize(userId);
  const v = sanitize(vin);
  const dev = sanitize(deviceId);
  const prefix = ipPrefix(ip);
  const userPk = `U#${uId}`;
  const vinSk = `VIN#${v}`;

  try {
    // 1. Already unlocked this VIN → free re-view, no counters touched.
    const existing = await docClient.send(new GetCommand({ TableName: table, Key: { pk: userPk, sk: vinSk } }));
    if (existing?.Item) return { allowed: true, already: true, reason: "already_unlocked" };

    // 2. Per-user lifetime cap (distinct VINs) — the real free-tier limit. Enforced in ALL modes.
    const used = await countItems(docClient, table, userPk);
    if (used >= perUserLimit) {
      return { allowed: false, reason: "per_user_limit", count: used, message: `You've used all ${perUserLimit} of your free vehicle reports.` };
    }

    // 3. Windowed per-PREFIX rate (TTL'd) — replaces the lifetime per-IP account count.
    const shadow = [];
    if (prefix) {
      const rateCap = Number(config.prefixRatePerHour ?? 60);
      const hb = Math.floor(nowMs / 3_600_000);
      const rate = await bumpCounter(docClient, table, `PFX#${prefix}`, `H#${hb}`, epochSec(nowMs) + 7_200);
      if (rateCap > 0 && rate > rateCap) shadow.push({ reason: "prefix_rate", prefix, rate, cap: rateCap });
    }

    // 4. Global daily budget backstop (0/undefined = disabled).
    const budgetCap = Number(config.dailyReportBudget ?? 0);
    if (budgetCap > 0) {
      const spent = await bumpCounter(docClient, table, `BUDGET#${dayKey(now)}`, "TOTAL", epochSec(nowMs) + 172_800);
      if (spent > budgetCap) shadow.push({ reason: "daily_budget", spent, cap: budgetCap });
    }

    const wouldBlock = shadow[0] || null;

    // 5. Enforce mode → apply the first soft-deny. Monitor mode → log + allow.
    if (wouldBlock && mode === "enforce") {
      console.warn(`🚩 [report-guard] ENFORCE deny=${wouldBlock.reason} ${JSON.stringify({ user: uId, vin: v, prefix, dev, ...wouldBlock })}`);
      return { allowed: false, reason: wouldBlock.reason, flagged: true, message: softMessage(wouldBlock.reason), wouldBlock: wouldBlock.reason };
    }
    if (wouldBlock) {
      console.warn(`🟡 [report-guard] SHADOW would_block=${wouldBlock.reason} ${JSON.stringify({ user: uId, vin: v, prefix, dev, used, ...wouldBlock })}`);
    }

    // Reserve: the U#/VIN# row is the source of truth for the cap (lifetime, no TTL).
    await docClient.send(new PutCommand({ TableName: table, Item: { pk: userPk, sk: vinSk, ip: sanitize(ip) || null, prefix: prefix || null, deviceId: dev || null, ts: nowIso } }));
    // First-seen/last-seen (account-age proxy for future risk scoring; best-effort).
    docClient
      .send(new UpdateCommand({ TableName: table, Key: { pk: userPk, sk: "META" }, UpdateExpression: "SET firstSeen = if_not_exists(firstSeen, :t), lastSeen = :t", ExpressionAttributeValues: { ":t": nowIso } }))
      .catch(() => {});

    console.log(`✅ [report-guard] grant ${JSON.stringify({ user: uId, vin: v, prefix, used: used + 1, mode, wouldBlock: wouldBlock?.reason || null })}`);
    return { allowed: true, reason: "reserved", count: used + 1, wouldBlock: wouldBlock?.reason || null };
  } catch (e) {
    // Fail open — never block a paying-customer-to-be over an infra hiccup.
    console.warn("⚠️ [report-guard] failed (allowing):", e.message);
    return { allowed: true, reason: "guard_error" };
  }
}

/**
 * Release a reservation made by checkAndReserveReport — deletes the U#/VIN# row
 * so the VIN no longer counts against the per-user free cap. Used when the report
 * turned out to have no data to show (we don't charge a free slot for a VIN we
 * couldn't find anything on). Best-effort, idempotent.
 */
export async function releaseReport({ docClient, table, userId, vin }) {
  if (!docClient || !table || !userId || !vin) return;
  try {
    await docClient.send(
      new DeleteCommand({ TableName: table, Key: { pk: `U#${sanitize(userId)}`, sk: `VIN#${sanitize(vin)}` } })
    );
    console.log(`↩️ [report-guard] released reservation ${JSON.stringify({ user: sanitize(userId), vin: sanitize(vin) })}`);
  } catch (e) {
    console.warn("⚠️ [report-guard] release failed:", e.message);
  }
}

/**
 * List the VINs a user has unlocked (for the "Your reports" history), newest
 * first. Returns [{ vin, ts }]. Best-effort — [] on any error.
 */
export async function listUserReports({ docClient, table, userId, limit = 20 }) {
  if (!docClient || !table || !userId) return [];
  try {
    const r = await docClient.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :vin)",
        ExpressionAttributeValues: { ":pk": `U#${sanitize(userId)}`, ":vin": "VIN#" },
        Limit: 200,
      })
    );
    return (r?.Items || [])
      .map((it) => ({ vin: String(it.sk || "").replace(/^VIN#/, ""), ts: it.ts || null }))
      .sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")))
      .slice(0, limit);
  } catch (e) {
    console.warn("listUserReports failed:", e.message);
    return [];
  }
}

/**
 * Paid report credits (bought after the 3 free): a per-user balance of report
 * unlocks usable on any VIN. Stored at U#<userId> / CREDITS as a running
 * { granted, spent } (credit = granted − spent). Purchases are recorded once per
 * Stripe session (sk PURCHASE#<sessionId>) so a re-confirm never double-grants.
 */
export async function getReportCredits({ docClient, table, userId }) {
  if (!docClient || !table || !userId) return 0;
  try {
    const r = await docClient.send(
      new GetCommand({ TableName: table, Key: { pk: `U#${sanitize(userId)}`, sk: "CREDITS" } })
    );
    const it = r?.Item;
    return Math.max(0, (Number(it?.granted) || 0) - (Number(it?.spent) || 0));
  } catch (e) {
    console.warn("getReportCredits failed:", e.message);
    return 0;
  }
}

/** Grant N credits for a paid purchase — idempotent per Stripe sessionId. Returns
 *  { granted:boolean, credits:number }. */
export async function grantReportCredits({ docClient, table, userId, count, sessionId }) {
  if (!docClient || !table || !userId || !count) return { granted: false, credits: 0 };
  const uPk = `U#${sanitize(userId)}`;
  try {
    // Idempotency guard: record the purchase once; if it already exists, skip.
    if (sessionId) {
      try {
        await docClient.send(
          new PutCommand({
            TableName: table,
            Item: { pk: uPk, sk: `PURCHASE#${sanitize(sessionId)}`, count, ts: new Date().toISOString() },
            ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          })
        );
      } catch (e) {
        if (e?.name === "ConditionalCheckFailedException") {
          return { granted: false, already: true, credits: await getReportCredits({ docClient, table, userId }) };
        }
        throw e;
      }
    }
    const r = await docClient.send(
      new UpdateCommand({
        TableName: table,
        Key: { pk: uPk, sk: "CREDITS" },
        UpdateExpression: "ADD granted :n",
        ExpressionAttributeValues: { ":n": count },
        ReturnValues: "ALL_NEW",
      })
    );
    const it = r?.Attributes || {};
    return { granted: true, credits: Math.max(0, (Number(it.granted) || 0) - (Number(it.spent) || 0)) };
  } catch (e) {
    console.warn("grantReportCredits failed:", e.message);
    return { granted: false, credits: 0 };
  }
}

/** Spend one credit to unlock a VIN (also records the U#/VIN# unlock so re-views
 *  are free). Returns true if a credit was available and spent. */
export async function spendReportCredit({ docClient, table, userId, vin, now = new Date().toISOString() }) {
  if (!docClient || !table || !userId) return false;
  const uPk = `U#${sanitize(userId)}`;
  try {
    // Atomically increment `spent` only while spent < granted (a credit exists).
    await docClient.send(
      new UpdateCommand({
        TableName: table,
        Key: { pk: uPk, sk: "CREDITS" },
        UpdateExpression: "ADD spent :one",
        // if_not_exists() is an UPDATE-expression function — DynamoDB rejects it in a
        // condition ("The function is not allowed in a condition expression"), which
        // made every credit spend fail, so purchased reports never unlocked. The
        // attribute_not_exists() branch covers a balance that has never been spent.
        ConditionExpression: "attribute_exists(granted) AND (attribute_not_exists(spent) OR granted > spent)",
        ExpressionAttributeValues: { ":one": 1 },
      })
    );
    // Record the unlock so re-viewing this VIN is free.
    await docClient.send(
      new PutCommand({ TableName: table, Item: { pk: uPk, sk: `VIN#${sanitize(vin)}`, paid: true, ts: now } })
    );
    return true;
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") return false; // no credit
    console.warn("spendReportCredit failed:", e.message);
    return false;
  }
}

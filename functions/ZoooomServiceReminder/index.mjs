/**
 * ZoooomServiceReminder — daily maintenance-reminder sweep.
 *
 * Trigger: EventBridge daily schedule → invoke with { task: "service_reminder_sweep" }
 * (also accepts a raw Scheduled Event). Can also be invoked ad-hoc for one vehicle:
 *   { vin, userId }  — recompute + (re)persist that vehicle's next service.
 *
 * For each owned vehicle it:
 *   1. reads the de-duplicated service history (ZoooomServiceRecord GSI vehicleId-index),
 *   2. computes the next due service via maintenanceSchedule.mjs (OEM MMYT intervals,
 *      "whichever comes first" of miles vs months, miles/day learned from history),
 *   3. persists nextServiceDate / nextServiceMile / nextServiceItem back onto the
 *      ZoooomVehicle row (so the garage + report can read it without recomputing),
 *   4. if that service is due within REMIND_WITHIN_DAYS (default 7) — or overdue —
 *      and we haven't already reminded for THIS service+due-date, invokes
 *      ZoooomOfferNotification with { eventType: "SERVICE_REMINDER", ... }.
 *
 * The notifier owns the opt-in gate (reuses the "Service Notifications" preference)
 * and the email/inbox send. This lambda only decides WHAT is due.
 *
 * Per-env config is resolved from the INVOKED ALIAS qualifier at runtime (Dev/
 * Staging/Prod → _dev/_staging/_prod tables + same-env ZoooomOfferNotification
 * alias). One published version serves all envs; $LATEST = dev.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { computeSchedule } from "./maintenanceSchedule.mjs";

const REGION = process.env.AWS_REGION || "us-west-2";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const lambda = new LambdaClient({ region: REGION });

const SERVICE_RECORDS_INDEX = process.env.SERVICE_RECORDS_INDEX || "vehicleId-index";
const REMIND_WITHIN_DAYS = Number(process.env.REMIND_WITHIN_DAYS || "7");
// Don't re-nudge on items that have been overdue for ages (stale/mismatched data).
const OVERDUE_GRACE_DAYS = Number(process.env.OVERDUE_GRACE_DAYS || "45");

// ── per-env resolution via the invoked alias qualifier ──────────────────────
// One published version serves all envs: EventBridge/callers invoke the Dev,
// Staging or Prod alias and we resolve tables + the downstream notifier to the
// matching env at runtime (same pattern as ZoooomOfferNotification/DealOffer).
// $LATEST (no qualifier) = dev. NEVER point a prod/staging alias at $LATEST.
let currentQualifier; // 'Staging' | 'Prod' | undefined ($LATEST → dev)
const SUFFIX_BY_QUALIFIER = { Staging: "_staging", staging: "_staging", Prod: "_prod", prod: "_prod" };
function tableSuffix() { return SUFFIX_BY_QUALIFIER[currentQualifier] || "_dev"; }
function vehiclesTable() { return `ZoooomVehicle${tableSuffix()}`; }
function serviceRecordsTable() { return `ZoooomServiceRecord${tableSuffix()}`; }
// Invoke the SAME-env notifier alias so its inbox/email use the matching env
// tables. Dev ($LATEST) → unqualified ZoooomOfferNotification (its $LATEST=dev).
// NOTE: ZoooomOfferNotification's env aliases are LOWERCASE (staging/prod), so we
// lowercase the qualifier here regardless of our own alias casing.
function notificationFn() {
  if (!currentQualifier) return "ZoooomOfferNotification";
  return `ZoooomOfferNotification:${currentQualifier.toLowerCase()}`;
}
function parseQualifierFromArn(arn) {
  if (!arn) return undefined;
  const parts = arn.split(":");
  return parts.length >= 8 ? parts[7] : undefined; // ...:function:Name:QUALIFIER
}

const nowIso = () => new Date().toISOString();

async function getServiceHistory(vin) {
  try {
    const r = await ddb.send(new QueryCommand({
      TableName: serviceRecordsTable(),
      IndexName: SERVICE_RECORDS_INDEX,
      KeyConditionExpression: "vehicleId = :v",
      ExpressionAttributeValues: { ":v": vin },
    }));
    return r.Items || [];
  } catch (e) {
    console.error("[getServiceHistory]", vin, e?.message);
    return [];
  }
}

async function notify(payload) {
  try {
    await lambda.send(new InvokeCommand({
      FunctionName: notificationFn(),
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    }));
    return true;
  } catch (e) {
    console.warn("[notify] non-blocking:", e?.message || e);
    return false;
  }
}

function vehicleTitle(v) {
  const t = [v.year, v.make, v.model].filter(Boolean).join(" ").trim();
  return t || v.vin || "your vehicle";
}

/**
 * Process one vehicle: compute → persist → maybe remind.
 * Returns { vin, computed, reminded, reason }.
 */
async function processVehicle(v, { asOf } = {}) {
  const vin = v.vin || v.vehicleId;
  const userId = v.userId;
  if (!vin || !userId) return { vin, computed: false, reminded: false, reason: "missing vin/userId" };

  const rawRecords = await getServiceHistory(vin);
  const sched = computeSchedule(rawRecords, {
    year: v.year, make: v.make, model: v.model, trim: v.trim,
    mileage: v.mileage,
  }, { asOf });

  const next = sched.nextService;

  // Persist next-service fields (or clear them when nothing is predictable).
  await ddb.send(new UpdateCommand({
    TableName: vehiclesTable(),
    Key: { vin, userId },
    UpdateExpression: next
      ? "SET nextServiceDate = :d, nextServiceMile = :m, nextServiceItem = :i, milesPerDayEst = :mpd, scheduleUpdatedAt = :ts"
      : "SET scheduleUpdatedAt = :ts REMOVE nextServiceDate, nextServiceMile, nextServiceItem",
    ExpressionAttributeValues: next
      ? { ":d": next.dueDate, ":m": next.dueMileage ?? null, ":i": next.label, ":mpd": sched.milesPerDay, ":ts": nowIso() }
      : { ":ts": nowIso() },
  }));

  if (!next) return { vin, computed: true, reminded: false, reason: "no prediction" };

  // Reminder window: due within N days (or recently overdue, within grace).
  const d = next.daysRemaining;
  const inWindow = d <= REMIND_WITHIN_DAYS && d >= -OVERDUE_GRACE_DAYS;
  if (!inWindow) return { vin, computed: true, reminded: false, reason: `due in ${d}d (outside window)` };

  // Dedupe: one reminder per service+due-date cycle.
  const reminderKey = `${vin}#${next.key}#${next.dueDate}`;
  if (v.lastServiceReminderKey === reminderKey) {
    return { vin, computed: true, reminded: false, reason: "already reminded this cycle" };
  }

  const sent = await notify({
    eventType: "SERVICE_REMINDER",
    userId,
    vin,
    vehicleTitle: vehicleTitle(v),
    serviceLabel: next.label,
    dueDate: next.dueDate,
    dueMileage: next.dueMileage,
    currentMileage: sched.currentMileage,
    milesRemaining: next.milesRemaining,
    daysRemaining: d,
    basis: next.basis,
    overdue: d < 0,
  });

  // Mark reminded (even if the notifier suppresses the email on opt-out — inbox
  // is still delivered, and we don't want to re-attempt the same cycle daily).
  if (sent) {
    await ddb.send(new UpdateCommand({
      TableName: vehiclesTable(),
      Key: { vin, userId },
      UpdateExpression: "SET lastServiceReminderKey = :k, lastServiceReminderAt = :ts",
      ExpressionAttributeValues: { ":k": reminderKey, ":ts": nowIso() },
    }));
  }

  return { vin, computed: true, reminded: sent, reason: sent ? `reminded (${d}d, ${next.basis})` : "notify failed" };
}

async function sweep({ asOf } = {}) {
  let scanned = 0, reminded = 0, lastKey;
  const results = [];
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: vehiclesTable(),
      ExclusiveStartKey: lastKey,
    }));
    const items = r.Items || [];
    for (const v of items) {
      scanned++;
      try {
        const out = await processVehicle(v, { asOf });
        if (out.reminded) reminded++;
        results.push(out);
      } catch (e) {
        console.error("[sweep] vehicle failed", v?.vin, e?.message);
      }
    }
    lastKey = r.LastEvaluatedKey;
  } while (lastKey);

  console.log(`[sweep] scanned ${scanned} vehicles, sent ${reminded} reminders`);
  return { scanned, reminded, results };
}

export const handler = async (event = {}, context) => {
  // Resolve env (tables + downstream notifier) from the invoked alias.
  currentQualifier = parseQualifierFromArn(context?.invokedFunctionArn);
  console.log(`[ServiceReminder] qualifier=${currentQualifier || "$LATEST(dev)"} tables=${vehiclesTable()}/${serviceRecordsTable()} notifier=${notificationFn()}`);

  const isSchedule =
    event?.task === "service_reminder_sweep" ||
    event?.["detail-type"] === "Scheduled Event" ||
    event?.source === "aws.events";

  // Ad-hoc single-vehicle recompute: { vin, userId } (e.g. called after a record add).
  // Load the persisted row first so dedupe state (lastServiceReminderKey) and any
  // stored year/make/model/mileage are present; the event may override fields.
  if (event?.vin && event?.userId && !isSchedule) {
    let row = null;
    try {
      const r = await ddb.send(new GetCommand({
        TableName: vehiclesTable(), Key: { vin: event.vin, userId: event.userId },
      }));
      row = r.Item || null;
    } catch (e) { console.warn("[handler] getVehicle failed:", e?.message); }
    const v = { ...(row || {}), ...event };
    const out = await processVehicle(v, { asOf: event.asOf });
    return { ok: true, ...out };
  }

  if (isSchedule || Object.keys(event).length === 0) {
    return await sweep({ asOf: event?.asOf });
  }

  return { ok: false, error: "Unrecognized invocation", event };
};

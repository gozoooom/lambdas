/**
 * ZoooomAuditTrail — the append-only record of who changed what, and when.
 *
 * TRIGGER  DynamoDB streams (INSERT/MODIFY/REMOVE) on the in-scope business
 *          tables, all three envs. One record in => one audit row.
 *
 * WHY STREAMS AND NOT AN AUDIT CALL IN EVERY LAMBDA: the previous design
 * (ZoooomInternalUserActionAuditLog) asked 389 lambdas to remember to log. Its
 * table held ZERO rows. A forgotten audit call is an ABSENCE — invisible to code
 * review, exactly the failure class env-config-check.sh exists to catch. Streams
 * make coverage structural: a write that isn't audited is impossible, because the
 * audit is downstream of the write rather than beside it.
 *
 * WHAT THIS CAN AND CANNOT KNOW. The stream carries the ROW, not the caller. So:
 *   • WHAT / WHEN / BEFORE / AFTER  — always captured, cannot be bypassed.
 *   • WHO — only as good as the actor the writer stamped on the row
 *     (updatedBy / lastUpdatedBy / approvedBy / createdBy). Unstamped writes are
 *     recorded with actorId "unknown" rather than silently attributed, so the gap
 *     is VISIBLE and countable (query byActor = "unknown" to measure coverage).
 *   • DELETES cannot be attributed at all — a removed row can't say who removed
 *     it. Prefer soft-delete/archive (as ZoooomDeleteVehicle already does), or
 *     stamp deletedBy immediately before the delete.
 *
 * IMMUTABILITY IS ENFORCED IN IAM, NOT HERE. This function runs as
 * ZoooomAuditWriterRole: stream read + PutItem on ZoooomAudit_{env} and nothing
 * else — it cannot alter or delete what it has written. Every other lambda runs
 * as basic-user-role, which carries an explicit DENY on Update/Delete/Put against
 * the audit tables. Tables have PITR + deletion protection on. An audit trail the
 * application can rewrite is not evidence.
 *
 * FAIL CLOSED. A failed write THROWS so the stream retries (5 attempts, batch
 * bisected on error), and exhausted records land in the ZoooomAuditDLQ queue
 * rather than disappearing. Losing an audit record silently is the one outcome
 * worse than a wedged shard.
 *
 * Env:
 *   AUDIT_TABLE_OVERRIDE  optional; normally the env is read from the stream ARN
 *                         and the table is ZoooomAudit_{env}.
 *   MAX_IMAGE_BYTES       default 120000. Above this the row images are dropped
 *                         and only the changed FIELD NAMES are kept (see below).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const REGION = process.env.AWS_REGION || "us-west-2";
const TABLE_OVERRIDE = process.env.AUDIT_TABLE_OVERRIDE || "";
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || "120000");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

/** arn:…:table/ZoooomVehicleListing_prod/stream/… -> {table, base, env} */
function parseStreamArn(arn) {
  const m = /table\/([A-Za-z0-9_.-]+)\/stream\//.exec(arn || "");
  if (!m) return null;
  const table = m[1];
  const em = /^(.*)_(dev|staging|prod)$/.exec(table);
  if (!em) return null;
  return { table, base: em[1], env: em[2] };
}

/** "ZoooomVehicleListing" -> "VehicleListing"; "KycSession" -> "KycSession". */
const entityTypeOf = (base) => base.replace(/^Zoooom/, "") || base;

/**
 * Fields we record as "changed" but never copy the value of. Auditing must not
 * become a second, less-guarded copy of identity documents and bank tokens —
 * that would enlarge the breach surface in the name of controlling it.
 */
const SENSITIVE = /(password|passwd|secret|token|accesstoken|refresh|apikey|api_key|ssn|socialsecurity|dob|dateofbirth|licensenumber|dlnumber|documentnumber|docnumber|cardnumber|cvv|routing|accountnumber|bankaccount|iban|selfie|image64|base64|imagedata|rawimage)/i;

const REDACTED = "[redacted]";

function redact(value, key = "") {
  if (SENSITIVE.test(key)) return REDACTED;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value instanceof Set) return `[set:${value.size}]`;
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

const stable = (v) => {
  try {
    return JSON.stringify(v, (_k, val) => (val instanceof Set ? [...val].sort() : val));
  } catch {
    return String(v);
  }
};

/**
 * Which top-level attributes actually differ. This — not the full images — is
 * what a reviewer reads, and it's what makes "someone changed a price" findable
 * instead of buried in two 40 KB blobs.
 */
function diffFields(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changed = [];
  for (const k of keys) {
    // Our own marker is not a business change; recording it would make every
    // announced signup look like it was edited.
    if (k === "slackSignupTs") continue;
    if (stable(before?.[k]) !== stable(after?.[k])) changed.push(k);
  }
  return changed.sort();
}

/**
 * Who did this, as stamped on the row.
 *
 * NEVER fall back across actions. `createdBy` describes the FIRST write only, so
 * accepting it for an UPDATE blames the original creator for someone else's
 * change — attribution that reads as authoritative and is simply false. A
 * fabricated actor is worse than an admitted gap: the gap is measurable
 * (query byActor = "unknown"), the fabrication is invisible and gets believed.
 * Caught by the dev lifecycle e2e, which saw an unstamped price change
 * attributed to the listing's creator.
 *
 * A hard DELETE is genuinely unattributable — the row that could name the actor
 * is the row being removed. We say so explicitly rather than guessing, and the
 * fix is upstream: soft-delete/archive (as ZoooomDeleteVehicle does) or stamp
 * deletedBy immediately before the delete.
 */
function resolveActor(image, action) {
  if (!image) return { actorId: "unknown", actorSource: "none" };
  const candidates = {
    // At create, updatedBy/lastUpdatedBy DO describe this same write.
    CREATE: ["createdBy", "updatedBy", "lastUpdatedBy", "invitedBy"],
    UPDATE: ["updatedBy", "lastUpdatedBy", "approvedBy", "reviewedBy"],
    DELETE: ["deletedBy", "archivedBy", "removedBy"],
  }[action] || [];
  for (const f of candidates) {
    const v = image[f];
    if (typeof v === "string" && v.trim()) return { actorId: v.trim(), actorSource: f };
  }
  return {
    actorId: "unknown",
    actorSource: action === "DELETE" ? "unattributable-delete" : "not-stamped",
  };
}

/**
 * A Cognito sub means a human; the handful of literal strings the codebase
 * stamps ("api", "system", "first-login…") mean a machine path. Classifying
 * lets a reviewer filter staff actions from background jobs, which is the whole
 * point of segregation-of-duties evidence.
 */
function classifyActor(actorId) {
  if (!actorId || actorId === "unknown") return "unknown";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actorId)) return "user";
  if (/@/.test(actorId)) return "user";
  if (/^(api|system|lambda|cron|first-login|.*-system|.*-importer|craigslist.*)$/i.test(actorId)) return "system";
  return "other";
}

const ACTION = { INSERT: "CREATE", MODIFY: "UPDATE", REMOVE: "DELETE" };

function buildAuditItem(rec, parsed) {
  const action = ACTION[rec.eventName];
  if (!action) return null;

  const New = rec.dynamodb?.NewImage ? unmarshall(rec.dynamodb.NewImage) : null;
  const Old = rec.dynamodb?.OldImage ? unmarshall(rec.dynamodb.OldImage) : null;
  const keys = rec.dynamodb?.Keys ? unmarshall(rec.dynamodb.Keys) : {};

  const entityType = entityTypeOf(parsed.base);
  const entityId = Object.keys(keys).sort().map((k) => `${keys[k]}`).join("|") || "unknown";

  // The DATABASE's clock, not this function's — an audit timestamp taken at
  // processing time drifts from the event under retry or backlog.
  const secs = rec.dynamodb?.ApproximateCreationDateTime;
  const ts = new Date((secs ? secs * 1000 : Date.now())).toISOString();

  // seq is deterministic (eventID, unique per stream record), so a stream RETRY
  // rewrites the identical row instead of appending a phantom second event.
  const seq = `${ts}#${rec.eventID || "noid"}`;

  const changedFields = action === "UPDATE" ? diffFields(Old, New) : Object.keys(New || Old || {}).sort();
  const { actorId, actorSource } = resolveActor(action === "DELETE" ? Old : New, action);

  const item = {
    entity: `${entityType}#${entityId}`,
    seq,
    day: ts.slice(0, 10),
    ts,
    env: parsed.env,
    sourceTable: parsed.table,
    entityType,
    entityId,
    action,
    actorId,
    actorType: classifyActor(actorId),
    actorSource,       // which field the actor came from — provenance of the provenance
    actorEmail: (New?.updatedByEmail || New?.email || Old?.email || "") + "" || undefined,
    changedFields,
    changedCount: changedFields.length,
    eventId: rec.eventID,
    streamSeq: rec.dynamodb?.SequenceNumber,
    recordedBy: "ZoooomAuditTrail",
  };

  // Full images make an audit row self-contained: a reviewer sees the actual
  // before/after without needing the row to still exist. But an oversized item
  // is a REJECTED item, i.e. a lost audit record, so field names win over values
  // when we can't have both.
  const beforeR = Old ? redact(Old) : undefined;
  const afterR = New ? redact(New) : undefined;
  const bytes = (stable(beforeR) || "").length + (stable(afterR) || "").length;
  if (bytes <= MAX_IMAGE_BYTES) {
    item.before = beforeR;
    item.after = afterR;
  } else {
    item.imagesOmitted = true;
    item.imageBytes = bytes;
    // Keep the changed values only, still redacted, still bounded.
    const slim = {};
    for (const k of changedFields.slice(0, 40)) {
      slim[k] = { before: redact(Old?.[k], k), after: redact(New?.[k], k) };
    }
    const slimStr = stable(slim);
    if (slimStr.length <= MAX_IMAGE_BYTES) item.changes = slim;
  }
  return item;
}

export const handler = async (event = {}) => {
  const records = Array.isArray(event.Records)
    ? event.Records.filter((r) => r.eventSource === "aws:dynamodb")
    : [];
  if (!records.length) return { ok: true, written: 0, reason: "no dynamodb records" };

  let written = 0, skipped = 0;
  const failures = [];

  for (const rec of records) {
    const parsed = parseStreamArn(rec.eventSourceARN);
    if (!parsed) {
      // An unrecognised source is a wiring mistake, not a record to drop quietly.
      console.error("[audit] UNMAPPED_STREAM", rec.eventSourceARN);
      skipped++;
      continue;
    }
    const table = TABLE_OVERRIDE || `ZoooomAudit_${parsed.env}`;
    let item;
    try {
      item = buildAuditItem(rec, parsed);
    } catch (e) {
      console.error("[audit] BUILD_FAILED", parsed.table, rec.eventID, e.message);
      failures.push({ eventId: rec.eventID, stage: "build", error: e.message });
      continue;
    }
    if (!item) { skipped++; continue; }

    try {
      await ddb.send(new PutCommand({ TableName: table, Item: item }));
      written++;
    } catch (e) {
      // Log the whole record before rethrowing: CloudWatch becomes the backstop
      // copy even if every retry and the DLQ also fail.
      console.error("[audit] WRITE_FAILED", table, rec.eventID, e.message, JSON.stringify(item).slice(0, 4000));
      failures.push({ eventId: rec.eventID, stage: "write", error: e.message });
    }
  }

  if (failures.length) {
    // Throwing is deliberate: the ESM retries, then routes to ZoooomAuditDLQ.
    // Swallowing here would turn a write failure into a permanent silent gap.
    throw new Error(`[audit] ${failures.length}/${records.length} record(s) not recorded: ${JSON.stringify(failures).slice(0, 1000)}`);
  }
  return { ok: true, written, skipped, seen: records.length };
};

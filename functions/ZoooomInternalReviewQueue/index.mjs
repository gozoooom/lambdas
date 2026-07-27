/**
 * ZoooomInternalReviewQueue — one API behind the internal Review Inbox.
 *
 * Before this existed the internal dashboard could only action ONE of the three
 * review queues (duplicate-VIN claims). Blocked sellers and flagged photos were
 * announced in Slack but there was nowhere to actually dispose of them.
 *
 *   GET  /review/queues            -> all three queues, open items only
 *   POST /review/decision          -> approve / reject one item
 *
 * Queues:
 *   kyc         KycSession_{env}, decision=REVIEW — a seller whose verification
 *               could not be decided automatically. THIS BLOCKS THEIR LISTING.
 *   fraud       ZoooomFraudReview_{env}, status=PENDING — duplicate-VIN claim.
 *   moderation  ZoooomModerationReview_{env}, status=PENDING — flagged photos.
 *
 * EVERY table name comes from the environment with NO fallback. A previous
 * version of the fraud lambda defaulted to a hardcoded ZoooomUser_prod, so a
 * missing variable silently pointed staging at real production users. Fail
 * closed instead — see the startup check below.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  QueryCommand,
  GetCommand,
  UpdateCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.REGION || process.env.AWS_REGION || "us-west-2";
const KYC_TABLE = process.env.KYC_TABLE;
const FRAUD_TABLE = process.env.FRAUD_TABLE;
const MODERATION_TABLE = process.env.MODERATION_TABLE;
const TENANT_ID = process.env.TENANT_ID || "zoooom";

for (const [name, val] of Object.entries({ KYC_TABLE, FRAUD_TABLE, MODERATION_TABLE })) {
  if (!val) {
    throw new Error(`${name} is not set — refusing to start rather than guess a table.`);
  }
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};
const respond = (statusCode, body) => ({
  statusCode,
  headers: { ...CORS, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Internal-audit reason codes are not operator-facing English, and several read
 * as far more alarming than they are (ADDRESS_MISMATCH is usually just a move).
 * Translate; pass unknown codes through rather than dropping them silently.
 */
const REASON_TEXT = {
  TITLE_NAME_MISMATCH: "Name on title doesn't match their licence",
  REGISTRATION_NAME_MISMATCH: "Name on title doesn't match their licence",
  TITLE_NAME_NOT_FOUND_AND_VIN_UNCONFIRMED: "Couldn't read the owner name, and the VIN didn't confirm",
  REGISTRATION_NAME_NOT_FOUND: "Couldn't read the owner name off the document",
  ADDRESS_MISMATCH: "Address differs between licence and title (often just a move)",
  FACE_MATCH_BORDERLINE: "Selfie/licence face match was borderline",
  VIN_NOT_EXTRACTED: "No VIN found on the document",
  VIN_MISMATCH: "VIN on the document doesn't match the vehicle",
  OFAC_POTENTIAL_MATCH: "Possible sanctions-list match — check before releasing",
  OFAC_SCREENING_UNAVAILABLE: "Sanctions screening was unavailable (failed closed)",
};
const describeReasons = (reasons) => {
  const list = (reasons || []).filter(Boolean);
  if (!list.length) return "No reason recorded";
  return list.map((r) => REASON_TEXT[r] || r).join(" · ");
};

async function scanAll(TableName, params = {}) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new ScanCommand({ TableName, ...params, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * Open KYC reviews.
 *
 * KycSession has no disposition column, so "open" is derived. A seller who was
 * reviewed and then re-verified successfully on their own carries a KYC#STATUS
 * with a newer verifiedAt — that is NOT a work item. Dropping those is what
 * keeps the queue trustworthy; a list that nags about resolved cases stops
 * being read, which is worse than no list.
 */
async function kycQueue() {
  const rows = await scanAll(KYC_TABLE);
  const verifiedAt = new Map();
  for (const r of rows) {
    if (r.sk === "KYC#STATUS" && r.verified) verifiedAt.set(r.pk, r.verifiedAt || "");
  }
  return rows
    .filter((r) => String(r.sk || "").startsWith("vfy#") && r.decision === "REVIEW")
    .filter((r) => {
      const done = verifiedAt.get(r.pk);
      return !(done && done > (r.updatedAt || r.createdAt || ""));
    })
    .map((r) => ({
      queue: "kyc",
      id: r.verificationId || String(r.sk).replace(/^vfy#/, ""),
      userId: r.userId || String(r.pk || "").split("#")[1] || null,
      at: r.updatedAt || r.createdAt || "",
      who: [r.dlFirstName, r.dlLastName].filter(Boolean).join(" ") || "Unknown seller",
      vin: r.vin || null,
      why: describeReasons(r.decisionReasons),
      reasonCodes: r.decisionReasons || [],
      detail: {
        faceSimilarity: r.faceSimilarity ?? null,
        vinMatch: r.vinMatch ?? null,
        nameOnTitle: r.registrationName || null,
        addressOnTitle: r.registrationAddress || null,
        dlExpiration: r.dlExpiration || null,
        documents: Object.keys(r.keys || {}),
      },
    }))
    .sort((a, b) => (a.at || "").localeCompare(b.at || ""));
}

async function pendingQueue(TableName, queue) {
  const rows = await scanAll(TableName, {
    FilterExpression: "#s = :p",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":p": "PENDING" },
  });
  return rows
    .map((r) => ({
      queue,
      id: r.reviewId,
      userId: r.newUserId || r.userId || null,
      at: r.createdAt || "",
      who: r.newUserEmail || r.userEmail || "Unknown user",
      vin: r.vin || null,
      why:
        queue === "fraud"
          ? `Claiming a VIN already in another garage — proof: ${r.verificationMethod || "none"} (${r.proofStrength || "unknown"})`
          : `${Array.isArray(r.rejected) ? r.rejected.length : "Some"} photo(s) flagged${r.listingId ? ` on listing ${r.listingId}` : ""}`,
      detail:
        queue === "fraud"
          ? {
              previousUserId: r.previousUserId || null,
              previousEmail: r.previousEmail || null,
              proofStrength: r.proofStrength || null,
              verificationMethod: r.verificationMethod || null,
              proofS3Key: r.proofS3Key || null,
            }
          : { listingId: r.listingId || null, rejected: r.rejected || [] },
    }))
    .sort((a, b) => (a.at || "").localeCompare(b.at || ""));
}

/**
 * Approving a KYC review is the whole point of the queue: it writes the durable
 * KYC#STATUS record, which is what kycUserStatus reads. Without that write the
 * seller stays stuck being asked to re-scan their licence forever, because a
 * REVIEW alone never marks them verified.
 */
async function decideKyc({ id, userId, decision, reviewer, notes }) {
  const pk = `${TENANT_ID}#${userId}`;
  const sk = `vfy#${id}`;
  const existing = await ddb.send(new GetCommand({ TableName: KYC_TABLE, Key: { pk, sk } }));
  if (!existing.Item) return respond(404, { error: "Verification session not found" });
  const s = existing.Item;
  const now = new Date().toISOString();
  const approved = decision === "approve";

  await ddb.send(
    new UpdateCommand({
      TableName: KYC_TABLE,
      Key: { pk, sk },
      UpdateExpression:
        "SET #s = :st, decision = :st, reviewedAt = :now, reviewedBy = :by, reviewNotes = :notes",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":st": approved ? "VERIFIED" : "FAILED",
        ":now": now,
        ":by": reviewer || "internal",
        ":notes": notes || "",
      },
    })
  );

  if (approved) {
    await ddb.send(
      new PutCommand({
        TableName: KYC_TABLE,
        Item: {
          pk,
          sk: "KYC#STATUS",
          verified: true,
          lastVerificationId: id,
          dlExpiration: s.dlExpiration || null,
          dlFirstName: s.dlFirstName || null,
          dlLastName: s.dlLastName || null,
          dlState: s.dlState || null,
          registeredState: s.registrationState || s.dlState || null,
          licensePlate: s.registrationLicensePlate || null,
          verifiedAt: now,
          updatedAt: now,
          schemaVersion: 1,
          manuallyApprovedBy: reviewer || "internal",
        },
      })
    );
  }
  return respond(200, { ok: true, queue: "kyc", id, decision, unblocked: approved });
}

async function decidePending({ TableName, queue, id, decision, reviewer, notes }) {
  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: { reviewId: id },
      UpdateExpression:
        "SET #s = :st, reviewedAt = :now, reviewedBy = :by, reviewNotes = :notes, updatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":st": decision === "approve" ? "APPROVED" : "REJECTED",
        ":now": new Date().toISOString(),
        ":by": reviewer || "internal",
        ":notes": notes || "",
      },
    })
  );
  return respond(200, { ok: true, queue, id, decision });
}

export const handler = async (event = {}) => {
  const method = event.httpMethod || event.requestContext?.http?.method || "GET";
  if (method === "OPTIONS") return respond(200, {});

  try {
    if (method === "GET") {
      const [kyc, fraud, moderation] = await Promise.all([
        kycQueue(),
        pendingQueue(FRAUD_TABLE, "fraud"),
        pendingQueue(MODERATION_TABLE, "moderation"),
      ]);
      return respond(200, {
        counts: { kyc: kyc.length, fraud: fraud.length, moderation: moderation.length,
                  total: kyc.length + fraud.length + moderation.length },
        queues: { kyc, fraud, moderation },
      });
    }

    if (method === "POST") {
      const body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
      const { queue, id, decision, userId, reviewer, notes } = body;
      if (!queue || !id || !decision) {
        return respond(400, { error: "queue, id and decision are required" });
      }
      if (!["approve", "reject"].includes(decision)) {
        return respond(400, { error: "decision must be 'approve' or 'reject'" });
      }
      if (queue === "kyc") {
        if (!userId) return respond(400, { error: "userId is required for kyc decisions" });
        return await decideKyc({ id, userId, decision, reviewer, notes });
      }
      if (queue === "fraud") {
        return await decidePending({ TableName: FRAUD_TABLE, queue, id, decision, reviewer, notes });
      }
      if (queue === "moderation") {
        return await decidePending({ TableName: MODERATION_TABLE, queue, id, decision, reviewer, notes });
      }
      return respond(400, { error: `unknown queue '${queue}'` });
    }

    return respond(405, { error: `method ${method} not allowed` });
  } catch (e) {
    console.error("[reviewQueue]", e);
    return respond(500, { error: e.message || "Server error" });
  }
};

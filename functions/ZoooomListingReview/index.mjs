/**
 * ZoooomListingReview — surfaces everything awaiting human review into Slack.
 *
 * Two delivery paths, one function:
 *   ALERT   DynamoDB streams on the three review tables. Fires the moment an
 *           item lands in review, so nothing sits unseen.
 *   DIGEST  EventBridge cron. Everything still open, oldest first, so an item
 *           nobody clicked on can't quietly rot.
 *
 * PROD ONLY by design — every table below is explicitly `_prod`. There is no
 * env switch: dev carries test traffic (11 REVIEW rows at time of writing) and
 * a dev run pointing at this channel would bury the real queue in noise. Same
 * rule as ZoooomDailyStats. See RELEASE-RUNBOOK §1.
 *
 * Sources:
 *   KycSession_prod             decision=REVIEW  — seller identity/title couldn't
 *                               be auto-verified. THIS ONE BLOCKS A LISTING.
 *   ZoooomFraudReview_prod      status=PENDING   — duplicate-VIN ownership claim
 *   ZoooomModerationReview_prod status=PENDING   — flagged listing photos / chat
 *
 * Env:
 *   LISTING_REVIEW_CHANNEL  Slack channel ID. Empty => render to logs, never post.
 *   SLACK_SECRET_ID         default zoooom/slack/support-bot (reuses support bot)
 *   REVIEW_DASHBOARD_URL    optional. If set, each item links to <url>?id=<id>.
 *   POST_WHEN_EMPTY         "false" to stay silent on a clean queue. Default true:
 *                           a daily "queue is clear" line is the heartbeat that
 *                           tells you silence means "nothing to do", not "job died".
 *   DIGEST_MAX_PER_SECTION  default 10, then "+N more".
 *
 * Invoke {dryRun:true} to render the digest to logs without posting.
 */
import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const REGION = process.env.AWS_REGION || "us-west-2";
/**
 * One channel per queue — the team has a dedicated channel for each, and
 * routing everything into one defeats the point of having them. A queue with
 * no channel configured logs instead of posting, so nothing lands in the wrong
 * place just because a variable is missing.
 */
const CHANNEL = process.env.LISTING_REVIEW_CHANNEL || "";
const CHANNEL_BY_QUEUE = {
  kyc: process.env.LISTING_REVIEW_CHANNEL || "",
  fraud: process.env.OWNERSHIP_REVIEW_CHANNEL || "",
  moderation: process.env.PHOTO_REVIEW_CHANNEL || process.env.LISTING_REVIEW_CHANNEL || "",
};
const channelFor = (queue) => CHANNEL_BY_QUEUE[queue] || CHANNEL;
const SLACK_SECRET_ID = process.env.SLACK_SECRET_ID || "zoooom/slack/support-bot";
const DASHBOARD_URL = process.env.REVIEW_DASHBOARD_URL || "";
const POST_WHEN_EMPTY = (process.env.POST_WHEN_EMPTY || "true") !== "false";
const MAX_PER_SECTION = Number(process.env.DIGEST_MAX_PER_SECTION || "10");

const KYC_TABLE = "KycSession_prod";
const FRAUD_TABLE = "ZoooomFraudReview_prod";
const MODERATION_TABLE = "ZoooomModerationReview_prod";

const ddb = new DynamoDBClient({ region: REGION });
const sm = new SecretsManagerClient({ region: REGION });

/**
 * Why a seller landed in review, in words an operator can act on. The raw codes
 * are internal audit strings and several are actively misleading out of context
 * (ADDRESS_MISMATCH usually just means "they moved"), so we translate rather
 * than dump them. Unknown codes fall through verbatim — better an ugly string
 * than a silently dropped reason.
 */
const REASON_TEXT = {
  TITLE_NAME_MISMATCH: "Name on title doesn't match their licence",
  REGISTRATION_NAME_MISMATCH: "Name on title doesn't match their licence",
  TITLE_NAME_NOT_FOUND_AND_VIN_UNCONFIRMED: "Couldn't read the owner name, and the VIN didn't confirm",
  REGISTRATION_NAME_NOT_FOUND: "Couldn't read the owner name off the document",
  ADDRESS_MISMATCH: "Address differs between licence and title (often just a move)",
  FACE_MATCH_BORDERLINE: "Selfie/licence face match was borderline",
  VIN_NOT_EXTRACTED: "No VIN found on the document",
  OFAC_POTENTIAL_MATCH: "Possible sanctions-list match — check before releasing",
  OFAC_SCREENING_UNAVAILABLE: "Sanctions screening was unavailable (failed closed)",
};

const describeReasons = (reasons) => {
  const list = (reasons || []).filter(Boolean);
  if (!list.length) return "No reason recorded";
  return list.map((r) => REASON_TEXT[r] || r).join(" · ");
};

/** "3d" / "4h" / "12m" — how long this has been waiting. */
function ageLabel(iso) {
  const t = Date.parse(iso || "");
  if (Number.isNaN(t)) return "?";
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}

/** Age in whole hours, for the stale-item callout. */
const ageHours = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isNaN(t) ? 0 : (Date.now() - t) / 3600000;
};

const link = (id) => (DASHBOARD_URL && id ? ` <${DASHBOARD_URL}?id=${encodeURIComponent(id)}|open>` : "");

/** Name we can show without dumping a full identity record into a chat channel. */
function shortName(first, last) {
  const f = (first || "").trim();
  const l = (last || "").trim();
  if (!f && !l) return "unknown seller";
  if (!f) return l;
  return `${f[0]}. ${l}`.trim();
}

async function scanAll(TableName, ProjectionExpression, ExpressionAttributeNames, filter) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName,
        ProjectionExpression,
        ...(ExpressionAttributeNames ? { ExpressionAttributeNames } : {}),
        ...(filter || {}),
        ExclusiveStartKey,
      })
    );
    for (const it of res.Items || []) items.push(unmarshall(it));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * Open KYC reviews.
 *
 * KycSession has no disposition column, so "open" has to be derived. A seller
 * who was reviewed and then simply re-ran verification successfully is NOT a
 * work item — their KYC#STATUS carries a verifiedAt newer than the review. We
 * drop those, otherwise the digest nags forever about cases that resolved
 * themselves, and a queue that cries wolf stops being read.
 */
async function openKycReviews() {
  const rows = await scanAll(
    KYC_TABLE,
    "pk, sk, userId, #d, decisionReasons, createdAt, updatedAt, dlFirstName, dlLastName, vin, verified, verifiedAt, lastVerificationId, verificationId",
    { "#d": "decision" }
  );

  const verifiedAtByPk = new Map();
  for (const r of rows) {
    if (r.sk === "KYC#STATUS" && r.verified) verifiedAtByPk.set(r.pk, r.verifiedAt || "");
  }

  return rows
    .filter((r) => String(r.sk || "").startsWith("vfy#") && r.decision === "REVIEW")
    .filter((r) => {
      const resolvedAt = verifiedAtByPk.get(r.pk);
      // Verified AFTER this review landed => the seller resolved it themselves.
      return !(resolvedAt && resolvedAt > (r.updatedAt || r.createdAt || ""));
    })
    .map((r) => ({
      kind: "kyc",
      id: r.verificationId || String(r.sk || "").replace(/^vfy#/, ""),
      at: r.updatedAt || r.createdAt || "",
      who: shortName(r.dlFirstName, r.dlLastName),
      vin: r.vin || null,
      why: describeReasons(r.decisionReasons),
    }))
    .sort((a, b) => (a.at || "").localeCompare(b.at || ""));
}

async function openPending(table, kind) {
  const rows = await scanAll(
    table,
    "reviewId, #s, createdAt, vin, newUserEmail, userEmail, listingId, proofStrength, verificationMethod, rejected",
    { "#s": "status" },
    {
      FilterExpression: "#s = :p",
      ExpressionAttributeValues: { ":p": { S: "PENDING" } },
    }
  );
  return rows
    .map((r) => ({
      kind,
      id: r.reviewId,
      at: r.createdAt || "",
      who: r.newUserEmail || r.userEmail || "unknown user",
      vin: r.vin || null,
      why:
        kind === "fraud"
          ? `Claiming a VIN already in another garage — proof: ${r.verificationMethod || "none"} (${r.proofStrength || "unknown"})`
          : `${Array.isArray(r.rejected) ? r.rejected.length : "Some"} photo(s) flagged${r.listingId ? ` on listing ${r.listingId}` : ""}`,
    }))
    .sort((a, b) => (a.at || "").localeCompare(b.at || ""));
}

function renderSection(title, items) {
  if (!items.length) return null;
  const shown = items.slice(0, MAX_PER_SECTION);
  const lines = shown.map((i) => {
    const vin = i.vin ? ` · VIN ${i.vin}` : "";
    return `• *${ageLabel(i.at)}* — ${i.who}${vin}\n     ${i.why}${link(i.id)}`;
  });
  if (items.length > shown.length) lines.push(`• _+${items.length - shown.length} more_`);
  return `*${title}* (${items.length})\n${lines.join("\n")}`;
}

function renderDigest({ kyc, fraud, moderation }) {
  const total = kyc.length + fraud.length + moderation.length;
  if (!total) return "✅ *Review queue is clear* — nothing awaiting review.";

  const sections = [
    renderSection("🚗 Listings blocked on seller verification", kyc),
    renderSection("🔁 Duplicate-VIN ownership claims", fraud),
    renderSection("🖼️ Flagged listing photos", moderation),
  ].filter(Boolean);

  const head = `📋 *${total} item${total === 1 ? "" : "s"} awaiting review*`;

  // Call out anything that's been sitting for over two days. A seller blocked
  // this long has almost certainly given up and gone to Craigslist.
  const stale = [...kyc, ...fraud, ...moderation].filter((i) => ageHours(i.at) >= 48);
  const tail = stale.length
    ? `\n⏳ _${stale.length} item${stale.length === 1 ? " has" : "s have"} been waiting 2+ days._`
    : "";

  return [head, ...sections].join("\n\n") + tail;
}

function renderAlert(item) {
  const titles = {
    kyc: "🚗 Listing blocked — seller verification needs review",
    fraud: "🔁 Duplicate-VIN ownership claim",
    moderation: "🖼️ Listing photos flagged",
  };
  const vin = item.vin ? `\n*VIN:* ${item.vin}` : "";
  return `⚠️ *${titles[item.kind] || "Needs review"}*\n*Who:* ${item.who}${vin}\n*Why:* ${item.why}${link(item.id)}`;
}

async function postSlack(text, channel = CHANNEL) {
  if (!channel) {
    console.warn("no channel configured for this post — not sending. Would have sent:\n" + text);
    return { ok: false, reason: "no_channel", preview: text };
  }
  const sec = await sm.send(new GetSecretValueCommand({ SecretId: SLACK_SECRET_ID }));
  const creds = JSON.parse(sec.SecretString || "{}");
  if (!creds.botToken) {
    console.warn("no Slack botToken — skipping");
    return { ok: false, reason: "no_token" };
  }
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${creds.botToken}`,
    },
    body: JSON.stringify({ channel, text, unfurl_links: false }),
  });
  const j = await r.json();
  if (!j.ok) console.warn("Slack post failed:", j.error);
  return j;
}

/**
 * Stream record -> alertable item, or null.
 *
 * Only fires on the TRANSITION into review. kycRun writes the session row
 * several times over one verification (IN_PROGRESS, then the decision, then
 * OFAC downgrades), so alerting on "NewImage says REVIEW" alone would post the
 * same case two or three times. Comparing against OldImage is the only way to
 * tell "just landed here" from "was already here".
 */
function streamRecordToItem(record) {
  const table = (record.eventSourceARN || "").split("/")[1] || "";
  const New = record.dynamodb?.NewImage ? unmarshall(record.dynamodb.NewImage) : null;
  const Old = record.dynamodb?.OldImage ? unmarshall(record.dynamodb.OldImage) : null;
  if (!New) return null;

  if (table === KYC_TABLE) {
    if (!String(New.sk || "").startsWith("vfy#")) return null;
    if (New.decision !== "REVIEW") return null;
    if (Old && Old.decision === "REVIEW") return null; // already alerted
    return {
      kind: "kyc",
      id: New.verificationId || String(New.sk || "").replace(/^vfy#/, ""),
      at: New.updatedAt || New.createdAt || "",
      who: shortName(New.dlFirstName, New.dlLastName),
      vin: New.vin || null,
      why: describeReasons(New.decisionReasons),
    };
  }

  const kind = table === FRAUD_TABLE ? "fraud" : table === MODERATION_TABLE ? "moderation" : null;
  if (!kind) return null;
  if (New.status !== "PENDING") return null;
  if (Old && Old.status === "PENDING") return null;
  return {
    kind,
    id: New.reviewId,
    at: New.createdAt || "",
    who: New.newUserEmail || New.userEmail || "unknown user",
    vin: New.vin || null,
    why:
      kind === "fraud"
        ? `Claiming a VIN already in another garage — proof: ${New.verificationMethod || "none"} (${New.proofStrength || "unknown"})`
        : `${Array.isArray(New.rejected) ? New.rejected.length : "Some"} photo(s) flagged${New.listingId ? ` on listing ${New.listingId}` : ""}`,
  };
}

export const handler = async (event = {}) => {
  // ── ALERT: DynamoDB stream ────────────────────────────────────────────────
  if (Array.isArray(event.Records) && event.Records[0]?.eventSource === "aws:dynamodb") {
    const items = event.Records.map(streamRecordToItem).filter(Boolean);
    if (!items.length) return { ok: true, mode: "alert", posted: 0, seen: event.Records.length };

    let posted = 0;
    for (const item of items) {
      // One failed post must not poison the batch — a thrown error would make
      // Lambda retry the whole shard and re-alert everything that did succeed.
      try {
        const res = await postSlack(renderAlert(item), channelFor(item.kind));
        if (res.ok) posted++;
      } catch (e) {
        console.error("alert post failed for", item.kind, item.id, e);
      }
    }
    return { ok: true, mode: "alert", posted, seen: event.Records.length };
  }

  // ── DIGEST: scheduled ─────────────────────────────────────────────────────
  const [kyc, fraud, moderation] = await Promise.all([
    openKycReviews(),
    openPending(FRAUD_TABLE, "fraud"),
    openPending(MODERATION_TABLE, "moderation"),
  ]);

  const total = kyc.length + fraud.length + moderation.length;
  const text = renderDigest({ kyc, fraud, moderation });

  if (event.dryRun) {
    console.log(text);
    return { ok: true, mode: "digest", dryRun: true, counts: { kyc: kyc.length, fraud: fraud.length, moderation: moderation.length }, preview: text };
  }

  if (!total && !POST_WHEN_EMPTY) {
    return { ok: true, mode: "digest", posted: false, reason: "empty_queue" };
  }

  const res = await postSlack(text);
  return {
    ok: true,
    mode: "digest",
    posted: res.ok === true,
    counts: { kyc: kyc.length, fraud: fraud.length, moderation: moderation.length },
    slack: res.error || res.reason || "sent",
  };
};

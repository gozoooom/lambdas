/**
 * ZoooomMechanicReferralTrack — turns consumer activity into mechanic rewards.
 *
 * The mechanic hands a customer a QR code. That customer lands on zoooom.me with
 * ?mref=ZM-XXXXXX, signs up, and later does something real — scans a service
 * record, lists a car, or buys one. This function is the only place that decides
 * a referral "counted", and every fifth one mints a $10 reward for the shop.
 *
 * ROUTE (mechanic gateway h7g4lqgvof, stages dev/staging/prod):
 *   POST /MechanicReferral   { action, … }
 *
 * ACTIONS
 *   attribute  { referralCode, consumerUserId, email }   consumer signed up via a code
 *   qualify    { consumerUserId, qualifyingAction }      consumer did the real thing
 *   lookup     { referralCode }                          validate a code for the UI
 *
 * A CONSUMER COUNTS ONCE, EVER. The rule is "every 5 new consumers", not every 5
 * actions — otherwise one enthusiastic customer scanning ten service records
 * pays the shop $20 on their own. The first qualifying action flips the
 * attribution row's `qualified` flag under a condition; every later action for
 * that consumer loses the condition and stops there without touching the
 * counter.
 *
 * THE COUNTER IS THE SOURCE OF TRUTH, NOT A COUNT(). Qualification does an
 * atomic ADD on the referral row and reads the new value back. Two customers
 * qualifying in the same second get 4 and 5, not 4 and 4 — so the milestone
 * fires exactly once. Counting rows in the GSI instead would double-mint under
 * concurrency and silently drift if a row were ever repaired by hand.
 *
 * Rewards land in PENDING_ISSUE. Nothing here moves money; a human issues the
 * gift card after ZoooomMechanicRewardNotify posts it to Slack.
 *
 * Tables (all _{env}):
 *   ZoooomMechanicReferral             referralCode (HASH)
 *   ZoooomMechanicReferralAttribution  consumerUserId (HASH) · GSI ReferralCodeIndex
 *   ZoooomMechanicReward               rewardId (HASH)
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.REGION || process.env.AWS_REGION || "us-west-2";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const MILESTONE_BONUS_USD = Number(process.env.MILESTONE_BONUS_USD || 10);
const MILESTONE_EVERY = Number(process.env.MILESTONE_EVERY || 5);

/**
 * What counts. Kept as an explicit allow-list rather than "any non-empty
 * string" so a new consumer event can't start paying out shops just by being
 * named plausibly — adding one is a deliberate edit here.
 */
const QUALIFYING_ACTIONS = new Set(["service_record_scan", "list_vehicle", "purchase_vehicle"]);

const ACTION_LABELS = {
  service_record_scan: "scanned a service record",
  list_vehicle: "listed a car",
  purchase_vehicle: "bought a car",
};

function envSuffix(context) {
  const qualifier = (context?.invokedFunctionArn || "").split(":").pop() || "";
  if (/staging/i.test(qualifier)) return "_staging";
  if (/prod/i.test(qualifier)) return "_prod";
  return "_dev";
}

const tables = (context) => {
  const s = envSuffix(context);
  return {
    referral: process.env.REFERRAL_TABLE || `ZoooomMechanicReferral${s}`,
    attribution: process.env.ATTRIBUTION_TABLE || `ZoooomMechanicReferralAttribution${s}`,
    reward: process.env.REWARD_TABLE || `ZoooomMechanicReward${s}`,
  };
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Content-Type": "application/json",
};
const reply = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max).trim() : undefined);

function identityFromEvent(event) {
  const claims = event?.requestContext?.authorizer?.claims;
  if (claims?.sub) return { userId: claims.sub, email: claims.email || null };
  const h = event?.headers || {};
  const raw = h.Authorization || h.authorization || "";
  const parts = raw.replace(/^Bearer\s+/i, "").trim().split(".");
  if (parts.length !== 3) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return { userId: payload.sub || null, email: payload.email || null };
  } catch {
    return {};
  }
}

const normaliseCode = (v) => (str(v, 20) || "").toUpperCase().replace(/\s/g, "");

async function getReferral(T, referralCode) {
  const r = await ddb.send(new GetCommand({ TableName: T.referral, Key: { referralCode } }));
  return r.Item || null;
}

// ── actions ──────────────────────────────────────────────────────────────────

/**
 * Record that a consumer arrived through a shop's code.
 *
 * First code wins. A consumer who later clicks a second shop's QR keeps their
 * original attribution — last-touch would let shops poach each other's
 * customers by re-scanning them, and the whole point is rewarding the shop that
 * actually brought the person in.
 */
async function attribute(T, { referralCode, consumerUserId, email, source }) {
  const referral = await getReferral(T, referralCode);
  if (!referral || referral.status !== "active") {
    return { ok: false, status: 404, error: "unknown or inactive referral code" };
  }

  const item = {
    consumerUserId,
    referralCode,
    masterMechanicId: referral.masterMechanicId,
    shopName: referral.shopName || null,
    email: email || null,
    source: source || "web",
    attributedAt: new Date().toISOString(),
    qualified: false,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: T.attribution,
        Item: item,
        ConditionExpression: "attribute_not_exists(consumerUserId)",
      })
    );
  } catch (err) {
    if (err?.name !== "ConditionalCheckFailedException") throw err;
    const existing = await ddb.send(
      new GetCommand({ TableName: T.attribution, Key: { consumerUserId } })
    );
    return {
      ok: true,
      alreadyAttributed: true,
      referralCode: existing.Item?.referralCode || null,
      shopName: existing.Item?.shopName || null,
    };
  }

  // Headline number for the shop's dashboard: how many people scanned and
  // signed up, separate from how many went on to do something that pays.
  await ddb.send(
    new UpdateCommand({
      TableName: T.referral,
      Key: { referralCode },
      UpdateExpression: "ADD attributedCount :one",
      ExpressionAttributeValues: { ":one": 1 },
    })
  );

  return { ok: true, alreadyAttributed: false, referralCode, shopName: referral.shopName || null };
}

/**
 * Mark a consumer's first qualifying action and pay the shop on every Nth.
 * No attribution row means the consumer did not come from a mechanic — a no-op,
 * not an error, because the consumer apps call this on every qualifying action
 * regardless of where the user came from.
 */
async function qualify(T, { consumerUserId, qualifyingAction, detail }) {
  const existing = await ddb.send(
    new GetCommand({ TableName: T.attribution, Key: { consumerUserId } })
  );
  const row = existing.Item;
  if (!row) return { ok: true, counted: false, reason: "no-referral" };
  if (row.qualified) return { ok: true, counted: false, reason: "already-counted" };

  const qualifiedAt = new Date().toISOString();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: T.attribution,
        Key: { consumerUserId },
        UpdateExpression:
          "SET qualified = :t, qualifyingAction = :a, qualifiedAt = :ts, qualifyingDetail = :d",
        ConditionExpression: "qualified = :f",
        ExpressionAttributeValues: {
          ":t": true,
          ":f": false,
          ":a": qualifyingAction,
          ":ts": qualifiedAt,
          ":d": detail || null,
        },
      })
    );
  } catch (err) {
    // Lost the race to a concurrent qualifying action for the same consumer.
    // The other call counted them; this one must not count them again.
    if (err?.name === "ConditionalCheckFailedException") {
      return { ok: true, counted: false, reason: "already-counted" };
    }
    throw err;
  }

  const bumped = await ddb.send(
    new UpdateCommand({
      TableName: T.referral,
      Key: { referralCode: row.referralCode },
      UpdateExpression: "ADD qualifiedCount :one",
      ExpressionAttributeValues: { ":one": 1 },
      ReturnValues: "ALL_NEW",
    })
  );
  const qualifiedCount = bumped.Attributes?.qualifiedCount || 0;

  let reward = null;
  if (qualifiedCount > 0 && qualifiedCount % MILESTONE_EVERY === 0) {
    const milestoneIndex = qualifiedCount / MILESTONE_EVERY;
    const rewardRow = {
      rewardId: `milestone#${row.masterMechanicId}#${milestoneIndex}`,
      masterMechanicId: row.masterMechanicId,
      type: "REFERRAL_MILESTONE",
      amountUsd: MILESTONE_BONUS_USD,
      status: "PENDING_ISSUE",
      reason: `${qualifiedCount} referred customers active on Zoooom`,
      shopName: row.shopName || null,
      referralCode: row.referralCode,
      milestoneIndex,
      qualifiedCountAtAward: qualifiedCount,
      createdAt: qualifiedAt,
    };
    try {
      await ddb.send(
        new PutCommand({
          TableName: T.reward,
          Item: rewardRow,
          ConditionExpression: "attribute_not_exists(rewardId)",
        })
      );
      reward = rewardRow;
      await ddb.send(
        new UpdateCommand({
          TableName: T.referral,
          Key: { referralCode: row.referralCode },
          UpdateExpression: "ADD milestonesAwarded :one",
          ExpressionAttributeValues: { ":one": 1 },
        })
      );
    } catch (err) {
      // Already minted (a replayed call, or a counter repaired by hand landing
      // on the same multiple). The milestone is paid; say so rather than fail.
      if (err?.name !== "ConditionalCheckFailedException") throw err;
    }
  }

  return {
    ok: true,
    counted: true,
    qualifiedCount,
    milestoneEvery: MILESTONE_EVERY,
    action: ACTION_LABELS[qualifyingAction] || qualifyingAction,
    rewardMinted: !!reward,
    reward,
  };
}

// ── handler ──────────────────────────────────────────────────────────────────

export const handler = async (event, context) => {
  const method = event?.httpMethod || event?.requestContext?.http?.method || "POST";
  if (method === "OPTIONS") return reply(200, { ok: true });

  const T = tables(context);

  let body = {};
  try {
    body = typeof event?.body === "string" ? JSON.parse(event.body) : event?.body || {};
  } catch {
    return reply(400, { error: "invalid JSON body" });
  }

  const identity = identityFromEvent(event);
  const action = str(body.action, 40);

  try {
    if (action === "lookup") {
      const referralCode = normaliseCode(body.referralCode);
      if (!referralCode) return reply(400, { error: "referralCode required" });
      const referral = await getReferral(T, referralCode);
      if (!referral || referral.status !== "active") {
        return reply(404, { ok: false, valid: false, error: "unknown or inactive referral code" });
      }
      // Deliberately narrow: this route is unauthenticated so a stranger can
      // validate a code they were handed. It confirms the shop's name and
      // nothing else — no counters, no earnings, no contact details.
      return reply(200, {
        ok: true,
        valid: true,
        referralCode,
        shopName: referral.shopName || null,
      });
    }

    if (action === "attribute") {
      const referralCode = normaliseCode(body.referralCode);
      const consumerUserId = str(body.consumerUserId, 120) || identity.userId;
      if (!referralCode) return reply(400, { error: "referralCode required" });
      if (!consumerUserId) return reply(400, { error: "consumerUserId required" });

      const result = await attribute(T, {
        referralCode,
        consumerUserId,
        email: str(body.email, 200) || identity.email,
        source: str(body.source, 40),
      });
      if (!result.ok) return reply(result.status || 400, result);
      return reply(200, result);
    }

    if (action === "qualify") {
      const consumerUserId = str(body.consumerUserId, 120) || identity.userId;
      const qualifyingAction = str(body.qualifyingAction, 40);
      if (!consumerUserId) return reply(400, { error: "consumerUserId required" });
      if (!QUALIFYING_ACTIONS.has(qualifyingAction)) {
        return reply(400, {
          error: "qualifyingAction must be one of " + [...QUALIFYING_ACTIONS].join(", "),
        });
      }
      const result = await qualify(T, {
        consumerUserId,
        qualifyingAction,
        detail: str(body.detail, 200),
      });
      return reply(200, result);
    }

    return reply(400, { error: `unknown action: ${action || "(none)"}` });
  } catch (err) {
    console.error("ZoooomMechanicReferralTrack failed", err);
    return reply(500, { error: "internal error", detail: String(err?.message || err) });
  }
};

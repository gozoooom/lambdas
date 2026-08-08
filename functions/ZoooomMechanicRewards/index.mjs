/**
 * ZoooomMechanicRewards — the mechanic-facing rewards + referral API.
 *
 * WHY THIS EXISTS. Shop owners we interviewed are busy and not especially
 * technical, and the old funnel asked them for a 10-step service questionnaire
 * before giving them anything at all. This function is the "instant reward"
 * half of the new deal: the moment a shop is approved it has a referral code, a
 * QR poster it can tape to the counter, and a running dollar balance it can see
 * without talking to anyone.
 *
 * ROUTES (mechanic gateway h7g4lqgvof, stages dev/staging/prod):
 *   GET  /MechanicRewards?masterMechanicId=…   summary: code, counters, ledger
 *   POST /MechanicRewards                      { action, … }
 *
 * ACTIONS
 *   ensure-code           idempotently mint this shop's referral code
 *   claim-signup-bonus    mint the $50 approval bonus (once, approved shops only)
 *   record-verification   log a $25 in-person deal verification (see below)
 *   request-redemption    flag the balance for payout; staff issue it by hand
 *
 * PAYOUT IS DELIBERATELY MANUAL. There is no Tremendous API call anywhere in
 * here. A reward row lands in PENDING_ISSUE, ZoooomMechanicRewardNotify puts it
 * in Slack, and a human issues the card and marks it ISSUED. That keeps a
 * money-moving action behind a person while the program is small, and it means
 * no payout credentials live in a Lambda that a referral counter can reach.
 *
 * THE $25 VERIFICATION TIER IS RECORDED NOW AND PAID LATER. A mechanic who
 * photographs both parties, scans both licences and scans the title has done
 * ~5 minutes of work that only they can do — but the reward attaches to a
 * FINANCED purchase, and financing is not live yet. So the work is written down
 * the moment it happens, with status HELD, and no Slack alert fires. When
 * financing launches, flipping VERIFICATION_REWARDS_ENABLED makes new rows land
 * in PENDING_ISSUE, and a one-line scan flips the accumulated HELD rows — the
 * stream announces each as it changes. The alternative, refusing to record the
 * work until the feature ships, means the first mechanics to do it never get
 * paid, which is precisely the trust we cannot afford to lose.
 *
 * DOUBLE-PAY IS PREVENTED BY THE KEY, NOT BY A READ. Every reward has a
 * deterministic rewardId ("signup#<shop>" / "milestone#<shop>#<n>") written
 * under attribute_not_exists. A retried request, a double-click, or two Lambda
 * containers racing all collapse onto the same row instead of minting a second
 * gift card. Check-then-write would not survive any of those.
 *
 * Tables (all _{env}):
 *   ZoooomMechanicReferral      referralCode (HASH) · GSI MasterMechanicIndex
 *   ZoooomMechanicReward        rewardId (HASH)     · GSI MasterMechanicIndex
 *
 * Env resolution mirrors ZoooomReportIntent: explicit *_TABLE per version, else
 * derive the suffix from the invoked alias qualifier, else _dev.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.REGION || process.env.AWS_REGION || "us-west-2";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

/** Dollars per milestone, and how many qualified consumers earn one. */
const SIGNUP_BONUS_USD = Number(process.env.SIGNUP_BONUS_USD || 50);
const MILESTONE_BONUS_USD = Number(process.env.MILESTONE_BONUS_USD || 10);
const MILESTONE_EVERY = Number(process.env.MILESTONE_EVERY || 5);

/** Per financed deal the mechanic verifies in person. Off until financing ships. */
const VERIFICATION_BONUS_USD = Number(process.env.VERIFICATION_BONUS_USD || 25);
const VERIFICATION_REWARDS_ENABLED = process.env.VERIFICATION_REWARDS_ENABLED === "true";

/**
 * The five artifacts that make a deal verification worth paying for. All are
 * required: a package missing the title scan, or with only one licence, does
 * not establish who sold what to whom — which is the entire value we are buying
 * for $25. Partial packages are recorded as INCOMPLETE rather than rejected, so
 * a mechanic who was interrupted can come back and finish.
 */
const VERIFICATION_ARTIFACTS = [
  "buyerPhoto",
  "sellerPhoto",
  "buyerLicenseScan",
  "sellerLicenseScan",
  "titleScan",
];

function envSuffix(context) {
  const qualifier = (context?.invokedFunctionArn || "").split(":").pop() || "";
  if (/staging/i.test(qualifier)) return "_staging";
  if (/prod/i.test(qualifier)) return "_prod";
  return "_dev";
}

/**
 * Where the QR code points. Derived from the invoked alias rather than a baked
 * env var so a single published version is correct in all three environments —
 * the same reason the table names are derived. Getting this wrong is not a
 * cosmetic bug: a dev-issued poster printed with a zoooom.me link sends real
 * customers into prod under a code that only exists in the dev table, and the
 * mechanic is never credited.
 */
const BASE_URL_BY_ENV = {
  _prod: "https://zoooom.me",
  _staging: "https://staging.zoooom.me",
  _dev: "https://dev.zoooom.me",
};
const referralBaseUrl = (context) =>
  process.env.REFERRAL_BASE_URL || BASE_URL_BY_ENV[envSuffix(context)] || "https://zoooom.me";

const tables = (context) => {
  const s = envSuffix(context);
  return {
    referral: process.env.REFERRAL_TABLE || `ZoooomMechanicReferral${s}`,
    reward: process.env.REWARD_TABLE || `ZoooomMechanicReward${s}`,
    master: process.env.MASTER_MECHANIC_TABLE || `ZoooomMasterMechanic${s}`,
  };
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Content-Type": "application/json",
};
const reply = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max).trim() : undefined);

/**
 * Crockford-style alphabet: no O/0, I/1, L, U. These codes get read aloud over a
 * service counter and typed in by hand, so the ambiguous glyphs are removed
 * rather than "handled" with a normalisation table nobody remembers to update.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
function randomCode() {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `ZM-${out}`;
}

/** Best-effort identity — attribution only, never an authorisation decision. */
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

// ── referral code ────────────────────────────────────────────────────────────

/** The shop's existing code, or null. Reads the GSI, not a scan. */
async function findCodeForShop(T, masterMechanicId) {
  const r = await ddb.send(
    new QueryCommand({
      TableName: T.referral,
      IndexName: "MasterMechanicIndex",
      KeyConditionExpression: "masterMechanicId = :m",
      ExpressionAttributeValues: { ":m": masterMechanicId },
      Limit: 1,
    })
  );
  return r.Items?.[0] || null;
}

/**
 * Mint a code, idempotently. Existing shop -> its existing row, unchanged.
 *
 * The conditional put is what makes a collision safe: two shops that happen to
 * draw the same six characters cannot both take it, and the loser simply draws
 * again. With a 30-char alphabet over 6 places a collision is vanishingly
 * unlikely, but "unlikely" is not a guarantee that two shops never share a code
 * and get paid for each other's customers.
 */
async function ensureCode(T, { masterMechanicId, shopName, createdBy }) {
  const existing = await findCodeForShop(T, masterMechanicId);
  if (existing) return existing;

  for (let attempt = 0; attempt < 5; attempt++) {
    const referralCode = randomCode();
    const item = {
      referralCode,
      masterMechanicId,
      shopName: shopName || null,
      status: "active",
      qualifiedCount: 0,
      attributedCount: 0,
      milestonesAwarded: 0,
      createdAt: new Date().toISOString(),
      createdBy: createdBy || null,
    };
    try {
      await ddb.send(
        new PutCommand({
          TableName: T.referral,
          Item: item,
          ConditionExpression: "attribute_not_exists(referralCode)",
        })
      );
      return item;
    } catch (err) {
      if (err?.name !== "ConditionalCheckFailedException") throw err;
      // Code taken — draw again.
    }
  }
  throw new Error("could not allocate a unique referral code");
}

// ── rewards ──────────────────────────────────────────────────────────────────

/**
 * Write a reward row unless its deterministic id already exists.
 * Returns {created:boolean, reward}. Callers treat "already there" as success —
 * a retried claim must not read as an error to the shop.
 */
async function mintReward(T, reward) {
  try {
    await ddb.send(
      new PutCommand({
        TableName: T.reward,
        Item: reward,
        ConditionExpression: "attribute_not_exists(rewardId)",
      })
    );
    return { created: true, reward };
  } catch (err) {
    if (err?.name !== "ConditionalCheckFailedException") throw err;
    const existing = await ddb.send(
      new GetCommand({ TableName: T.reward, Key: { rewardId: reward.rewardId } })
    );
    return { created: false, reward: existing.Item || reward };
  }
}

async function listRewards(T, masterMechanicId) {
  const r = await ddb.send(
    new QueryCommand({
      TableName: T.reward,
      IndexName: "MasterMechanicIndex",
      KeyConditionExpression: "masterMechanicId = :m",
      ExpressionAttributeValues: { ":m": masterMechanicId },
      ScanIndexForward: false,
      Limit: 100,
    })
  );
  return r.Items || [];
}

/**
 * Is this shop approved? The bonus is explicitly "after they are approved", so
 * an unapproved shop asking for $50 gets a clear "not yet", not a pending row
 * that a human then has to decline in Slack.
 */
async function isApproved(T, masterMechanicId) {
  try {
    const r = await ddb.send(
      new GetCommand({ TableName: T.master, Key: { masterMechanicId } })
    );
    const status = String(r.Item?.status || r.Item?.approvalStatus || "").toLowerCase();
    return { approved: status === "approved" || status === "active", shop: r.Item || null, status };
  } catch (err) {
    console.error("approval lookup failed", err);
    return { approved: false, shop: null, status: "unknown" };
  }
}

function summarise(referral, rewards, baseUrl) {
  const qualifiedCount = referral?.qualifiedCount || 0;

  // HELD rows are work already done that the program cannot pay for yet. They
  // are shown as their own line, never folded into "earned" — a mechanic who
  // sees a balance they cannot redeem reads it as the program being broken.
  const live = rewards.filter((r) => r.status !== "VOID" && r.status !== "HELD");
  const held = rewards.filter((r) => r.status === "HELD");

  const earnedUsd = live.reduce((sum, r) => sum + (r.amountUsd || 0), 0);
  const issuedUsd = live
    .filter((r) => r.status === "ISSUED")
    .reduce((sum, r) => sum + (r.amountUsd || 0), 0);
  const heldUsd = held.reduce((sum, r) => sum + (r.amountUsd || 0), 0);
  const towardNext = qualifiedCount % MILESTONE_EVERY;

  return {
    referralCode: referral?.referralCode || null,
    referralUrl: referral ? `${baseUrl}/?mref=${encodeURIComponent(referral.referralCode)}` : null,
    attributedCount: referral?.attributedCount || 0,
    qualifiedCount,
    milestoneEvery: MILESTONE_EVERY,
    towardNextMilestone: towardNext,
    needSoFarNextMilestone: MILESTONE_EVERY - towardNext,
    signupBonusUsd: SIGNUP_BONUS_USD,
    milestoneBonusUsd: MILESTONE_BONUS_USD,
    verificationBonusUsd: VERIFICATION_BONUS_USD,
    verificationEnabled: VERIFICATION_REWARDS_ENABLED,
    verificationArtifacts: VERIFICATION_ARTIFACTS,
    verificationsRecorded: held.length + live.filter((r) => r.type === "TRANSACTION_VERIFICATION").length,
    earnedUsd,
    issuedUsd,
    pendingUsd: earnedUsd - issuedUsd,
    heldUsd,
    rewards,
  };
}

// ── handler ──────────────────────────────────────────────────────────────────

export const handler = async (event, context) => {
  const method = event?.httpMethod || event?.requestContext?.http?.method || "POST";
  if (method === "OPTIONS") return reply(200, { ok: true });

  const T = tables(context);
  const BASE = referralBaseUrl(context);
  const identity = identityFromEvent(event);

  try {
    if (method === "GET") {
      const masterMechanicId = str(event?.queryStringParameters?.masterMechanicId, 120);
      if (!masterMechanicId) return reply(400, { error: "masterMechanicId required" });

      const [referral, rewards] = await Promise.all([
        findCodeForShop(T, masterMechanicId),
        listRewards(T, masterMechanicId),
      ]);
      return reply(200, { ok: true, ...summarise(referral, rewards, BASE) });
    }

    let body = {};
    try {
      body = typeof event?.body === "string" ? JSON.parse(event.body) : event?.body || {};
    } catch {
      return reply(400, { error: "invalid JSON body" });
    }

    const action = str(body.action, 40);
    const masterMechanicId = str(body.masterMechanicId, 120);
    if (!masterMechanicId) return reply(400, { error: "masterMechanicId required" });

    if (action === "ensure-code") {
      const referral = await ensureCode(T, {
        masterMechanicId,
        shopName: str(body.shopName, 200),
        createdBy: identity.userId,
      });
      const rewards = await listRewards(T, masterMechanicId);
      return reply(200, { ok: true, ...summarise(referral, rewards, BASE) });
    }

    if (action === "claim-signup-bonus") {
      const { approved, shop, status } = await isApproved(T, masterMechanicId);
      if (!approved) {
        return reply(200, {
          ok: true,
          claimed: false,
          reason: "not-approved",
          approvalStatus: status,
          message: "Your $50 welcome bonus unlocks the moment your shop is approved.",
        });
      }

      // Code first: the Slack alert and the poster are both useless without it,
      // and a shop that just earned $50 is exactly when it will go looking.
      const referral = await ensureCode(T, {
        masterMechanicId,
        shopName: str(body.shopName, 200) || shop?.shopName,
        createdBy: identity.userId,
      });

      const { created, reward } = await mintReward(T, {
        rewardId: `signup#${masterMechanicId}`,
        masterMechanicId,
        type: "SIGNUP_BONUS",
        amountUsd: SIGNUP_BONUS_USD,
        status: "PENDING_ISSUE",
        reason: "Welcome bonus — shop approved",
        shopName: str(body.shopName, 200) || shop?.shopName || referral.shopName || null,
        email: str(body.email, 200) || identity.email || shop?.email || null,
        contactName: str(body.contactName, 120) || shop?.primaryContact || null,
        referralCode: referral.referralCode,
        createdAt: new Date().toISOString(),
        createdBy: identity.userId || null,
      });

      const rewards = await listRewards(T, masterMechanicId);
      return reply(200, { ok: true, claimed: true, firstTime: created, reward, ...summarise(referral, rewards, BASE) });
    }

    if (action === "record-verification") {
      // The mechanic witnessed a private-party handover and captured the five
      // artifacts. dealId keys the reward so the same deal cannot pay twice,
      // however many times the app retries or the mechanic re-submits.
      const dealId = str(body.dealId, 120);
      if (!dealId) return reply(400, { error: "dealId required" });

      const captured = body.artifacts && typeof body.artifacts === "object" ? body.artifacts : {};
      const missing = VERIFICATION_ARTIFACTS.filter((a) => !captured[a]);
      const complete = missing.length === 0;

      // A financed deal is the only kind this pays for, and the caller does not
      // get to assert that — it is read from the deal record by the backfill
      // that flips HELD rows. Recorded here only as what the app believed.
      const claimedFinanced = body.financed === true;

      const status = complete && VERIFICATION_REWARDS_ENABLED && claimedFinanced
        ? "PENDING_ISSUE"
        : complete
        ? "HELD"
        : "INCOMPLETE";

      const { created, reward } = await mintReward(T, {
        rewardId: `txnverify#${masterMechanicId}#${dealId}`,
        masterMechanicId,
        type: "TRANSACTION_VERIFICATION",
        amountUsd: VERIFICATION_BONUS_USD,
        status,
        reason: `In-person verification of deal ${dealId}`,
        dealId,
        artifacts: captured,
        missingArtifacts: missing,
        claimedFinanced,
        shopName: str(body.shopName, 200) || null,
        vin: str(body.vin, 20) || null,
        createdAt: new Date().toISOString(),
        createdBy: identity.userId || null,
      });

      const referral = await findCodeForShop(T, masterMechanicId);
      const rewards = await listRewards(T, masterMechanicId);
      return reply(200, {
        ok: true,
        recorded: true,
        firstTime: created,
        complete,
        missing,
        status: reward.status,
        payable: VERIFICATION_REWARDS_ENABLED,
        message: complete
          ? VERIFICATION_REWARDS_ENABLED
            ? `Verification recorded — ${VERIFICATION_BONUS_USD} dollars added to your balance.`
            : `Verification recorded. It pays ${VERIFICATION_BONUS_USD} dollars once Zoooom financing goes live — we have it on file.`
          : `Still need: ${missing.join(", ")}`,
        reward,
        ...summarise(referral, rewards, BASE),
      });
    }

    if (action === "request-redemption") {
      // Marks every PENDING_ISSUE row with how the shop wants paying. It does
      // NOT move money and does not change status — the Slack alert already
      // fired when each row was minted; this only records the preference so the
      // person issuing the card knows whether to send a gift card or cash.
      const method_ = str(body.method, 20) === "cash" ? "cash" : "giftcard";
      const email = str(body.email, 200) || identity.email;
      if (!email) return reply(400, { error: "email required for redemption" });

      const rewards = await listRewards(T, masterMechanicId);
      const pending = rewards.filter((r) => r.status === "PENDING_ISSUE");
      await Promise.all(
        pending.map((r) =>
          ddb.send(
            new UpdateCommand({
              TableName: T.reward,
              Key: { rewardId: r.rewardId },
              UpdateExpression:
                "SET redemptionMethod = :m, redemptionEmail = :e, redemptionRequestedAt = :t",
              ExpressionAttributeValues: {
                ":m": method_,
                ":e": email,
                ":t": new Date().toISOString(),
              },
            })
          )
        )
      );

      const referral = await findCodeForShop(T, masterMechanicId);
      const refreshed = await listRewards(T, masterMechanicId);
      return reply(200, {
        ok: true,
        requested: pending.length,
        method: method_,
        ...summarise(referral, refreshed, BASE),
      });
    }

    return reply(400, { error: `unknown action: ${action || "(none)"}` });
  } catch (err) {
    console.error("ZoooomMechanicRewards failed", err);
    return reply(500, { error: "internal error", detail: String(err?.message || err) });
  }
};

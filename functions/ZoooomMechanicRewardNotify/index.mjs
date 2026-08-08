/**
 * ZoooomMechanicRewardNotify — tells #mechanic-rewards when a gift card is owed.
 *
 * TRIGGER  DynamoDB stream (INSERT + MODIFY) on ZoooomMechanicReward_{dev,staging,prod}.
 *
 * Gift cards are issued BY HAND. That is a deliberate choice while the program
 * is small: no payout credentials sit in a Lambda that a referral counter can
 * reach, and a person sees every dollar before it leaves. The consequence is
 * that a reward row is worthless until someone knows about it — which is this
 * function's entire job.
 *
 * WHY THE STREAM AND NOT THE TWO WRITERS: rewards are minted from two different
 * places (ZoooomMechanicRewards for the $50 approval bonus, and
 * ZoooomMechanicReferralTrack for each $10 milestone), and more will follow.
 * Bolting a Slack call onto each means N code changes and N chances for a Slack
 * outage to fail a reward write. The stream sits behind all of them: any present
 * or future write to the reward table gets announced, and Slack being down can
 * never lose a mechanic their money — the row is already committed.
 * Same reasoning as ZoooomMechanicSignupNotify.
 *
 * ONE FUNCTION, ALL THREE ENVS. The environment comes from the stream ARN
 * (…/table/ZoooomMechanicReward_prod/stream/…), not a per-alias env var, so
 * there is no way for the wrong table to resolve to the wrong channel.
 *
 * REDEMPTION REQUESTS ARE THE SECOND ALERT. A shop that earns $50 and then asks
 * to be paid produces a MODIFY, not an INSERT. Without handling MODIFY the team
 * sees "money owed" but never "they want it now, and by this method, at this
 * address" — which is the message that actually triggers the payout.
 *
 * Env:
 *   REWARD_CHANNEL_PROD      Slack channel ID for prod (C0BPPG3LTNU).
 *   REWARD_CHANNEL_STAGING   empty => log only.
 *   REWARD_CHANNEL_DEV       empty => log only.
 *   SLACK_SECRET_ID          default zoooom/slack/support-bot.
 *
 * Manual invokes:
 *   {dryRun:true}                 render the last-seen shape to logs, post nothing
 *   {env:"prod", testPost:true}   send one clearly-labelled test line
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const REGION = process.env.AWS_REGION || "us-west-2";
const SLACK_SECRET_ID = process.env.SLACK_SECRET_ID || "zoooom/slack/support-bot";

const CHANNEL_BY_ENV = {
  prod: process.env.REWARD_CHANNEL_PROD || "",
  staging: process.env.REWARD_CHANNEL_STAGING || "",
  dev: process.env.REWARD_CHANNEL_DEV || "",
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sm = new SecretsManagerClient({ region: REGION });

const REWARD_TABLE = (env) => `ZoooomMechanicReward_${env}`;

/** arn:…:table/ZoooomMechanicReward_prod/stream/… -> "prod". */
function envFromStreamArn(arn) {
  const m = /table\/ZoooomMechanicReward_(dev|staging|prod)\//.exec(arn || "");
  return m ? m[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Slack ────────────────────────────────────────────────────────────────────
let cachedToken = null;
async function slackToken() {
  if (cachedToken) return cachedToken;
  const sec = await sm.send(new GetSecretValueCommand({ SecretId: SLACK_SECRET_ID }));
  cachedToken = JSON.parse(sec.SecretString || "{}").botToken || null;
  return cachedToken;
}

async function postSlack(channel, text) {
  if (!channel) {
    console.warn("[mechanicReward] no channel for this env — not posting. Would have sent:\n" + text);
    return { ok: false, reason: "no_channel" };
  }
  const token = await slackToken();
  if (!token) {
    console.warn("[mechanicReward] no Slack botToken — skipping");
    return { ok: false, reason: "no_token" };
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ channel, text, unfurl_links: false }),
      });
      const j = await r.json();
      if (j.ok) return j;
      console.warn(`[mechanicReward] Slack post failed (attempt ${attempt}):`, j.error);
      if (["invalid_auth", "not_in_channel", "channel_not_found", "token_revoked"].includes(j.error)) {
        return j;
      }
    } catch (e) {
      console.warn(`[mechanicReward] Slack post threw (attempt ${attempt}):`, e.message);
    }
    if (attempt === 1) await sleep(700);
  }
  return { ok: false, reason: "post_failed" };
}

// ── Rendering ────────────────────────────────────────────────────────────────
const clean = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const money = (n) => `$${Number(n || 0).toFixed(Number(n) % 1 === 0 ? 0 : 2)}`;

const TYPE_HEADLINE = {
  SIGNUP_BONUS: ":tada: *Welcome bonus owed*",
  REFERRAL_MILESTONE: ":handshake: *Referral milestone hit*",
  TRANSACTION_VERIFICATION: ":camera_with_flash: *Deal verification owed*",
};

function renderNew(env, r) {
  const who = clean(r.shopName) || clean(r.masterMechanicId) || "unknown shop";
  const lines = [
    `${TYPE_HEADLINE[r.type] || ":gift: *Reward owed*"} — ${money(r.amountUsd)} to *${who}*`,
  ];
  if (clean(r.reason)) lines.push(`• Why: ${clean(r.reason)}`);
  if (clean(r.referralCode)) lines.push(`• Referral code: \`${clean(r.referralCode)}\``);
  const contact = [clean(r.contactName), clean(r.email)].filter(Boolean).join(" · ");
  if (contact) lines.push(`• Contact: ${contact}`);
  lines.push(`• Reward id: \`${clean(r.rewardId)}\``);
  lines.push(
    "• :point_right: Issue the card in Tremendous, then mark it issued " +
      "(`aws dynamodb update-item` or the internal dashboard)."
  );
  if (env !== "prod") lines.push(`_(${env})_`);
  return lines.join("\n");
}

function renderRedemption(env, r) {
  const who = clean(r.shopName) || clean(r.masterMechanicId) || "unknown shop";
  const method = clean(r.redemptionMethod) === "cash" ? "cash" : "gift card";
  const lines = [
    `:moneybag: *Payout requested* — ${money(r.amountUsd)} to *${who}* as a ${method}`,
    `• Send to: ${clean(r.redemptionEmail) || clean(r.email) || "no email on file"}`,
    `• Reward id: \`${clean(r.rewardId)}\``,
  ];
  if (clean(r.reason)) lines.push(`• Why: ${clean(r.reason)}`);
  if (env !== "prod") lines.push(`_(${env})_`);
  return lines.join("\n");
}

function renderIssued(env, r) {
  const who = clean(r.shopName) || clean(r.masterMechanicId) || "unknown shop";
  const lines = [
    `:white_check_mark: *Reward issued* — ${money(r.amountUsd)} to *${who}*`,
    `• Reward id: \`${clean(r.rewardId)}\``,
  ];
  if (clean(r.issuedBy)) lines.push(`• Issued by: ${clean(r.issuedBy)}`);
  if (clean(r.giftCardRef)) lines.push(`• Reference: ${clean(r.giftCardRef)}`);
  if (env !== "prod") lines.push(`_(${env})_`);
  return lines.join("\n");
}

/**
 * Which of the three messages (if any) this stream record deserves.
 *
 * MODIFY fires on every field change, including the ones this function writes
 * back itself. Deciding on the specific transition rather than "something
 * changed" is what stops a status update from re-announcing the original debt,
 * and stops the dedup stamp from triggering a message about itself.
 */
function classify(eventName, oldImg, newImg) {
  if (!newImg) return null;

  if (eventName === "INSERT") {
    // HELD (verification work banked until financing ships) and INCOMPLETE (a
    // half-captured package) are not debts yet. Announcing them would train the
    // channel that a reward alert does not mean "go issue a card".
    return newImg.status === "PENDING_ISSUE" ? { kind: "new", render: renderNew } : null;
  }

  if (eventName === "MODIFY" && oldImg) {
    // Shop asked to be paid: a redemption timestamp appeared.
    if (!oldImg.redemptionRequestedAt && newImg.redemptionRequestedAt) {
      return { kind: "redemption", render: renderRedemption };
    }
    // A human marked it paid — closes the loop for whoever else was watching.
    if (oldImg.status !== "ISSUED" && newImg.status === "ISSUED") {
      return { kind: "issued", render: renderIssued };
    }
    // Banked verification work became payable — either the mechanic completed a
    // package or financing launched and the backfill released the HELD rows.
    // This is the ONLY way a verification reward ever reaches the channel, so
    // dropping it would strand every dollar earned before the flag flipped.
    if (oldImg.status !== "PENDING_ISSUE" && newImg.status === "PENDING_ISSUE") {
      return { kind: "new", render: renderNew };
    }
  }

  return null;
}

/**
 * Stamp what we posted onto the row so a stream redelivery (at-least-once) does
 * not repost. Keyed per message kind: the same reward legitimately produces a
 * "owed", a "requested", and an "issued" line, and one shared stamp would
 * swallow the second and third.
 */
const STAMP_FIELD = { new: "slackOwedTs", redemption: "slackRedemptionTs", issued: "slackIssuedTs" };

async function claimStamp(env, rewardId, kind) {
  const field = STAMP_FIELD[kind];
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: REWARD_TABLE(env),
        Key: { rewardId },
        UpdateExpression: `SET ${field} = :t`,
        ConditionExpression: `attribute_not_exists(${field})`,
        ExpressionAttributeValues: { ":t": new Date().toISOString() },
      })
    );
    return true;
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") return false; // already announced
    console.warn("[mechanicReward] stamp failed:", err.message);
    return true; // never let bookkeeping suppress a real alert
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  // Manual test post — labelled so nobody mistakes it for a real payout.
  if (event?.testPost) {
    const env = event.env || "dev";
    const res = await postSlack(
      CHANNEL_BY_ENV[env],
      `:test_tube: ZoooomMechanicRewardNotify test post (${env}) — no money is owed.`
    );
    return { ok: res.ok === true, env };
  }

  const records = event?.Records || [];
  let posted = 0;
  let skipped = 0;

  for (const rec of records) {
    try {
      const env = envFromStreamArn(rec.eventSourceARN);
      if (!env) {
        console.warn("[mechanicReward] unrecognised stream ARN:", rec.eventSourceARN);
        continue;
      }

      const newImg = rec.dynamodb?.NewImage ? unmarshall(rec.dynamodb.NewImage) : null;
      const oldImg = rec.dynamodb?.OldImage ? unmarshall(rec.dynamodb.OldImage) : null;

      const decision = classify(rec.eventName, oldImg, newImg);
      if (!decision) {
        skipped++;
        continue;
      }

      const text = decision.render(env, newImg);

      if (event?.dryRun) {
        console.log("[mechanicReward] dryRun would post:\n" + text);
        continue;
      }

      const fresh = await claimStamp(env, newImg.rewardId, decision.kind);
      if (!fresh) {
        skipped++;
        continue;
      }

      await postSlack(CHANNEL_BY_ENV[env], text);
      posted++;
    } catch (err) {
      // Never throw: a thrown handler makes Lambda retry the whole batch, which
      // would re-announce every reward in it. A missed alert is recoverable
      // from the table; a duplicated payout alert is not.
      console.error("[mechanicReward] record failed:", err);
    }
  }

  return { ok: true, posted, skipped, seen: records.length };
};

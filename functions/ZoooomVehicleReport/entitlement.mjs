/**
 * Entitlement / paywall resolver for the Verified Vehicle Report.
 * Ported from prototypes/paywall/entitlement.js — see that file's DESIGN notes.
 *
 * GOAL: "free until Oct 1 2026, charge when ready" is a CONFIG change, not a deploy.
 * The promo is resolved server-side from a ZoooomFeatureConfig record. During the
 * promo every logged-in caller is GRANTED with no Stripe path reached. Flipping to
 * paid = a single DynamoDB write (freeUntil in the past / priceCents / payer).
 *
 * Resolution order (first match wins):
 *   1. Cached funded report for VIN within TTL  -> granted (never double-charge)
 *   2. Promo active (now < freeUntil)           -> granted (subject to fair-use)
 *   3. Active subscription                       -> granted
 *   4. One-time purchase exists for VIN+feature  -> granted
 *   5. otherwise                                 -> paywall (+ price + checkout)
 */

import { GetCommand } from "@aws-sdk/lib-dynamodb";

// Free-now default: used if the config table is unset or the record is missing,
// so the report ships free even before ZoooomFeatureConfig_dev is seeded.
export const DEFAULT_CONFIG = {
  featureKey: "vehicle_report",
  enabled: true,
  // Buyer "3 free reports per user" promo runs through Aug 31 2026.
  freeUntil: "2026-08-31T23:59:59Z",
  priceCents: 1499,
  currency: "usd",
  payer: "seller", // "seller" | "buyer" | "either"
  fairUseLimitPerDay: 25,
  // Lifetime free reports per user during the promo (distinct VINs). Re-viewing a
  // VIN you already unlocked does NOT count again.
  freeReportsPerUser: 3,
  // Anti-fraud: max distinct accounts that may unlock from the same device or IP
  // before we stop granting free reports to that device/IP.
  maxAccountsPerDevice: 3,
  reportTtlDays: 90,
  // Paid packs after the 3 free (through the promo): buy 1 for $1.99 or 3 for $5.
  reportSinglePriceCents: 199,
  reportPack3PriceCents: 500,
};

/**
 * Load the feature config from DynamoDB, falling back to DEFAULT_CONFIG.
 * @param {object|null} docClient DynamoDBDocumentClient (or null to skip)
 * @param {string|null} table     FEATURE_CONFIG_TABLE name
 */
export async function loadFeatureConfig(docClient, table, featureKey = "vehicle_report") {
  if (!docClient || !table) return DEFAULT_CONFIG;
  try {
    const r = await docClient.send(new GetCommand({ TableName: table, Key: { featureKey } }));
    return r?.Item ? { ...DEFAULT_CONFIG, ...r.Item } : DEFAULT_CONFIG;
  } catch (e) {
    console.warn("⚠️ Feature config read failed, using default (free):", e.message);
    return DEFAULT_CONFIG;
  }
}

/**
 * @param {object} req
 * @param {string} req.featureKey
 * @param {string} req.vin
 * @param {object} req.caller  { userId, role: "seller"|"buyer", usageToday }
 * @param {string} req.now     ISO timestamp
 * @param {object} req.config  the feature config record
 * @param {object} [req.state] { cachedReport, subscriptionActive, purchaseExists }
 */
export function resolveEntitlement(req) {
  const { featureKey, vin, caller, now, config, state = {} } = req;
  const nowMs = new Date(now).getTime();

  if (!config?.enabled) return deny("feature_disabled");

  const payerIsCaller = config.payer === "either" || config.payer === caller.role;

  // 1. Already have a fresh, funded report for this VIN -> always granted.
  if (state.cachedReport) {
    const ageDays = (nowMs - new Date(state.cachedReport.generatedAt).getTime()) / 86400000;
    if (state.cachedReport.funded && ageDays <= (config.reportTtlDays ?? 90)) {
      return grant("cached_report", { cached: true });
    }
  }

  // 2. Promo window.
  const promoActive = config.freeUntil && nowMs < new Date(config.freeUntil).getTime();
  if (promoActive) {
    if ((caller.usageToday ?? 0) >= (config.fairUseLimitPerDay ?? Infinity)) {
      return deny("fair_use_exceeded", {
        message: "Daily free limit reached — try again tomorrow.",
        retryable: true,
      });
    }
    return grant("promo", {
      promo: true,
      promoEndsAt: config.freeUntil,
      banner: `Free until ${config.freeUntil.slice(0, 10)} — included while you're an early member.`,
    });
  }

  // 3. Subscription (e.g. dealer plan).
  if (state.subscriptionActive) return grant("subscription");

  // 4. One-time purchase already made for this VIN+feature.
  if (state.purchaseExists) return grant("purchase");

  // 5. Paywall.
  return {
    access: "paywall",
    reason: "payment_required",
    payer: config.payer,
    payerIsCaller,
    priceCents: config.priceCents,
    currency: config.currency || "usd",
    checkout: {
      product: featureKey,
      vin,
      amountCents: config.priceCents,
      metadata: { featureKey, vin, payerRole: config.payer },
    },
    message:
      config.payer === caller.role
        ? `Unlock the full Verified Vehicle Report for $${(config.priceCents / 100).toFixed(2)}.`
        : `The ${config.payer} can unlock the full report for this listing.`,
  };
}

const grant = (reason, extra = {}) => ({ access: "granted", reason, ...extra });
const deny = (reason, extra = {}) => ({ access: "denied", reason, ...extra });

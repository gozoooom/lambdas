/**
 * Secret resolution for the Stripe platform key.
 *
 * WHY: the live `sk_live_…` key was stored in PLAINTEXT Lambda environment
 * variables — readable by anyone with lambda:GetFunctionConfiguration, and
 * visible in any config export. This moves it to Secrets Manager.
 *
 * MIGRATION SAFETY (this is deliberately a two-phase change):
 *   Phase 1 (this code) — read STRIPE_SECRET_ID from Secrets Manager, but fall
 *     back to the STRIPE_SECRET_KEY env var if the secret is missing/unreadable.
 *     Both paths live simultaneously, so a bad IAM policy or a typo'd secret name
 *     degrades to today's behaviour instead of breaking checkout. Rollback is
 *     "unset STRIPE_SECRET_ID", no redeploy.
 *   Phase 2 (follow-up) — once logs confirm the Secrets Manager path is being
 *     used in every env, DELETE the STRIPE_SECRET_KEY env var and this fallback.
 *
 * The value is cached at MODULE scope, so it is fetched at most once per warm
 * container — not per request. Cold-start cost is one GetSecretValue (~50–150ms).
 */

let cachedKey = null;   // resolved secret string
let cachedFrom = null;  // "secretsmanager" | "env" — for the one-time log line

/**
 * True when Stripe is configured at all. SYNCHRONOUS on purpose: callers use it
 * as a cheap feature gate before doing any async work, and it must not trigger a
 * network call. Presence of either config source is enough.
 */
export function stripeAvailable() {
  return !!(process.env.STRIPE_SECRET_ID || process.env.STRIPE_SECRET_KEY);
}

/** Resolve the Stripe secret key. Returns "" when Stripe isn't configured. */
export async function getStripeKey() {
  if (cachedKey !== null) return cachedKey;

  const secretId = process.env.STRIPE_SECRET_ID;
  if (secretId) {
    try {
      // Dynamic import: if this client isn't present in the runtime, we fall
      // through to the env var rather than crashing the whole lambda on import.
      const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
      const client = new SecretsManagerClient({ region: process.env.REGION || "us-west-2" });
      const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      const val = res?.SecretString || "";
      if (val) {
        cachedKey = val;
        cachedFrom = "secretsmanager";
        console.log(`🔐 Stripe key loaded from Secrets Manager (${secretId})`);
        return cachedKey;
      }
      console.warn(`⚠️ Secret ${secretId} is empty — falling back to STRIPE_SECRET_KEY env var`);
    } catch (e) {
      console.warn(`⚠️ Secrets Manager read failed for ${secretId} (${e.name}: ${e.message}) — falling back to STRIPE_SECRET_KEY env var`);
    }
  }

  cachedKey = process.env.STRIPE_SECRET_KEY || "";
  cachedFrom = "env";
  if (cachedKey) console.log("🔐 Stripe key loaded from env var (migration fallback — Phase 2 should remove this)");
  return cachedKey;
}

/** Which source served the cached key. For post-migration verification. */
export function stripeKeySource() {
  return cachedFrom;
}

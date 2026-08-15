/**
 * Secret resolution for the OpenAI platform API key.
 *
 * WHY: the key was stored in PLAINTEXT Lambda environment variables across five
 * functions — readable by anyone with lambda:GetFunctionConfiguration and visible
 * in any config export or console screenshot. This moves it to Secrets Manager
 * (`zoooom/openai/api-key`), so rotating it is a secret update with NO redeploy.
 *
 * Mirrors ZoooomVehicleReport/secrets.mjs, including its two-phase migration:
 *   Phase 1 (this code) — read OPENAI_SECRET_ID from Secrets Manager, falling back
 *     to the OPENAI_API_KEY env var if the secret is missing/unreadable. Both paths
 *     live at once, so a bad IAM policy or typo'd name degrades to today's
 *     behaviour instead of breaking every LLM call. Rollback = unset
 *     OPENAI_SECRET_ID, no redeploy.
 *   Phase 2 — once the logs confirm the Secrets Manager path in every function,
 *     DELETE the OPENAI_API_KEY env var. The fallback then simply never fires.
 *
 * The client is built lazily and cached at MODULE scope: these lambdas used to do
 * `new OpenAI({ apiKey: process.env.OPENAI_API_KEY })` at import time, which can't
 * await a secret. Now the first call pays one GetSecretValue (~50-150ms) per warm
 * container and every later call reuses the same client.
 */

let cachedKey = null;    // resolved secret string
let cachedFrom = null;   // "secretsmanager" | "env"
let cachedClient = null; // constructed OpenAI client

/** Resolve the OpenAI API key. Returns "" when nothing is configured. */
export async function getOpenAIKey() {
  if (cachedKey !== null) return cachedKey;

  const secretId = process.env.OPENAI_SECRET_ID;
  if (secretId) {
    try {
      // Dynamic import so a runtime without this client falls back to the env
      // var rather than crashing the lambda at import time.
      const { SecretsManagerClient, GetSecretValueCommand } = await import(
        "@aws-sdk/client-secrets-manager"
      );
      const client = new SecretsManagerClient({
        region: process.env.REGION || process.env.AWS_REGION || "us-west-2",
      });
      const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      const val = res?.SecretString || "";
      if (val) {
        cachedKey = val;
        cachedFrom = "secretsmanager";
        console.log(`🔐 OpenAI key loaded from Secrets Manager (${secretId})`);
        return cachedKey;
      }
      console.warn(`⚠️ Secret ${secretId} is empty — falling back to OPENAI_API_KEY env var`);
    } catch (e) {
      console.warn(
        `⚠️ Secrets Manager read failed for ${secretId} (${e.name}: ${e.message}) — falling back to OPENAI_API_KEY env var`
      );
    }
  }

  cachedKey = process.env.OPENAI_API_KEY || "";
  cachedFrom = "env";
  if (cachedKey) console.log("🔐 OpenAI key loaded from env var (migration fallback — Phase 2 should remove this)");
  return cachedKey;
}

/**
 * The shared OpenAI client. Replaces the old module-scope `new OpenAI(...)`.
 * `openai` itself comes from the ZoooomOpenAI layer, so it is imported
 * dynamically here too — the deployment package only ships index.mjs.
 */
export async function getOpenAI() {
  if (cachedClient) return cachedClient;
  const { default: OpenAI } = await import("openai");
  cachedClient = new OpenAI({ apiKey: await getOpenAIKey() });
  return cachedClient;
}

/** Which source served the cached key. For post-migration verification. */
export function openAIKeySource() {
  return cachedFrom;
}

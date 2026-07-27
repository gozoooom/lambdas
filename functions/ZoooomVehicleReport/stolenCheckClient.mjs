/**
 * Theft signal for the report — delegates to the ZoooomStolenCheck lambda.
 *
 * Stolen-check lives in its own lambda because it requires the NEW Vehicle
 * Databases license key (the report's own key has no stolen-check access). That
 * lambda owns the credential AND the centralized cross-env cache (one live call
 * per VIN per ~30 days, each result timestamped). The report just asks it for the
 * answer and degrades gracefully to `null` if anything is off (no key yet, invoke
 * error, etc.) so the theft section simply doesn't appear — the report never fails.
 *
 * Env:
 *   STOLEN_CHECK_FN   target lambda name (default ZoooomStolenCheck)
 *   REGION            default us-west-2
 */
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const REGION = process.env.REGION || "us-west-2";
const FN = process.env.STOLEN_CHECK_FN || "ZoooomStolenCheck";
const lambda = new LambdaClient({ region: REGION });

/**
 * @returns {Promise<{possibleStolen:boolean, records:any[], checkedAt:string|null}|null>}
 *   null when the result is unavailable (no key / error) — caller omits the theft signal.
 */
export async function getStolenCheck(vin) {
  try {
    const res = await lambda.send(new InvokeCommand({
      FunctionName: FN,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ vin })),
    }));
    if (!res.Payload) return null;
    const outer = JSON.parse(Buffer.from(res.Payload).toString("utf8"));
    // ZoooomStolenCheck returns an API-Gateway-style envelope: { statusCode, body }.
    const body = typeof outer?.body === "string" ? JSON.parse(outer.body) : (outer?.body || outer);
    if (!body || body.available === false) return null;
    if (typeof body.possibleStolen !== "boolean") return null;
    return {
      possibleStolen: body.possibleStolen,
      records: Array.isArray(body.records) ? body.records : [],
      checkedAt: body.checkedAt || null,
    };
  } catch (e) {
    console.warn("⚠️ stolen-check invoke failed:", e.message);
    return null;
  }
}

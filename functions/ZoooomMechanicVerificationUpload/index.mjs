/**
 * ZoooomMechanicVerificationUpload — presigned PUTs for deal-verification captures.
 *
 * POST /MechanicVerificationUpload
 *   { masterMechanicId, dealId, artifact, contentType }
 *   -> { uploadUrl, key, expiresIn }
 *
 * WHAT IS BEING STORED. Photos of a private buyer and seller, scans of both
 * their driver's licences, and a scan of the vehicle title. Government ID and
 * face images belonging to people who are NOT Zoooom users — they are the
 * counterparties to a private-party sale. That data class drives every decision
 * below; see lib/create-deal-verification-buckets.sh for the bucket side.
 *
 * ── AUTHENTICATION IS REQUIRED HERE, UNLIKE THE OTHER MECHANIC ROUTES ────────
 * The rewards and referral routes decode the id token best-effort and carry on
 * without one, because the worst case is a mis-attributed counter. This route
 * hands out write access to an identity-document bucket, so an unverifiable
 * caller gets 401 — an absent or wrong-environment token is a hard stop, not a
 * fallback.
 *
 * The token IS signature-verified: API Gateway runs a COGNITO_USER_POOLS
 * authorizer on this route, so `requestContext.authorizer.claims` only exists
 * for a genuinely signed, unexpired token. Because one authorizer serves all
 * three stages (the mechanic app has a pool per environment), mechanicAuth.mjs
 * additionally binds the token's issuer to this stage's pool — otherwise a
 * dev-pool token would authorize against prod.
 *
 * The constraints below still hold as defence in depth:
 *   · the URL is PUT-only — it can never read an existing object back
 *   · the key path is built server-side from sanitised inputs
 *   · content type is allow-listed to images
 *   · the URL expires in 5 minutes
 *
 * ── THE CLIENT NEVER CHOOSES THE KEY ─────────────────────────────────────────
 * Keys are `<env>/<masterMechanicId>/<dealId>/<artifact>-<uuid>.<ext>`, all
 * components sanitised. A client-supplied key is how you get path traversal into
 * another shop's evidence, and there is no reason the client needs to name it.
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { verifiedCaller } from "./mechanicAuth.mjs";

const REGION = process.env.REGION || process.env.AWS_REGION || "us-west-2";
const s3 = new S3Client({ region: REGION });

/**
 * MASTER SWITCH — OFF until Zoooom financing launches.
 *
 * The $25 verification tier only exists for FINANCED purchases, and financing is
 * not live. Until it is, there is no business purpose for holding a stranger's
 * driver's licence, and collecting government ID you have no current use for is
 * the kind of thing that is indefensible in a breach review however good the
 * bucket controls are. So this refuses to mint upload URLs at all.
 *
 * THIS IS THE REAL CONTROL, NOT THE UI. The mobile app's capture screen is also
 * disabled, but an app build already on a phone cannot be un-shipped — a stale
 * binary must not be able to push ID documents into the bucket. The server is
 * the only place that can guarantee that, so the switch lives here and the UI
 * merely agrees with it.
 *
 * To enable: set VERIFICATION_UPLOADS_ENABLED=true on the target alias (via
 * lib/promote.sh --set, so it is baked per environment) AND settle retention
 * first — see RETENTION_NOTE in lib/create-deal-verification-buckets.sh. Object
 * Lock cannot be added once objects exist.
 */
const UPLOADS_ENABLED = process.env.VERIFICATION_UPLOADS_ENABLED === "true";

/** Short enough that a leaked URL is near-worthless; long enough for shop wifi. */
const URL_TTL_SECONDS = 300;

/** Matches the five artifacts ZoooomMechanicRewards requires for a payout. */
const ARTIFACTS = new Set([
  "buyerPhoto",
  "sellerPhoto",
  "buyerLicenseScan",
  "sellerLicenseScan",
  "titleScan",
]);

/**
 * Images only. HEIC is included because iPhones still produce it by default and
 * the app does not re-encode before upload; PDFs and anything else are refused
 * so this cannot become a general file drop.
 */
const CONTENT_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
};

function envSuffix(context) {
  const qualifier = (context?.invokedFunctionArn || "").split(":").pop() || "";
  if (/staging/i.test(qualifier)) return "staging";
  if (/prod/i.test(qualifier)) return "prod";
  return "dev";
}

const bucketFor = (env) => process.env.VERIFICATION_BUCKET || `zoooom-deal-verification-${env}`;
const kmsKeyFor = (env) => process.env.VERIFICATION_KMS_KEY || `alias/zv-dealverify-${env}`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Content-Type": "application/json",
};
const reply = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

/**
 * Strip everything that could escape a key segment. Deliberately aggressive:
 * these values become part of an S3 path, and "../" or a stray "/" in a shop id
 * would write into a prefix the caller does not own.
 */
const safeSegment = (v, max = 80) =>
  String(v || "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, max);

export const handler = async (event, context) => {
  const method = event?.httpMethod || event?.requestContext?.http?.method || "POST";
  if (method === "OPTIONS") return reply(200, { ok: true });

  const env = envSuffix(context);
  const Bucket = bucketFor(env);

  // Checked BEFORE parsing, authenticating, or touching S3: when the feature is
  // off there is nothing to validate and no reason to read a caller's payload.
  if (!UPLOADS_ENABLED) {
    return reply(503, {
      ok: false,
      enabled: false,
      error: "verification_uploads_disabled",
      message:
        "Deal verification opens when Zoooom financing launches. We're not collecting documents yet.",
    });
  }

  let body = {};
  try {
    body = typeof event?.body === "string" ? JSON.parse(event.body) : event?.body || {};
  } catch {
    return reply(400, { error: "invalid JSON body" });
  }

  // Claims come from the API Gateway Cognito authorizer, i.e. AFTER signature
  // verification — plus an issuer check binding the token to THIS environment's
  // pool (one authorizer necessarily trusts all three). See mechanicAuth.mjs.
  const caller = verifiedCaller(event, context);
  if (!caller.ok) {
    return reply(401, {
      error: "sign in required to upload verification documents",
      reason: caller.reason,
      detail: caller.detail,
    });
  }
  const identity = { userId: caller.userId, email: caller.email };

  const masterMechanicId = safeSegment(body.masterMechanicId, 120);
  const dealId = safeSegment(body.dealId, 120);
  const artifact = String(body.artifact || "");
  const contentType = String(body.contentType || "image/jpeg").toLowerCase();

  if (!masterMechanicId) return reply(400, { error: "masterMechanicId required" });
  if (!dealId) return reply(400, { error: "dealId required" });
  if (!ARTIFACTS.has(artifact)) {
    return reply(400, { error: `artifact must be one of ${[...ARTIFACTS].join(", ")}` });
  }
  const ext = CONTENT_TYPES[contentType];
  if (!ext) {
    return reply(415, {
      error: `unsupported content type ${contentType}`,
      supported: Object.keys(CONTENT_TYPES),
    });
  }

  // Server-built key. Nothing from the body reaches it unsanitised, and the
  // uuid means a retake never silently overwrites the previous capture — with
  // versioning on, an overwrite would be recoverable but invisible.
  const Key = `${env}/${masterMechanicId}/${dealId}/${artifact}-${randomUUID()}.${ext}`;

  try {
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket,
        Key,
        ContentType: contentType,
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: kmsKeyFor(env),
        // Signed into the URL so the uploader cannot substitute its own values;
        // the bucket policy independently denies anything weaker.
        Metadata: {
          "uploaded-by": identity.userId,
          "master-mechanic-id": masterMechanicId,
          "deal-id": dealId,
          artifact,
        },
      }),
      { expiresIn: URL_TTL_SECONDS }
    );

    return reply(200, {
      ok: true,
      uploadUrl,
      key: Key,
      bucket: Bucket,
      contentType,
      expiresIn: URL_TTL_SECONDS,
      // The caller sends these back verbatim on the PUT. Mismatched headers
      // break the signature, which is the single most common integration bug
      // with presigned uploads — so they are spelled out rather than implied.
      requiredHeaders: {
        "Content-Type": contentType,
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": kmsKeyFor(env),
      },
    });
  } catch (err) {
    console.error("presign failed", err);
    return reply(500, { error: "could not create an upload URL" });
  }
};

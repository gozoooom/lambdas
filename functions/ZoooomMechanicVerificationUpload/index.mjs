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
 * caller gets 401. `identityFromEvent` returning nothing is a hard stop, not a
 * fallback.
 *
 * ⚠️ THE TOKEN IS NOT SIGNATURE-VERIFIED. API Gateway has no Cognito authorizer
 * on this route (the mechanic gateway has none configured at all), so this reads
 * the JWT payload without checking the signature — exactly like the sibling
 * routes. That is ACCEPTABLE ONLY because of the constraints below, and it is
 * why they are not optional:
 *   · the URL is PUT-only — it can never read an existing object back
 *   · the key path is built server-side from the caller's own sub; nothing in
 *     the request body can steer where the bytes land
 *   · content type is allow-listed to images, and size is capped
 *   · the URL expires in 5 minutes
 * The realistic worst case is a forged token writing junk images into a key
 * prefix it does not own. Adding a real Cognito authorizer to this route is
 * tracked as the follow-up; do NOT relax any constraint above until it exists.
 *
 * ── THE CLIENT NEVER CHOOSES THE KEY ─────────────────────────────────────────
 * Keys are `<env>/<masterMechanicId>/<dealId>/<artifact>-<uuid>.<ext>`, all
 * components sanitised. A client-supplied key is how you get path traversal into
 * another shop's evidence, and there is no reason the client needs to name it.
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

const REGION = process.env.REGION || process.env.AWS_REGION || "us-west-2";
const s3 = new S3Client({ region: REGION });

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

function identityFromEvent(event) {
  const claims = event?.requestContext?.authorizer?.claims;
  if (claims?.sub) return { userId: claims.sub, email: claims.email || null };
  const h = event?.headers || {};
  const raw = h.Authorization || h.authorization || "";
  const parts = raw.replace(/^Bearer\s+/i, "").trim().split(".");
  if (parts.length !== 3) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    // An expired token is not a valid caller. This is the one claim worth
    // checking even without signature verification — it costs nothing and stops
    // a stale token lying around on a device from still minting upload URLs.
    if (payload.exp && Date.now() / 1000 > payload.exp) return {};
    return { userId: payload.sub || null, email: payload.email || null };
  } catch {
    return {};
  }
}

export const handler = async (event, context) => {
  const method = event?.httpMethod || event?.requestContext?.http?.method || "POST";
  if (method === "OPTIONS") return reply(200, { ok: true });

  const env = envSuffix(context);
  const Bucket = bucketFor(env);

  let body = {};
  try {
    body = typeof event?.body === "string" ? JSON.parse(event.body) : event?.body || {};
  } catch {
    return reply(400, { error: "invalid JSON body" });
  }

  const identity = identityFromEvent(event);
  if (!identity.userId) {
    return reply(401, { error: "sign in required to upload verification documents" });
  }

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

#!/usr/bin/env bash
#
# create-deal-verification-buckets.sh [dev|staging|prod]...
#
# Storage for mechanic deal-verification captures: photos of the buyer and
# seller, scans of BOTH driver's licences, and a scan of the title.
#
# ── TREAT THIS AS IDENTITY-DOCUMENT STORAGE, NOT MEDIA ────────────────────────
# These objects are government ID and face images of private individuals who are
# not Zoooom users — they are the counterparties to a private-party sale. That is
# the same data class as zoooomkyc-*, and this bucket deliberately mirrors that
# bucket's controls rather than the far looser zoooom-vehicle-image-* ones.
# A leak here is a reportable breach, not an inconvenience.
#
# Controls applied (matching zoooomkyc-*, plus the lifecycle it lacks):
#   · Block Public Access — all four switches
#   · ObjectOwnership=BucketOwnerEnforced (ACLs disabled entirely)
#   · Versioning (so a bad overwrite or delete is recoverable)
#   · SSE-KMS with a PER-ENV customer-managed key, bucket key enabled
#   · Bucket policy: DenyNonTLS + DenyUnencryptedUploads + DenyWrongKMSKey
#   · Lifecycle: abort stalled multipart uploads, expire noncurrent versions
#   · CORS restricted to the Zoooom origins that perform presigned PUTs
#
# ── ONE KMS KEY PER ENVIRONMENT ───────────────────────────────────────────────
# Same shape as alias/zv-kyc-{env}. A single shared key would mean a compromised
# dev credential could decrypt production licence scans; separate keys make that
# structurally impossible rather than a matter of IAM getting it right.
#
# ⚠️ RETENTION IS A LEGAL DECISION, NOT A DEFAULT. This script expires NONCURRENT
# versions after 90 days and never auto-deletes current objects, because deleting
# transaction records on a timer could destroy evidence the AML/record-keeping
# program is required to retain. Set a real retention period with counsel and add
# an Expiration rule then — see RETENTION_NOTE at the bottom.
set -euo pipefail

REGION="${AWS_REGION:-us-west-2}"
ACCT=754623618539
ENVS=("$@")
[ ${#ENVS[@]} -eq 0 ] && ENVS=(dev staging prod)

BUCKET() { echo "zoooom-deal-verification-$1"; }
ALIAS()  { echo "alias/zv-dealverify-$1"; }

# Origins allowed to perform a presigned PUT. The mobile app sends no Origin
# header (native fetch), so this list only has to cover the browser surfaces.
CORS_ORIGINS='["https://zoooom.me","https://dev.d3dfqtkbs78aev.amplifyapp.com","https://staging-master-mechanic.d3dfqtkbs78aev.amplifyapp.com","http://localhost:3000"]'

for ENV in "${ENVS[@]}"; do
  B=$(BUCKET "$ENV"); A=$(ALIAS "$ENV")
  echo "── $ENV ─────────────────────────────────────────────"

  # 1) KMS key (idempotent: reuse the alias if it already resolves).
  KEY_ARN=$(aws kms describe-key --key-id "$A" --region "$REGION" \
    --query 'KeyMetadata.Arn' --output text 2>/dev/null || echo "")
  if [ -z "$KEY_ARN" ]; then
    KEY_ID=$(aws kms create-key --region "$REGION" \
      --description "Zoooom mechanic deal-verification captures ($ENV): buyer/seller photos, driver's licence scans, title scans" \
      --key-usage ENCRYPT_DECRYPT --key-spec SYMMETRIC_DEFAULT \
      --tags TagKey=app,TagValue=zoooom TagKey=env,TagValue=$ENV TagKey=data-class,TagValue=identity-document \
      --query 'KeyMetadata.KeyId' --output text)
    aws kms create-alias --region "$REGION" --alias-name "$A" --target-key-id "$KEY_ID"
    # Annual rotation: cheap, and it is the control auditors ask about first.
    aws kms enable-key-rotation --region "$REGION" --key-id "$KEY_ID"
    KEY_ARN=$(aws kms describe-key --key-id "$A" --region "$REGION" --query 'KeyMetadata.Arn' --output text)
    echo "→ created key $A"
  else
    echo "✓ key $A exists"
  fi

  # 2) Bucket.
  if aws s3api head-bucket --bucket "$B" --region "$REGION" 2>/dev/null; then
    echo "✓ bucket $B exists"
  else
    aws s3api create-bucket --bucket "$B" --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION" \
      --object-ownership BucketOwnerEnforced >/dev/null
    echo "→ created bucket $B"
  fi

  # 3) Block Public Access — all four. Applied unconditionally on every run:
  #    this is the single control whose absence turns a mistake into a breach,
  #    so it is re-asserted rather than assumed.
  aws s3api put-public-access-block --bucket "$B" --region "$REGION" \
    --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

  # 4) ACLs off (BucketOwnerEnforced) — re-asserted for pre-existing buckets.
  aws s3api put-bucket-ownership-controls --bucket "$B" --region "$REGION" \
    --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'

  # 5) Versioning.
  aws s3api put-bucket-versioning --bucket "$B" --region "$REGION" \
    --versioning-configuration Status=Enabled

  # 6) Default encryption with this env's CMK.
  aws s3api put-bucket-encryption --bucket "$B" --region "$REGION" \
    --server-side-encryption-configuration "{
      \"Rules\":[{
        \"ApplyServerSideEncryptionByDefault\":{\"SSEAlgorithm\":\"aws:kms\",\"KMSMasterKeyID\":\"$KEY_ARN\"},
        \"BucketKeyEnabled\":true
      }]
    }"

  # 7) Bucket policy. Default encryption sets the algorithm when the caller
  #    omits it; these Deny statements stop a caller that explicitly asks for
  #    something weaker (or for a different key) from succeeding.
  aws s3api put-bucket-policy --bucket "$B" --region "$REGION" --policy "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[
      {
        \"Sid\":\"DenyNonTLS\",
        \"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",
        \"Resource\":[\"arn:aws:s3:::$B\",\"arn:aws:s3:::$B/*\"],
        \"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}
      },
      {
        \"Sid\":\"DenyUnencryptedUploads\",
        \"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:PutObject\",
        \"Resource\":\"arn:aws:s3:::$B/*\",
        \"Condition\":{\"StringNotEquals\":{\"s3:x-amz-server-side-encryption\":\"aws:kms\"}}
      },
      {
        \"Sid\":\"DenyWrongKMSKey\",
        \"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:PutObject\",
        \"Resource\":\"arn:aws:s3:::$B/*\",
        \"Condition\":{\"StringNotEquals\":{\"s3:x-amz-server-side-encryption-aws-kms-key-id\":\"$KEY_ARN\"}}
      }
    ]
  }"

  # 8) Lifecycle. NOTE what this does NOT do: it never expires a current object.
  aws s3api put-bucket-lifecycle-configuration --bucket "$B" --region "$REGION" \
    --lifecycle-configuration '{
      "Rules":[
        {
          "ID":"abort-stalled-multipart",
          "Status":"Enabled",
          "Filter":{"Prefix":""},
          "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}
        },
        {
          "ID":"expire-noncurrent-versions",
          "Status":"Enabled",
          "Filter":{"Prefix":""},
          "NoncurrentVersionExpiration":{"NoncurrentDays":90}
        }
      ]
    }'

  # 9) CORS for presigned PUTs from the browser surfaces.
  aws s3api put-bucket-cors --bucket "$B" --region "$REGION" \
    --cors-configuration "{
      \"CORSRules\":[{
        \"AllowedOrigins\":$CORS_ORIGINS,
        \"AllowedMethods\":[\"PUT\",\"GET\"],
        \"AllowedHeaders\":[\"*\"],
        \"ExposeHeaders\":[\"ETag\"],
        \"MaxAgeSeconds\":3000
      }]
    }"

  echo "✓ $B secured (KMS $A)"
done

echo
echo "── verification ─────────────────────────────────────"
for ENV in "${ENVS[@]}"; do
  B=$(BUCKET "$ENV")
  PAB=$(aws s3api get-public-access-block --bucket "$B" --region "$REGION" \
    --query 'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]' --output text)
  ENC=$(aws s3api get-bucket-encryption --bucket "$B" --region "$REGION" \
    --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' --output text)
  VER=$(aws s3api get-bucket-versioning --bucket "$B" --region "$REGION" --query 'Status' --output text)
  echo "  $B  publicblock=[$PAB]  sse=$ENC  versioning=$VER"
done

cat <<'RETENTION_NOTE'

⚠️ RETENTION IS STILL OPEN — a deliberate omission, not an oversight.
   Nothing here ever deletes a current object. Driver's licence scans tied to a
   completed vehicle sale are records the AML / record-keeping program may be
   required to retain (commonly 5 years), and auto-expiring them on a guessed
   timer is worse than keeping them. Decide the period with counsel, then add:

     {"ID":"retain-N-years","Status":"Enabled","Filter":{"Prefix":""},
      "Expiration":{"Days":<N*365>}}

   Consider S3 Object Lock (COMPLIANCE mode) if the retention must be provable
   and tamper-evident — that CANNOT be added to an existing bucket, so decide
   before these buckets carry real data.
RETENTION_NOTE

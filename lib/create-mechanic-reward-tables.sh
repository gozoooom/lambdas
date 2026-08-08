#!/usr/bin/env bash
#
# create-mechanic-reward-tables.sh [dev|staging|prod]...
#
# Create the three tables behind the mechanic rewards program. Idempotent —
# a table that already exists is left completely alone (never updated in place),
# so re-running this after a partial failure is safe.
#
# Tables are created in ALL environments up front, even though only dev has
# traffic today. A promote moves a Lambda alias, not infrastructure: if the
# staging/prod tables don't exist at promote time the function fails on its
# first real invocation, in the environment where that costs the most. Empty
# PAY_PER_REQUEST tables cost nothing to keep waiting.
#
#   ZoooomMechanicReferral_{env}             one row per shop's referral code
#   ZoooomMechanicReferralAttribution_{env}  one row per referred consumer
#   ZoooomMechanicReward_{env}               one row per dollar amount owed  (STREAM)
#
# The reward table carries a NEW_AND_OLD_IMAGES stream because
# ZoooomMechanicRewardNotify needs the before/after pair to tell "money is now
# owed" from "a human marked it paid" — NEW_IMAGE alone cannot distinguish them.
set -euo pipefail

REGION="${AWS_REGION:-us-west-2}"
ENVS=("$@")
[ ${#ENVS[@]} -eq 0 ] && ENVS=(dev staging prod)

exists() {
  aws dynamodb describe-table --table-name "$1" --region "$REGION" >/dev/null 2>&1
}

for ENV in "${ENVS[@]}"; do
  echo "── $ENV ──────────────────────────────────────────────"

  # 1) Referral codes. Looked up by code (the QR payload) and by shop (the
  #    dashboard), so the shop lookup gets a GSI rather than a table scan.
  T="ZoooomMechanicReferral_${ENV}"
  if exists "$T"; then echo "✓ $T already exists"; else
    aws dynamodb create-table --region "$REGION" --table-name "$T" \
      --attribute-definitions \
        AttributeName=referralCode,AttributeType=S \
        AttributeName=masterMechanicId,AttributeType=S \
      --key-schema AttributeName=referralCode,KeyType=HASH \
      --billing-mode PAY_PER_REQUEST \
      --global-secondary-indexes '[{
        "IndexName":"MasterMechanicIndex",
        "KeySchema":[{"AttributeName":"masterMechanicId","KeyType":"HASH"}],
        "Projection":{"ProjectionType":"ALL"}
      }]' \
      --query 'TableDescription.TableStatus' --output text
    echo "→ created $T"
  fi

  # 2) Attribution. Keyed on the consumer because every qualify call arrives
  #    with a consumer id and nothing else; the code-side GSI is for auditing
  #    a shop's referrals, never for counting them (the counter lives on the
  #    referral row, see ZoooomMechanicReferralTrack).
  T="ZoooomMechanicReferralAttribution_${ENV}"
  if exists "$T"; then echo "✓ $T already exists"; else
    aws dynamodb create-table --region "$REGION" --table-name "$T" \
      --attribute-definitions \
        AttributeName=consumerUserId,AttributeType=S \
        AttributeName=referralCode,AttributeType=S \
        AttributeName=attributedAt,AttributeType=S \
      --key-schema AttributeName=consumerUserId,KeyType=HASH \
      --billing-mode PAY_PER_REQUEST \
      --global-secondary-indexes '[{
        "IndexName":"ReferralCodeIndex",
        "KeySchema":[
          {"AttributeName":"referralCode","KeyType":"HASH"},
          {"AttributeName":"attributedAt","KeyType":"RANGE"}
        ],
        "Projection":{"ProjectionType":"ALL"}
      }]' \
      --query 'TableDescription.TableStatus' --output text
    echo "→ created $T"
  fi

  # 3) Rewards ledger. This one holds money owed, so it gets the stream and,
  #    below, point-in-time recovery.
  T="ZoooomMechanicReward_${ENV}"
  if exists "$T"; then echo "✓ $T already exists"; else
    aws dynamodb create-table --region "$REGION" --table-name "$T" \
      --attribute-definitions \
        AttributeName=rewardId,AttributeType=S \
        AttributeName=masterMechanicId,AttributeType=S \
        AttributeName=createdAt,AttributeType=S \
      --key-schema AttributeName=rewardId,KeyType=HASH \
      --billing-mode PAY_PER_REQUEST \
      --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES \
      --global-secondary-indexes '[{
        "IndexName":"MasterMechanicIndex",
        "KeySchema":[
          {"AttributeName":"masterMechanicId","KeyType":"HASH"},
          {"AttributeName":"createdAt","KeyType":"RANGE"}
        ],
        "Projection":{"ProjectionType":"ALL"}
      }]' \
      --query 'TableDescription.TableStatus' --output text
    echo "→ created $T"
  fi
done

# PITR on the ledger only. A lost referral row costs a shop one credit toward a
# milestone; a lost reward row is a gift card that was promised and vanished.
for ENV in "${ENVS[@]}"; do
  T="ZoooomMechanicReward_${ENV}"
  echo "→ waiting for $T to go ACTIVE before enabling PITR ..."
  aws dynamodb wait table-exists --table-name "$T" --region "$REGION"
  aws dynamodb update-continuous-backups --region "$REGION" --table-name "$T" \
    --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true \
    --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' \
    --output text 2>/dev/null || echo "  (PITR already on)"
done

echo
echo "Stream ARNs (wire these to ZoooomMechanicRewardNotify):"
for ENV in "${ENVS[@]}"; do
  aws dynamodb describe-table --table-name "ZoooomMechanicReward_${ENV}" --region "$REGION" \
    --query 'Table.LatestStreamArn' --output text
done

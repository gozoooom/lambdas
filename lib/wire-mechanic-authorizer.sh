#!/usr/bin/env bash
#
# wire-mechanic-authorizer.sh
#
# Put a Cognito authorizer in front of the mechanic routes that carry a mechanic
# identity, matching how the consumer Zoooom API (4mtzppkye5 / pabikbpzo5) does
# it with CognitoAuthorizer{Env}.
#
# ── WHY ONE AUTHORIZER LISTING THREE POOLS ────────────────────────────────────
# The mechanic app has a SEPARATE user pool per environment (dev txbLud6fS,
# staging ApaugdMWV, prod Zouus0I8a) but ONE gateway with three stages. An API
# Gateway method carries exactly one authorizer id and there is no way to vary it
# per stage, so a single COGNITO_USER_POOLS authorizer lists all three pools.
#
# That alone would let a dev-pool token authorize against the prod stage. The
# gateway is therefore only half the control: it proves the token's SIGNATURE,
# and each Lambda additionally checks that the token's `iss` matches the pool for
# the alias it was invoked under. Signature verification is the expensive part
# and the part you cannot do correctly by hand; env binding is a string compare.
#
# ── WHICH ROUTES, AND WHY NOT THE OTHER TWO ───────────────────────────────────
#   /MechanicVerificationUpload  YES — hands out writes to an identity-document
#                                bucket; the Expo app always sends a token.
#   /MechanicRewards             YES — a shop's own balance and payout requests;
#                                web + app both send a token.
#   /MechanicReferral            NO  — called by the apex and marketplace CONSUMER
#                                apps, which send no mechanic token and belong to
#                                a different pool entirely. Authorizing it would
#                                silently kill every referral attribution.
#   /MechanicSite                NO  — backs public, unauthenticated shop pages.
#
# The lesson behind that table: enabling an authorizer on the internal API broke
# the dashboard because only 4 of 69 fetch sites sent tokens. Call sites were
# counted BEFORE running this, not after.
#
# ── OPTIONS IS NEVER AUTHORIZED ───────────────────────────────────────────────
# A browser preflight carries no Authorization header. Putting an authorizer on
# OPTIONS makes every cross-origin call fail with an opaque CORS error while curl
# keeps working perfectly — the same class of bug as a missing OPTIONS method.
set -euo pipefail

API=h7g4lqgvof
REGION="${AWS_REGION:-us-west-2}"
ACCT=754623618539
NAME=CognitoMechanicAuthorizer

POOLS=(us-west-2_txbLud6fS us-west-2_ApaugdMWV us-west-2_Zouus0I8a)

# --provider-arns takes a LIST: the CLI wants separate argv entries, and a
# comma-joined string is rejected as "Invalid ARNs" with the whole blob echoed
# back, which reads like the ARNs themselves are wrong.
ARN_ARGS=()
for P in "${POOLS[@]}"; do
  ARN_ARGS+=("arn:aws:cognito-idp:${REGION}:${ACCT}:userpool/${P}")
done

echo "── authorizer ────────────────────────────────────────"
AUTH_ID=$(aws apigateway get-authorizers --rest-api-id $API --region $REGION \
  --query "items[?name=='$NAME'].id" --output text)

if [ -n "$AUTH_ID" ] && [ "$AUTH_ID" != "None" ]; then
  echo "✓ $NAME exists ($AUTH_ID)"
else
  AUTH_ID=$(aws apigateway create-authorizer --rest-api-id $API --region $REGION \
    --name "$NAME" --type COGNITO_USER_POOLS \
    --provider-arns "${ARN_ARGS[@]}" \
    --identity-source 'method.request.header.Authorization' \
    --query 'id' --output text)
  echo "→ created $NAME ($AUTH_ID)"
fi

resource_id() {
  aws apigateway get-resources --rest-api-id $API --region $REGION --limit 200 \
    --query "items[?path=='/$1'].id" --output text
}

# Swap a method from NONE to the Cognito authorizer. Idempotent.
protect() {
  local path="$1" method="$2"
  local rid; rid=$(resource_id "$path")
  [ -z "$rid" ] || [ "$rid" = "None" ] && { echo "  ✗ /$path not found"; return 1; }

  aws apigateway update-method --rest-api-id $API --region $REGION \
    --resource-id "$rid" --http-method "$method" \
    --patch-operations \
      op=replace,path=/authorizationType,value=COGNITO_USER_POOLS \
      op=replace,path=/authorizerId,value="$AUTH_ID" \
    --query '[httpMethod,authorizationType]' --output text | sed 's/^/  ✓ /'
}

echo "── protected routes ──────────────────────────────────"
protect MechanicVerificationUpload POST
protect MechanicRewards GET
protect MechanicRewards POST

echo "── left unauthenticated ON PURPOSE ───────────────────"
echo "  · /MechanicReferral  (consumer apps, different pool, no token)"
echo "  · /MechanicSite      (public shop pages)"
echo "  · every OPTIONS      (preflight carries no Authorization header)"

echo "── deploy stages ─────────────────────────────────────"
for S in dev staging prod; do
  for attempt in 1 2 3 4 5 6; do
    if ID=$(aws apigateway create-deployment --rest-api-id $API --region $REGION \
        --stage-name "$S" --description "cognito authorizer on mechanic identity routes" \
        --query 'id' --output text 2>/dev/null); then
      echo "  ✓ $S -> $ID"; break
    fi
    [ "$attempt" = 6 ] && { echo "  ✗ $S FAILED"; exit 1; }
    sleep 12
  done
done

echo
echo "── verification ──────────────────────────────────────"
for S in dev staging prod; do
  U="https://${API}.execute-api.${REGION}.amazonaws.com/${S}"
  echo -n "  $S  no-token GET /MechanicRewards -> "
  curl -s -o /dev/null -w "%{http_code}" "$U/MechanicRewards?masterMechanicId=x"; echo -n "  (want 401)"
  echo -n "   OPTIONS -> "
  curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "$U/MechanicRewards" \
    -H 'Origin: https://zoooom.me' -H 'Access-Control-Request-Method: POST'; echo -n " (want 200)"
  echo -n "   referral still open -> "
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$U/MechanicReferral" \
    -H 'Content-Type: application/json' -d '{"action":"lookup","referralCode":"ZM-NOPE99"}'
done
echo "  (referral 404 = reachable without a token, which is correct)"

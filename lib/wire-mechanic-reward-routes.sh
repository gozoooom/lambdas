#!/usr/bin/env bash
#
# wire-mechanic-reward-routes.sh
#
# Add /MechanicRewards, /MechanicReferral, /MechanicSite and
# /MechanicVerificationUpload to the mechanic API (h7g4lqgvof)
# and deploy all three stages. Idempotent — safe to re-run.
#
# ── TWO THINGS THIS DOES DIFFERENTLY FROM THE ROUTES ALREADY ON THIS GATEWAY ──
#
# 1. STAGE VARIABLES, NOT A PINNED ALIAS. Every existing route here integrates
#    against a hardcoded `:staging` alias, so the dev, staging and prod stage
#    URLs all execute the same Lambda against the same tables. That is a known
#    wart on the older routes and NOT something to copy into a path that decides
#    who gets paid: a dev test run must not mint a reward row in the prod ledger.
#    These routes use ${stageVariables.lambdaAlias}, and each stage carries its
#    own value, so the environment is decided by the stage the browser called.
#
# 2. OPTIONS IS CREATED ON EVERY STAGE, DELIBERATELY. A missing OPTIONS method
#    has bitten this codebase before: /vehicle/generate_listing_ai worked under
#    curl in prod and failed in every browser, because curl sends no preflight
#    and the gateway 403'd the OPTIONS the browser sent — the Lambda was never
#    invoked, so the logs looked clean. MOCK integration rather than proxying
#    the preflight to the Lambda, so a cold start can never turn into a CORS
#    failure the front end reports as "network error".
set -euo pipefail

API=h7g4lqgvof
REGION="${AWS_REGION:-us-west-2}"
ACCT=754623618539
ROOT_ID=$(aws apigateway get-resources --rest-api-id $API --region $REGION \
  --query "items[?path=='/'].id" --output text)

# CORS headers echoed by the MOCK preflight. Authorization is included because
# the mechanic app sends a Cognito id token on these routes.
CORS_HEADERS="'Content-Type,Authorization'"

resource_id() {
  aws apigateway get-resources --rest-api-id $API --region $REGION --limit 200 \
    --query "items[?path=='/$1'].id" --output text
}

ensure_resource() {
  local part="$1" id
  id=$(resource_id "$part")
  if [ -n "$id" ] && [ "$id" != "None" ]; then echo "$id"; return; fi
  aws apigateway create-resource --rest-api-id $API --region $REGION \
    --parent-id "$ROOT_ID" --path-part "$part" --query 'id' --output text
}

ensure_lambda_method() {
  local rid="$1" method="$2" fn="$3"
  aws apigateway put-method --rest-api-id $API --region $REGION \
    --resource-id "$rid" --http-method "$method" --authorization-type NONE \
    >/dev/null 2>&1 || true
  aws apigateway put-integration --rest-api-id $API --region $REGION \
    --resource-id "$rid" --http-method "$method" \
    --type AWS_PROXY --integration-http-method POST \
    --uri "arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/arn:aws:lambda:${REGION}:${ACCT}:function:${fn}:\${stageVariables.lambdaAlias}/invocations" \
    >/dev/null
  echo "  ✓ $method -> $fn:\${stageVariables.lambdaAlias}"
}

ensure_options() {
  local rid="$1" allow="$2"
  aws apigateway put-method --rest-api-id $API --region $REGION \
    --resource-id "$rid" --http-method OPTIONS --authorization-type NONE >/dev/null 2>&1 || true
  aws apigateway put-integration --rest-api-id $API --region $REGION \
    --resource-id "$rid" --http-method OPTIONS --type MOCK \
    --request-templates '{"application/json":"{\"statusCode\": 200}"}' >/dev/null
  aws apigateway put-method-response --rest-api-id $API --region $REGION \
    --resource-id "$rid" --http-method OPTIONS --status-code 200 \
    --response-parameters '{"method.response.header.Access-Control-Allow-Headers":true,"method.response.header.Access-Control-Allow-Methods":true,"method.response.header.Access-Control-Allow-Origin":true}' \
    >/dev/null 2>&1 || true
  aws apigateway put-integration-response --rest-api-id $API --region $REGION \
    --resource-id "$rid" --http-method OPTIONS --status-code 200 \
    --response-parameters "{\"method.response.header.Access-Control-Allow-Headers\":\"${CORS_HEADERS}\",\"method.response.header.Access-Control-Allow-Methods\":\"'${allow}'\",\"method.response.header.Access-Control-Allow-Origin\":\"'*'\"}" \
    >/dev/null
  echo "  ✓ OPTIONS (MOCK) allow: $allow"
}

# API Gateway needs invoke permission on EACH alias it can resolve to. The
# stage-variable URI means the gateway picks the alias at request time, so a
# missing grant surfaces as a 500 on one stage only — usually the one nobody
# tested. Grant all three up front.
grant_invoke() {
  local fn="$1"
  for ALIAS in Dev Staging Prod; do
    aws lambda add-permission --function-name "${fn}:${ALIAS}" \
      --statement-id "apigw-${API}-${ALIAS}" --action lambda:InvokeFunction \
      --principal apigateway.amazonaws.com \
      --source-arn "arn:aws:execute-api:${REGION}:${ACCT}:${API}/*/*/*" \
      --region $REGION >/dev/null 2>&1 && echo "  ✓ invoke grant ${fn}:${ALIAS}" \
      || echo "  · invoke grant ${fn}:${ALIAS} already present"
  done
}

echo "── /MechanicRewards ──────────────────────────────────"
RID=$(ensure_resource MechanicRewards)
ensure_lambda_method "$RID" GET  ZoooomMechanicRewards
ensure_lambda_method "$RID" POST ZoooomMechanicRewards
ensure_options "$RID" "GET,POST,OPTIONS"
grant_invoke ZoooomMechanicRewards

echo "── /MechanicReferral ─────────────────────────────────"
RID=$(ensure_resource MechanicReferral)
ensure_lambda_method "$RID" POST ZoooomMechanicReferralTrack
ensure_options "$RID" "POST,OPTIONS"
grant_invoke ZoooomMechanicReferralTrack

echo "── /MechanicSite (public, read-only) ─────────────────"
RID=$(ensure_resource MechanicSite)
ensure_lambda_method "$RID" GET ZoooomMechanicSite
ensure_options "$RID" "GET,OPTIONS"
grant_invoke ZoooomMechanicSite

echo "── /MechanicVerificationUpload (presigned PUT) ───────"
RID=$(ensure_resource MechanicVerificationUpload)
ensure_lambda_method "$RID" POST ZoooomMechanicVerificationUpload
ensure_options "$RID" "POST,OPTIONS"
grant_invoke ZoooomMechanicVerificationUpload

echo "── stage variables ───────────────────────────────────"
set_stage_var() {
  aws apigateway update-stage --rest-api-id $API --region $REGION --stage-name "$1" \
    --patch-operations "op=replace,path=/variables/lambdaAlias,value=$2" \
    --query 'variables' --output json
}
set_stage_var dev Dev
set_stage_var staging Staging
set_stage_var prod Prod

# API Gateway throttles CreateDeployment hard (a few per minute per account).
# Three back-to-back calls reliably lose the 2nd and 3rd, which silently leaves
# staging and prod serving the OLD route set — the failure looks like "the
# route 403s in prod only". Retry each stage until it lands.
echo "── deploy stages ─────────────────────────────────────"
for S in dev staging prod; do
  for attempt in 1 2 3 4 5 6; do
    if ID=$(aws apigateway create-deployment --rest-api-id $API --region $REGION \
        --stage-name "$S" --description "mechanic rewards + referral routes" \
        --query 'id' --output text 2>/dev/null); then
      echo "  ✓ $S -> $ID"
      break
    fi
    [ "$attempt" = 6 ] && { echo "  ✗ $S FAILED after 6 attempts"; exit 1; }
    sleep 12
  done
done

echo
echo "Smoke (expect 400 'masterMechanicId required' — proves routing + alias resolve):"
for S in dev staging prod; do
  echo -n "  $S: "
  curl -s -o /dev/null -w "%{http_code}\n" "https://${API}.execute-api.${REGION}.amazonaws.com/${S}/MechanicRewards"
done

#!/usr/bin/env bash
#
# deploy.sh <FunctionName>
# Deploy functions/<name>/ to the function's $LATEST (= the dev alias).
#
# SAFETY INVARIANT: staging/prod ride PUBLISHED versions via their own aliases,
# so updating $LATEST only affects dev — UNLESS a prod/staging alias has been
# pointed at $LATEST. This script REFUSES to deploy in that case, so you can
# never accidentally ship dev code to prod by editing $LATEST.
#
# Promotion to staging/prod is deliberate and NOT done here:
#   aws lambda publish-version --function-name <name>
#   aws lambda update-alias --function-name <name> --name Prod --function-version <N>
set -euo pipefail
NAME="${1:?usage: deploy.sh <FunctionName>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-us-west-2}"
DIR="$ROOT/functions/$NAME"
[ -d "$DIR" ] || { echo "ABORT: no functions/$NAME (pull.sh it first)"; exit 1; }

# 1) Safety: no prod/staging alias may point at $LATEST.
BAD=$(aws lambda list-aliases --function-name "$NAME" --region "$REGION" \
  --query "Aliases[?FunctionVersion=='\$LATEST' && (contains(Name,'rod')||contains(Name,'taging'))].Name" \
  --output text 2>/dev/null || echo "")
if [ -n "$BAD" ] && [ "$BAD" != "None" ]; then
  echo "ABORT: alias(es) [$BAD] point to \$LATEST — deploying would hit prod/staging, not just dev."
  exit 1
fi

# 2) Syntax-check every .mjs before shipping.
for f in "$DIR"/*.mjs; do [ -e "$f" ] && node --check "$f"; done

# 3) Zip + update $LATEST.
TMP=$(mktemp -d); ZIP="$TMP/deploy.zip"
( cd "$DIR" && zip -q -r "$ZIP" . -x '*.zip' 'node_modules/*' 'test.mjs' )
echo "→ deploying $NAME to \$LATEST (dev) ..."
aws lambda update-function-code --function-name "$NAME" --zip-file "fileb://$ZIP" --region "$REGION" \
  --query '{Status:LastUpdateStatus,CodeSize:CodeSize}' --output json
rm -rf "$TMP"

# 4) Wait for the update to settle.
for i in $(seq 1 10); do
  S=$(aws lambda get-function-configuration --function-name "$NAME" --region "$REGION" --query 'LastUpdateStatus' --output text)
  [ "$S" = "Successful" ] && { echo "✓ $NAME deployed to \$LATEST (dev)."; break; }
  sleep 3
done
echo "Promote to staging/prod deliberately: publish-version + move Staging/Prod aliases (see README)."

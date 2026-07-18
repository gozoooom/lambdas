#!/usr/bin/env bash
#
# pull.sh <FunctionName> [<FunctionName> ...]
# Download the CURRENT deployed code ($LATEST = dev) for each function into
# functions/<name>/. This is how you keep the repo == what's actually deployed:
# ALWAYS pull-live before you edit, so you never clobber drift.
#
# With no args, pulls every function listed in manifest.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-us-west-2}"

names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  names=($(python3 -c "import json;print(' '.join(f['name'] for f in json.load(open('$ROOT/manifest.json'))['functions']))"))
fi

for NAME in "${names[@]}"; do
  DIR="$ROOT/functions/$NAME"
  mkdir -p "$DIR"
  echo "→ pulling $NAME ..."
  URL=$(aws lambda get-function --function-name "$NAME" --region "$REGION" --query 'Code.Location' --output text)
  TMP=$(mktemp -d)
  curl -s "$URL" -o "$TMP/f.zip"
  # Clear only files we manage (keep any local README/notes in the dir).
  rm -f "$DIR"/*.mjs "$DIR"/*.js 2>/dev/null || true
  unzip -o -q "$TMP/f.zip" -d "$DIR"
  rm -rf "$TMP"
  echo "  ✓ functions/$NAME ($(ls "$DIR" | tr '\n' ' '))"
done

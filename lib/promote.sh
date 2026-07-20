#!/usr/bin/env bash
#
# promote.sh <FunctionName> <Staging|Prod> [--yes]
#
# Promote the code currently on $LATEST (= dev) to the Staging or Prod alias,
# WITHOUT carrying dev environment variables into that environment.
#
# ── WHY THIS SCRIPT EXISTS ────────────────────────────────────────────────────
# Lambda bakes environment variables into a published version. So the "obvious"
# promote — `publish-version` then point Prod at it — publishes $LATEST's **dev**
# env vars and ships them to prod. Prod then silently reads/writes `_dev` tables.
# It looks completely successful: publish succeeds, the alias moves, nothing errors.
# The only symptom is prod traffic hitting dev data.
#
# This happened for real on 2026-07-20 (ZoooomAddVehicleDynamoDB). Caught in ~40s
# with zero invocations in the window, so no data was misrouted — but only because
# the function is low-traffic. On a busy function it would have been silent damage.
#
# The correct dance, which this script performs:
#   1. read the TARGET alias's existing env vars  (source of truth — never guessed)
#   2. set $LATEST's env to those values
#   3. publish-version                            (captures new code + target env)
#   4. point the alias at that new version
#   5. ALWAYS restore $LATEST's env back to dev   (EXIT trap — even on failure)
#   6. verify parity across every alias, and fail loudly on any mismatch
#
# Each environment gets its OWN published version. Never share one version across
# two environments — they need different baked env vars, so one version cannot
# serve both correctly.
set -euo pipefail

FN="${1:?usage: promote.sh <FunctionName> <Staging|Prod> [--yes]}"
TARGET="${2:?usage: promote.sh <FunctionName> <Staging|Prod> [--yes]}"
ASSUME_YES="${3:-}"
REGION="${AWS_REGION:-us-west-2}"

case "$(echo "$TARGET" | tr '[:upper:]' '[:lower:]')" in
  staging) WANT_SUFFIX="staging" ;;
  prod)    WANT_SUFFIX="prod" ;;
  *) echo "ABORT: target must be Staging or Prod (got '$TARGET')"; exit 1 ;;
esac

j() { python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)$1))"; }

wait_ok() {
  for _ in $(seq 1 30); do
    [ "$(aws lambda get-function-configuration --function-name "$FN" --region "$REGION" \
         --query LastUpdateStatus --output text)" = "Successful" ] && return 0
    sleep 2
  done
  echo "ABORT: function update did not settle"; exit 1
}

# ── 1. Snapshot dev ($LATEST) env FIRST, so the restore trap can always run ────
DEV_ENV_JSON=$(aws lambda get-function-configuration --function-name "$FN" --region "$REGION" \
  --query 'Environment.Variables' --output json)
if [ "$DEV_ENV_JSON" = "null" ]; then DEV_ENV_JSON='{}'; fi

restore_dev() {
  echo "→ restoring \$LATEST env to dev values"
  aws lambda update-function-configuration --function-name "$FN" --region "$REGION" \
    --environment "$(python3 -c "import json,sys;print(json.dumps({'Variables':json.loads(sys.argv[1])}))" "$DEV_ENV_JSON")" \
    >/dev/null 2>&1 || echo "WARNING: could not restore \$LATEST env — CHECK MANUALLY"
  wait_ok 2>/dev/null || true
}
trap restore_dev EXIT

# ── 2. The target alias's CURRENT env is the source of truth for that env ──────
if ! TARGET_ENV_JSON=$(aws lambda get-function-configuration --function-name "$FN:$TARGET" \
     --region "$REGION" --query 'Environment.Variables' --output json 2>/dev/null); then
  echo "ABORT: alias '$TARGET' does not exist on $FN."
  echo "       Create it with the correct env vars first — this script will not invent them."
  exit 1
fi
[ "$TARGET_ENV_JSON" = "null" ] && TARGET_ENV_JSON='{}'

# ── 3. Refuse to promote if the target's OWN env is already cross-wired ────────
BAD=$(python3 - "$TARGET_ENV_JSON" "$WANT_SUFFIX" <<'PY'
import json,re,sys
env=json.loads(sys.argv[1]); want=sys.argv[2]
bad=[f"{k}={v}" for k,v in env.items() if isinstance(v,str)
     for got in re.findall(r'_(dev|staging|prod)\b',v) if got!=want]
print("; ".join(sorted(set(bad))))
PY
)
if [ -n "$BAD" ]; then
  echo "ABORT: $FN:$TARGET env is ALREADY cross-wired — fix it before promoting:"
  echo "       $BAD"
  exit 1
fi

echo "── promoting $FN → $TARGET"
echo "   target env (preserved from the existing alias):"
echo "$TARGET_ENV_JSON" | python3 -c "import json,sys;[print(f'     {k}={v}') for k,v in sorted(json.load(sys.stdin).items())]"
if [ "$ASSUME_YES" != "--yes" ]; then
  read -r -p "   proceed? [y/N] " a; [ "$a" = y ] || { echo "aborted"; exit 1; }
fi

# ── 4. Swap env → publish → move alias. The trap restores dev env regardless. ──
aws lambda update-function-configuration --function-name "$FN" --region "$REGION" \
  --environment "$(python3 -c "import json,sys;print(json.dumps({'Variables':json.loads(sys.argv[1])}))" "$TARGET_ENV_JSON")" >/dev/null
wait_ok
VER=$(aws lambda publish-version --function-name "$FN" --region "$REGION" \
  --description "promote to $TARGET ($WANT_SUFFIX env)" --query Version --output text)
aws lambda update-alias --function-name "$FN" --region "$REGION" \
  --name "$TARGET" --function-version "$VER" >/dev/null
echo "   $TARGET → v$VER"

restore_dev
trap - EXIT

# ── 5. Parity gate: every alias must match its own environment ────────────────
echo "── parity check"
FAIL=0
for A in $(aws lambda list-aliases --function-name "$FN" --region "$REGION" --query 'Aliases[].Name' --output text); do
  L=$(echo "$A" | tr '[:upper:]' '[:lower:]')
  case "$L" in dev|staging|prod) ;; *) continue ;; esac
  E=$(aws lambda get-function-configuration --function-name "$FN:$A" --region "$REGION" \
      --query 'Environment.Variables' --output json)
  [ "$E" = "null" ] && E='{}'
  M=$(python3 - "$E" "$L" <<'PY'
import json,re,sys
env=json.loads(sys.argv[1]); want=sys.argv[2]
bad=[f"{k}={v}" for k,v in env.items() if isinstance(v,str)
     for got in re.findall(r'_(dev|staging|prod)\b',v) if got!=want]
print("; ".join(sorted(set(bad))))
PY
)
  if [ -n "$M" ]; then echo "   ✗ $A  MISMATCH: $M"; FAIL=1; else echo "   ✓ $A"; fi
done
[ "$FAIL" = 0 ] || { echo "PARITY FAILED — roll the alias back to its previous version NOW."; exit 1; }
echo "✓ $FN promoted to $TARGET; all aliases env-correct; \$LATEST back on dev."

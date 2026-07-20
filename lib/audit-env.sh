#!/usr/bin/env bash
#
# audit-env.sh [FunctionName ...]
#
# Fleet-wide check that every Lambda alias's baked environment variables point at
# its OWN environment. Flags any Dev/Staging/Prod alias whose env references a
# `_dev` / `_staging` / `_prod` resource belonging to a different environment.
#
# Run this after ANY promotion, and periodically. Exits non-zero on mismatch so
# it can gate a release. With no args, audits every Zoooom* function.
set -euo pipefail
REGION="${AWS_REGION:-us-west-2}"
export AWS_REGION="$REGION"
python3 - "$@" <<'PY'
import boto3, re, sys
L = boto3.client("lambda")
names = sys.argv[1:]
if not names:
    names = [f["FunctionName"] for pg in L.get_paginator("list_functions").paginate()
             for f in pg["Functions"] if f["FunctionName"].startswith(("Zoooom", "Zooooom"))]

# Functions that resolve their per-env config from the invoked alias qualifier at
# RUNTIME. Their baked env vars are vestigial and intentionally look like dev, so
# a static read of them is a false positive. Keep this list tiny and justified.
QUALIFIER_BASED = {"ZoooomServiceReminder"}

ENVS = {"dev", "staging", "prod"}
checked = fnc = 0
mismatches, skipped = [], []
for n in names:
    try:
        aliases = [a["Name"] for a in L.list_aliases(FunctionName=n)["Aliases"]
                   if a["Name"].lower() in ENVS]
    except Exception:
        continue
    if not aliases:
        continue
    fnc += 1
    if n in QUALIFIER_BASED:
        skipped.append(n)
        continue
    for a in aliases:
        checked += 1
        env = (L.get_function_configuration(FunctionName=f"{n}:{a}")
                .get("Environment", {}).get("Variables", {}) or {})
        want = a.lower()
        bad = sorted({f"{k}={v}" for k, v in env.items() if isinstance(v, str)
                      for got in re.findall(r"_(dev|staging|prod)\b", v) if got != want})
        if bad:
            mismatches.append((n, a, bad))

print(f"functions with env aliases: {fnc} | alias-configs checked: {checked}")
if skipped:
    print(f"skipped (qualifier-based, env resolved at runtime): {', '.join(sorted(skipped))}")
if not mismatches:
    print("\n✓ NO MISMATCHES — every alias points at its own environment.")
    sys.exit(0)
print(f"\n✗ {len(mismatches)} MISMATCH(ES):")
for n, a, bad in sorted(mismatches):
    print(f"\n  {n}:{a}")
    for b in bad:
        print(f"     {b}")
sys.exit(1)
PY

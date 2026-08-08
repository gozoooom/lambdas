#!/usr/bin/env bash
#
# parity-check.sh [--json] [FunctionName ...]
#
# Cross-ENVIRONMENT drift gate for the alias-per-env fleet (dev=$LATEST /
# Staging / Prod). Complements audit-env.sh (which only checks a single alias
# for cross-wired _dev/_staging/_prod values). This script compares the THREE
# aliases of each function against EACH OTHER and flags drift that browser e2e
# structurally cannot catch:
#
#   • CODE drift        — CodeSha256 differs across aliases (a fix landed in one
#                         env only). NOTE: sha can differ for packaging reasons
#                         even when handler code is identical, so CODE drift is a
#                         WARN (investigate), not a hard FAIL.
#   • CONFIG drift      — Timeout / Runtime / MemorySize differ. HARD FAIL: these
#                         are the "dev raised the timeout to 30s, prod still 3s"
#                         class that silently times out under real prod latency.
#   • ENV-KEY drift     — an env var KEY present on one alias, missing on another
#                         (values are NOT printed — secrets stay out of logs).
#                         HARD FAIL.
#   • VERSION ordering  — Staging version HIGHER than Prod (staging got a promote
#                         prod never did). WARN.
#   • CROSS-WIRE        — an env value points at another env's resource. HARD FAIL
#                         (delegates to the same rule as audit-env.sh).
#
# Also checks, once (not per-function):
#   • GATEWAY route parity across the 3 consumer REST APIs + integration alias.
#   • EventBridge cron targets that are unqualified ($LATEST) so staging/prod get
#     no scheduled run.
#
# Exit 0 only if there are ZERO hard failures. Run it as the FIRST step of every
# promotion and on a daily cron → Slack. Intentional drift is allow-listed below
# with a justification — keep that list SHORT and reviewed.
set -euo pipefail
REGION="${AWS_REGION:-us-west-2}"
export AWS_REGION="$REGION"
JSON=""; ARGS=()
for a in "$@"; do case "$a" in --json) JSON=1;; *) ARGS+=("$a");; esac; done

python3 - "$JSON" "${ARGS[@]+"${ARGS[@]}"}" <<'PY'
import boto3, re, sys, json
JSON = bool(sys.argv[1])
names = sys.argv[2:]
L = boto3.client("lambda")

# ── Allow-list: (function-or-prefix, dimension) pairs that are INTENTIONALLY
# different across envs. Keep tiny + justified. dimension ∈ {code,config,env,*}.
ALLOW_PREFIX = [
    # Mechanic subsystem is under active development; drift expected (owner-confirmed 2026-07-23).
    ("ZoooomMasterMechanic", "*"), ("ZoooomMechanic", "*"),
    ("ZoooomAddMechanicUser", "*"), ("ZoooomAddMasterMechanicUser", "*"),
    ("ZoooomGetMechanic", "*"), ("ZoooomInternalGetMechanic", "*"),
    ("ZoooomUpdateMechanic", "*"), ("ZoooomSearchForConsumers", "code"),
    ("ZoooomGetConsumerDetails", "code"),
]
# Functions that carry a per-env value HARD-CODED in source (not env var). Their
# CodeSha256 legitimately differs per env. FIX-FORWARD: move the value to an env
# var so promote.sh can manage it; until then, code drift here is expected.
ALLOW_CODE_HARDCODED = {"ZoooomGetShowcaseVehicleDetail", "ZoooomMarketplaceFilters"}

def allowed(fn, dim):
    if fn in ALLOW_CODE_HARDCODED and dim == "code":
        return True
    for p, d in ALLOW_PREFIX:
        if fn.startswith(p) and d in ("*", dim):
            return True
    return False

if not names:
    names = sorted({f["FunctionName"] for pg in L.get_paginator("list_functions").paginate()
                    for f in pg["Functions"] if f["FunctionName"].startswith(("Zoooom","Zooooom"))})

ENVS = ["dev", "staging", "prod"]
def cfg(fn, alias):
    c = L.get_function_configuration(FunctionName=f"{fn}:{alias}")
    return dict(sha=c["CodeSha256"], rt=c.get("Runtime"), mem=c.get("MemorySize"),
                to=c.get("Timeout"), ver=c["Version"],
                env=(c.get("Environment") or {}).get("Variables", {}) or {})

def cross_wired(vals, want):
    return sorted({f"{k}" for k, v in vals.items() if isinstance(v, str)
                   for got in re.findall(r'_(dev|staging|prod)\b', v) if got != want})

fails, warns = [], []
for fn in names:
    try:
        al = {a["Name"].lower(): a["Name"] for a in L.list_aliases(FunctionName=fn)["Aliases"]}
    except Exception:
        continue
    if not all(e in al for e in ENVS):
        continue
    try:
        c = {e: cfg(fn, al[e]) for e in ENVS}
    except Exception as ex:
        warns.append((fn, "fetch", str(ex))); continue

    # code
    if len({c[e]["sha"] for e in ENVS}) > 1 and not allowed(fn, "code"):
        warns.append((fn, "code", "CodeSha256 differs: " + ", ".join(f"{e}={c[e]['sha'][:8]}" for e in ENVS)))
    # config (hard)
    for dim in ("to", "rt", "mem"):
        if len({str(c[e][dim]) for e in ENVS}) > 1 and not allowed(fn, "config"):
            fails.append((fn, "config", f"{dim}: " + ", ".join(f"{e}={c[e][dim]}" for e in ENVS)))
    # env keys (hard) — keys only, never values
    keys = {e: set(c[e]["env"]) for e in ENVS}
    allk = set().union(*keys.values())
    missing = {k: [e for e in ENVS if k not in keys[e]] for k in allk}
    missing = {k: v for k, v in missing.items() if v}
    if missing and not allowed(fn, "env"):
        for k, envs in sorted(missing.items()):
            fails.append((fn, "env-key", f"'{k}' missing on {','.join(envs)}"))
    # cross-wire (hard)
    for e in ENVS:
        bad = cross_wired(c[e]["env"], e)
        if bad:
            fails.append((fn, "cross-wire", f"{e} env keys point at another env: {','.join(bad)}"))
    # version ordering (warn)
    def n(v): return -1 if v == "$LATEST" else int(v)
    if n(c["staging"]["ver"]) > n(c["prod"]["ver"]):
        warns.append((fn, "version", f"staging v{c['staging']['ver']} > prod v{c['prod']['ver']}"))

# ── Gateway route parity (once) ────────────────────────────────────────────
GW = {"dev": "4mtzppkye5", "staging": "xlav3g21ze", "prod": "pabikbpzo5"}
try:
    ag = boto3.client("apigateway")
    routes = {}
    for e, api in GW.items():
        items = []
        pos = None
        while True:
            kw = {"restApiId": api, "limit": 500}
            if pos: kw["position"] = pos
            r = ag.get_resources(**kw)
            items += r["items"]; pos = r.get("position")
            if not pos: break
        s = set()
        for it in items:
            for m in (it.get("resourceMethods") or {}):
                if m != "OPTIONS":
                    s.add(f"{m} {it['path']}")
        routes[e] = s
    allr = set().union(*routes.values())
    for rt in sorted(allr):
        present = [e for e in ENVS if rt in routes[e]]
        if len(present) < 3:
            warns.append(("<gateway>", "route", f"'{rt}' only in {','.join(present)}"))
except Exception as ex:
    warns.append(("<gateway>", "error", str(ex)))

# ── Cron targets unqualified ($LATEST → dev only) ──────────────────────────
try:
    ev = boto3.client("events")
    for rp in ev.get_paginator("list_rules").paginate():
        for rule in rp["Rules"]:
            if not rule["Name"].startswith("Zoooom"): continue
            tg = ev.list_targets_by_rule(Rule=rule["Name"]).get("Targets", [])
            for t in tg:
                arn = t.get("Arn", "")
                if ":function:" in arn and re.search(r'Zoooom', arn) and not re.search(r':(Prod|Staging|Dev|prod|staging|dev)$', arn):
                    warns.append(("<cron>", "unqualified", f"{rule['Name']} → {arn.split(':function:')[-1]} ($LATEST=dev only)"))
except Exception as ex:
    warns.append(("<cron>", "error", str(ex)))

if JSON:
    print(json.dumps({"fails": fails, "warns": warns}, indent=2)); sys.exit(1 if fails else 0)

print(f"── parity-check: {len(names)} functions considered\n")
if fails:
    print(f"✗ {len(fails)} HARD FAILURE(S) (block promotion):")
    for fn, cat, msg in fails: print(f"   ✗ [{cat}] {fn}: {msg}")
else:
    print("✓ no hard failures")
if warns:
    print(f"\n⚠ {len(warns)} warning(s) (investigate, not blocking):")
    for fn, cat, msg in warns: print(f"   ⚠ [{cat}] {fn}: {msg}")
sys.exit(1 if fails else 0)
PY

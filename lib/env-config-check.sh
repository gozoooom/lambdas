#!/usr/bin/env bash
#
# env-config-check.sh [--strict] [--json] [appId ...]
#
# FRONTEND cross-environment config gate. The companion to parity-check.sh:
# that one compares lambda aliases; this one checks the edge NEITHER of them
# covered — the Amplify branch env vars that decide which API a frontend calls.
#
# ── WHY THIS EXISTS ───────────────────────────────────────────────────────────
# 2026-07-25: the marketplace `prod` branch had NO NEXT_PUBLIC_REPORT_API_URL, so
# it inherited the APP-LEVEL default, which is a dev endpoint. Prod pointing at
# dev. Nothing errored, no diff showed it, no e2e failed (the dev backend answers
# fine), and parity-check.sh passed green because it never reads Amplify at all.
# The defect was an ABSENCE, which is invisible to every change-scoped review.
# Same root cause on apex: 9 app-level vars still aimed at the old shared prod
# gateway, inherited by every dev-* branch, left over from before the
# gateway-per-env split.
#
# ── THE RULE ──────────────────────────────────────────────────────────────────
# Every resource a branch references must be EITHER
#   (a) the one belonging to that branch's environment, OR
#   (b) on the SHARED registry below — declared, justified, reviewed.
# Anything else is a hard failure. (b) is what keeps fail-closed workable: the
# VIN/plate decode caches and taxonomy tables are shared ON PURPOSE, so we never
# re-pay an external API for the same VIN across three environments. Sharing is
# fine; UNDECLARED sharing is the bug.
#
# --strict additionally fails when a branch INHERITS an env-specific var from
# app-level instead of declaring its own. That is the fail-closed posture: a
# forgotten variable should break its own branch loudly, never resolve silently
# to another environment's backend.
set -euo pipefail
REGION="${AWS_REGION:-us-west-2}"
STRICT=""
JSON=""
APPS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --strict) STRICT=1; shift ;;
    --json)   JSON=1; shift ;;
    *)        APPS+=("$1"); shift ;;
  esac
done
[ ${#APPS[@]} -eq 0 ] && APPS=($(aws amplify list-apps --region "$REGION" --query 'apps[].appId' --output text))

export REGION STRICT JSON
printf '%s\n' "${APPS[@]}" | python3 -c '
import json, os, re, subprocess, sys

REGION = os.environ["REGION"]
STRICT = bool(os.environ.get("STRICT"))
AS_JSON = bool(os.environ.get("JSON"))

def aws(*args):
    out = subprocess.run(["aws", *args, "--region", REGION, "--output", "json"],
                         capture_output=True, text=True)
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout or "null")
    except json.JSONDecodeError:
        return None

# ── Per-environment resources. A value naming one of these belongs to that env. ──
ENV_RESOURCES = {
    "dev": [
        "4mtzppkye5",            # ZoooomAPI-Dev
        "2s95b8ogjd",            # Marketplace-Dev
        "sdgbzsatq2",            # ZoooomKYC-dev
        "us-west-2_YbCcOFoOH",   # dev user pool
        "us-west-2ybccofooh",    # dev hosted-UI domain
        "8e9393e5-0b94-4bc3-8274-818c754d956e",  # dev identity pool
        "zoooom-vehicle-image-dev", "aws-textractdocumentbucket-dev",
        "https://api.zoooom.me", "dev.zoooom.me",
        "zoooom/stripe/secret-key/dev",
    ],
    "staging": [
        "xlav3g21ze", "is6570g20d", "dazvqwf1zg",
        "us-west-2_MBEiUbUEv", "us-west-2mbeiubuev",
        "d32fc072-f23f-4c64-85d5-e1724322cbfe",
        "zoooom-vehicle-image-staging",
        "staging-api.zoooom.me", "staging.zoooom.me",
        "zoooom/stripe/secret-key/staging",
    ],
    "prod": [
        "pabikbpzo5", "8n88bt8wnb", "h4icuahqp6",
        "us-west-2_aWEnHDaAh", "us-west-2awenhdaah",
        "d5d9ef33-a383-48a4-80ee-36bb4cc3a229",
        "zoooom-vehicle-image-prod",
        "prod-api.zoooom.me",
        "zoooom/stripe/secret-key/prod",
    ],
}

# ── SHARED registry: intentionally ONE instance across all environments. ──────
# Keep this list short, and every entry earns its place with a reason. These are
# what make fail-closed safe — without the registry the gate would scream at the
# decode caches, which is exactly the false alarm that gets a gate switched off.
SHARED = {
    # Decode / external-API caches — shared so a VIN or plate is bought ONCE,
    # not once per environment. See reference_mmyt_gold_standard.
    "ZoooomVinLookup": "VIN→MMYT decode cache (paid VDB call)",
    "ZoooomVinMarketLookup": "VIN→market-value cache (paid VDB call)",
    "ZoooomMMYTSpec": "MMYT catalog — gold-standard intrinsic specs",
    "ZoooomMMYTRaw": "raw VDB decode archive",
    "ZoooomMMYTCost": "market-value cache keyed by MMYT",
    "ZoooomMMYTMaintenance": "maintenance schedules by MMYT",
    "ZoooomVDCatalog": "VD YMMT dropdown catalog",
    "ZoooomVehicleCatalog": "vehicle catalog reference data",
    "ZoooomTitleChecks": "title-brand cache (slow + paid VD call)",
    "ZoooomStolenChecks": "theft cache, once per VIN per 30d (paid)",
    "ZoooomEVSpec": "EV spec reference data",
    "VehicleRecalls": "NHTSA recall cache",
    # Reference / taxonomy data — same content in every env by definition.
    "ZoooomServiceTaxonomy": "service taxonomy reference data",
    "ZoooomState": "US state reference data",
    "ZoooomMake": "vehicle make reference data",
    "ZoooomStdMaintenance": "standard maintenance reference",
    "ZoooomStdMaintenanceDB": "standard maintenance reference",
    "ZoooomMaintenanceTable": "maintenance reference",
    "ZoooomWarrantyTable": "warranty reference",
    "ZoooomVehicleWarranty": "warranty reference",
    "ZoooomMechanicService": "mechanic service reference",
    "ZoooomConfig": "global config",
    # Shared lambdas (no per-env alias, by design). Verify with:
    #   aws lambda list-aliases --function-name X --query "length(Aliases)"  → 0
    # AND no _dev/_staging/_prod table in its env. Both must hold to list here.
    "ZoooomVINDecodeVDB": "single decoder writing the shared caches above",
    "ZoooomGetEVSpec": "read-only EV spec service, 0 aliases, shared ZoooomEVSpec",
    "ev-spec": "route of the shared ZoooomGetEVSpec service (stage name is cosmetic)",
    # Shared frontend services / analytics — one instance on purpose.
    "hrjes5wvpmybgus6lkeccxi2fa0ichix": "support-chat lambda URL (single fn)",
    "GTM-MHVWTDPH": "one GTM container, env split by trigger",
    "590bae02f301780d6687cc65a015a643": "one Mixpanel project",
    "a2_hyi6lbd35gfr": "one Reddit pixel",
}

# Branches that serve nobody — skipped so their noise never buries a real finding.
IGNORED_BRANCHES = {
    ("zoooom", "main"): "ancient branch, not domain-mapped (zoooom.me is served by Prod)",
}

# Apps with their OWN environment setup (own auth, own gateways, own conventions —
# mechanics and internal staff are not consumer users). Findings are REPORTED so
# they are visible, but they never gate a consumer release, and nothing here gets
# "fixed" against consumer-platform rules. Run with --include-own-setup to enforce.
OWN_SETUP_APPS = {
    "ZoooomMechanic": "mechanic auth/session is its own system, not consumer Cognito",
    "InternalDashboard": "internal staff tool, own internal-user API",
}

# A Next.js browser bundle can ONLY read NEXT_PUBLIC_*. A var named NEXT_AWS_FOO is
# invisible at runtime, so the code silently falls back to whatever app-level says —
# which is how mechanic PROD ended up on the DEV session API while its branch config
# looked correct at a glance. Vite has the same trap with non-VITE_ names.
INVISIBLE_KEY = re.compile(r"^(NEXT_(?!PUBLIC_)[A-Z].*|VITE[A-Z].*)$")

# Branch → environment. Anything not listed is treated as a dev-class preview.
def branch_env(branch):
    b = branch.lower()
    # seo-* are the subdirectory-migration branches; they carry PROD values by design
    # (seo-marketplace is what CloudFront serves at zoooom.me/marketplace).
    if b in ("prod", "main", "seo-marketplace", "seo-mechanics"):
        return "prod"
    if b == "staging-master-mechanic":
        return "staging"
    if b.startswith("staging"):
        return "staging"
    return "dev"

RESOURCE_HINT = re.compile(
    r"(execute-api|us-west-2_[A-Za-z0-9]+|amazonaws\.com|zoooom\.me|"
    r"zoooom-vehicle-image|textractdocumentbucket|secret-key)"
)

# Gateways that still carry MULTIPLE stages on one API (the pre-split topology the
# core APIs moved away from). For these the STAGE PATH is what names the env, so
# .../h7g4lqgvof.../dev on a prod branch is a leak even though the host looks fine.
STAGE_IN_PATH = re.compile(r"execute-api\.[a-z0-9-]+\.amazonaws\.com/([A-Za-z0-9_-]+)")
STAGE_TO_ENV = {"dev": "dev", "staging": "staging", "prod": "prod", "default": None}

def classify(value):
    """Return (env_owning_this_value | "shared" | None) for a var value."""
    v = str(value)
    for token, _why in SHARED.items():
        if token in v:
            return "shared"
    hits = {env for env, toks in ENV_RESOURCES.items() if any(t in v for t in toks)}
    if len(hits) == 1:
        return hits.pop()
    if len(hits) > 1:
        return "ambiguous"
    # Unknown gateway id → fall back to the stage segment of the URL.
    m = STAGE_IN_PATH.search(v)
    if m:
        return STAGE_TO_ENV.get(m.group(1).lower())
    return None

fails, warns, checked = [], [], 0
own_setup = []
report = []

for app_id in [l.strip() for l in sys.stdin if l.strip()]:
    app = (aws("amplify", "get-app", "--app-id", app_id) or {}).get("app") or {}
    app_name = app.get("name", app_id)
    app_vars = app.get("environmentVariables") or {}
    own = app_name in OWN_SETUP_APPS and not os.environ.get("INCLUDE_OWN_SETUP")
    branches = (aws("amplify", "list-branches", "--app-id", app_id) or {}).get("branches") or []

    # App-level vars that name a specific environment are the inheritance trap:
    # any branch that does not override them silently adopts that environment.
    for k, v in sorted(app_vars.items()):
        owner = classify(v)
        if owner in (None, "shared"):
            continue
        msg = f"{app_name}: APP-LEVEL {k} → {owner} resource (inherited by every branch that does not override it)"
        (own_setup if own else (fails if STRICT else warns)).append(msg)

    for br in branches:
        name = br["branchName"]
        if (app_name, name) in IGNORED_BRANCHES:
            continue
        env = branch_env(name)
        bvars = br.get("environmentVariables") or {}
        for k, v in sorted(bvars.items()):
            if INVISIBLE_KEY.match(k) and classify(v) not in (None, "shared"):
                (own_setup if own else fails).append(
                    f"{app_name}/{name} [{env}]: {k} is not NEXT_PUBLIC_*/VITE_* — the bundle "
                    f"cannot read it, so this branch silently uses the app-level value ({v})")
            owner = classify(v)
            if owner is None or owner == "shared":
                continue
            checked += 1
            if owner == "ambiguous":
                warns.append(f"{app_name}/{name} [{env}]: {k} names more than one environment")
            elif owner != env:
                (own_setup if own else fails).append(f"{app_name}/{name} [{env}]: {k} → {owner.upper()} resource  ({v})")
        # Fail-closed: an env-specific key defined at app level but NOT overridden
        # here resolves to whatever app-level says — the marketplace-prod defect.
        for k, v in sorted(app_vars.items()):
            if k in bvars or INVISIBLE_KEY.match(k):
                continue  # an unreadable key cannot reach the bundle either way
            owner = classify(v)
            if owner in (None, "shared"):
                continue
            msg = f"{app_name}/{name} [{env}]: INHERITS {k} from app-level → {owner.upper()} ({v})"
            # Inheritance on a branch that SERVES USERS is the marketplace-prod
            # defect itself — always a hard failure. On a dev preview it is merely
            # untidy, so it warns unless --strict asks for full fail-closed.
            hard = env in ("prod", "staging") or STRICT
            (own_setup if own else (fails if hard else warns)).append(msg)
        report.append({"app": app_name, "branch": name, "env": env})

if AS_JSON:
    print(json.dumps({"hardFailures": fails, "ownSetupFindings": own_setup, "warnings": warns,
                      "branchesChecked": len(report), "varsChecked": checked}, indent=2))
else:
    mode = " (strict)" if STRICT else ""
    print(f"── env-config-check: {len(report)} branches, {checked} env-scoped vars{mode}")
    if fails:
        print(f"\n✗ {len(fails)} HARD FAILURE(S):")
        for f in fails:
            print("   ✗", f)
    else:
        print("\n✓ no hard failures — every branch points at its own environment")
    if own_setup:
        print(f"\n○ {len(own_setup)} finding(s) in apps with their OWN setup (reported, not gating):")
        for o in own_setup[:12]:
            print("   ○", o)
        if len(own_setup) > 12:
            print(f"   … {len(own_setup)-12} more")
    if warns:
        print(f"\n⚠ {len(warns)} warning(s):")
        for w in warns[:40]:
            print("   ⚠", w)
        if len(warns) > 40:
            print(f"   … {len(warns)-40} more")

sys.exit(1 if fails else 0)
'

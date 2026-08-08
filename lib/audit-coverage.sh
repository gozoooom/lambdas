#!/usr/bin/env bash
#
# audit-coverage.sh [--json]
#
# AUDIT-TRAIL coverage gate. Third member of the family alongside
# parity-check.sh (lambda alias drift) and env-config-check.sh (frontend env
# wiring). Those two exist because an ABSENCE is invisible to change-scoped
# review; this one applies the same logic to the audit trail:
#
#   • STREAM/MAPPING GAP  — an in-scope table with no stream, or a stream with no
#                           mapping to ZoooomAuditTrail. HARD FAIL: writes to that
#                           table are simply not recorded, and nothing else in the
#                           system would ever tell you.
#   • IMMUTABILITY        — audit tables must have PITR + deletion protection, and
#                           basic-user-role must be explicitly DENIED write/delete
#                           on them. HARD FAIL: an audit trail the application can
#                           edit is not evidence.
#   • OPEN INTERNAL API   — methods on the internal staff API with
#                           authorizationType NONE. HARD FAIL: with no authorizer
#                           there is no verified claim, so any "who" recorded for
#                           those endpoints is caller-supplied and worthless — and
#                           the endpoints themselves are publicly reachable.
#   • ATTRIBUTION RATE    — share of recent audit rows with actorId "unknown".
#                           WARN with the number, because the fix is per-lambda
#                           actor stamping and the ratio is how you track it.
#   • HELPER DRIFT        — a function-local copy of audit-actor.mjs that differs
#                           from lib/audit-actor.mjs. WARN: two definitions of
#                           "who did this" is one too many.
#
# Exit 0 only with zero hard failures.
set -euo pipefail
REGION="${AWS_REGION:-us-west-2}"
export AWS_REGION="$REGION"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JSON=""; [ "${1:-}" = "--json" ] && JSON=1
export JSON ROOT

python3 - <<'PY'
import boto3, json, os, hashlib, datetime, collections, sys

REGION=os.environ.get("AWS_REGION","us-west-2")
ROOT=os.environ["ROOT"]
JSON=bool(os.environ.get("JSON"))
D=boto3.client("dynamodb",region_name=REGION)
L=boto3.client("lambda",region_name=REGION)
I=boto3.client("iam")
AG=boto3.client("apigateway",region_name=REGION)

# Keep this list identical to the one the audit design was signed off against.
IN_SCOPE=["ZoooomUser","ZoooomMechanicUser","ZoooomInternalUser","ZoooomMechanicUserShop",
"KycSession","ZoooomMasterMechanic","ZoooomMechanic","ZoooomMechanicConsumer","ZoooomVehicle",
"ZoooomVehicleListing","ZoooomVehicleTransfers","ZoooomVehicleReports","ZoooomDeals","ZoooomOffers",
"ZoooomPlaidAccess","ZoooomSentGiftCardRewards","ZoooomFraudReview","ZoooomModerationReview",
"ZoooomOfacScreenings","ZoooomServiceRecord"]
ENVS=("dev","staging","prod")
INTERNAL_APIS=["ZoooomInternalUserAPI","ZoooomInternalUserAPIStaging","ZoooomInternalUserAPIProd"]

fails=[]; warns=[]

# ── streams + mappings ───────────────────────────────────────────────────────
mapped=set()
for pg in L.get_paginator("list_event_source_mappings").paginate(FunctionName="ZoooomAuditTrail"):
    for m in pg["EventSourceMappings"]:
        if m["State"] in ("Enabled","Creating"): mapped.add(m["EventSourceArn"])
        else: warns.append(("mapping-state", m["EventSourceArn"].split("/")[1], m["State"]))
for base in IN_SCOPE:
    for env in ENVS:
        t=f"{base}_{env}"
        try: d=D.describe_table(TableName=t)["Table"]
        except D.exceptions.ResourceNotFoundException:
            warns.append(("table-missing",t,"not present in this env")); continue
        ss=d.get("StreamSpecification") or {}
        if not ss.get("StreamEnabled"):
            fails.append(("stream-off",t,"no DynamoDB stream — writes are unrecorded")); continue
        if ss.get("StreamViewType")!="NEW_AND_OLD_IMAGES":
            warns.append(("stream-viewtype",t,f"{ss.get('StreamViewType')} — before-images unavailable"))
        if d.get("LatestStreamArn") not in mapped:
            fails.append(("no-mapping",t,"stream exists but is not wired to ZoooomAuditTrail"))

# ── immutability of the audit tables ────────────────────────────────────────
for env in ENVS:
    t=f"ZoooomAudit_{env}"
    try: d=D.describe_table(TableName=t)["Table"]
    except D.exceptions.ResourceNotFoundException:
        fails.append(("audit-table-missing",t,"audit table does not exist")); continue
    if not d.get("DeletionProtectionEnabled"):
        fails.append(("deletion-protection",t,"disabled"))
    st=D.describe_continuous_backups(TableName=t)["ContinuousBackupsDescription"]["PointInTimeRecoveryDescription"]["PointInTimeRecoveryStatus"]
    if st!="ENABLED": fails.append(("pitr",t,st))
    arn=f"arn:aws:dynamodb:{REGION}:754623618539:table/{t}"
    r=I.simulate_principal_policy(
        PolicySourceArn=f"arn:aws:iam::754623618539:role/basic-user-role",
        ActionNames=["dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:DeleteItem","dynamodb:BatchWriteItem"],
        ResourceArns=[arn])
    for e in r["EvaluationResults"]:
        if e["EvalDecision"]!="explicitDeny":
            fails.append(("mutable-audit",t,f"basic-user-role {e['EvalActionName']} = {e['EvalDecision']} (must be explicitDeny)"))

# ── internal API authentication ─────────────────────────────────────────────
apis={a["name"]:a["id"] for pg in AG.get_paginator("get_rest_apis").paginate() for a in pg["items"]}
for name in INTERNAL_APIS:
    aid=apis.get(name)
    if not aid: warns.append(("api-missing",name,"not found")); continue
    res=[]
    for pg in AG.get_paginator("get_resources").paginate(restApiId=aid,limit=500): res+=pg["items"]
    open_n=0; total=0
    for r in res:
        for m in (r.get("resourceMethods") or {}):
            if m=="OPTIONS": continue
            total+=1
            d=AG.get_method(restApiId=aid,resourceId=r["id"],httpMethod=m)
            if d.get("authorizationType","NONE")=="NONE" and not d.get("apiKeyRequired"): open_n+=1
    if open_n:
        fails.append(("open-internal-api",name,f"{open_n}/{total} methods have no authorizer — no verifiable actor, and publicly reachable"))

# ── attribution rate (last 7 days) ──────────────────────────────────────────
today=datetime.date.today()
for env in ENVS:
    t=f"ZoooomAudit_{env}"
    tot=unk=0
    for i in range(7):
        day=str(today-datetime.timedelta(days=i))
        try:
            r=D.query(TableName=t,IndexName="byDay",
                      KeyConditionExpression="#d = :d",
                      ExpressionAttributeNames={"#d":"day"},
                      ExpressionAttributeValues={":d":{"S":day}},
                      ProjectionExpression="actorId")
        except Exception: continue
        for it in r.get("Items",[]):
            tot+=1
            if it.get("actorId",{}).get("S")=="unknown": unk+=1
    if tot:
        pct=100*unk/tot
        warns.append(("attribution",env,f"{unk}/{tot} rows ({pct:.0f}%) have actorId=unknown over 7d"))

# ── canonical helper drift ──────────────────────────────────────────────────
canon=os.path.join(ROOT,"lib","audit-actor.mjs")
if os.path.exists(canon):
    h=hashlib.sha256(open(canon,"rb").read()).hexdigest()
    fdir=os.path.join(ROOT,"functions")
    for fn in sorted(os.listdir(fdir)) if os.path.isdir(fdir) else []:
        p=os.path.join(fdir,fn,"audit-actor.mjs")
        if os.path.exists(p) and hashlib.sha256(open(p,"rb").read()).hexdigest()!=h:
            warns.append(("helper-drift",fn,"local audit-actor.mjs differs from lib/audit-actor.mjs"))

if JSON:
    print(json.dumps({"fails":fails,"warns":warns},indent=1)); sys.exit(1 if fails else 0)

print(f"── audit-coverage: {len(IN_SCOPE)} in-scope tables x {len(ENVS)} envs")
if fails:
    print(f"\n✗ {len(fails)} HARD FAILURE(S):")
    for k,w,m in fails: print(f"   ✗ [{k}] {w}: {m}")
else:
    print("\n✓ no hard failures")
if warns:
    print(f"\n⚠ {len(warns)} warning(s):")
    for k,w,m in warns: print(f"   ⚠ [{k}] {w}: {m}")
sys.exit(1 if fails else 0)
PY

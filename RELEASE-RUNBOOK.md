# Zoooom Release Runbook & Environment Reference

**Purpose:** prevent environment cross-wiring (a "dev" surface silently reading/writing
**prod** data, or a `$LATEST` deploy hitting prod). This happened because frontend
API-endpoint env vars were **unset on some branches**, so the build fell back to a
**hard-coded default in code that pointed at PROD**. This runbook is the single source
of truth for env → gateway → alias → tables, plus the checklists that keep it correct.

> **The one rule that would have prevented every bug we found:**
> Every deployed branch must **explicitly set** its API-endpoint env vars, and every
> app-level default must be **DEV-safe**. Never rely on a code fallback for an endpoint.

---

## 1. Canonical environment topology

Region `us-west-2`, account `754623618539`. Lambda tables are suffixed `_dev` / `_staging` / `_prod`.

### Core (deals / offers / consumer / report / stripe) — one Lambda per fn, alias-per-env

| Env | API Gateway (stage) | Lambda alias | Tables | Auth API |
|---|---|---|---|---|
| **dev** | `4mtzppkye5` `/Dev` (ZoooomAPI-Dev) | `:Dev` = **`$LATEST`** | `_dev` | `api.zoooom.me` |
| **staging** | `xlav3g21ze` `/staging` (ZoooomAPI-Staging) | `:Staging` = published vN | `_staging` | `staging-api.zoooom.me` |
| **prod** | `pabikbpzo5` `/Prod` (ZoooomAPI, mature) | `:Prod` = published vM | `_prod` | `prod-api.zoooom.me` |

⚠️ **`pabikbpzo5` is the PROD gateway. Its integrations resolve to `:Prod` on ALL stages**
(it has `/Dev` and `/Staging` stages too, but they still invoke `:Prod` → **prod tables**).
**Never point a dev or staging branch at `pabikbpzo5/anything`.** This was the root cause of
the dev-marketplace split-brain (offers written to `_prod`).

### Marketplace app API (`NEXT_PUBLIC_API_URL`)
| Env | Gateway (stage) |
|---|---|
| dev | `2s95b8ogjd` `/dev` (Marketplace-Dev) |
| staging | `is6570g20d` `/staging` (Marketplace-Staging) |
| prod | `8n88bt8wnb` `/Prod` (Marketplace) |

### KYC API
| Env | Gateway (stage) |
|---|---|
| dev | `sdgbzsatq2` `/dev` |
| staging | `dazvqwf1zg` `/staging` |
| prod | `h4icuahqp6` `/Prod` |

### Report API (`*_REPORT_API_URL`)
dev = `4mtzppkye5/Dev`; staging = `xlav3g21ze/staging`; prod = `pabikbpzo5/Prod` (ZoooomVehicleReport `:Prod`).

### Mechanic app (own gateways)
| Env | Main API (`h7g4lqgvof`) | Session API (`6kskijhxxj`) | Cognito user pool | Identity pool |
|---|---|---|---|---|
| dev | `/dev` | `/dev` | `us-west-2_txbLud6fS` (client `6g5tk0ac7jn2b6pm2dknp134ol`) | `us-west-2:293267d9-…` (ZOOOOM-MECHANIC-USER-POOL-DEV) |
| staging | `/staging` | `/staging` | `us-west-2_ApaugdMWV` (client `4gmi16sekctsa4jjln52o9nehj`) | `us-west-2:876954fd-…` |
| prod | `/prod` | `/prod` | `us-west-2_Zouus0I8a` | (prod identity pool) |

### Amplify apps
| App | id | Deploy branch | Notes |
|---|---|---|---|
| Apex (zoooom-main, Vite) | `d2nxqv3eekujl` | `Prod` | + dev, staging, dev-sheng-1 (Amplify), dev-jason, dev-idverify. `dev`=dev.zoooom.me |
| Marketplace (Next.js) | `d11lhr3ng54bgo` | `prod` / `seo-marketplace` | + dev, staging |
| Mechanic | `d3dfqtkbs78aev` | `Prod` / `seo-mechanics` | + dev, staging-master-mechanic |
| Blog / Newsroom / Lenders | `d4xj5cr5k7vhr` / `d10hgiccxuiykb` / `d3mbbw1jkfzm0s` | prod / main / prod | static — **no API env vars** |

> **SEO branches** (`seo-marketplace`, `seo-mechanics`) intentionally point at the **prod**
> backend — that is correct, not a leak.

---

## 2. Frontend env-var discipline (Amplify)

**How Amplify env resolution works:** app-level env vars merge into every branch; a
branch-level value overrides per key. A branch showing "no vars" **inherits the app-level
defaults** — so the app-level default MUST be dev-safe, and prod/staging branches MUST
override every endpoint var.

### Rules
1. **Every deployed branch explicitly sets every API-endpoint var** for its env. Do not
   depend on app-level inheritance for endpoints (it's how prod values leak into new/dev branches).
2. **App-level defaults = DEV values only.** (Never put a `/Prod` or `pabikbpzo5` value app-level.)
3. **Vite** (`VITE_*`) and **Next** (`NEXT_PUBLIC_*`) inline env at **build time** → any env
   change requires a **branch rebuild** to take effect (`aws amplify start-job --job-type RELEASE`).
4. No trailing/leading whitespace, no doubled hostnames. (We found `" ZoooomContact_prod"` and a
   fused double-URL in the wild.)

### Verify a branch (paste-ready)
```bash
export AWS_REGION=us-west-2
APP=d11lhr3ng54bgo BR=dev            # example: marketplace dev
aws amplify get-branch --app-id $APP --branch-name $BR \
  --query 'branch.environmentVariables' --output json |
  python3 -c 'import sys,json;[print(k,"=",v) for k,v in json.load(sys.stdin).items() if any(t in k.upper() for t in ["API","URL","GATEWAY","BASE","ENDPOINT","POOL"])]'
# Then eyeball: does every value use THIS env's gateway/stage from §1? Any pabikbpzo5 on a non-prod branch = LEAK.
```

---

## 3. Lambda deploy & promote flow

Source of truth for hand-deployed functions is **this repo** (`zoooom-lambdas/`). Always
pull-live before editing (`lib/pull.sh <fn>`), edit, deploy (`lib/deploy.sh <fn>`), commit.

### The alias invariant (never violate)
- `$LATEST` = **dev code, always.** `Dev`/`dev` alias → `$LATEST`.
- `Staging`/`Prod` aliases → **published numbered versions**, never `$LATEST`.
- **No `Prod`/`Staging` alias may ever point at `$LATEST`** (that makes a `$LATEST` deploy hit prod).
- `lib/deploy.sh` enforces this and refuses to deploy otherwise.

### Deploy to dev
```bash
lib/pull.sh <Fn>          # get current $LATEST(dev) code — anti-drift
# edit functions/<Fn>/...
lib/deploy.sh <Fn>        # syntax-check + ship to $LATEST (dev); refuses if a prod/staging alias rides $LATEST
git commit -am "<Fn>: <change>"
```
Then **e2e on dev** (real invoke / real logged-in flow).

### Promote dev → staging → prod (deliberate, manual)
```bash
VER=$(aws lambda publish-version --function-name <Fn> --query Version --output text)
# set the version's env to the target env's tables/keys BEFORE moving the alias if needed:
#   aws lambda update-function-configuration --function-name <Fn> --qualifier $VER --environment ...
aws lambda update-alias --function-name <Fn> --name Staging --function-version "$VER"   # test staging
aws lambda update-alias --function-name <Fn> --name Prod    --function-version "$VER"   # then prod
```
**After promoting, `$LATEST` stays dev — do nothing to it.** (If you ever edited $LATEST for a
prod-only reason, re-sync it back to dev immediately: pull-live is dev, so just redeploy dev code.)
Env vars are **baked per published version** — a promoted version keeps the env it had when
published, so set the right tables/keys on that version.

---

## 4. Creating a NEW Lambda (checklist)

1. **Name + code** in this repo under `functions/<Fn>/`; add to `manifest.json`.
2. **Env vars on `$LATEST` = DEV** (tables `_dev`, dev keys). Include a `SERVICE_REMINDER_FN`-style
   downstream-fn var only if it should invoke another fn, and default it OFF unless set.
3. **Create the function** (role with least privilege; reuse `basic-user-role` only for dev).
4. **Wire the DEV gateway** route → **unqualified `$LATEST`** (or a `:Dev` alias if you make one):
   `4mtzppkye5` for core/consumer, `2s95b8ogjd` marketplace, `sdgbzsatq2` KYC.
   Add the lambda invoke permission for that gateway route. **Redeploy the dev stage.**
5. e2e on dev.
6. **Promote:** `publish-version` → create/point `Staging`/`Prod` aliases at that version →
   wire the **staging** gateway (`xlav3g21ze` / `is6570g20d` / `dazvqwf1zg`) route → `:Staging`,
   and the **prod** gateway (`pabikbpzo5` / `8n88bt8wnb` / `h4icuahqp6`) route → `:Prod`.
   Redeploy those stages.
7. **Never** wire a dev gateway to `:Prod`/`:Staging`, or a prod gateway to `:Dev`/`$LATEST`.

Functions with **no aliases** (single shared version, e.g. AI/parse utilities) are invoked
**unqualified on all gateways** — that's fine and intentional; document it in `manifest.json`.

### 4a. Intentionally SHARED (single-env) functions — do NOT split per env

Some functions are **deliberately one function + one table + one endpoint for all environments**,
because the data is environment-independent and shared caching benefits every env. Examples:
- **License-plate → VIN decode** (`ZoooomParseLicensePlate` / plate lookup)
- **Advanced VIN decode** (`ZoooomVINDecodeVDB` / VIN spec cache) — one decode per VIN, cached once
- Read-only reference/AI utilities (`ZoooomDocAI`, `ZoooomReasoningHandler`, `VehicleRecall`,
  `ZoooomVerifyDocument`, `ZoooomGetCatalog*`, `ZoooomListingAI`)

Rules for shared functions:
- **One table, one deployment, no per-env alias.** All env gateways route to the **same unqualified**
  function. All three Amplify branches (dev/staging/prod) may point the corresponding endpoint var at
  the **same** gateway/URL — that is CORRECT, not a leak.
- Mark them `"shared": true` in `manifest.json` so the audit and this runbook don't flag them for
  per-env splitting. When auditing "does each env's endpoint exist," a shared endpoint legitimately
  resolves to one gateway across all envs.
- Decision test: **is the data env-specific?** VIN/plate decodes, recall data, OEM catalogs → NO →
  share. Deals/offers/users/KYC/service-records/reports → YES → split per env (`_dev/_staging/_prod`).

---

## 5. Pre-flight verification checklist (run before calling a change "done")

```bash
export AWS_REGION=us-west-2

# A) No prod/staging alias rides $LATEST (dangerous):
aws lambda list-aliases --function-name <Fn> \
  --query "Aliases[?FunctionVersion=='\$LATEST' && (contains(Name,'rod')||contains(Name,'taging'))].Name" --output text
# (empty = safe)

# B) A gateway route points at the RIGHT alias:
RID=$(aws apigateway get-resources --rest-api-id <gw> --limit 500 --query "items[?path=='<path>'].id" --output text)
aws apigateway get-integration --rest-api-id <gw> --resource-id $RID --http-method <M> --query 'uri' --output text
# dev gw → :Dev/unqualified ; staging gw → :Staging ; prod gw → :Prod

# C) A frontend branch's endpoints match its env (see §2 verify block). Any pabikbpzo5 on non-prod = LEAK.

# D) After ANY frontend env change: rebuild the branch, then confirm live behavior.
```

**Golden test for a "dev" write path:** perform the dev action, then confirm the row landed in
the **`_dev`** table (and NOT in `_prod`). This is exactly the check that would have caught the
offer split-brain immediately.

---

## 6. Known-good / gotchas (from the July 18 2026 audit)

- `pabikbpzo5` = prod (routes → `:Prod` on every stage). Any non-prod pointer here = leak. **Fixed:**
  marketplace app-level `NEXT_PUBLIC_CONSUMER_BASE_URL` (was `pabikbpzo5/Dev`) → `4mtzppkye5/Dev`;
  marketplace `staging` (was `pabikbpzo5/Staging`) → `xlav3g21ze/staging`.
- **Fixed:** dev gateway `4mtzppkye5` `/settings/sms` POST/DELETE were wired to `:Prod` → repointed to
  unqualified (`$LATEST` = dev) + redeployed `Dev`/`dev` stages.
- **Fixed:** apex Prod `VITE_AWS_ADD_VEHICLE_IMAGE` (corrupted host), `VITE_AWS_CONTACT_TABLE`
  (leading space); apex app-level dead `VITE_AWS_INVOKE_URL` (`pabikbpzo5/Prod`) neutralized.
- **Fixed:** mechanic `dev` branch had NO API vars (→ prod fallback) — populated with dev gateway/stage
  + `MechanicUserPool_dev`; mechanic `staging-master-mechanic` corrupted search URL repaired.
- **Open (flagged, not auto-fixed):** `ZoooomTaxonomyService` & `ServiceRecommendation` have
  `Dev`→numbered version (not `$LATEST`) — confirm `$LATEST` holds intended dev code before
  repointing `Dev`→`$LATEST`. 40 functions have `Prod`/`Staging` aliases but no `Dev` alias
  (they run `$LATEST` on the dev gw = dev, fine, but inconsistent). `VITE_STRIPE_OPS_URL` uses
  lowercase `/dev` stage (works; casing differs from `/Dev`).

---

## Lambda promotion — env vars are baked into versions

**Rule: every environment gets its OWN published version. Never point two aliases
at one version.** Lambda freezes environment variables into a published version, so
one version cannot carry both `_dev` and `_prod` table names.

**The failure mode (happened 2026-07-20, `ZoooomAddVehicleDynamoDB`):** publishing a
version straight off `$LATEST` and pointing `Prod` at it ships **dev** table names to
prod — prod then silently reads/writes `_dev` tables. Nothing errors: the publish
succeeds, the alias moves, CloudWatch is clean. The only symptom is prod traffic
hitting dev data. Caught in ~40s; `Invocations` on the `Resource=<fn>:Prod` dimension
confirmed zero invokes in the window, so nothing was misrouted — but only because the
function is low-traffic.

**Always promote with the script — it cannot make this mistake:**

    ./lib/promote.sh <FunctionName> <Staging|Prod>

It takes the target alias's existing env as the source of truth (never guesses table
names), swaps `$LATEST` env → publishes → moves the alias → restores `$LATEST` to dev
via an EXIT trap, then runs a parity gate. It refuses outright if the target alias is
already cross-wired.

**Audit the whole fleet any time (exits non-zero on mismatch, so it can gate a release):**

    ./lib/audit-env.sh                 # all Zoooom* functions
    ./lib/audit-env.sh ZoooomFoo       # one function

`ZoooomServiceReminder` is the one legitimate exception — it resolves per-env config
from the invoked alias qualifier at runtime, so its baked env vars are vestigial and
intentionally look like dev. It is allow-listed in `audit-env.sh`.

**Known open mismatch:** `ZoooomInternalFraudReview:staging` has
`VITE_AWS_USER_TABLE=ZoooomUser_prod` (since 2026-05-07). It both reads flagged users
and **writes** review decisions (`isFraud`, `reviewNote`) — so staging fraud-review
actions mutate PROD user rows. Left as-is pending a decision on whether internal
reviewers are meant to work against prod data.

**Also fix eventually:** several handlers default to `_prod` table names when an env
var is unset (e.g. `ZoooomAddVehicleDynamoDB`). Per §1 every app-level default must be
**dev-safe**; a missing var should fail into dev, never prod.

# Internal-lambda drift audit — 2026-07-29

**Method.** Downloaded source for **all 390 lambdas** in `us-west-2`, normalised it (comments, string
literals and whitespace stripped), and scored every one of the 42 `ZoooomInternal*` functions against
all 344 non-internal functions using 6-gram shingle Jaccard similarity plus name-token affinity. Then,
per candidate pair, diffed helper sets, table targets, env-var keys and guard patterns. Separately
resolved every `process.env.X || "Table_env"` fallback **per alias** (`$LATEST`/Staging/Prod) and
checked what each of the three internal API Gateways actually invokes.

**Headline:** the internal fleet is **not** a set of stale verbatim copies — only 8 of 42 have a
textual ancestor still in the account. **Cross-env wiring is clean fleet-wide** (§A — an earlier
contrary finding was a false positive and is retracted). The drift that matters is (a) seven functions
that diverged from the consumer implementation and lost fixes or guards, (b) code that landed on dev
and was never promoted, and (c) a governance blind spot that let it accumulate unseen.

---

## A. Cross-env wiring — CLEAN (earlier finding retracted)

**Correction.** An earlier pass of this audit reported two live cross-env leaks
(`ZoooomInternalGetMechanic` and `ZoooomInternalGetUserInbox` on Prod/Staging falling back to `_dev`
tables). **That was a false positive** and is withdrawn. The check resolved `process.env.X || "..._dev"`
fallbacks found in **`$LATEST`'s source** against **each alias's** env vars — but alias code differs
from `$LATEST` on both functions, so those fallbacks do not exist in the versions prod and staging
actually run.

Re-run correctly — downloading **each alias's own version code** and resolving its fallbacks against
that same version's baked env — across all 42 internal lambdas and every alias:

| Finding class | Count |
|---|---|
| `ENV-CROSSWIRE` (alias env names another env's table) | **0** |
| `FALLBACK-CROSSENV` (unset var → another env's hardcoded default) | **0** |
| `HARDCODED` (literal `TableName` for another env) | **0** |

**Prod points at prod, staging at staging, dev at dev — verified per version, fleet-wide.**

Methodology lesson worth keeping: when env vars are **baked per published version**, any config audit
must pair a version's code with *that version's* env. Auditing `$LATEST` source against alias env
manufactures findings that cannot occur.

### Real residue: `DEAD-CONFIG` (23) — vars set but never read by that version

Harmless at runtime, but a review hazard: config that *looks* env-correct while the code ignores it.
- `ZoooomInternalGetMechanic` `$LATEST`/`dev`: `VITE_AWS_MECHANIC_TABLE` — dev's code migrated to
  `VITE_AWS_MASTER_MECHANIC_TABLE`; prod/staging versions still read the old var, so it is live there.
- `ZoooomInternalVINDecodeVDB` (all 3): `DDB_SPEC`/`DDB_RAW`/`DDB_COST`/`DDB_MAINT`/`DDB_VIN_LOOKUP`/
  `S3_bucket` — 6 vars × 3 aliases, unread after a refactor.
- `ZoooomInternalUserSessionActivity`, `ZoooomInternalModifyCommunicationPreferences`: one each.

### Applied 2026-07-29 — dev made explicit (no fallback reliance)
Per the runbook rule "never rely on a code fallback for a resource":
- `ZoooomInternalGetUserInbox` `$LATEST`: `VITE_AWS_MESSAGE_TABLE=ZoooomUserInboxMessage_dev`
- `ZoooomInternalGetMechanic` `$LATEST`: `VITE_AWS_MASTER_MECHANIC_TABLE=ZoooomMasterMechanic_dev`

### Unpromoted code is the actual drift on these two
| Function | dev (`$LATEST`) | staging | prod |
|---|---|---|---|
| `ZoooomInternalGetUserInbox` | 5,548 B — adds `MESSAGE_TABLE`+`QueryCommand`, CORS headers, OPTIONS, flexible `userId` extraction | 2,596 B (v3) | **919 B (v1)** — no message table at all |
| `ZoooomInternalGetMechanic` | 6,763 B — reads `ZoooomMasterMechanic_*` | 5,876 B (v1) — legacy `ZoooomMechanic_*` | 5,873 B (v2) — legacy `ZoooomMechanic_*` |

Promoting requires supplying the new per-env variable at promote time (the alias env is the source of
truth, so a brand-new key cannot come from there):

```bash
./lib/promote.sh ZoooomInternalGetUserInbox Prod    --set VITE_AWS_MESSAGE_TABLE=ZoooomUserInboxMessage_prod
./lib/promote.sh ZoooomInternalGetUserInbox Staging --set VITE_AWS_MESSAGE_TABLE=ZoooomUserInboxMessage_staging
./lib/promote.sh ZoooomInternalGetMechanic  Prod    --set VITE_AWS_MASTER_MECHANIC_TABLE=ZoooomMasterMechanic_prod
./lib/promote.sh ZoooomInternalGetMechanic  Staging --set VITE_AWS_MASTER_MECHANIC_TABLE=ZoooomMasterMechanic_staging
```

⚠️ `ZoooomInternalGetMechanic` is **not** a pure env change: promoting switches prod staff from the
legacy `ZoooomMechanic_prod` table to `ZoooomMasterMechanic_prod`. That is a product decision about
which mechanic dataset the dashboard shows — confirm before running.

## RESOLVED — internal inbox is a STAFF inbox (built 2026-07-29)

Confirmed by the owner: internal users get their own inbox, separate from the consumer inbox.
`ZoooomInternalGetUserInbox` reads the CONSUMER family (`ZoooomUserInbox_{env}` /
`ZoooomUserInboxMessage_{env}`) for a customer id in the request, and no staff inbox existed anywhere.

Built: **`ZoooomInternalUserInbox_{dev,staging,prod}`** (PK `staffId` = staff email, SK
`<createdAt>#<messageId>`, GSI `byMessage`) plus **`ZoooomInternalInbox`** —
`list` / `markRead` / `markUnread` / `broadcast` / `sweepMissedChats`, on
`GET|POST /internal-inbox` behind `ZoooomInternalStaffAuth` in all three envs, with
`ZoooomInternalInboxSweep{,-Staging,-Prod}` on `rate(15 minutes)`.

Design points worth keeping:
- **Roster from the Cognito staff pool, not `ZoooomInternalUser_{env}`.** That table holds 0 rows in
  prod while the prod staff pool has 2 real users — a table-based fan-out would have silently reached
  nobody in prod, which is the worst possible failure for an alerting inbox.
- **Missed = escalated + no `agent` reply.** `assistant` is the AI and does not count as answered; the
  whole point of an escalation is that the AI was not enough. Grace period `MISSED_AFTER_MINUTES` (15).
- **Idempotent by construction.** `messageId = missed-chat#<conversationId>#<lastUserMsgId>` plus a
  `byMessage` check, so a 15-minute schedule, a manual re-run and an EventBridge retry all converge.
- **Per-staff read state.** One row per (staff, message) — one person reading their mail does not clear
  it from everyone else's inbox (verified).
- **Support email (Gmail) deliberately not built.** `broadcast` is the seam it plugs into.

Verified in dev: sweeper found the seeded missed chat and delivered to all 5 staff; re-run delivered 0;
`GET` with a real staff token returned it; no claim → 401; `markRead` affected only the caller's copy;
unknown messageId → 404; real authenticated HTTP `GET /internal-inbox` → 200. Test data removed.

## `ZoooomInternalGetMechanic` promoted to the master table — with data caveats

Promoted via `lib/promote.sh` (staging v3, prod v4, env parity green): all envs now read
`ZoooomMasterMechanic_{env}`. Master is keyed on the Google place/address; scanned service records can
misread mechanic details and produce many near-duplicate legacy rows, so legacy mechanics are
**children** of a master and the `linkedLegacyMechanics` array is the drill-down. Prod now returns
master records with that array present.

**Three data-integrity gaps found while verifying the click-through:**

| Env | masters | with children | child entry type | `linkedRecordsCount` | legacy rows w/ `linkedToMasterId` |
|---|---|---|---|---|---|
| dev | 3 | 1 | **object** | 1 (matches) | 0 of 19 |
| staging | 2 | 0 | — | — | 0 of 14 |
| prod | 7 | **1** | **string** | **0 (array has 7)** | 0 of 47 |

1. **Shape mismatch:** prod stores children as plain legacy-id **strings**, dev as **objects**
   (`{legacyMechanicId, legacyShopName, linkedAt, …}` — what `ZoooomAddMechanic` writes today). A UI
   built against dev's object shape will render blank children in prod.
2. **Only 1 of 7 prod masters has any children** despite 47 legacy rows — the fuzzy linker has never
   been run across prod data.
3. **`linkedToMasterId` is unpopulated on legacy rows in every env**, so legacy → master navigation is
   impossible in the reverse direction.

Master → legacy click-through therefore works today only for that single linked prod master, and only
if the frontend tolerates both entry shapes.

## B. Functions that diverged from the consumer implementation

| Internal | Origin | Drift |
|---|---|---|
| `ZoooomInternalVINDecodeVDB` | `ZoooomVINDecodeVDB` | 17.0 KB vs 24.6 KB. Missing 12 helpers — `engine`, `engineType`, `driveType`, `fuelEconomy`, `extractFilterFields`, `filterFields`, `enableFilterFields`, `hasCore/hasCost/hasMaint/hasSpec/hasWarranty` — and the `ENABLE_FILTER_FIELDS` var. Staff see a thinner spec set than customers for the same VIN. |
| `ZoooomInternalEmailSubscriptionInbox` | `ZoooomEmailSubscriptionInbox` | 8.3 KB vs 11.2 KB. Missing `MESSAGE_TABLE`, `markChatInbox`, `transactItems` (chat-inbox marking + transactional write). **Zero env vars** vs 5 on the origin, including `UNSUBSCRIBE_SIGNING_SECRET_NAME` and `COGNITO_USER_POOL_ID` — so unsubscribe-link signature verification is absent. |
| `ZoooomInternalSearchForUser` | `ZoooomSearchForConsumers` | No `LastEvaluatedKey` handling — staff search **silently truncates** at the first 1 MB scan page. Origin also joins service-record and vehicle data. Uses `VITE_AWS_*` where origin uses `NEXT_PUBLIC_AWS_*`. |
| `ZoooomInternalInboxUnsubscribed` | `ZoooomTestInboxUnsubscribed` | **Byte-identical (5,502 B) to a _Test_ lambda.** A test artefact is the ancestor of a live internal endpoint. Zero env vars, hardcoded `_dev`. |
| `ZoooomInternalUpdateMechanicMaster_dev` | `ZoooomUpdateMechanicMaster_dev` (0.91) and `…_Nedal_Dev` (0.82) | **Three-way fork** of a 64 KB function. Internal-only `handleLinkDuplicateMechanic`. Zero env vars. |
| `ZoooomInternalGetCustomerVehicle` | `…_dev-nedal` | Stale personal fork (14.4 KB vs 13.0 KB); the fork has zero env vars. Both hardcode `_dev`. |
| `ZoooomInternalGetVehicleInfoFromVINNHTSA` | `ZoooomVehicleInfoFromVINNHTSA` | Internal is *larger* (2.3 KB vs 1.3 KB) with 8 extra fields (`trim`, `cylinders`, `drive_type`, `fuel_type`, `transmission_type`, `body_type`…). Divergent NHTSA field mapping between staff and consumer views. |

Also noted: `ZoooomInternalGetConsumerServiceDetail` takes an S3 `key` straight from the request and
returns that object base64 with no key scoping or validation. Its origin (`ZoooomGetServiceRecord`)
reads `requestContext.authorizer.claims.sub` but **only logs it** — neither enforces ownership, so
this is a shared weakness, not drift. It is **not routed** on any internal API (invoked directly), so
it was never internet-reachable. Bucket `aws-textractdocumentbucket-*` has all four public-access
blocks on and partitions objects by Cognito sub.

## C. Why none of this was caught — parity-check blind spot

`lib/parity-check.sh` skips any function that does not have **all three** of dev/staging/prod aliases:

```python
if not all(e in al for e in ENVS):
    continue
```

Of 42 internal lambdas, exactly **one** (`ZoooomInternalUserSessionActivity`) has all three. 29 have
`prod`+`staging` but no `Dev`; **12 have no aliases at all**. So **41 of 42 internal lambdas have never
been drift-checked by the gate** — the fleet was invisible to the very tool built to catch this.

Supporting counts: 23 of 42 hardcode an env-suffixed table name in source; 9 have zero env vars.

Recommended: treat a missing `Dev` alias as a finding rather than a skip, and compare whatever aliases
*do* exist instead of requiring all three.

## D. Confirmed healthy

- **API → alias routing is correct.** dev API `0ntan6ver9` → `$LATEST` (84/84); staging `hmrs6qv2aj` →
  `:staging`/`:Staging` (84/84); prod `8w93j9fb1c` → `:prod`/`:Prod` (84/84). **Zero** routes point at a
  non-existent alias, and zero point at another env's alias.
- Orphans (no route, safe to retire after confirmation): `ZoooomInternalUserActionAuditLog`,
  `ZoooomInternalGetCustomerVehicle_dev-nedal`, `ZoooomInternalGetRecords_dev`.

## E. Internal staff API is now authenticated (fixed this session)

All three internal APIs previously had **84/84 methods at `authorizationType NONE`** with no resource
policy, WAF or API key — `TempResetUserPassword`, `GetCustomerDetail` and `GetCustomerVehicle` were
publicly callable in prod. Now each API carries a `ZoooomInternalStaffAuth` COGNITO_USER_POOLS
authorizer bound to **its own** pool:

| API | Pool | Result |
|---|---|---|
| `0ntan6ver9` dev | `us-west-2_TXqy6UVpM` | 84 methods secured |
| `hmrs6qv2aj` staging | `us-west-2_dlLUWVauL` | 84 methods secured |
| `8w93j9fb1c` prod | `us-west-2_ZmxFpOQGW` | 84 methods secured |

`OPTIONS` deliberately left at `NONE` (65–67 methods): CORS preflight carries no `Authorization`
header, so authenticating it would break every browser call before it starts.

Verified: unauthenticated `GET`/`POST` → **401** in all three envs; a real `ZoooomInternalUser_dev`
staff ID token → request reaches the lambda; a malformed token → **401**; `OPTIONS` → **200**.
Prod took ~10 s to propagate before enforcing.

**Rollback**, if a dashboard screen turns out not to attach the token:

```bash
# per method: aws apigateway update-method --rest-api-id <id> --resource-id <rid> \
#   --http-method <M> --patch-operations op=replace,path=/authorizationType,value=NONE
# then: aws apigateway create-deployment --rest-api-id <id> --stage-name <stage>
```

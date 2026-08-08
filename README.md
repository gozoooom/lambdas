# zoooom-lambdas

Source of truth for Zoooom's **hand-deployed** Lambda functions. These functions
are **not** deployed by CI or from an app repo — they're updated individually with
the AWS CLI. Historically the only real copy of a function's code was the deployed
zip, and reference copies (e.g. `zoooom-main/docs/lambda/*.mjs`) silently drifted.
This repo ends that: **git here == what's deployed to dev.**

## The one rule that kills drift

**Always `pull` before you edit.** Never trust a stale local copy.

```bash
export AWS_REGION=us-west-2
lib/pull.sh ZoooomOfferNotification   # download current $LATEST(dev) into functions/
# ...edit functions/ZoooomOfferNotification/index.mjs...
lib/deploy.sh ZoooomOfferNotification # syntax-check + ship to $LATEST(dev)
git commit -am "notifier: <what changed>"
```

`lib/pull.sh` / `lib/deploy.sh` with no args operate on every function in
`manifest.json`.

## Environments & the safety invariant

Every function uses **alias-per-env**: `$LATEST` = **dev**; `staging`/`prod` ride
**published versions** via their own aliases (see `manifest.json`). So updating
`$LATEST` only affects **dev**.

`deploy.sh` enforces this: it **refuses** to deploy if any `prod`/`staging` alias
currently points at `$LATEST` (which would mean editing `$LATEST` hits prod).
Verify the topology yourself anytime:

```bash
aws lambda list-aliases --function-name <name> --query 'Aliases[].{Name:Name,Version:FunctionVersion}'
```

## Promoting dev → staging → prod (deliberate, not automatic)

> ⚠️ **DO NOT hand-roll `publish-version` + `update-alias`.** The old procedure
> here told you to point **both** Staging and Prod at the **same** published
> version. A published version bakes in whatever env vars are on `$LATEST` at
> publish time — i.e. **dev's** env — so that "one version for both" ships dev
> tables/keys to prod. It looks 100% successful (publish ok, alias moves, no
> error); the only symptom is prod silently reading `_dev` data. This is exactly
> the 2026-07-20 `ZoooomAddVehicleDynamoDB` incident. **Never share one version
> across two envs — each env needs its own version with its own baked env.**

**The only supported promote is `lib/promote.sh`** (it does the env-swap dance,
publishes a per-env version, restores `$LATEST`=dev, and parity-checks). Full
gated procedure — never skip a step:

```bash
export AWS_REGION=us-west-2

# 0. GATE: no drift may exist that you're not deliberately fixing
lib/parity-check.sh <name>

# 1. Promote to STAGING (its own version, its own baked env)
lib/promote.sh <name> Staging            # add --set KEY=VALUE for a genuinely NEW env key
lib/audit-env.sh <name>                  # confirm no cross-wiring

# 2. E2E ON STAGING against staging.zoooom.me's REAL backend (NOT dev). Assert
#    the DB record / side-effect, not just the UI. Commit the spec. Only if GREEN:

# 3. Promote to PROD
lib/promote.sh <name> Prod
lib/audit-env.sh <name>
lib/parity-check.sh <name>               # must exit 0

# 4. E2E on prod (skip live payment/KYC per policy — verify config parity instead)
```

`--set` is for a NEW env key no alias has yet (e.g. `AWS_SLACK_WEBHOOK` when
promoting the Slack-notify code). It still passes the cross-wire guard. Never use
`--set` to paper over drift.

### ⚠️ Two traps promote.sh does NOT protect you from
1. **Per-env values HARD-CODED in source** (not read from env): `promote.sh` ships
   `$LATEST`(dev) **code** to the target, so a function that hard-codes
   `"ZoooomVehicleListing_dev"` in source will point prod at the **dev** table when
   promoted. `ZoooomGetShowcaseVehicleDetail` and `ZoooomMarketplaceFilters` do
   this today (allow-listed in parity-check). FIX-FORWARD: move the value to an
   env var, then promote normally. Until then, do NOT promote these two blindly.
2. **Timeout / runtime / memory are baked per version too.** `publish-version`
   snapshots `$LATEST`'s Timeout/Runtime/Memory. So promote.sh will carry **dev's**
   timeout to the target — good when dev is the newer/correct value (the "prod
   still 3s" fixes), but a REGRESSION when dev is the outlier (e.g.
   `ZoooomTaxonomyService` dev=3s vs staging/prod=30s — fix DEV first, then promote).
   Always eyeball `parity-check` config lines and know which env is correct before
   promoting.

## Functions in this repo

| Function | Runtime | Dev = | Notes |
|---|---|---|---|
| `ZoooomOfferNotification` | nodejs24 | `$LATEST` | Inbox + SES notifier; `{eventType}` dispatch incl. `SERVICE_REMINDER`. Per-env by alias qualifier. |
| `ZoooomServiceReminder` | nodejs22 | `$LATEST` | Daily maintenance sweep (`ZoooomServiceReminderDaily` cron) + ad-hoc `{vin,userId}`. `test.mjs` = local unit test (excluded from deploy zip). |
| `ZoooomAddServiceRecord` | nodejs24 | `Dev`→`$LATEST` | Scanned add; invokes `SERVICE_REMINDER_FN {vin,userId}` on success. |
| `ZoooomAddServiceRecordManual` | nodejs24 | `Dev`→`$LATEST` | Manual add; same instant-refresh invoke. |
| `ZoooomMessagingV3` | nodejs22 | `dev`→`$LATEST` | Inbox/chat + notification prefs (`set_prefs`/`get_prefs` on `ZoooomUser`). |

## Adding another function

1. Add an entry to `manifest.json`.
2. `lib/pull.sh <name>` to seed `functions/<name>/` from the live code.
3. Commit.

## Not included

Runtime deps: these functions use only the AWS SDK v3, which is **provided by the
Node.js Lambda runtime** — so there's no `node_modules` to vendor. If a function
ever needs a third-party dep, add a `package.json` in its dir and adjust `deploy.sh`
to `npm ci` + include `node_modules` in the zip.

---

# Drift post-mortem & the parity gate (2026-07-23)

A full cross-env audit found **22 hard drift failures + 28 warnings** that had
accumulated across dev/staging/prod despite ~20 e2e runs in the prior week. Root
cause: **dev fixes were verified on dev and never promoted**, and there was no
check that compares environments to each other.

## Why ~20 e2e runs never caught it

Browser e2e, as run, structurally cannot see this class of bug:

1. **It ran against dev, not staging/prod.** A green dev run says nothing about
   whether staging/prod got the same code + config. Every gap lived only in
   staging/prod.
2. **It asserts the UI happy-path, not side-effects.** `ZoooomFlagFraud` still
   *creates* the fraud review in staging/prod — only the **Slack alert** was
   missing (the notify code + `AWS_SLACK_WEBHOOK` were dev-only). No UI flow sees
   that.
3. **Parity is cross-env; a test drives one env.** Nothing in the suite compares
   dev vs staging vs prod, so a route/env-var/timeout that exists in one env but
   not another is undetectable by a functional test.
4. **DB checks were partial and dev-only.** A row written to `ZoooomDeals_dev`
   proves nothing about `_prod`. And a 3 s timeout passes a fast test but times
   out under real prod latency.

## The controls that close the gap (run every promote)

| Control | Catches | Command |
|---|---|---|
| `lib/parity-check.sh` | cross-env code/config/env-key/version/cross-wire drift, gateway route gaps, unqualified crons | `parity-check.sh [fn...]` — exit 0 required |
| `lib/audit-env.sh` | a single alias wired to another env's `_dev/_staging/_prod` resource | run after every promote |
| **e2e on the promoted env** | functional regressions in THAT env's real backend | staging first, prod after; assert the DB row / side-effect, not just UI |
| `lib/promote.sh` | shipping dev env vars to prod (the split-brain) | the ONLY supported promote |

Wire `parity-check.sh` into a daily cron → Slack so drift is caught within a day,
not a quarter. Keep the allow-lists in `parity-check.sh` short and reviewed —
every entry is a deliberate, owner-confirmed exception (today: the mechanic
subsystem, and the two hard-coded-table functions pending a fix-forward to env
vars).

## The drift catalog this audit found (tracked to closure)

- **Code not promoted (dev→staging/prod):** `ZoooomFlagFraud` (Slack fraud
  alerts), `ZoooomUpdateVehicleType` (specs/features partial update),
  `ZoooomEmailSubscriptionInbox` (null-safety), `ZoooomRewardHandler` (env-driven
  campaign id).
- **Timeouts stuck at 3 s in staging/prod:** FlagFraud, MarketplaceMessaging,
  Messaging, UpdateWishlist, UpdateWishlistWithCatalog, EmailSubscriptionInbox,
  GetWishlist. (`ZoooomTaxonomyService` is the reverse — dev is the 3 s outlier.)
- **Env-var / wrong-env pointers:** `AWS_SLACK_WEBHOOK` (FlagFraud) missing
  staging/prod; `VELOCITY_TABLE` missing dev (anti-bot); `CAMPAIGN_ID_ENV` missing
  staging/prod; `MasterMechanicPerformance` dev → prod Cognito pool; Amplify
  staging inheriting dev Report/SMS URLs; marketplace Google Cognito domain = prod
  pool on dev/staging.
- **Cron only on `$LATEST` (no prod/staging run):** `ZoooomDailyStats`,
  `ZoooomSaleAutoClose` sweeper. (Antibot is dev-tier by design; OfacSync &
  ServiceReminder DO have Prod/Staging siblings — parity-check sibling-awareness
  TODO.)
- **Gateway:** prod-only `POST /vehicle/generate_listing_ai` → `$LATEST`; staging
  `update_user_login` → wrong lambda; staging stage 8 days stale.
- **Confirmed NOT drift:** promo banner (intended all envs), mechanic cluster
  (active dev), `GetShowcaseVehicleDetail`/`MarketplaceFilters` (per-env hard-coded
  table — correct, allow-listed), `NextService`/`GetMarketValue`/`AddVehicleImage`/
  `MarketplaceListings` (identical source, packaging-only sha).

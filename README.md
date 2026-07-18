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

`deploy.sh` never touches staging/prod. To promote after dev is verified:

```bash
VER=$(aws lambda publish-version --function-name <name> --query Version --output text)
aws lambda update-alias --function-name <name> --name Staging --function-version "$VER"   # test staging
aws lambda update-alias --function-name <name> --name Prod    --function-version "$VER"   # then prod
```

Note env vars are **baked per published version** — set the right env on `$LATEST`
before `publish-version`, or update the version's config, so prod points at prod
tables. (`SERVICE_REMINDER_FN`, table suffixes, etc.)

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

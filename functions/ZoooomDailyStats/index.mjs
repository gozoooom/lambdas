/**
 * ZoooomDailyStats — daily high-level product metrics digest → Slack #daily-stats.
 *
 * PROD ONLY by design. Every source below is explicitly prod-scoped:
 *   - DynamoDB `_prod` tables
 *   - auth logs filtered to the ZoooomAuthAllDomain :Prod alias version
 *   - CloudWatch metrics filtered by the `Resource=<fn>:Prod` alias dimension
 * There is no env switch — adding one would risk a dev run reporting prod numbers
 * (or worse) into the exec-facing channel. See RELEASE-RUNBOOK §1.
 *
 * Each metric reports: yesterday | 7-day rolling | WoW delta (last 7d vs prior 7d).
 * Days are bucketed on **America/Los_Angeles** boundaries, not UTC, so "yesterday"
 * matches what a human means. CloudWatch is pulled hourly and re-bucketed into PT
 * for the same reason (its native daily periods are UTC-aligned).
 *
 * Env:
 *   DAILY_STATS_CHANNEL  Slack channel ID. If empty, does NOT post (logs instead).
 *   SLACK_SECRET_ID      default zoooom/slack/support-bot (reuses support bot token)
 *   AUTH_FUNCTION_NAME   default ZoooomAuthAllDomain
 *   AUTH_LOG_GROUP       default /aws/lambda/ZoooomAuthAllDomain
 *
 * Invoke with {dryRun:true} to render the digest to logs without posting.
 */
import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, GetAliasCommand } from "@aws-sdk/client-lambda";

const REGION = process.env.AWS_REGION || "us-west-2";
const CHANNEL = process.env.DAILY_STATS_CHANNEL || "";
const SLACK_SECRET_ID = process.env.SLACK_SECRET_ID || "zoooom/slack/support-bot";
const AUTH_FN = process.env.AUTH_FUNCTION_NAME || "ZoooomAuthAllDomain";
const AUTH_LOG_GROUP = process.env.AUTH_LOG_GROUP || "/aws/lambda/ZoooomAuthAllDomain";
const TZ = "America/Los_Angeles";

const ddb = new DynamoDBClient({ region: REGION });
const logs = new CloudWatchLogsClient({ region: REGION });
const cw = new CloudWatchClient({ region: REGION });
const sm = new SecretsManagerClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ptFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Epoch ms or ISO string -> 'YYYY-MM-DD' in PT. Returns "" for junk. */
function ptDay(v) {
  if (v === null || v === undefined || v === "") return "";
  const d = typeof v === "number" ? new Date(v) : new Date(v);
  if (isNaN(d.getTime())) return "";
  return ptFmt.format(d);
}

/**
 * The last `n` PT day strings, index 0 = yesterday, walking backwards.
 * Anchored at UTC noon of today-PT so DST shifts can never skip or repeat a day
 * (naively subtracting 24h from "now" does exactly that twice a year).
 */
function recentPtDays(n) {
  const [y, m, d] = ptFmt.format(new Date()).split("-").map(Number);
  const anchor = Date.UTC(y, m - 1, d, 12, 0, 0);
  const out = [];
  for (let i = 1; i <= n; i++) out.push(ptFmt.format(new Date(anchor - i * 86400000)));
  return out;
}

/** Full paginated scan, projecting only the fields we need. */
async function scanAll(TableName, ProjectionExpression, ExpressionAttributeNames) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName,
        ProjectionExpression,
        ...(ExpressionAttributeNames ? { ExpressionAttributeNames } : {}),
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      })
    );
    items.push(...(r.Items || []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const S = (it, f) => it?.[f]?.S;

/** Count items into a { 'YYYY-MM-DD': n } map, keyed on a string-ISO timestamp field. */
function countByDay(items, field, predicate) {
  const m = {};
  for (const it of items) {
    if (predicate && !predicate(it)) continue;
    const day = ptDay(S(it, field));
    if (day) m[day] = (m[day] || 0) + 1;
  }
  return m;
}

/**
 * Distinct users who logged in, per PT day, from the shared auth log group.
 * Prod-scoped by matching each log stream's `[version]` bracket against the
 * version the :Prod alias currently points at — resolved live so it survives
 * future promotes (version numbers change; this doesn't).
 */
async function loginsByDay(startMs, endMs) {
  let prodVersion = null;
  try {
    const a = await lambda.send(new GetAliasCommand({ FunctionName: AUTH_FN, Name: "Prod" }));
    prodVersion = a.FunctionVersion || null;
  } catch (e) {
    console.warn("could not resolve Prod alias — login counts unavailable:", e?.name || e);
    return null;
  }

  const queryString = [
    "fields @timestamp, @message, @logStream",
    "| filter @message like /handleLogin - got user from token:/",
    "| limit 10000",
  ].join("\n");

  const { queryId } = await logs.send(
    new StartQueryCommand({
      logGroupName: AUTH_LOG_GROUP,
      startTime: Math.floor(startMs / 1000),
      endTime: Math.floor(endMs / 1000),
      queryString,
    })
  );

  let rows = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const res = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (res.status === "Complete") {
      rows = res.results || [];
      break;
    }
    if (["Failed", "Cancelled", "Timeout"].includes(res.status)) {
      console.warn("Insights query status:", res.status);
      return null;
    }
  }
  if (rows === null) {
    console.warn("Insights query did not complete in time");
    return null;
  }

  const field = (row, name) => (row.find((f) => f.field === name) || {}).value || "";
  const perDay = {}; // day -> Set(userId)
  for (const row of rows) {
    const stream = field(row, "@logStream");
    const ver = (stream.match(/\[([^\]]+)\]/) || [])[1] || "";
    if (ver !== prodVersion) continue; // dev/staging traffic shares this log group
    const uid = (field(row, "@message").match(/got user from token:\s*(\S+)/) || [])[1];
    if (!uid) continue;
    // Insights returns '@timestamp' as UTC 'YYYY-MM-DD HH:mm:ss.SSS'.
    const day = ptDay(field(row, "@timestamp").replace(" ", "T") + "Z");
    if (!day) continue;
    (perDay[day] ||= new Set()).add(uid);
  }
  return perDay;
}

/**
 * Lambda invocation counts per PT day for a specific alias.
 * Pulled hourly because CloudWatch's daily periods are UTC-aligned.
 */
async function invocationsByDay(fnName, alias, startMs, endMs) {
  const r = await cw.send(
    new GetMetricStatisticsCommand({
      Namespace: "AWS/Lambda",
      MetricName: "Invocations",
      Dimensions: [
        { Name: "FunctionName", Value: fnName },
        { Name: "Resource", Value: `${fnName}:${alias}` },
      ],
      StartTime: new Date(startMs),
      EndTime: new Date(endMs),
      Period: 3600,
      Statistics: ["Sum"],
    })
  );
  const m = {};
  for (const dp of r.Datapoints || []) {
    const day = ptDay(dp.Timestamp);
    if (day) m[day] = (m[day] || 0) + (dp.Sum || 0);
  }
  return m;
}

/** yesterday / 7-day rolling / prior-7-day, given a day->count map. */
function rollup(map, days) {
  const at = (d) => (map && map[d]) || 0;
  const last7 = days.slice(0, 7).reduce((s, d) => s + at(d), 0);
  const prev7 = days.slice(7, 14).reduce((s, d) => s + at(d), 0);
  return { yesterday: at(days[0]), last7, prev7, delta: last7 - prev7 };
}

function fmtDelta(r) {
  if (r === null) return "  n/a";
  if (r.delta > 0) return `▲ +${r.delta}`;
  if (r.delta < 0) return `▼ ${r.delta}`;
  return "   —";
}

function pad(s, n, right = false) {
  s = String(s);
  return right ? s.padStart(n) : s.padEnd(n);
}

function buildDigest(rows, dayLabel) {
  const out = [];
  out.push(`*📊 Zoooom Daily Stats — prod — ${dayLabel}*`);
  out.push("```");
  out.push(`${pad("", 24)}${pad("Yest", 6, true)}${pad("7d", 7, true)}${pad("WoW", 8, true)}`);
  for (const row of rows) {
    if (row.section) {
      out.push(row.section);
      continue;
    }
    const r = row.value;
    out.push(
      `  ${pad(row.label, 22)}` +
        `${pad(r === null ? "n/a" : r.yesterday, 6, true)}` +
        `${pad(r === null ? "n/a" : r.last7, 7, true)}` +
        `${pad(fmtDelta(r), 8, true)}`
    );
  }
  out.push("```");
  const notes = rows.filter((r) => r.note).map((r) => `_${r.label}: ${r.note}_`);
  if (notes.length) out.push(notes.join("\n"));
  out.push("_Yest = yesterday (PT) · 7d = rolling 7 days · WoW = 7d vs prior 7d_");
  return out.join("\n");
}

async function postSlack(text) {
  if (!CHANNEL) {
    console.warn("no DAILY_STATS_CHANNEL set — skipping post");
    return { ok: false, reason: "no_channel", preview: text };
  }
  const sec = await sm.send(new GetSecretValueCommand({ SecretId: SLACK_SECRET_ID }));
  const creds = JSON.parse(sec.SecretString || "{}");
  if (!creds.botToken) {
    console.warn("no Slack botToken — skipping");
    return { ok: false, reason: "no_token" };
  }
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${creds.botToken}`,
    },
    body: JSON.stringify({ channel: CHANNEL, text, unfurl_links: false }),
  });
  const j = await r.json();
  if (!j.ok) console.warn("Slack post failed:", j.error);
  return j;
}

export const handler = async (event = {}) => {
  const days = recentPtDays(14);
  const endMs = Date.now();
  const startMs = endMs - 15 * 86400000; // 15d covers the full 14-day PT window

  const [users, listings, offers, deals, reportUsage, inspections, logins, garageAdds] =
    await Promise.all([
      scanAll("ZoooomUser_prod", "IdUser, createdAt"),
      scanAll("ZoooomVehicleListing_prod", "createdAt"),
      scanAll("ZoooomOffers_prod", "createdAt, acceptedAt, #s", { "#s": "status" }),
      scanAll("ZoooomDeals_prod", "completedAt"),
      scanAll("ZoooomReportUsage_prod", "sk, ts"),
      scanAll("ZoooomVehicleInspections_prod", "generatedAt"),
      loginsByDay(startMs, endMs).catch((e) => {
        console.warn("logins failed:", e?.name || e);
        return null;
      }),
      invocationsByDay("ZoooomAddVehicleDynamoDB", "Prod", startMs, endMs).catch((e) => {
        console.warn("garage adds failed:", e?.name || e);
        return null;
      }),
    ]);

  const signupsByDay = countByDay(users, "createdAt");

  // "Returning" = distinct users who logged in, excluding anyone who signed up
  // that same day — otherwise a new user's first login double-counts as both.
  let returningByDay = null;
  if (logins) {
    const signupDayByUser = {};
    for (const u of users) {
      const id = S(u, "IdUser");
      const day = ptDay(S(u, "createdAt"));
      if (id && day) signupDayByUser[id] = day;
    }
    returningByDay = {};
    for (const [day, set] of Object.entries(logins)) {
      let n = 0;
      for (const uid of set) if (signupDayByUser[uid] !== day) n++;
      returningByDay[day] = n;
    }
  }

  const rows = [
    { section: "Acquisition" },
    { label: "New signups", value: rollup(signupsByDay, days) },
    {
      label: "Returning logins",
      value: returningByDay ? rollup(returningByDay, days) : null,
      note: returningByDay ? null : "auth-log query unavailable this run",
    },
    { section: "Engagement" },
    {
      label: "Vehicle reports run",
      value: rollup(
        countByDay(reportUsage, "ts", (it) => (S(it, "sk") || "").startsWith("VIN#")),
        days
      ),
    },
    {
      label: "AI inspections",
      value: rollup(countByDay(inspections, "generatedAt"), days),
      note: "1 row per VIN — re-inspections of the same VIN overwrite",
    },
    { section: "Supply" },
    {
      label: "Cars added to garage",
      value: garageAdds ? rollup(garageAdds, days) : null,
      note: "proxy: AddVehicle:Prod invocations (table has no createdAt)",
    },
    { label: "Cars listed", value: rollup(countByDay(listings, "createdAt"), days) },
    { section: "Demand" },
    { label: "Offers made", value: rollup(countByDay(offers, "createdAt"), days) },
    { label: "Offers accepted", value: rollup(countByDay(offers, "acceptedAt"), days) },
    { label: "Cars sold", value: rollup(countByDay(deals, "completedAt"), days) },
  ];

  const [y, m, d] = days[0].split("-").map(Number);
  const dayLabel = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const text = buildDigest(rows, dayLabel);
  if (event.dryRun) {
    console.log(text);
    return { ok: true, dryRun: true, text };
  }
  const res = await postSlack(text);
  return { ok: true, posted: res.ok === true, slack: res.error || res.reason || "sent" };
};

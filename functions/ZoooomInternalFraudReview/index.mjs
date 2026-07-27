import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";


const REGION = process.env.VITE_AWS_REGION || "us-west-2";
// NO DEFAULT ON PURPOSE. This previously fell back to a hardcoded table name,
// and the staging/prod builds of this file fell back to ZoooomUser_PROD — so a
// missing env var silently pointed a non-prod environment at real production
// users, and nothing in a diff would show it. Fail closed instead: an unset
// variable must break loudly at startup, never quietly write to the wrong env.
const USER_TABLE = process.env.VITE_AWS_USER_TABLE;
if (!USER_TABLE) {
  throw new Error(
    "VITE_AWS_USER_TABLE is not set — refusing to start rather than guess a user table."
  );
}
/**
 * Slack via Secrets Manager + chat.postMessage, matching ZoooomDailyStats and
 * ZoooomListingReview.
 *
 * This used to hold a raw incoming-webhook URL in a plaintext env var — a live
 * credential readable by anyone with lambda:GetFunctionConfiguration, and
 * unrotatable without editing three aliases. It sat next to a
 * SLACK_SIGNING_SECRET that no line of this file ever referenced.
 *
 * The webhook was also IDENTICAL across dev, staging and prod, so a test fraud
 * decision in dev posted into the same channel the team treats as real. The
 * channel is now per-environment: unset means log instead of post, so only the
 * environment you deliberately configure ever reaches Slack.
 */
const SLACK_SECRET_ID = process.env.SLACK_SECRET_ID || "zoooom/slack/support-bot";
const FRAUD_REVIEW_CHANNEL = process.env.FRAUD_REVIEW_CHANNEL || "";
const sm = new SecretsManagerClient({ region: REGION });

// Cached across warm invocations — the token is stable and this avoids a
// Secrets Manager call on every fraud decision.
let cachedToken = null;
async function slackToken() {
  if (cachedToken) return cachedToken;
  const sec = await sm.send(new GetSecretValueCommand({ SecretId: SLACK_SECRET_ID }));
  cachedToken = JSON.parse(sec.SecretString || "{}").botToken || null;
  return cachedToken;
}

const ddb = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddb);


const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};


async function notifySlack(userId, email, isFraud, reviewNote) {
  if (!FRAUD_REVIEW_CHANNEL) {
    console.log("[fraudReview] no FRAUD_REVIEW_CHANNEL for this environment — not posting");
    return;
  }
  try {
    const token = await slackToken();
    if (!token) {
      console.warn("[fraudReview] no botToken in secret — not posting");
      return;
    }
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: FRAUD_REVIEW_CHANNEL,
        unfurl_links: false,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: [
                `*Fraud Review Decision*`,
                `*User ID:* ${userId}`,
                `*Email:* ${email}`,
                `*Decision:* ${isFraud ? "🚨 Confirmed Fraud" : "✅ Cleared — Not Fraud"}`,
                reviewNote ? `*Note:* ${reviewNote}` : null,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          },
        ],
      }),
    });
    const j = await res.json();
    if (!j.ok) console.warn("[fraudReview] Slack post failed:", j.error);
  } catch (err) {
    console.error("Slack notification failed:", err);
  }
}

async function getFlaggedUsers() {
  const command = new ScanCommand({
    TableName: USER_TABLE,
    FilterExpression: "isFlagged = :true",
    ExpressionAttributeValues: {
      ":true": true,
    },
    ProjectionExpression:
      "IdUser, email, firstName, lastName, createdAt, isFlagged, isFraud, #rsn, reviewNote, reviewedAt, rewardPoints, vehicles",
    ExpressionAttributeNames: {
      "#rsn": "reason", 
    },
  });

  const result = await docClient.send(command);
  return result.Items ?? [];
}

async function saveDecision({ userId, email, isFraud, reviewNote }) {
  if (!userId || !email) throw new Error("userId and email are required");

  const command = new UpdateCommand({
    TableName: USER_TABLE,
    Key: {
      IdUser: userId,
      email: email,
    },
    UpdateExpression:
      "SET isFraud = :isFraud, reviewNote = :note, reviewedAt = :ts",
    ExpressionAttributeValues: {
      ":isFraud": isFraud === true,
      ":note": reviewNote ?? "",
      ":ts": new Date().toISOString(),
    },
  });

  await docClient.send(command);
  await notifySlack(userId, email, isFraud, reviewNote);
}

export const handler = async (event) => {
  console.log("event:", JSON.stringify(event, null, 2));

  const method = event.httpMethod ?? event.requestContext?.http?.method ?? "GET";

  // OPTIONS pre-flight
  if (method === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  try {
    if (method === "GET") {
      const users = await getFlaggedUsers();
      return {
        statusCode: 200,
        headers: { ...CORS, "Content-Type": "application/json" },
        body: JSON.stringify({ users }),
      };
    }

    if (method === "POST") {
      const body =
        typeof event.body === "string" ? JSON.parse(event.body) : event.body;
      await saveDecision(body);
      return {
        statusCode: 200,
        headers: { ...CORS, "Content-Type": "application/json" },
        body: JSON.stringify({ success: true }),
      };
    }

    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (err) {
    console.error("Handler error:", err);
    return {
      statusCode: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message || "Internal server error" }),
    };
  }
};
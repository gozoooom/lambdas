import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

/**
 * Type-ahead suggestions for the customer directory's email field.
 *
 * Fixed 2026-07-30. Two defects:
 *
 *  1. CASE-SENSITIVE PREFIX. It used DynamoDB `begins_with(email, :q)`, and
 *     begins_with — like contains — is case-sensitive. Typing "sheng" produced no
 *     suggestions while "Sheng" produced one, so the type-ahead appeared dead to
 *     anyone typing normally.
 *
 *  2. WRONG FIELD READ. All three type-aheads were copies of the first-name one
 *     and every copy still did `namesSet.add(unmarshall(i).firstName)` while
 *     projecting its own column. The last-name and email type-aheads therefore
 *     collected `undefined` and returned [null] — they had never produced a single
 *     usable suggestion.
 *
 * Matching is now case-insensitive and done in the function. The scan already
 * walked the whole table, so this costs no extra reads. Prefix matches are ranked
 * before mid-string matches, because a type-ahead should offer "Sheng" first when
 * you type "she".
 */
const REGION = process.env.VITE_AWS_REGION || "us-west-2";
const USER_TABLE = process.env.VITE_AWS_CONSUMER_USER_TABLE || "ZoooomUser_dev";
const FIELD = "email";
const MAX_SUGGESTIONS = Number(process.env.MAX_SUGGESTIONS || "20");

const client = new DynamoDBClient({ region: REGION });

export const handler = async (event) => {
  const { q = "" } = event.queryStringParameters || {};
  const needle = String(q).trim().toLowerCase();

  if (needle.length < 2) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Query must be at least 2 characters" }),
    };
  }

  const params = { TableName: USER_TABLE, ProjectionExpression: "#f",
                   ExpressionAttributeNames: { "#f": FIELD } };

  const prefix = new Set();
  const inner = new Set();
  let lastEvaluatedKey;

  do {
    const res = await client.send(new ScanCommand({ ...params, ExclusiveStartKey: lastEvaluatedKey }));
    for (const raw of res.Items || []) {
      const value = unmarshall(raw)[FIELD];
      if (!value) continue;
      const lc = String(value).toLowerCase();
      if (lc.startsWith(needle)) prefix.add(value);
      else if (lc.includes(needle)) inner.add(value);
    }
    lastEvaluatedKey = res.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  const suggestions = [
    ...Array.from(prefix).sort(),
    ...Array.from(inner).sort(),
  ].slice(0, MAX_SUGGESTIONS);

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
    body: JSON.stringify({ suggestions }),
  };
};

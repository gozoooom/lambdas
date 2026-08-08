import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

/**
 * ZoooomGetConsumerUsers — the internal customer directory (GET /GetConsumers).
 *
 * Fixed 2026-07-30. Three defects, all of which made the directory quietly
 * under-report customers:
 *
 * 1. CASE-SENSITIVE FILTER. It used DynamoDB `contains(firstName, :firstName)`,
 *    and `contains` is case-sensitive. Searching "sheng" returned **0** while
 *    "Sheng" returned 4 — staff typing a name in lower case were told the
 *    customer does not exist. Matching now happens in the function, lower-cased
 *    on both sides. This costs nothing: the handler already scanned the ENTIRE
 *    table (the do/while below runs to LastEvaluatedKey) before paginating in
 *    memory, so the filter was never saving a read.
 *
 * 2. PAGE 2 RETURNED THE WHOLE TAIL. `page`/`pageSize` arrive from the query
 *    string as STRINGS, so `startIndex + pageSize` was string concatenation:
 *    with pageSize "30", page 2 computed endIndex `30 + "30"` = "3030" and
 *    sliced 30..3030 instead of 30..60. Both are coerced to numbers now.
 *
 * 3. `phone` WAS IGNORED. The dashboard's Advanced Search sends a phone filter;
 *    the handler never read it, so the field silently did nothing.
 *
 * `totalCount` is the number of MATCHES across the whole table — not the size of
 * the returned page — so the caller can work out how many pages exist.
 */

const REGION = process.env.VITE_AWS_REGION || "us-west-2";
const USER_TABLE = process.env.VITE_AWS_CONSUMER_USER_TABLE || "ZoooomUser_dev";
const MAX_PAGE_SIZE = 200;

const client = new DynamoDBClient({ region: REGION });

const lc = (v) => String(v ?? "").toLowerCase();
/** Case-insensitive substring match; a blank filter matches everything. */
const matches = (value, needle) => !needle || lc(value).includes(lc(needle));

export const handler = async (event) => {
  const qs = event.queryStringParameters || {};

  // Numbers, not strings — see defect 2 above.
  const page = Math.max(1, Number(qs.page) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(qs.pageSize) || 30));
  const { firstName, lastName, email, phone } = qs;

  const allItems = [];
  let lastEvaluatedKey;
  let scannedCount = 0;

  do {
    const res = await client.send(
      new ScanCommand({
        TableName: USER_TABLE,
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );
    scannedCount += res.ScannedCount || 0;
    for (const raw of res.Items || []) {
      const item = unmarshall(raw);
      if (
        matches(item.firstName, firstName) &&
        matches(item.lastName, lastName) &&
        matches(item.email, email) &&
        matches(item.phone ?? item.phoneNumber, phone)
      ) {
        allItems.push(item);
      }
    }
    lastEvaluatedKey = res.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  // Stable order, so page 2 cannot repeat or skip a row that page 1 already showed.
  allItems.sort((a, b) =>
    `${lc(a.lastName)}${lc(a.firstName)}${lc(a.email)}`.localeCompare(
      `${lc(b.lastName)}${lc(b.firstName)}${lc(b.email)}`
    )
  );

  const totalCount = allItems.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const startIndex = (page - 1) * pageSize;
  const pageItems = allItems.slice(startIndex, startIndex + pageSize);

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
    body: JSON.stringify({
      totalCount,
      totalPages,
      page,
      pageSize,
      scannedCount,
      records: pageItems,
    }),
  };
};

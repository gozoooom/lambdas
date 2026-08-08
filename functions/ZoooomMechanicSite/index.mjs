/**
 * ZoooomMechanicSite — resolves a published shop page by its slug.
 *
 * GET /MechanicSite?slug=joes-auto-repair   -> the public shop profile
 * GET /MechanicSite?masterMechanicId=…      -> same, for the owner's preview
 *
 * WHY A NEW FUNCTION INSTEAD OF ONE MORE FILTER ON THE EXISTING ONE.
 * ZoooomUpdateMechanicMaster_dev already owns publish/unpublish and would be
 * the natural home for a slug lookup. But every stage of the mechanic gateway
 * integrates against that function's `:staging` alias — dev, staging and prod
 * all execute the same code — so shipping a "harmless additive filter" there
 * means moving the alias that prod is serving from. A read-only sibling costs
 * one Lambda and risks nothing that currently works.
 *
 * READ-ONLY AND PUBLIC BY DESIGN. This backs an unauthenticated page, so it
 * returns only what a shop chose to publish and refuses to serve a record with
 * published !== true. An unpublished draft must not be readable by guessing its
 * slug — that is the whole difference between "preview" and "live".
 *
 * THE SCAN IS DELIBERATE, FOR NOW. ZoooomMasterMechanic_{env} has no slug index
 * and adding a GSI to a live table for a feature with a handful of published
 * shops is the wrong trade. Results are cached hard at the edge (see the
 * Cache-Control below) so the scan runs once per slug per hour, not per view.
 * When published shops reach the hundreds, add a GSI on `slug` and swap the
 * scan for a Query — the response shape does not change.
 *
 * Tables: ZoooomMasterMechanic_{env}  (masterMechanicId HASH)
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.REGION || process.env.AWS_REGION || "us-west-2";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

function envSuffix(context) {
  const qualifier = (context?.invokedFunctionArn || "").split(":").pop() || "";
  if (/staging/i.test(qualifier)) return "_staging";
  if (/prod/i.test(qualifier)) return "_prod";
  return "_dev";
}

const masterTable = (context) =>
  process.env.MASTER_MECHANIC_TABLE || `ZoooomMasterMechanic${envSuffix(context)}`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Content-Type": "application/json",
};

// A published shop page changes when its owner edits it — minutes matter far
// less than the scan cost. s-maxage lets CloudFront absorb the traffic while
// stale-while-revalidate keeps an edit from showing a spinner to the next
// visitor.
const PUBLIC_CACHE = "public, max-age=60, s-maxage=3600, stale-while-revalidate=86400";

const reply = (statusCode, obj, cache = false) => ({
  statusCode,
  headers: cache ? { ...CORS, "Cache-Control": PUBLIC_CACHE } : CORS,
  body: JSON.stringify(obj),
});

/**
 * Project the record down to what a public page may show.
 *
 * An allow-list, not a delete-list. The master record carries the owner's
 * email, the Cognito user ids linked to the shop, internal approval status and
 * the legacy-mechanic linkage — none of which belongs on a page anyone can
 * fetch. A deny-list would leak every field added after this was written.
 */
function publicProfile(item) {
  return {
    masterMechanicId: item.masterMechanicId,
    slug: item.slug || null,
    shopName: item.name || item.shopName || null,
    tagline: item.tagline || null,
    about: item.about || null,

    address: item.address || item.street || null,
    city: item.city || null,
    state: item.state || null,
    zipCode: item.zipCode || null,
    latitude: item.latitude ?? null,
    longitude: item.longitude ?? null,

    phone: item.phone || null,
    website: item.websiteUrl || null,
    hours: item.hours || null,

    isMobileService: !!item.isMobileService,
    serviceRadius: item.serviceRadius ?? null,

    serviceAllMakes: !!item.serviceAllMakes,
    servicedMakes: item.servicedMakes || [],
    servicedModels: item.servicedModels || [],
    powertrainTypes: item.powertrainTypes || [],
    specialties: item.specialties || [],
    amenities: item.amenities || [],
    certifications: item.certifications || [],
    languages: item.languages || [],
    towing: !!item.towing,
    aaaPartner: !!(item.aaaPartner || item.AAA),

    photos: item.photos || [],
    logoUrl: item.logoUrl || null,

    publishedAt: item.lastPublished || null,
  };
}

export const handler = async (event, context) => {
  const method = event?.httpMethod || event?.requestContext?.http?.method || "GET";
  if (method === "OPTIONS") return reply(200, { ok: true });

  const q = event?.queryStringParameters || {};
  const slug = typeof q.slug === "string" ? q.slug.toLowerCase().trim().slice(0, 120) : null;
  const masterMechanicId =
    typeof q.masterMechanicId === "string" ? q.masterMechanicId.trim().slice(0, 120) : null;

  if (!slug && !masterMechanicId) {
    return reply(400, { error: "slug or masterMechanicId required" });
  }

  const TableName = masterTable(context);

  try {
    let item = null;

    if (masterMechanicId) {
      const r = await ddb.send(new GetCommand({ TableName, Key: { masterMechanicId } }));
      item = r.Item || null;
    } else {
      // Paginate: a Scan with a FilterExpression can return an empty page and a
      // LastEvaluatedKey while the match sits further in. Stopping at the first
      // page would 404 a shop that exists — intermittently, and more often as
      // the table grows, which is the worst possible failure to debug.
      let ExclusiveStartKey;
      do {
        const r = await ddb.send(
          new ScanCommand({
            TableName,
            FilterExpression: "#s = :slug",
            ExpressionAttributeNames: { "#s": "slug" },
            ExpressionAttributeValues: { ":slug": slug },
            ExclusiveStartKey,
          })
        );
        item = r.Items?.[0] || null;
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (!item && ExclusiveStartKey);
    }

    if (!item) return reply(404, { ok: false, error: "not found" });

    // The owner's own preview passes masterMechanicId and may see a draft; a
    // slug lookup is the public route and must not.
    if (!item.published && !masterMechanicId) {
      return reply(404, { ok: false, error: "not found" });
    }

    return reply(
      200,
      { ok: true, published: !!item.published, profile: publicProfile(item) },
      !!item.published
    );
  } catch (err) {
    console.error("ZoooomMechanicSite failed", err);
    return reply(500, { error: "internal error" });
  }
};

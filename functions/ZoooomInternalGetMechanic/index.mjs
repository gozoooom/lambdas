import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const REGION = process.env.VITE_AWS_REGION || "us-west-2";
const MECHANIC_TABLE =
  process.env.VITE_AWS_MASTER_MECHANIC_TABLE || "ZoooomMasterMechanic_dev";

const client = new DynamoDBClient({ region: REGION });

export const handler = async (event) => {
  console.log("📥 Received event:", JSON.stringify(event));

  try {
    const {
      page = "1",
      pageSize = "30",
      idMechanic,
      mechanicName,
      mechanicStreet,
      mechanicCertified,
      mechanicPhone,
      mechanicCity,
      mechanicState,
      mechanicZip,
    } = event.queryStringParameters || {};

    const pageNum = parseInt(page, 10) || 1;
    const pageSizeNum = parseInt(pageSize, 10) || 30;

    // 🧭 Base scan setup
    //
    // FILTERING HAPPENS AFTER NORMALISATION (below), not in a DynamoDB
    // FilterExpression. Two reasons, both of which silently returned zero rows:
    //
    //  1. FIELD NAMES. This function now reads ZoooomMasterMechanic_{env}, whose
    //     attributes are `name`/`shopName`/`address`/`city`/`state`/`zip`/`phone`.
    //     The filters were written for the LEGACY table's `mechanic*` attributes,
    //     which do not exist on a master record — so `contains(#mechanicName, :v)`
    //     matched nothing at all. The response mapping below already normalises
    //     master → legacy names, so filtering there matches what staff actually see.
    //
    //  2. CASE. DynamoDB `contains` is case-sensitive: "hybrid" found nothing while
    //     "Hybrid" worked. Same defect as the customer directory.
    //
    // The scan already walked the whole table before paginating in memory, so
    // moving the filter costs no extra reads.
    const scanParams = { TableName: MECHANIC_TABLE };

    console.log("🔍 Scanning DynamoDB Table:", MECHANIC_TABLE);

    // 🧾 Perform scan
    const allItems = [];
    let lastKey;

    do {
      const res = await client.send(
        new ScanCommand({ ...scanParams, ExclusiveStartKey: lastKey })
      );

      if (res.Items) {
        console.log(`📦 Retrieved ${res.Items.length} items from scan batch`);

        const items = res.Items.map((item, index) => {
          const unmarshalled = unmarshall(item);

          // 🚨 Log each item that has linkedLegacyMechanics
          if (item.linkedLegacyMechanics) {
            console.log(
              `🔗 Item[${index}] ${unmarshalled.masterMechanicId || unmarshalled.idMechanic} has linkedLegacyMechanics:`,
              JSON.stringify(item.linkedLegacyMechanics, null, 2)
            );
          }

          // ✅ Handle linkedLegacyMechanics properly
          let linkedLegacyMechanics = [];
          if (item?.linkedLegacyMechanics?.L) {
            linkedLegacyMechanics = item.linkedLegacyMechanics.L.map((entry) => {
              const m = entry.M || {};
              return {
                legacyMechanicId: m.legacyMechanicId?.S || null,
                legacyShopName: m.legacyShopName?.S || null,
                linkedAt: m.linkedAt?.S || null,
                distance: m.distance?.N ? Number(m.distance.N) : 0,
                similarity: m.similarity?.N ? Number(m.similarity.N) : 0,
                hasCustomerData: m.hasCustomerData?.BOOL || false,
                coordinates: {
                  latitude: m.coordinates?.M?.latitude?.N
                    ? Number(m.coordinates.M.latitude.N)
                    : 0,
                  longitude: m.coordinates?.M?.longitude?.N
                    ? Number(m.coordinates.M.longitude.N)
                    : 0,
                },
              };
            });
          }

          // 🧾 Log parsed linked mechanic IDs (for sanity)
          if (linkedLegacyMechanics.length > 0) {
            console.log(
              `✅ Parsed linkedLegacyMechanics for ${unmarshalled.masterMechanicId || unmarshalled.idMechanic}:`,
              linkedLegacyMechanics.map((l) => l.legacyMechanicId)
            );
          }

          // ✅ Normalize structure for frontend
          return {
            ...unmarshalled,
            idMechanic:
              unmarshalled.masterMechanicId || unmarshalled.idMechanic || "",
            mechanicName: unmarshalled.mechanicName || unmarshalled.name || "",
            mechanicStreet:
              unmarshalled.mechanicStreet ||
              unmarshalled.address ||
              unmarshalled.street ||
              "",
            mechanicCity: unmarshalled.mechanicCity || unmarshalled.city || "",
            mechanicState: unmarshalled.mechanicState || unmarshalled.state || "",
            mechanicZip:
              unmarshalled.mechanicZip ||
              unmarshalled.zip ||
              unmarshalled.zipCode ||
              "",
            mechanicPhone:
              unmarshalled.mechanicPhone || unmarshalled.phone || "",
            mechanicCertified:
              unmarshalled.mechanicCertified || unmarshalled.status || "",
            linkedLegacyMechanics,
          };
        });

        allItems.push(...items);
      }

      lastKey = res.LastEvaluatedKey;
    } while (lastKey);

    // ✅ Summary Log
    console.log(`🧮 Total mechanics found: ${allItems.length}`);
    const withLinks = allItems.filter((i) => i.linkedLegacyMechanics?.length > 0);
    console.log(`🔗 Mechanics with linkedLegacyMechanics: ${withLinks.length}`);

    // 🔎 Case-insensitive filtering over the NORMALISED records.
    const lc = (v) => String(v ?? "").toLowerCase();
    const keep = (value, needle) => !needle || !String(needle).trim() ||
      lc(value).includes(lc(String(needle).trim()));

    const filteredItems = allItems.filter((m) =>
      keep(m.idMechanic, idMechanic) &&
      // Match either normalised or master-native name, so "costco" finds a shop
      // stored only as `name`/`shopName`.
      (!mechanicName || !String(mechanicName).trim() ||
        keep(m.mechanicName, mechanicName) || keep(m.name, mechanicName) ||
        keep(m.shopName, mechanicName)) &&
      keep(m.mechanicCertified, mechanicCertified) &&
      keep(m.mechanicPhone, mechanicPhone) &&
      keep(m.mechanicStreet, mechanicStreet) &&
      keep(m.mechanicCity, mechanicCity) &&
      keep(m.mechanicState, mechanicState) &&
      keep(m.mechanicZip, mechanicZip)
    );

    // 🧮 Pagination
    const totalCount = filteredItems.length;
    const startIndex = (pageNum - 1) * pageSizeNum;
    const endIndex = startIndex + pageSizeNum;
    const pageItems = filteredItems.slice(startIndex, endIndex);

    // ✅ Return
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      },
      body: JSON.stringify({
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / pageSizeNum)),
        page: pageNum,
        pageSize: pageSizeNum,
        records: pageItems,
      }),
    };
  } catch (error) {
    console.error("❌ Lambda execution error:", error);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Internal Server Error",
        message: error.message,
        records: [],
        totalCount: 0,
        page: 1,
        pageSize: 30,
      }),
    };
  }
};

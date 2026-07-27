import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand,
  BatchGetCommand,
  QueryCommand,
  PutCommand
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

let REGION = process.env.VITE_AWS_REGION || "us-west-2";
const ddb = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddb);
const lambdaClient = new LambdaClient({ region: REGION });
let VIN_LOOKUP_TABLE = process.env.VIN_LOOKUP_TABLE;
let MMYT_COST_TABLE = "ZoooomMMYTCost";
let VEHICLE_TABLE = process.env.VEHICLE_TABLE; // Add your vehicle table name
const VIN_DECODE_FN = process.env.VIN_DECODE_FN || "ZoooomVINDecodeVDB";

export const handler = async (event) => {
  const { vin, userId, state, mileage } = event;

  console.log("Vin:", vin, "UserId:", userId, "State:", state, "Mileage:", mileage);

  if (!vin || !userId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "vin and userId are required" })
    };
  }

  let MMYT = "";

  const getParams = {
    TableName: VIN_LOOKUP_TABLE,
    Key: {
      PK: `VIN:${vin}`
    }
  };

  try {
    const getMMYT = await docClient.send(new GetCommand(getParams));
    console.log(getMMYT.Item);
    MMYT = getMMYT.Item?.mmyt || "";
  } catch (err) {
    console.log("Error getting MMYT:", err);
  }

  // A VIN reaches us from the vehicle report as well as the garage, so it may
  // never have been decoded — ZoooomVinLookup then has no row. Price it anyway:
  // the market-value API is keyed by VIN and MMYT only picks the cache row, so
  // fall back to a VIN-scoped row instead of failing the request. Kick off the
  // decode in the background (it takes ~13s, which would blow the 29s API
  // Gateway budget if we waited) so later calls key off the shared MMYT row.
  const costPK = MMYT ? `MMYT:${MMYT}` : `VIN:${vin}`;
  if (!MMYT) {
    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: VIN_DECODE_FN,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ vin, allowExternal: true }))
      }));
      console.log("No MMYT for VIN — queued background decode:", vin);
    } catch (err) {
      console.log("Could not queue VIN decode:", err);
    }
  }

  console.log("MMYT:", MMYT, "costPK:", costPK);

  // Create cache key based on MMYT, state, and mileage
  const cacheKey = `${MMYT}${state ? `_${state}` : ""}${mileage ? `_${mileage}` : ""}`;

  const costParams = {
    TableName: MMYT_COST_TABLE,
    Key: {
      PK: costPK,
      SK: `VALUE${state ? `#${state}` : ""}${mileage ? `#${mileage}` : ""}`
    }
  };

  try {
    const existingCost = await docClient.send(new GetCommand(costParams));

    // If data exists and is recent (less than 24 hours old), return it
    if (existingCost.Item && existingCost.Item.data) {
      const dataAge = Date.now() - new Date(existingCost.Item.asOf).getTime();
      const oneDayInMs = 24 * 60 * 60 * 1000;
      
      if (dataAge < oneDayInMs) {
        console.log("Found existing cost data for MMYT:", MMYT);
        
        // Update vehicle table with cached data
        await updateVehicleTable(userId, vin, existingCost.Item.data.market_value, state, mileage);
        
        return {
          statusCode: 200,
          body: JSON.stringify({
            source: "cache",
            data: existingCost.Item.data
          })
        };
      }
    }

    console.log("No existing cost data found or data is stale, fetching from API...");
  } catch (err) {
    console.log("Error checking cost table:", err);
    // Continue to fetch from API
  }

  const VEHICLE_DB_BASE = "https://api.vehicledatabases.com/market-value/v2";
  const VEHICLE_DB_API_KEY = process.env.VEHICLE_DB_API_KEY;

  // Build URL with state and mileage parameters
  let url = `${VEHICLE_DB_BASE}/${encodeURIComponent(vin)}`;
  const queryParams = [];
  if (state) queryParams.push(`state=${encodeURIComponent(state)}`);
  if (mileage) queryParams.push(`mileage=${encodeURIComponent(mileage)}`);
  if (queryParams.length > 0) {
    url += `?${queryParams.join("&")}`;
  }

  console.log("URL", url);

  try {
    const resp = await fetch(url, {
      headers: {
        "x-AuthKey": VEHICLE_DB_API_KEY,
        Accept: "application/json"
      }
    });

    console.log("Response status:", resp.status);

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error("API Error:", resp.status, errorText);
      return {
        statusCode: resp.status,
        body: JSON.stringify({
          error: "Failed to fetch vehicle data",
          details: errorText
        })
      };
    }

    const data = await resp.json();
    console.log("API Response:", data);

    // Store the data in MMYT_COST_TABLE
    const timestamp = new Date().toISOString();
    const putParams = {
      TableName: MMYT_COST_TABLE,
      Item: {
        PK: costPK,
        SK: `VALUE${state ? `#${state}` : ""}${mileage ? `#${mileage}` : ""}`,
        data: data.data,
        state: state || null,
        mileage: mileage || null,
        asOf: timestamp,
        label: "PRICE"
      }
    };

    try {
      await docClient.send(new PutCommand(putParams));
      console.log("Successfully stored cost data for MMYT:", MMYT);
    } catch (putErr) {
      console.error("Error storing cost data:", putErr);
    }

    // Update vehicle table with the new market value data. Never let a garage
    // write turn a successful valuation into a 500 — the caller wants the price.
    try {
      await updateVehicleTable(userId, vin, data.data.market_value, state, mileage);
    } catch (updErr) {
      console.error("Vehicle-table update failed, returning value anyway:", updErr);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        source: "api",
        data: data.data
      })
    };
  } catch (err) {
    console.log("Error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal server error",
        details: err.message
      })
    };
  }
};

// Helper function to update vehicle table
async function updateVehicleTable(userId, vin, marketData, state, mileage) {

  const marketPayload = { ...marketData, lastUpdatedAt: new Date().toISOString()}
  const updateParams = {
    TableName: VEHICLE_TABLE,
    Key: {
      vin: vin,
      userId: userId
    },
    UpdateExpression: "SET market = :market, updatedAt = :timestamp",
    ExpressionAttributeValues: {
      ":market": marketPayload,
      ":timestamp": new Date().toISOString()
    },
    // Report viewers price VINs they don't own. Without this guard the update
    // upserts a bare {vin,userId,market} row into the garage table — a phantom
    // vehicle. Only stamp the value onto a car the user actually has.
    ConditionExpression: "attribute_exists(vin)"
  };

  // Add state to update if provided
  if (state) {
    updateParams.UpdateExpression += ", #state = :state";
    updateParams.ExpressionAttributeNames = { "#state": "state" };
    updateParams.ExpressionAttributeValues[":state"] = state;
  }

  // Add mileage to update if provided
  if (mileage) {
    updateParams.UpdateExpression += ", mileage = :mileage";
    updateParams.ExpressionAttributeValues[":mileage"] = mileage;
  }

  try {
    await docClient.send(new UpdateCommand(updateParams));
    console.log("Successfully updated vehicle table for VIN:", vin);
  } catch (updateErr) {
    if (updateErr?.name === "ConditionalCheckFailedException") {
      console.log("VIN not in this user's garage — skipping vehicle-table write:", vin);
      return;
    }
    console.error("Error updating vehicle table:", updateErr);
    throw updateErr;
  }
}
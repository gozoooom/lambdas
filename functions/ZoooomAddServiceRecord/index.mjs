import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  DeleteCommand
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { randomUUID } from "crypto";

// --- Environment Variables ---
const REGION = process.env.VITE_AWS_REGION || "us-west-2";
const SERVICE_RECORD_TABLE = process.env.VITE_AWS_SERVICE_RECORD_TABLE || "ZoooomServiceRecord_prod";
const VEHICLE_TABLE = process.env.VITE_AWS_VEHICLE_TABLE || "ZoooomVehicle_dev";
const MECHANIC_CONSUMER_TABLE = process.env.VITE_AWS_MECHANIC_CONSUMER_TABLE || "ZoooomMechanicConsumer_dev";
// Fire an immediate maintenance-schedule recompute after a record is added,
// instead of waiting for the daily ZoooomServiceReminder sweep. Env-gated so
// only environments that set it (dev $LATEST) attempt the cross-invoke.
const SERVICE_REMINDER_FN = process.env.SERVICE_REMINDER_FN || "";

// --- DynamoDB Client ---
const ddb = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddb);
const lambdaClient = new LambdaClient({ region: REGION });

// Recompute this vehicle's next service + fire any due reminder. Fire-and-forget
// (InvocationType: "Event") and fully non-blocking — a failure must never fail
// the record add.
async function refreshServiceSchedule(vin, userId) {
  if (!SERVICE_REMINDER_FN || !vin || !userId) return;
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: SERVICE_REMINDER_FN,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ vin, userId })),
    }));
    console.log(`🔔 Triggered ${SERVICE_REMINDER_FN} recompute for ${vin}`);
  } catch (e) {
    console.warn("[refreshServiceSchedule] non-blocking:", e?.message || e);
  }
}

// --- Helper to safely parse numbers ---
const toNumber = (val) => {
  const num = parseInt(val, 10);
  return isNaN(num) ? 0 : num;
};

// Fuzzy summary match (char-trigram Jaccard) for near-duplicate service wording.
function _trig(x){const n=String(x||"").toLowerCase().replace(/[^a-z0-9]/g,"");if(n.length<3)return new Set([n]);const t=new Set();for(let i=0;i<n.length-2;i++)t.add(n.slice(i,i+3));return t;}
function normDate(d){if(!d)return null;const s=String(d).trim();let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);if(m)return `${m[1]}-${String(m[2]).padStart(2,"0")}-${String(m[3]).padStart(2,"0")}`;m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(m)return `${m[3]}-${String(m[1]).padStart(2,"0")}-${String(m[2]).padStart(2,"0")}`;return s.slice(0,10);}
function fuzzySim(a,b){const A=_trig(a),B=_trig(b);if(!A.size||!B.size)return String(a).toLowerCase()===String(b).toLowerCase()?1:0;let i=0;for(const x of A)if(B.has(x))i++;return i/Math.min(A.size,B.size);}


const safeDate = (dateInput) => {
  if (!dateInput) return new Date("1999-01-01");

  const date = new Date(dateInput);
  return isNaN(date.getTime()) ? new Date("1999-01-01") : date;
};

const levenshtein = (a, b) => {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
};

const normalizeSvc = (str = "") =>
  str.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

const similarityScore = (a, b) => {
  const na = normalizeSvc(a);
  const nb = normalizeSvc(b);
  if (na === nb) return 1.0;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshtein(na, nb) / maxLen;
};

const tokenOverlap = (a, b) => {
  const setA = new Set(normalizeSvc(a).split(" ").filter(Boolean));
  const setB = new Set(normalizeSvc(b).split(" ").filter(Boolean));
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 1 : intersection / union;
};

const isSimilarService = (a, b, threshold = 0.75) =>
  Math.max(similarityScore(a, b), tokenOverlap(a, b)) >= threshold;

const handleCheckService = async (serviceData) => {

  const { date, mileage, serviceType, vehicleId, key, serviceDetails } = serviceData
  const parsedMileage = toNumber(mileage)
  const existingRecords = await docClient.send(new QueryCommand({
    TableName: SERVICE_RECORD_TABLE,
    IndexName: "vehicleId-index",
    KeyConditionExpression: "vehicleId = :v",
    ExpressionAttributeValues: {
      ":v": vehicleId
    }
  }))

  const duplicate = existingRecords.Items?.find(r => {
    // Idempotency: same submission retried (e.g. double-click, network retry).
    if (r.key && r.key === key) return true

    // Boss's rule: only a duplicate if the date AND the summary are an EXACT
    // match. No fuzzy similarity, no mileage proximity — those false-positive
    // against unrelated entries, especially now that archived/re-listed
    // vehicles carry their full serviceRecords history forward instead of
    // getting wiped on delete.
    // Duplicate rule: SAME service date AND SAME mileage (from the scanned/parsed
    // doc) AND a fuzzy-similar summary. Wording varies per scan ("Head Gasket
    // Replacement" / "Headgasket Job") so exact-summary match let dupes through.
    const sameDate = normDate(r.date) === normDate(date)
    const rm = toNumber(r.mileage)
    const sameMileage = rm != null && parsedMileage != null && rm === parsedMileage
    if (!(sameDate && sameMileage)) return false
    return fuzzySim(`${r.serviceType || ""} ${r.serviceDetails || ""}`,
                    `${serviceType || ""} ${serviceDetails || ""}`) >= 0.5
  })

  console.log("Duplicate:", duplicate)

  if (duplicate) {
    console.log("⚠️ Duplicate service record detected");

    return {
      message: "duplicate",
      duplicateServiceId: duplicate.serviceId,
      duplicateKey: duplicate.key
    }
  }

  return "proceed"
}

export const handler = async (event) => {
  console.log("🚀 Lambda invoked with event:", JSON.stringify(event, null, 2));

  const serviceId = randomUUID();

  // ✅ Extract fields
  const {
    vehicleId,
    userId = "",
    mechanicId = "",
    date,
    mileage,
    serviceType = "Unknown",
    key,
    serviceDetails,
    trim,
    make,
    model,
    year,
    license,
    shop_state,
    recall = [],
    force,
    duplicateServiceId
  } = event;

  try {
    // 1️⃣ Insert Service Record
    const serviceData = {
      serviceId,
      vehicleId,
      date,
      serviceType,
      mileage: toNumber(mileage),
      key,
      serviceDetails,
      mechanicId
    };

    if (force && duplicateServiceId) {
      await docClient.send(new DeleteCommand({
        TableName: SERVICE_RECORD_TABLE,
        Key: { serviceId: duplicateServiceId, vehicleId: vehicleId }  // adjust if your key schema is different
      }))
      console.log(`🗑️ Deleted duplicate service record: ${duplicateServiceId}`)

      // Also remove it from the vehicle's serviceRecords array
      const existingVehicle = await docClient.send(new GetCommand({
        TableName: VEHICLE_TABLE,
        Key: { vin: vehicleId, userId }
      }))

      if (existingVehicle.Item) {
        const updatedRecords = (existingVehicle.Item.serviceRecords || [])
          .filter((id) => id !== duplicateServiceId)

        await docClient.send(new UpdateCommand({
          TableName: VEHICLE_TABLE,
          Key: { vin: vehicleId, userId },
          UpdateExpression: "SET serviceRecords = :records",
          ExpressionAttributeValues: { ":records": updatedRecords }
        }))
        console.log(`✅ Removed duplicate serviceId from vehicle`)
      }
    }

    const checkService = force ? "proceed" : await handleCheckService(serviceData)

    if (checkService.message === "duplicate") {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "possible_duplicate",
          duplicateServiceId: checkService.duplicateServiceId,
          duplicateKey: checkService.duplicateKey
        })
      }
    }
    console.log(event)

    await docClient.send(new PutCommand({
      TableName: SERVICE_RECORD_TABLE,
      Item: serviceData
    }));
    console.log(`✅ Service record inserted: ${serviceId}`);

    // 2️⃣ Fetch Existing Vehicle
    const existingVehicle = await docClient.send(new GetCommand({
      TableName: VEHICLE_TABLE,
      Key: { vin: vehicleId, userId }
    }));

    if (!existingVehicle.Item) {
      console.log("❌ Vehicle not found, aborting vehicle update");
      return { statusCode: 404, body: JSON.stringify({ error: "Vehicle not found" }) };
    }

    // 3️⃣ Update Vehicle Info
    const newDate = safeDate(date);
    const newMileage = toNumber(mileage);
    const oldMileage = toNumber(existingVehicle.Item.mileage);
    const oldDate = safeDate(existingVehicle.Item.lastServiceDate);

    const dateToUpdate = newDate > oldDate ? newDate : oldDate;
    const dateOnly = dateToUpdate.toISOString().split('T')[0];
    const mileageToUpdate = newMileage > oldMileage ? newMileage : oldMileage;

    const mergedRecalls = mergeRecalls(
      Array.isArray(existingVehicle.Item.recall) ? existingVehicle.Item.recall : [],
      Array.isArray(recall) ? recall : []
    );

    let updateExpression = `
      SET serviceRecords = list_append(serviceRecords, :new_record),
          mileage = :mileage,
          lastServiceDate = :date,
          #recall = :recall
    `;

    const expressionAttributeValues = {
      ":new_record": [serviceId],
      ":mileage": mileageToUpdate,
      ":date": dateOnly,
      ":recall": mergedRecalls
    };

    const expressionAttributeNames = { "#recall": "recall" };

    // Optional attribute updates
    // maybeSetAttr(updateExpression, expressionAttributeValues, expressionAttributeNames, "trim", trim, existingVehicle.Item.trim);
    // maybeSetAttr(updateExpression, expressionAttributeValues, expressionAttributeNames, "make", make, existingVehicle.Item.make);
    // maybeSetAttr(updateExpression, expressionAttributeValues, expressionAttributeNames, "model", model, existingVehicle.Item.model);
    // maybeSetAttr(updateExpression, expressionAttributeValues, expressionAttributeNames, "year", year, existingVehicle.Item.year);
    // maybeSetAttr(updateExpression, expressionAttributeValues, expressionAttributeNames, "license", license, existingVehicle.Item.license);
    // maybeSetAttr(updateExpression, expressionAttributeValues, expressionAttributeNames, "state", shop_state, existingVehicle.Item.state);

    if (event.trim !== "None" && shouldUpdateAttr(existingVehicle.Item.trim)) {
      updateExpression += ", #trim = :trim";
      expressionAttributeValues[":trim"] = event.trim;
      expressionAttributeNames["#trim"] = "trim";
    }

    if (event.make !== "None" && shouldUpdateAttr(existingVehicle.Item.make)) {
      updateExpression += ", #make = :make";
      expressionAttributeValues[":make"] = event.make;
      expressionAttributeNames["#make"] = "make";
    }

    if (event.model !== "None" && shouldUpdateAttr(existingVehicle.Item.model)) {
      updateExpression += ", #model = :model";
      expressionAttributeValues[":model"] = event.model;
      expressionAttributeNames["#model"] = "model";
    }

    if (event.year !== "None" && shouldUpdateAttr(existingVehicle.Item.year)) {
      updateExpression += ", #year = :year";
      expressionAttributeValues[":year"] = event.year;
      expressionAttributeNames["#year"] = "year";
    }

    if (event.license !== "None" && shouldUpdateAttr(existingVehicle.Item.license)) {
      updateExpression += ", #license = :license";
      expressionAttributeValues[":license"] = event.license;
      expressionAttributeNames["#license"] = "license";
    }

    if (event.shop_state !== "None" && shouldUpdateAttr(existingVehicle.Item.state)) {
      updateExpression += ", #state = :state";
      expressionAttributeValues[":state"] = event.shop_state;
      expressionAttributeNames["#state"] = "state";
    }

    await docClient.send(new UpdateCommand({
      TableName: VEHICLE_TABLE,
      Key: { vin: vehicleId, userId },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ExpressionAttributeNames: Object.keys(expressionAttributeNames).length ? expressionAttributeNames : undefined,
      ReturnValues: "UPDATED_NEW"
    }));
    console.log(`✅ Vehicle ${vehicleId} updated with mileage ${mileageToUpdate} and date ${dateOnly}`);

    // Immediately refresh the maintenance schedule for this vehicle (non-blocking).
    await refreshServiceSchedule(vehicleId, userId);

    // 4️⃣ Mechanic-User (Consumer) Table Insert
    console.log("🔹 Mechanic Consumer Table:", MECHANIC_CONSUMER_TABLE);
    console.log("🔹 mechanicId:", mechanicId);
    console.log("🔹 userId:", userId);

    if (mechanicId.trim() && userId.trim()) {
      const existingPair = await docClient.send(new GetCommand({
        TableName: MECHANIC_CONSUMER_TABLE,
        Key: { idMechanic: mechanicId, idUser: userId }
      }));

      if (!existingPair.Item) {
        await docClient.send(new PutCommand({
          TableName: MECHANIC_CONSUMER_TABLE,
          Item: { idMechanic: mechanicId, idUser: userId }
        }));
        console.log(`✅ Added new mechanic-user pair: ${mechanicId} - ${userId}`);
      } else {
        console.log(`ℹ️ Mechanic-user pair already exists: ${mechanicId} - ${userId}`);
      }
    } else {
      console.log("⚠️ Skipped mechanic-user insert: mechanicId or userId missing.");
    }

    // 5️⃣ Return Success
    return { statusCode: 200, body: JSON.stringify(serviceData) };

  } catch (err) {
    console.error("❌ Lambda Error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// --- Helpers ---
const shouldUpdateAttr = (currentValue) =>
  !currentValue || currentValue === "None" || currentValue === "" || currentValue === [];

const maybeSetAttr = (updateExpr, values, names, field, newValue, oldValue) => {
  if (newValue && newValue !== "None" && shouldUpdateAttr(oldValue)) {
    updateExpr += `, #${field} = :${field}`;
    values[`:${field}`] = newValue;
    names[`#${field}`] = field;
  }
};

const mergeRecalls = (existingRecalls, newRecalls) => {
  const existingSet = new Set(existingRecalls.map(r => r.recall_number));
  const uniqueNew = newRecalls.filter(r => !existingSet.has(r.recall_number));
  return [...existingRecalls, ...uniqueNew];
};

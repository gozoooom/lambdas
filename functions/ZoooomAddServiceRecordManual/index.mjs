import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { randomUUID } from "crypto";

const REGION = process.env.VITE_AWS_REGION || "us-west-2";
const SERVICE_RECORD_TABLE = process.env.VITE_AWS_SERVICE_RECORD_TABLE || "ZoooomServiceRecord_dev";
const VEHICLE_TABLE = process.env.VITE_AWS_VEHICLE_TABLE || "ZoooomVehicle_dev";
// See ZoooomAddServiceRecord — env-gated immediate schedule recompute.
const SERVICE_REMINDER_FN = process.env.SERVICE_REMINDER_FN || "";

const ddb = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddb);
const lambdaClient = new LambdaClient({ region: REGION });

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

const toNumber = (val) => {
  const num = parseInt(val, 10);
  return isNaN(num) ? 0 : num;
};

export const handler = async (event) => {

  const serviceId = randomUUID();

  const mechanicId = event.mechanicId?.trim()

  console.log('event details: ', event)

  const serviceData = {
    serviceId,
    vehicleId: event.vin,
    userId: event.userId,
    date: event.date,
    serviceType: event.serviceType,
    mileage: toNumber(event.mileage),
    key: event.key,
    serviceDetails: event.serviceDetails,
    ...(mechanicId ? { mechanicId } : {})
  };

  const putParams = {
    TableName: SERVICE_RECORD_TABLE,
    Item: serviceData
  }

  const putResult = await docClient.send(new PutCommand(putParams));

  const getParams = {
    TableName: VEHICLE_TABLE,
    Key: {
      vin: event.vin,
      userId: event.userId
    }
  }

  const existingVehicle = await docClient.send(new GetCommand(getParams));
  if (!existingVehicle.Item) {
    return {
      statusCode: 404,
      body: JSON.stringify("Vehicle not found")
    }
  }

  let lastServiceDate = existingVehicle.Item.lastServiceDate
  if (!lastServiceDate || lastServiceDate < event.date) {
    lastServiceDate = event.date
  }

  const existingMileage = toNumber(existingVehicle.Item.mileage)
  const newMileage = toNumber(event.mileage)
  const updatedMileage = newMileage > existingMileage ? newMileage : existingMileage

  const updateVehicle = await docClient.send(new UpdateCommand({
    TableName: VEHICLE_TABLE,
    Key: {
      vin: event.vin,
      userId: event.userId
    },
    UpdateExpression: `SET serviceRecords = list_append(if_not_exists(serviceRecords, :empty), :new_record), lastServiceDate = :date, mileage = :mileage`,
    ExpressionAttributeValues: {
      ":new_record": [serviceId],
      ":empty": [],
      ":date": lastServiceDate,
      ":mileage": updatedMileage
    },
    ReturnValues: "UPDATED_NEW"
  }))

  // Immediately refresh the maintenance schedule for this vehicle (non-blocking).
  await refreshServiceSchedule(event.vin, event.userId);

  return {
    statusCode: 200,
    body: JSON.stringify(serviceData)
  }
};
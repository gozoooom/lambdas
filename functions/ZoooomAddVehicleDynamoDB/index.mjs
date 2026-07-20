import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  DeleteCommand
} from "@aws-sdk/lib-dynamodb";

let REGION = process.env.VITE_AWS_REGION || "us-west-2";
const ddb = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddb);
let VEHICLE_TABLE = process.env.VITE_AWS_VEHICLE_TABLE || "ZoooomVehicle_prod";
let USER_TABLE = process.env.VITE_AWS_USER_TABLE || "ZoooomUser_prod";

export const handler = async (event) => {

  console.log('Event details: ', event)

  try {

    // Normalize VIN: trim whitespace + uppercase so the same vehicle written via
    // different code paths produces a single canonical row. Mismatched casing
    // between ZoooomVehicle and ZoooomUser.vehicles previously caused first-car
    // entries to silently drop out of GetUserDashboard's vehicle lookup.
    const vin = (event.vin || "").toString().trim().toUpperCase();
    const userId = event.userId;
    const email = event.email;
    const nowIso = new Date().toISOString();

    // Reject empty key attributes up-front. DynamoDB throws ValidationException
    // for empty strings on key attributes, but only AFTER the vehicle PutCommand
    // — which leaves an orphaned vehicle row. Fail fast instead.
    if (!vin || !userId || !email) {
      console.error("Missing required fields:", { vin, userId, email });
      return {
        statusCode: 400,
        body: JSON.stringify("Missing required fields: vin, userId, email")
      };
    }

    const checkVinParams = {
      TableName: VEHICLE_TABLE,
      IndexName: "vin-index",
      KeyConditionExpression: "vin = :vin",
      ExpressionAttributeValues: {
        ":vin": vin
      },
    }

    const existingVin = await docClient.send(new QueryCommand(checkVinParams))

    // This VIN's existing row(s). The current user's own row is "re-listable":
    // refresh it (basic decode fields) and detach it from any previous listing/
    // deal so the next step creates a BRAND-NEW listing. A row owned by a
    // DIFFERENT user still blocks (one VIN can't be listed by two people).
    const rows = existingVin.Items || [];
    const existing = rows.find((it) => it.userId === userId);

    const activeOtherOwnerRows = rows.filter(
      (it) => it.userId !== userId && it.archived !== true
    );

    if (existing) {
      const isArchived = existing.archived === true;
      // An archived row = the seller deleted this car and is re-adding it; that
      // re-add must become a BRAND-NEW listing (detach the old archived
      // listing/deal, drop the old photos). An active row (re-list without
      // deleting) only gets its basic-decode fields refreshed so its live
      // listing/deal + photos are never orphaned.
      if (isArchived && activeOtherOwnerRows.length > 0) {
        console.log('Cannot re-list, VIN now actively owned by another user:', activeOtherOwnerRows.map(r => r.userId))
        return {
          statusCode: 409,
          body: JSON.stringify("EXISTING")
        }
      }
      console.log(`Re-listing existing vehicle for owner (archived=${isArchived}):`, vin);
      const refreshed = {
        ...existing,
        vin,
        userId,
        // Refresh the cheap basic-decode fields (may have been wrong/null on a
        // prior run); fall back to the stored value when the event omits one.
        year: event.year || existing.year || null,
        make: event.make || existing.make || null,
        model: event.model || existing.model || null,
        trim: event.trim || existing.trim || null,
        license: event.license || existing.license || null,
        state: event.state || existing.state || null,
        mileage: event.mileage ?? existing.mileage ?? null,
        exteriorColor: event.exteriorColor ?? existing.exteriorColor ?? null,
        interiorColor: event.interiorColor ?? existing.interiorColor ?? null,
        recall: event.recall || existing.recall || [],
        type: event.type || existing.type || null,
        // REUSE the stored advanced specs (they don't change for a VIN) so we
        // never pay for a re-decode; only take the event's if none is stored.
        specs: existing.specs || event.specs || null,
        features: existing.features || event.features || null,
        ev_spec: existing.ev_spec || event.ev_spec || event.evSpec || null,
        evSpec: existing.evSpec || event.evSpec || event.ev_spec || null,
        updatedAt: nowIso,
        // NOTE: `createdAt` deliberately rides the `...existing` spread on the
        // active re-list path — a re-list is not a new garage add, so the
        // original add date must survive. Rows written before createdAt existed
        // stay without one on purpose: we don't know their true add date, and
        // stamping "now" would report an old car as added today.
        // Archived re-add only: fresh listing + fresh photos.
        ...(isArchived
          ? {
              archived: false,
              listingId: null,
              dealId: null,
              imageUrls: [],
              images: [],
              // The seller deleted this car and is re-adding it. The code already
              // treats that as brand-new (fresh listing + photos), so it is a
              // genuine garage add and gets a fresh createdAt.
              createdAt: nowIso,
            }
          : {}),
      };

      await docClient.send(new PutCommand({ TableName: VEHICLE_TABLE, Item: refreshed }));

      // Make sure the VIN is back in the user's garage list (a prior delete
      // removed it). Don't duplicate if it's still there (active re-list).
      try {
        const userRes = await docClient.send(new GetCommand({
          TableName: USER_TABLE,
          Key: { IdUser: userId, email },
        }));
        const vehicles = (userRes.Item && userRes.Item.vehicles) || [];
        if (!vehicles.includes(vin)) {
          await docClient.send(new UpdateCommand({
            TableName: USER_TABLE,
            Key: { IdUser: userId, email },
            UpdateExpression: "SET vehicles = list_append(if_not_exists(vehicles, :empty), :new)",
            ExpressionAttributeValues: { ":empty": [], ":new": [vin] },
          }));
        }
      } catch (e) {
        console.error("Re-list: failed to ensure VIN in user's garage list:", e);
      }

      // Keep the body a plain string like "NEW"/"EXISTING" for caller
      // compatibility; the refreshed row is already persisted above.
      return {
        statusCode: 200,
        body: JSON.stringify("REFRESHED"),
      };
    }

    if (activeOtherOwnerRows.length > 0) {
      console.log('Existing Vehicle (other owner, active): ', activeOtherOwnerRows.map((r) => r.userId))
      return {
        statusCode: 409,
        body: JSON.stringify("EXISTING")
      }
    }

    const vehicleData = {
      vin: vin,
      year: event.year,
      make: event.make,
      model: event.model,
      trim: event.trim,
      license: event.license,
      state: event.state,
      mileage: event.mileage,
      // Colors (AI-detected in the sell flow or seller-entered). Persisted on
      // the garage row so the digital-garage detail page shows them.
      exteriorColor: event.exteriorColor ?? null,
      interiorColor: event.interiorColor ?? null,
      userId: userId,
      serviceRecords: [],
      recall: event.recall,
      type: event.type,
      specs: event.specs,
      features: event.features,
      // EV spec snapshot. Written under both naming conventions so the
      // dashboard (VehicleDetails) and marketplace (CarDetailClient) can
      // each read it back without a live /ev-spec call.
      ev_spec: event.ev_spec || event.evSpec || null,
      evSpec: event.ev_spec || event.evSpec || null,
      // Add-date for the garage. The table previously had no creation timestamp
      // at all (only scheduleUpdatedAt, which the service-reminder cron rewrites
      // daily), so "cars added" could not be counted. ZoooomDailyStats reads this.
      createdAt: nowIso,
      updatedAt: nowIso,
    }

    const putParams = {
      TableName: VEHICLE_TABLE,
      Item: vehicleData
    }

    await docClient.send(new PutCommand(putParams));

    // Append VIN to user.vehicles list. `if_not_exists(vehicles, :empty)` makes
    // this safe when the user record has no `vehicles` attribute yet — without
    // it, list_append throws ValidationException on first-time users, the
    // vehicle row stays orphaned, and GetUserDashboard can't find it.
    const updateParams = {
      TableName: USER_TABLE,
      Key: {
        IdUser: userId,
        email: email
      },
      UpdateExpression: "SET vehicles = list_append(if_not_exists(vehicles, :empty), :new_vehicle)",
      ExpressionAttributeValues: {
        ":empty": [],
        ":new_vehicle": [vin]
      },
      ReturnValues: "UPDATED_NEW"
    }

    console.log('updateParams: ', updateParams)

    try {
      const updateUser = await docClient.send(new UpdateCommand(updateParams));
      console.log('updateUser: ', updateUser)
    } catch (userUpdateErr) {
      // Roll back the vehicle put so we don't leave an orphan that the dashboard
      // can never see (dashboard reads VINs from user.vehicles, then fetches
      // each by (vin, userId) — a vehicle row without a matching user entry
      // is invisible to the user forever).
      console.error("User update failed, rolling back vehicle put:", userUpdateErr);
      try {
        await docClient.send(new DeleteCommand({
          TableName: VEHICLE_TABLE,
          Key: { vin: vin, userId: userId }
        }));
        console.log("Rollback: vehicle row deleted");
      } catch (rollbackErr) {
        console.error("Rollback failed (vehicle row may be orphaned):", rollbackErr);
      }
      throw userUpdateErr;
    }

    return {
      statusCode: 200,
      body: JSON.stringify("NEW")
    }
  }
  catch (err) {
    console.error('Error: ', err)

    return {
      statusCode: 500,
      body: JSON.stringify(err)
    }
  }
};

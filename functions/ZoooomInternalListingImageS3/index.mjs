import { S3Client, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-west-2";

/**
 * The customer's listing photos live in the SAME bucket the consumer apps write
 * to — support agents have to see exactly what the customer sees. This used to
 * be hardcoded to "vehicle-listing-images", a legacy bucket with a completely
 * different key layout, so every environment shared one bucket and none of them
 * held the listing photos anyone was looking for.
 *
 * No default: an unset variable must break loudly rather than quietly read or
 * DELETE from the wrong environment's bucket.
 */
const BUCKET_NAME = process.env.S3_BUCKET_NAME;
const VEHICLE_TABLE = process.env.VEHICLE_TABLE_NAME;
for (const [n, v] of Object.entries({ S3_BUCKET_NAME: BUCKET_NAME, VEHICLE_TABLE_NAME: VEHICLE_TABLE })) {
  if (!v) throw new Error(`${n} is not set — refusing to start rather than guess.`);
}

const s3Client = new S3Client({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

/**
 * Consumer listing photos are keyed userId-images/{userId}/vehicles/{vin}/images/.
 * A support agent starts from the vehicle, not the owner, so resolve the owner
 * from the VIN when the caller didn't supply one. ZoooomVehicle is keyed
 * (vin HASH, userId RANGE), so this is a Query rather than a table scan.
 */
async function ownerPrefix(vin, userId) {
  let owner = userId;
  if (!owner) {
    const r = await ddb.send(new QueryCommand({
      TableName: VEHICLE_TABLE,
      KeyConditionExpression: "vin = :v",
      ExpressionAttributeValues: { ":v": vin },
      ProjectionExpression: "userId",
    }));
    const rows = r.Items || [];
    if (rows.length === 0) return { error: `No vehicle found for VIN ${vin}` };
    // A claimed/transferred VIN can carry more than one owner row. Make the
    // agent choose rather than silently guessing whose photos to touch.
    if (rows.length > 1 && !userId) {
      return { error: `VIN ${vin} has ${rows.length} owner records — pass ?userId= to disambiguate`,
               owners: rows.map((x) => x.userId) };
    }
    owner = rows[0].userId;
  }
  return { prefix: `userId-images/${owner}/vehicles/${vin}/images/`, userId: owner };
}

export const handler = async (event) => {
  const httpMethod = event.httpMethod || event.requestContext?.http?.method || "GET";
  const vehicleId = event.pathParameters?.vehicleId;
  const userId = event.queryStringParameters?.userId || null;

  // Enhanced logging
  console.log("🔍 REQUEST DETAILS:", JSON.stringify({
    httpMethod,
    vehicleId,
    pathParameters: event.pathParameters,
    path: event.path,
    requestId: event.requestContext?.requestId,
  }, null, 2));

  try {
    // GET: List all images for a vehicle
    if (httpMethod === "GET") {
      return await getVehicleImages(vehicleId, userId);
    }
    
    // POST: Upload a new image
    if (httpMethod === "POST") {
      return await uploadVehicleImage(event, vehicleId, userId);
    }
    
    // DELETE: Delete an image
    if (httpMethod === "DELETE") {
      return await deleteVehicleImage(event, vehicleId);
    }

    console.warn("⚠️ Method not allowed:", httpMethod);
    return {
      statusCode: 405,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ 
        ok: false, 
        error: "Method not allowed",
        allowedMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        receivedMethod: httpMethod,
      }),
    };

  } catch (err) {
    console.error("❌ UNHANDLED ERROR:", {
      message: err.message,
      stack: err.stack,
      name: err.name,
    });
    
    return {
      statusCode: 500,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ 
        ok: false, 
        error: err.message || "Internal server error",
        errorType: err.name,
        debug: {
          vehicleId,
          httpMethod,
          bucket: BUCKET_NAME,
        }
      }),
    };
  }
};

/**
 * GET: List all images for a vehicle from S3
 */
async function getVehicleImages(vehicleId, userId) {
  // Validate vehicleId
  if (!vehicleId) {
    console.error("❌ Vehicle ID missing in request");
    return {
      statusCode: 400,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ 
        ok: false, 
        error: "Vehicle ID is required",
        hint: "Check that the URL includes the vehicle ID parameter",
      }),
    };
  }

  // Validate vehicleId format (alphanumeric, dashes, underscores only)
  if (!/^[a-zA-Z0-9-_]+$/.test(vehicleId)) {
    console.error("❌ Invalid vehicle ID format:", vehicleId);
    return {
      statusCode: 400,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ 
        ok: false, 
        error: "Invalid vehicle ID format",
        hint: "Vehicle ID can only contain letters, numbers, dashes, and underscores",
        receivedId: vehicleId,
      }),
    };
  }

  const resolved = await ownerPrefix(vehicleId, userId);
  if (resolved.error) {
    return {
      statusCode: resolved.owners ? 409 : 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: false, error: resolved.error, owners: resolved.owners }),
    };
  }
  const s3Prefix = resolved.prefix;
  console.log(`📂 Listing S3 objects:`, {
    bucket: BUCKET_NAME,
    prefix: s3Prefix,
    region: REGION,
  });

  try {
    // List all objects in the vehicle's folder
    const listCommand = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: s3Prefix,
    });

    const listResult = await s3Client.send(listCommand);
    const objects = listResult.Contents || [];

    console.log(`📊 S3 LIST RESULTS:`, {
      totalObjects: objects.length,
      isTruncated: listResult.IsTruncated,
      keyCount: listResult.KeyCount,
      prefix: s3Prefix,
    });

    // Check if folder exists but is empty
    if (objects.length === 0) {
      console.log(`ℹ️ No photos found for vehicle: ${vehicleId}`);
      console.log(`💡 S3 folder "${s3Prefix}" is either empty or doesn't exist`);
      
      return {
        statusCode: 200,
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          ok: true,
          vehicleId: vehicleId,
          photos: [],
          count: 0,
          message: `No photos found for vehicle ${vehicleId}`,
          hint: "Upload photos using the 'Add Photo' button",
          s3Info: {
            bucket: BUCKET_NAME,
            prefix: s3Prefix,
            status: "folder_empty_or_not_exists",
          }
        }),
      };
    }

    // Build photo objects with URLs
    const photos = objects
      .filter(obj => {
        // Skip the folder itself (folders end with /)
        const isFolder = obj.Key === s3Prefix || obj.Key.endsWith('/');
        if (isFolder) {
          console.log(`⏭️ Skipping folder entry: ${obj.Key}`);
        }
        return !isFolder;
      })
      .map((obj, index) => {
        const fileName = obj.Key.split("/").pop();
        const url = `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${obj.Key}`;
        
        return {
          id: `photo-${index + 1}`,
          url: url,
          fileName: fileName,
          size: obj.Size,
          lastModified: obj.LastModified,
          key: obj.Key,
        };
      });

    console.log(`✅ Successfully retrieved ${photos.length} photos`, {
      vehicleId,
      photoCount: photos.length,
      totalSize: photos.reduce((sum, p) => sum + (p.size || 0), 0),
      firstPhoto: photos[0]?.fileName,
      lastPhoto: photos[photos.length - 1]?.fileName,
    });

    return {
      statusCode: 200,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        ok: true,
        vehicleId: vehicleId,
        photos: photos,
        count: photos.length,
        message: `Found ${photos.length} photo${photos.length !== 1 ? 's' : ''}`,
        s3Info: {
          bucket: BUCKET_NAME,
          prefix: s3Prefix,
          status: "success",
        }
      }),
    };

  } catch (error) {
    console.error("❌ S3 LIST ERROR:", {
      errorName: error.name,
      errorMessage: error.message,
      errorCode: error.$metadata?.httpStatusCode,
      bucket: BUCKET_NAME,
      prefix: s3Prefix,
    });

    // Check for specific S3 errors
    if (error.name === "NoSuchBucket") {
      return {
        statusCode: 500,
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ 
          ok: false, 
          error: `S3 bucket '${BUCKET_NAME}' does not exist`,
          hint: "Check Lambda environment variables and S3 bucket configuration",
        }),
      };
    }

    if (error.name === "AccessDenied") {
      return {
        statusCode: 500,
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ 
          ok: false, 
          error: "Access denied to S3 bucket",
          hint: "Check Lambda IAM role permissions for S3 access",
        }),
      };
    }

    throw error; // Re-throw to be caught by main handler
  }
}

/**
 * POST: Upload a new image to S3
 */
async function uploadVehicleImage(event, vehicleId, userId) {
  if (!vehicleId) {
    console.error("❌ Vehicle ID missing in upload request");
    return {
      statusCode: 400,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ 
        ok: false, 
        error: "Vehicle ID is required" 
      }),
    };
  }

  // Validate vehicleId format
  if (!/^[a-zA-Z0-9-_]+$/.test(vehicleId)) {
    console.error("❌ Invalid vehicle ID format for upload:", vehicleId);
    return {
      statusCode: 400,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ 
        ok: false, 
        error: "Invalid vehicle ID format",
        receivedId: vehicleId,
      }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (error) {
    console.error("❌ Invalid JSON in request body:", error.message);
    return {
      statusCode: 400,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ 
        ok: false, 
        error: "Invalid JSON in request body",
      }),
    };
  }

  const { fileName, fileType, fileData } = body;

  if (!fileName || !fileType || !fileData) {
    console.error("❌ Missing required upload fields:", { 
      hasFileName: !!fileName, 
      hasFileType: !!fileType, 
      hasFileData: !!fileData 
    });
    
    return {
      statusCode: 400,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ 
        ok: false, 
        error: "fileName, fileType, and fileData are required",
        received: {
          fileName: !!fileName,
          fileType: !!fileType,
          fileData: !!fileData,
        }
      }),
    };
  }

  // Sanitize filename
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const timestamp = Date.now();
  const resolvedUp = await ownerPrefix(vehicleId, userId);
  if (resolvedUp.error) {
    return {
      statusCode: resolvedUp.owners ? 409 : 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: false, error: resolvedUp.error, owners: resolvedUp.owners }),
    };
  }
  const key = `${resolvedUp.prefix}${timestamp}-${sanitizedFileName}`;

  console.log(`📤 UPLOAD DETAILS:`, {
    vehicleId,
    originalFileName: fileName,
    sanitizedFileName,
    fileType,
    s3Key: key,
    fileDataLength: fileData.length,
  });

  try {
    // Decode base64 file data
    const buffer = Buffer.from(fileData, "base64");
    
    if (buffer.length === 0) {
      throw new Error("File data is empty after base64 decode");
    }

    console.log(`📦 Buffer created: ${buffer.length} bytes`);

    // Upload to S3
    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: fileType,
    });

    await s3Client.send(putCommand);

    const url = `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${key}`;

    console.log(`✅ Upload successful:`, {
      url,
      key,
      size: buffer.length,
    });

    return {
      statusCode: 200,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        ok: true,
        message: "Image uploaded successfully",
        photo: {
          url: url,
          key: key,
          fileName: sanitizedFileName,
          size: buffer.length,
        },
      }),
    };

  } catch (error) {
    console.error("❌ UPLOAD ERROR:", {
      errorName: error.name,
      errorMessage: error.message,
      key,
    });

    if (error.name === "InvalidBase64") {
      return {
        statusCode: 400,
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ 
          ok: false, 
          error: "Invalid base64 file data",
          hint: "Ensure file is properly encoded as base64",
        }),
      };
    }

    throw error;
  }
}

/**
 * DELETE: Delete an image from S3
 */
async function deleteVehicleImage(event, vehicleId) {
  if (!vehicleId) {
    console.error("❌ Vehicle ID missing in delete request");
    return {
      statusCode: 400,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ 
        ok: false, 
        error: "Vehicle ID is required" 
      }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (error) {
    console.error("❌ Invalid JSON in delete request body");
    return {
      statusCode: 400,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ 
        ok: false, 
        error: "Invalid JSON in request body",
      }),
    };
  }

  const { photoUrl, key } = body;

  // Extract key from URL if only URL is provided
  let s3Key = key;
  if (!s3Key && photoUrl) {
    const urlParts = photoUrl.split(".amazonaws.com/");
    if (urlParts.length === 2) {
      s3Key = urlParts[1];
      console.log(`🔍 Extracted key from URL: ${s3Key}`);
    }
  }

  if (!s3Key) {
    console.error("❌ No S3 key provided:", { photoUrl, key });
    return {
      statusCode: 400,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ 
        ok: false, 
        error: "Photo URL or key is required",
        hint: "Provide either 'photoUrl' or 'key' in request body",
      }),
    };
  }

  // Verify the key belongs to this vehicle (security check)
  if (!s3Key.startsWith(`${vehicleId}/`)) {
    console.error("🚨 SECURITY: Attempted to delete photo from different vehicle:", {
      requestedVehicleId: vehicleId,
      photoKey: s3Key,
    });
    
    return {
      statusCode: 403,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ 
        ok: false, 
        error: "Cannot delete image from different vehicle",
        hint: `Photo key must start with '${vehicleId}/'`,
        receivedKey: s3Key,
      }),
    };
  }

  console.log(`🗑️ DELETE REQUEST:`, {
    vehicleId,
    s3Key,
    bucket: BUCKET_NAME,
  });

  try {
    // Optional: Check if file exists first
    try {
      await s3Client.send(new HeadObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
      }));
      console.log(`✅ Photo exists, proceeding with delete`);
    } catch (headError) {
      if (headError.name === "NotFound") {
        console.warn(`⚠️ Photo not found in S3: ${s3Key}`);
        return {
          statusCode: 404,
          headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({ 
            ok: false, 
            error: "Photo not found",
            hint: "The photo may have already been deleted",
            key: s3Key,
          }),
        };
      }
      // If other error, continue with delete anyway
      console.warn(`⚠️ Could not verify photo existence, proceeding with delete anyway`);
    }

    // Delete from S3
    const deleteCommand = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
    });

    await s3Client.send(deleteCommand);

    console.log(`✅ Photo deleted successfully: ${s3Key}`);

    return {
      statusCode: 200,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        ok: true,
        message: "Image deleted successfully",
        key: s3Key,
      }),
    };

  } catch (error) {
    console.error("❌ DELETE ERROR:", {
      errorName: error.name,
      errorMessage: error.message,
      key: s3Key,
    });

    throw error;
  }
}
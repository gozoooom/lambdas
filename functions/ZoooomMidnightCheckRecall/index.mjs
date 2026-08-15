import { getOpenAI } from './openaiSecret.mjs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, QueryCommand, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// Configuration
const OPENAI_BATCH_SIZE = parseInt(process.env.OPENAI_BATCH_SIZE || '10');
const MAX_VEHICLES_PER_RUN = parseInt(process.env.MAX_VEHICLES_PER_RUN || '2000');
const RECALL_CHECK_INTERVAL_DAYS = parseInt(process.env.RECALL_CHECK_INTERVAL_DAYS || '14');
const MAX_EXECUTION_TIME = parseInt(process.env.MAX_EXECUTION_TIME || '840000');
const CACHE_TABLE = process.env.CACHE_TABLE_NAME || 'RecallCacheTable';
const VEHICLE_TABLE = process.env.VEHICLE_TABLE_NAME || 'YourTableName';
const GSI_NAME = process.env.GSI_NAME || 'lastRecallCheck-index';

const RECENT_RECALL_DAYS = parseInt(process.env.RECENT_RECALL_DAYS || '90'); // 90 days = ~3 months

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// In-memory cache for this execution
const executionCache = new Map();

// Calculate cutoff date for vehicles that need checking
const getCheckCutoffDate = () => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RECALL_CHECK_INTERVAL_DAYS);
  return cutoff.toISOString();
};

// NEW: Calculate cutoff for what qualifies as a "recent" recall
const getRecentRecallCutoffDate = () => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RECENT_RECALL_DAYS);
  return cutoff;
};

// NEW: Parse NHTSA date format to Date object
const parseNHTSADate = (dateString) => {
  try {
    // NHTSA dates are typically in format: "MM/DD/YYYY"
    if (!dateString) return null;
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
};

// NEW: Check if recall is genuinely recent (by NHTSA issue date)
const isRecallRecent = (nhtsaRecall) => {
  const recallDate = parseNHTSADate(nhtsaRecall.ReportReceivedDate);
  if (!recallDate) return false;
  
  const cutoff = getRecentRecallCutoffDate();
  return recallDate >= cutoff;
};

// Fetch recalls from NHTSA API
const fetchNHTSARecalls = async (make, model, year) => {
  try {
    const url = `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${year}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`NHTSA API returned status ${response.status}`);
    }

    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error(`Error fetching NHTSA for ${make} ${model} ${year}:`, error.message);
    return [];
  }
};

// Get cached NHTSA data using GetCommand (primary key lookup)
const getCachedOrFetchNHTSA = async (make, model, year) => {
  const cacheKey = `${make}|${model}|${year}`.toLowerCase();
  
  // Check execution cache first (fastest)
  if (executionCache.has(cacheKey)) {
    console.log(`  ⚡ Execution cache hit: ${make} ${model} ${year}`);
    return executionCache.get(cacheKey);
  }

  // Check DynamoDB cache using GetCommand (not scan!)
  try {
    const cacheResult = await docClient.send(new GetCommand({
      TableName: CACHE_TABLE,
      Key: { cacheKey }
    }));

    const cachedItem = cacheResult.Item;
    
    // Use cache if less than 24 hours old
    if (cachedItem && cachedItem.expiresAt > Date.now()) {
      console.log(`  💾 DynamoDB cache hit: ${make} ${model} ${year}`);
      executionCache.set(cacheKey, cachedItem.recalls);
      return cachedItem.recalls;
    }
  } catch (error) {
    console.log(`  ⚠️  Cache lookup failed: ${error.message}`);
  }

  // Cache miss - fetch fresh data from NHTSA
  console.log(`  🌐 Cache miss - fetching from NHTSA: ${make} ${model} ${year}`);
  await delay(150); // Rate limiting
  const recalls = await fetchNHTSARecalls(make, model, year);
  
  // Store in both caches
  executionCache.set(cacheKey, recalls);
  
  // Store in DynamoDB cache (non-blocking)
  storeCacheAsync(cacheKey, recalls, make, model, year).catch(err => 
    console.log(`  ⚠️  Cache write failed: ${err.message}`)
  );

  return recalls;
};

// Store in cache with proper TTL
const storeCacheAsync = async (cacheKey, recalls, make, model, year) => {
  const now = Date.now();
  const ttl = Math.floor((now + (24 * 60 * 60 * 1000)) / 1000); // 24 hours in seconds for TTL
  
  try {
    await docClient.send(new UpdateCommand({
      TableName: CACHE_TABLE,
      Key: { cacheKey },
      UpdateExpression: 'SET recalls = :recalls, expiresAt = :ttl, make = :make, model = :model, #y = :year, lastUpdated = :now',
      ExpressionAttributeNames: {
        '#y': 'year'
      },
      ExpressionAttributeValues: {
        ':recalls': recalls,
        ':ttl': ttl,
        ':make': make,
        ':model': model,
        ':year': parseInt(year),
        ':now': new Date().toISOString()
      }
    }));
  } catch (error) {
    // If cache table doesn't exist, log but continue
    if (error.name === 'ResourceNotFoundException') {
      console.log(`  ⚠️  Cache table '${CACHE_TABLE}' not found. Create it for better performance.`);
    } else {
      throw error;
    }
  }
};

// ENHANCED: Check if recall is new to this vehicle
const isNewRecall = (existingRecalls, campaignNumber) => {
  return !existingRecalls.some(existing => 
    existing.recall_number === campaignNumber
  );
};

// Batch parse recalls with OpenAI (multiple at once)
const batchParseRecalls = async (recallObjects) => {
  if (recallObjects.length === 0) return [];

  try {
    const recallsText = recallObjects.map((recall, idx) => 
      `RECALL ${idx + 1}:
Campaign Number: ${recall.NHTSACampaignNumber}
Manufacturer: ${recall.Manufacturer}
Component: ${recall.Component}
Summary: ${recall.Summary}
Consequence: ${recall.Consequence}
Report Date: ${recall.ReportReceivedDate}`
    ).join('\n\n---\n\n');

    const prompt = `Parse these ${recallObjects.length} vehicle recalls into a JSON array. Each recall should have:
{
  "recall_number": "Campaign number",
  "recall_date": "YYYY-MM-DD format",
  "manufacturer": "Manufacturer name",
  "affected_vehicles": "Brief description",
  "recall_reason": "One sentence safety issue",
  "recall_summary": "One sentence summary",
  "recall_status": "Active"
}

${recallsText}

Return ONLY a JSON array of ${recallObjects.length} recall objects:`;

    const response = await (await getOpenAI()).chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a JSON extraction assistant. Return only valid JSON arrays, no markdown or extra text.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: 'json_object' }
    });

    const jsonResponse = response.choices[0]?.message?.content;
    if (jsonResponse) {
      const parsed = JSON.parse(jsonResponse);
      const recalls = Array.isArray(parsed) ? parsed : (parsed.recalls || Object.values(parsed));
      
      return recalls.map(recall => ({
        ...recall,
        discovered_date: new Date().toISOString(),
        notification_status: 'pending'
      }));
    }
    return [];
  } catch (error) {
    console.error(`  ⚠️  Batch parsing failed: ${error.message}`);
    return null;
  }
};

// Fallback: Parse recalls individually
const parseRecallsIndividually = async (recallObjects) => {
  console.log(`  🔄 Fallback: parsing ${recallObjects.length} recalls individually`);
  const results = [];
  
  for (const recall of recallObjects) {
    try {
      const prompt = `Extract recall info as JSON:
{
  "recall_number": "${recall.NHTSACampaignNumber}",
  "recall_date": "YYYY-MM-DD",
  "manufacturer": "${recall.Manufacturer}",
  "affected_vehicles": "brief description",
  "recall_reason": "one sentence",
  "recall_summary": "one sentence",
  "recall_status": "Active"
}

Component: ${recall.Component}
Summary: ${recall.Summary}
Consequence: ${recall.Consequence}
Date: ${recall.ReportReceivedDate}`;

      const response = await (await getOpenAI()).chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Return only valid JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0,
        max_tokens: 400,
        response_format: { type: 'json_object' }
      });

      const parsed = JSON.parse(response.choices[0]?.message?.content || '{}');
      results.push({
        ...parsed,
        discovered_date: new Date().toISOString(),
        notification_status: 'pending'
      });
      
      await delay(100);
    } catch (error) {
      console.error(`  ✗ Failed to parse ${recall.NHTSACampaignNumber}`);
    }
  }
  
  return results;
};

// Smart parse with batching and fallback
const smartParseRecalls = async (recallObjects) => {
  if (recallObjects.length === 0) return [];

  const allParsed = [];
  
  for (let i = 0; i < recallObjects.length; i += OPENAI_BATCH_SIZE) {
    const batch = recallObjects.slice(i, i + OPENAI_BATCH_SIZE);
    
    let parsed = await batchParseRecalls(batch);
    
    if (parsed === null || parsed.length === 0) {
      parsed = await parseRecallsIndividually(batch);
    }
    
    allParsed.push(...parsed);
    
    if (i + OPENAI_BATCH_SIZE < recallObjects.length) {
      await delay(200);
    }
  }
  
  return allParsed;
};

// Group vehicles by make/model/year
const groupVehicles = (vehicles) => {
  const groups = new Map();
  
  for (const vehicle of vehicles) {
    const key = `${vehicle.make}|${vehicle.model}|${vehicle.year}`.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, {
        make: vehicle.make,
        model: vehicle.model,
        year: vehicle.year,
        vehicles: []
      });
    }
    groups.get(key).vehicles.push(vehicle);
  }
  
  return Array.from(groups.values());
};

// ENHANCED: Process a group of vehicles with recent recall detection
const processVehicleGroup = async (group) => {
  const { make, model, year, vehicles } = group;
  console.log(`\n🚗 Processing ${vehicles.length} vehicles: ${make} ${model} ${year}`);
  
  try {
    // Single NHTSA call for entire group (cache-first!)
    const nhtsaRecalls = await getCachedOrFetchNHTSA(make, model, year);
    
    if (nhtsaRecalls.length === 0) {
      console.log(`  ℹ️  No recalls found`);
      await updateLastCheckTimestamps(vehicles);
      return vehicles.map(v => ({ 
        vin: v.vin, 
        newRecallCount: 0, 
        recentRecallCount: 0,
        status: 'success' 
      }));
    }

    console.log(`  📋 Found ${nhtsaRecalls.length} total recalls from NHTSA`);

    // NEW: Count how many are genuinely recent
    const recentRecalls = nhtsaRecalls.filter(isRecallRecent);
    if (recentRecalls.length > 0) {
      console.log(`  🆕 ${recentRecalls.length} recalls issued in last ${RECENT_RECALL_DAYS} days`);
    }

    const results = [];
    const allNewRecalls = [];
    const recallsToVehicles = new Map();

    // Identify new recalls for each vehicle
    for (const vehicle of vehicles) {
      const existingRecalls = vehicle.recall || [];
      const newRecallsForVehicle = nhtsaRecalls.filter(recall =>
        isNewRecall(existingRecalls, recall.NHTSACampaignNumber)
      );

      if (newRecallsForVehicle.length > 0) {
        recallsToVehicles.set(vehicle.vin, newRecallsForVehicle);
        
        for (const recall of newRecallsForVehicle) {
          if (!allNewRecalls.find(r => r.NHTSACampaignNumber === recall.NHTSACampaignNumber)) {
            allNewRecalls.push(recall);
          }
        }
      }
    }

    // Parse all unique new recalls once
    let parsedRecallsMap = new Map();
    if (allNewRecalls.length > 0) {
      console.log(`  🤖 Parsing ${allNewRecalls.length} unique new recalls with OpenAI...`);
      const parsedRecalls = await smartParseRecalls(allNewRecalls);
      
      // NEW: Add isRecent flag to parsed recalls
      parsedRecalls.forEach(parsed => {
        const originalRecall = allNewRecalls.find(r => r.NHTSACampaignNumber === parsed.recall_number);
        if (originalRecall) {
          parsed.is_recent_recall = isRecallRecent(originalRecall);
          parsed.nhtsa_report_date = originalRecall.ReportReceivedDate;
        }
        parsedRecallsMap.set(parsed.recall_number, parsed);
      });
    }

    // Update vehicles with their parsed recalls
    for (const vehicle of vehicles) {
      const newRecallsForVehicle = recallsToVehicles.get(vehicle.vin);
      
      if (newRecallsForVehicle && newRecallsForVehicle.length > 0) {
        const parsedForVehicle = newRecallsForVehicle
          .map(recall => parsedRecallsMap.get(recall.NHTSACampaignNumber))
          .filter(Boolean);

        if (parsedForVehicle.length > 0) {
          await updateVehicleRecalls(vehicle.vin, vehicle.userId, parsedForVehicle);
          
          const recentCount = parsedForVehicle.filter(r => r.is_recent_recall).length;
          console.log(`  ✓ ${vehicle.vin}: Added ${parsedForVehicle.length} new recalls (${recentCount} recent)`);
          
          results.push({
            vin: vehicle.vin,
            newRecallCount: parsedForVehicle.length,
            recentRecallCount: recentCount,
            status: 'success'
          });
        } else {
          await updateLastCheckTimestamp(vehicle.vin, vehicle.userId);
          results.push({ 
            vin: vehicle.vin, 
            newRecallCount: 0, 
            recentRecallCount: 0,
            status: 'success' 
          });
        }
      } else {
        await updateLastCheckTimestamp(vehicle.vin, vehicle.userId);
        results.push({ 
          vin: vehicle.vin, 
          newRecallCount: 0,
          recentRecallCount: 0, 
          status: 'success' 
        });
      }
    }

    return results;

  } catch (error) {
    console.error(`  ✗ Error processing group ${make} ${model} ${year}:`, error.message);
    return vehicles.map(v => ({
      vin: v.vin,
      error: error.message,
      status: 'failed'
    }));
  }
};

// Update vehicle recalls AND lastRecallCheck timestamp
const updateVehicleRecalls = async (vin, userId, newRecalls) => {
  await docClient.send(new UpdateCommand({
    TableName: VEHICLE_TABLE,
    Key: { vin : vin, userId: userId },
    UpdateExpression: 'SET recall = list_append(if_not_exists(recall, :empty_list), :new_recalls), lastRecallCheck = :timestamp',
    ExpressionAttributeValues: {
      ':new_recalls': newRecalls,
      ':empty_list': [],
      ':timestamp': new Date().toISOString()
    }
  }));
};

// Update only lastRecallCheck timestamp (no new recalls)
const updateLastCheckTimestamp = async (vin, userId) => {
  await docClient.send(new UpdateCommand({
    TableName: VEHICLE_TABLE,
    Key: { vin: vin, userId: userId },
    UpdateExpression: 'SET lastRecallCheck = :timestamp',
    ExpressionAttributeValues: {
      ':timestamp': new Date().toISOString()
    }
  }));
};

// Batch update timestamps for efficiency
const updateLastCheckTimestamps = async (vehicles) => {
  const timestamp = new Date().toISOString();
  
  const updatePromises = vehicles.map(vehicle => 
    updateLastCheckTimestamp(vehicle.vin, vehicle.userId)
  );
  
  await Promise.all(updatePromises);
};

const getVehiclesToCheck = async (maxVehicles) => {
  const cutoffDate = getCheckCutoffDate();
  const vehicles = [];
  let lastEvaluatedKey = null;
  
  console.log(`🔍 Finding vehicles that need checking (older than ${RECALL_CHECK_INTERVAL_DAYS} days)...`);
  
  do {
    const params = {
      TableName: VEHICLE_TABLE,
      FilterExpression: 'attribute_not_exists(lastRecallCheck) OR lastRecallCheck < :cutoff',
      ExpressionAttributeValues: {
        ':cutoff': cutoffDate
      },
      Limit: Math.min(100, maxVehicles - vehicles.length),
      ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey })
    };

    const result = await docClient.send(new ScanCommand(params));
    
    if (result.Items && result.Items.length > 0) {
      vehicles.push(...result.Items);
      console.log(`  📥 Fetched ${result.Items.length} vehicles (total: ${vehicles.length})`);
    }
    
    lastEvaluatedKey = result.LastEvaluatedKey;
    
    if (vehicles.length >= maxVehicles) {
      break;
    }
    
  } while (lastEvaluatedKey && vehicles.length < maxVehicles);
  
  console.log(`ℹ️  Using filtered scan. This is OK for up to ~10,000 vehicles.`);
  console.log(`💡 For better performance with more vehicles, add a GSI on 'lastRecallCheck'.`);
  
  return vehicles;
};

// Main processing with optimized queries
const processVehiclesOptimized = async (maxExecutionTime) => {
  const startTime = Date.now();
  
  console.log(`\n🔍 Querying vehicles needing recall check...`);
  console.log(`  - Check interval: ${RECALL_CHECK_INTERVAL_DAYS} days`);
  console.log(`  - Recent recall threshold: ${RECENT_RECALL_DAYS} days`);
  console.log(`  - Max vehicles per run: ${MAX_VEHICLES_PER_RUN}`);
  
  // Query vehicles that need checking
  const vehicles = await getVehiclesToCheck(MAX_VEHICLES_PER_RUN);
  
  if (vehicles.length === 0) {
    console.log(`\n✅ No vehicles need checking at this time`);
    return {
      results: [],
      totalProcessed: 0,
      totalNewRecalls: 0,
      totalRecentRecalls: 0,
      cacheHits: 0
    };
  }

  console.log(`\n📊 Found ${vehicles.length} vehicles to check`);

  // Group by make/model/year for efficiency
  const groups = groupVehicles(vehicles);
  console.log(`📦 Grouped into ${groups.length} unique vehicle types`);

  const allResults = [];
  let totalNewRecalls = 0;
  let totalRecentRecalls = 0;

  // Process each group
  for (const group of groups) {
    // Check time limit
    const elapsed = Date.now() - startTime;
    if (elapsed > maxExecutionTime) {
      console.log('\n⏱️  Approaching time limit, stopping...');
      break;
    }

    const groupResults = await processVehicleGroup(group);
    allResults.push(...groupResults);
    
    totalNewRecalls += groupResults.reduce((sum, r) => sum + (r.newRecallCount || 0), 0);
    totalRecentRecalls += groupResults.reduce((sum, r) => sum + (r.recentRecallCount || 0), 0);
  }

  return {
    results: allResults,
    totalProcessed: allResults.length,
    totalNewRecalls,
    totalRecentRecalls,
    cacheHits: executionCache.size
  };
};

export const handler = async (event) => {
  const startTime = Date.now();
  
  try {
    console.log('🚀 Starting enhanced recall check with recency detection...');
    console.log(`⚙️  Config: OpenAI Batch=${OPENAI_BATCH_SIZE}, Max Vehicles=${MAX_VEHICLES_PER_RUN}`);

    const { results, totalProcessed, totalNewRecalls, totalRecentRecalls, cacheHits } = 
      await processVehiclesOptimized(MAX_EXECUTION_TIME);

    const successfulChecks = results.filter(r => r.status === 'success').length;
    const failedChecks = results.filter(r => r.status === 'failed').length;
    const vehiclesWithNewRecalls = results.filter(r => r.newRecallCount > 0).length;
    const vehiclesWithRecentRecalls = results.filter(r => r.recentRecallCount > 0).length;

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n✅ Recall check completed');
    console.log(`⏱️  Duration: ${duration}s`);
    console.log(`📊 Processed: ${totalProcessed} vehicles`);
    console.log(`💾 Cache hits: ${cacheHits} unique vehicle types`);
    console.log(`🆕 New recalls found: ${totalNewRecalls} across ${vehiclesWithNewRecalls} vehicles`);
    console.log(`🔥 Recent recalls (last ${RECENT_RECALL_DAYS} days): ${totalRecentRecalls} across ${vehiclesWithRecentRecalls} vehicles`);
    console.log(`✓ Success: ${successfulChecks}, ✗ Failed: ${failedChecks}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Recall check completed',
        duration: `${duration}s`,
        totalProcessed,
        successfulChecks,
        failedChecks,
        totalNewRecalls,
        totalRecentRecalls,
        vehiclesWithNewRecalls,
        vehiclesWithRecentRecalls,
        cacheHits,
        checkIntervalDays: RECALL_CHECK_INTERVAL_DAYS,
        recentRecallThresholdDays: RECENT_RECALL_DAYS
      })
    };

  } catch (error) {
    console.error('❌ Error in recall check:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error checking recalls',
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      })
    };
  }
};
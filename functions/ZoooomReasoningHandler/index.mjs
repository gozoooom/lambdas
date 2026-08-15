import { getOpenAI } from './openaiSecret.mjs'


const REASONING_PROMPT = `You are a data extraction specialist. Extract the following information from this automotive maintenance/service record text and return it as a JSON object.

Required fields to extract:
- vin: Vehicle Identification Number (full VIN) if its not 17 characters long return "None"
- vehicle_license_plate: Vehicle license plate number if its not 7 characters long return "None"
- vehicle_make: vehicle description of the make (e.g., "Toyota", "Honda", "Ford")
- vehicle_model: vehicle description of the model WITHOUT the trim (e.g., "Camry", "Accord", "F-150")
- vehicle_year: vehicle description of the year (e.g., "2020", "2018")
- vehicle_trim: vehicle trim level or package name ONLY (e.g., "LE", "XLE", "Limited", "Sport", "Touring", "LX", "EX", "Premium", "Base", "S", "SE", "SEL", "Titanium", "Platinum", "Laredo", "Overland"). Look for trim designations that appear after the model name or in vehicle descriptions. Common trim patterns include:
  * Single letters: "L", "S", "R", "T", "Z"
  * Letter combinations: "LE", "XLE", "SE", "SEL", "LX", "EX", "DX", "LT", "LS", "RS", "SS", "RT", "SRT", "GT", "GTS", "STI", "WRX"
  * Descriptive words: "Limited", "Premium", "Sport", "Touring", "Base", "Custom", "Hybrid", "Electric", "Luxury", "Ultimate", "Elite"
  * Alphanumeric: "2.5S", "3.5SE", "V6 Limited", "2.0T", "3.6R", "5.7L"
  * Luxury indicators: "Platinum", "Titanium", "Summit", "Denali", "Escalade", "Aviator", "Navigator"
  * Performance trims: "Type R", "Type S", "AMG", "M3", "M5", "RS", "Hellcat", "Scat Pack", "SRT", "Nismo", "TRD"
  Do NOT include engine size, transmission type, or drivetrain (2WD/4WD/AWD) as trim.
- mileage: Vehicle mileage (mileage in or out, whichever is available — do not include any commas or periods)
- shop_name: Name of the mechanic shop/service center
- shop_phone: Phone number of the mechanic shop/service center
- shop_address_number: Street number of the mechanic shop/service center
- shop_full_address: Full address of the mechanic shop/service center
- shop_street_address: Street address of the mechanic shop/service center (include street number and street name)
- shop_city: City where the mechanic shop/service center is located
- shop_state: State where the mechanic shop/service center is located
- shop_zip_code: ZIP code of the mechanic shop/service center (5 digits, no hyphens or spaces)
- service_date: Date when the service record was created
- service_type: Type of service/maintenance being performed (e.g., "Head Gasket Replacement", "Oil Change", "Brake Service")
- parts_list: Array of ALL parts, components, fluids, filters, and services mentioned. Include:
  * All individual parts (e.g., "Oil Filter", "Cabin Air Filter", "Brake Pads")
  * All fluids (e.g., "Engine Oil", "Brake Fluid", "Power Steering Fluid")
  * All filters (e.g., "Air Filter", "Fuel Filter", "Transmission Filter")
  * All services performed (e.g., "Oil Change", "Tire Rotation", "Brake Inspection")
  * All inspections (e.g., "Multi-Point Inspection", "Brake Inspection", "Fluid Level Check")
  * Any adjustments or calibrations (e.g., "Parking Brake Adjustment", "Wheel Alignment")
  Extract EVERY item mentioned, even sub-components of a larger service.

Additional fields if available:
- customer_name: Customer's name
- customer_contact: Phone number or email
- invoice_number: Invoice or reference number
- technician_name: Name of the technician who performed the work
- total_cost: Total cost if mentioned

Rules:
1. Return ONLY a valid JSON object, no additional text
2. If a field is not found, use the string "None" as the value
3. For parts_list, include the part name/description only (no prices or quantities)
4. Ensure all field names are exactly as specified above
5. Use consistent date format: YYYY-MM-DD
6. For parts_list, be thorough — if a service description mentions multiple components, extract ALL of them as separate items
7. Use reasoning to infer missing fields when context strongly implies them (e.g., if only a city and zip are present, still populate both fields)`

export const handler = async (event) => {
  console.log('ZoooomReasoningHandler EVENT:', JSON.stringify(event))

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? event)
    const { extractedText } = body

    if (!extractedText?.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'extractedText is required' }) }
    }

    const response = await (await getOpenAI()).chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a precise data extraction assistant. Return valid JSON only.'
        },
        {
          role: 'user',
          content: `${REASONING_PROMPT}\n\nExtracted text:\n\n${extractedText}`
        }
      ]
    })

    let content = response.choices[0].message.content || '{}'
    content = content
      .replace(/```json\s*/gi, '').replace(/```\s*$/gi, '').trim()
      .replace(/:\s*None\b/g, ': null')        // Python None → JSON null
      .replace(/:\s*True\b/g, ': true')         // Python True → JSON true (safety)
      .replace(/:\s*False\b/g, ': false')       // Python False → JSON false (safety)

    const parsedData = JSON.parse(content.normalize('NFC'))

    return {
      statusCode: 200,
      body: JSON.stringify(parsedData)
    }

  } catch (error) {
    console.error('Reasoning error:', error.message)
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) }
  }
}
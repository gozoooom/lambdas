import { getOpenAI } from './openaiSecret.mjs'


export const handler = async (event) => {
  const imagePayload = []
  const base64Data = event.base64Array

  base64Data.forEach((item) => {
    imagePayload.push({
      type: 'image_url',
      image_url: {
        url: `data:image/${event.format};base64,${item}`,
        detail: 'high'
      }
    })
  })

  const GETSERVICEDETAILSPARSERPROMPT = `You are a data extraction specialist. Extract the following information from these automotive maintenance/service record image and return it as a JSON object.

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
    - mileage: Vehicle mileage (mileage in or out, whichever is available do not include any comma or periods)
    - shop_name: Name of the mechanic shop/service center
    - shop_phone: Phone number of the mechanic shop/service center
    - shop_address_number: Street number of the mechanic shop/service center
    - shop_full_adress: Full address of the mechanic shop/service center
    - shop_street_address: Street address of the mechanic shop/service center (include street number and street name)
    - shop_city: City where the mechanic shop/service center is located
    - shop_state: State where the mechanic shop/service center is located
    - shop_zip_code: ZIP code of the mechanic shop/service center (5 digits do not include hyphens or spaces)
    - service_date: Date when the service record was created
    - service_type: Type of service/maintenance being performed (e.g., "Head Gasket Replacement", "Oil Change", "Brake Service", etc.)
    - parts_list: Array of ALL parts, components, fluids, filters, and services mentioned in the service description. This should be a comprehensive list that includes:
      * All individual parts (e.g., "Oil Filter", "Cabin Air Filter", "Brake Pads")
      * All fluids (e.g., "Engine Oil", "Brake Fluid", "Power Steering Fluid")
      * All filters (e.g., "Air Filter", "Fuel Filter", "Transmission Filter")
      * All services performed (e.g., "Oil Change", "Tire Rotation", "Brake Inspection")
      * All inspections (e.g., "Multi-Point Inspection", "Brake Inspection", "Fluid Level Check")
      * Any adjustments or calibrations (e.g., "Parking Brake Adjustment", "Wheel Alignment")
      Extract EVERY item mentioned in detailed service descriptions, even if they seem like sub-components of a larger service.

    Additional fields if available:
    - customer_name: Customer's name
    - customer_contact: Phone number or email
    - invoice_number: Invoice or reference number
    - technician_name: Name of the technician who performed the work
    - total_cost: Total cost if mentioned

    Rules:
    1. Return ONLY a valid JSON object, no additional text
    2. If a field is not found, use "None" as the value
    3. For parts_list, include the part name/description only (no prices or quantities)
    4. Ensure all field names are exactly as specified above
    5. Use consistent date format: YYYY-MM-DD
    6. For parts_list, be thorough - if a service description mentions multiple components, extract ALL of them as separate items

    Examples of correct trim extraction for various vehicle types:

    Standard Vehicles:
    - "2020 Toyota Camry LE" → vehicle_model: "Camry", vehicle_trim: "LE"
    - "Honda Accord EX-L V6" → vehicle_model: "Accord", vehicle_trim: "EX-L"
    - "Ford F-150 Lariat SuperCrew" → vehicle_model: "F-150", vehicle_trim: "Lariat"
    - "Chevrolet Silverado 1500 LT" → vehicle_model: "Silverado 1500", vehicle_trim: "LT"

    Luxury Vehicles:
    - "2019 BMW 330i xDrive" → vehicle_model: "330i", vehicle_trim: "xDrive"
    - "Mercedes-Benz C300 4MATIC" → vehicle_model: "C300", vehicle_trim: "4MATIC"
    - "Audi A4 Premium Plus Quattro" → vehicle_model: "A4", vehicle_trim: "Premium Plus"
    - "Lexus RX 350 F Sport" → vehicle_model: "RX 350", vehicle_trim: "F Sport"

    Performance/Sports Cars:
    - "2021 Honda Civic Type R" → vehicle_model: "Civic", vehicle_trim: "Type R"
    - "Ford Mustang GT Premium" → vehicle_model: "Mustang", vehicle_trim: "GT Premium"
    - "Chevrolet Camaro SS 1LE" → vehicle_model: "Camaro", vehicle_trim: "SS 1LE"
    - "Dodge Challenger SRT Hellcat" → vehicle_model: "Challenger", vehicle_trim: "SRT Hellcat"

    SUVs/Trucks with Complex Names:
    - "Jeep Grand Cherokee Laredo 4x4" → vehicle_model: "Grand Cherokee", vehicle_trim: "Laredo"
    - "Toyota 4Runner TRD Off-Road Premium" → vehicle_model: "4Runner", vehicle_trim: "TRD Off-Road Premium"
    - "Ford Explorer ST AWD" → vehicle_model: "Explorer", vehicle_trim: "ST"
    - "Cadillac Escalade Premium Luxury" → vehicle_model: "Escalade", vehicle_trim: "Premium Luxury"

    Hybrids/Electric Vehicles:
    - "Toyota Prius Prime Limited" → vehicle_model: "Prius Prime", vehicle_trim: "Limited"
    - "Tesla Model S Plaid" → vehicle_model: "Model S", vehicle_trim: "Plaid"
    - "Honda Insight EX" → vehicle_model: "Insight", vehicle_trim: "EX"
    - "Ford Mustang Mach-E Premium" → vehicle_model: "Mustang Mach-E", vehicle_trim: "Premium"

    Unusual/Complex Model Names:
    - "Ram 1500 Big Horn Crew Cab" → vehicle_model: "1500", vehicle_trim: "Big Horn"
    - "GMC Sierra 2500HD AT4" → vehicle_model: "Sierra 2500HD", vehicle_trim: "AT4"
    - "Mitsubishi Outlander Sport ES" → vehicle_model: "Outlander Sport", vehicle_trim: "ES"
    - "Land Rover Range Rover Evoque SE Premium" → vehicle_model: "Range Rover Evoque", vehicle_trim: "SE Premium"

    Examples of comprehensive parts_list extraction:
    
    Service Description: "Level 2 Service - Perform Engine Oil and Filter Change, Rotate Tires (Non-Staggered Wheels), Replace Cabin Air Filter, Inspect and Top Off Fluids, Perform Brake Inspection Including Parking Brake Adjustment, Multi-Point Vehicle Inspection"
    
    parts_list should include:
    ["Engine Oil", "Oil Filter", "Tire Rotation", "Cabin Air Filter", "Fluid Top Off", "Brake Inspection", "Parking Brake Adjustment", "Multi-Point Vehicle Inspection"]

    Service Description: "Replace front brake pads and rotors, flush brake fluid, inspect brake lines"
    
    parts_list should include:
    ["Front Brake Pads", "Brake Rotors", "Brake Fluid Flush", "Brake Line Inspection"]

    Please analyze the image and extract the requested information.`

  const response = await (await getOpenAI()).chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: "json_object" },
    messages: [
        {
            role: 'system',
            content:
                'You are a precise data extraction assistant. You extract structured data from automotive service records and return valid JSON only.'
        },
        {
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: GETSERVICEDETAILSPARSERPROMPT
                },
                ...imagePayload
            ]
        }
    ]
  })

  let responseContent = response.choices[0].message.content || '{}'
    responseContent = responseContent
        .replace(/```json\s*/, '')
        .replace(/```\s*$/, '')
        .trim()
  
  const normal = responseContent.normalize('NFC')

  const answerObject = JSON.parse(normal)
  console.log('answerObject: ', answerObject)

  // TODO implement
  const returnResponse = {
    statusCode: 200,
    body: JSON.stringify(answerObject),
  };
  return returnResponse;
};

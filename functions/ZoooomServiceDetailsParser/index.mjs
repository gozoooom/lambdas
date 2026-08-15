import { getOpenAI } from './openaiSecret.mjs'


export const handler = async (event) => {

  const GETSERVICEDETAILSPARSERPROMPT = `You are a data extraction specialist. Extract the following information from this automotive maintenance/service record image and return it as a JSON object.

    Required fields to extract:
    - vin: Vehicle Identification Number (full VIN) if its not 17 characters long return null
    - vehicle_license_plate: Vehicle license plate
    - vehicle_make: vehicle description of the make (e.g., "Toyota", "Honda", "Ford")
    - vehicle_model: vehicle description of the model WITHOUT the trim (e.g., "Camry", "Accord", "F-150")
    - vehicle_year: vehicle description of the year (e.g., "2020", "2018")
    - vehicle_trim: vehicle trim level or package name ONLY (e.g., "LE", "XLE", "Limited", "Sport", "Touring", "LX", "EX", "Premium", "Base", "S", "SE", "SEL", "Titanium", "Platinum", "Laredo", "Overland"). Look for trim designations that appear after the model name or in vehicle descriptions. Common trim patterns include:
      * Single letters: "L", "S", "R"
      * Letter combinations: "LE", "XLE", "SE", "SEL", "LX", "EX", "DX"
      * Descriptive words: "Limited", "Premium", "Sport", "Touring", "Base", "Custom"
      * Alphanumeric: "2.5S", "3.5SE", "V6 Limited"
      * Luxury indicators: "Platinum", "Titanium", "Summit", "Denali"
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
    - parts_list: Array of all parts used/replaced with their descriptions

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

    Examples of correct trim extraction:
    - "2020 Toyota Camry LE" → vehicle_model: "Camry", vehicle_trim: "LE"
    - "Honda Accord EX-L V6" → vehicle_model: "Accord", vehicle_trim: "EX-L"
    - "Ford F-150 Lariat SuperCrew" → vehicle_model: "F-150", vehicle_trim: "Lariat"
    - "Chevrolet Silverado 1500 LT" → vehicle_model: "Silverado 1500", vehicle_trim: "LT"

    Please analyze the image and extract the requested information.`

  const response = await (await getOpenAI()).chat.completions.create({
    model: 'gpt-4o-mini',
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
                {
                    type: 'image_url',
                    image_url: {
                        url: `data:image/${event.format};base64,${event.base64}`,
                        detail: 'high'
                    }
                }
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

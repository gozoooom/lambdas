import { getOpenAI } from './openaiSecret.mjs'

const RECALLPARSEPROMPT =`Extract recall information from the following recall object and return ONLY a JSON object with these exact fields:

        {
          "recall_number": "NHTSA Campaign Number or recall number",
          :"recall_date": "Date of recall (YYYY-MM-DD)",
          "manufacturer": "Vehicle manufacturer name", 
          "affected_vehicles": "Brief description of affected vehicles",
          "recall_reason": "Primary reason for recall (e.g., safety, emissions, or other issues not too long a sentence that describes the issue very well)",
          "recall_summary": "1 sentence summary of the issue",
          "recall_status": "Current status of the recall (e.g., "Active", "Closed") if available if not make it "Active",
        }

        Recall Object Data:
        textContent

        Return only the JSON object, no other text:`;


export const handler = async (event) => {

    // console.log('Event Details: ', event)

  const summaries = await Promise.all(
      event.map(async (recallObj, index) => {
          try {
              // Convert the recall object to a readable format
              const textContent = JSON.stringify(recallObj, null, 2)

              const response = await (await getOpenAI()).chat.completions.create({
                  model: 'gpt-4o-mini',
                  messages: [
                      {
                          role: 'system',
                          content:
                              'You are a JSON extraction assistant. Always return valid JSON objects only, no additional text or formatting.'
                      },
                      {
                          role: 'user',
                          content: RECALLPARSEPROMPT.replace(
                              'textContent',
                              textContent
                          )
                      }
                  ],
                  temperature: 0,
                  max_tokens: 1000,
                  response_format: { type: 'json_object' }
              })

            //   console.log(`Response for recall ${index}:`, response.choices[0]?.message?.content);

              // Parse the JSON response
              const jsonResponse = response.choices[0]?.message?.content
              if (jsonResponse) {
                  try {
                      const parsedData = JSON.parse(jsonResponse)
                      return parsedData // Return the parsed object
                  } catch (parseError) {
                      // console.error(`JSON parsing error for recall ${index}:`, parseError);
                      // console.error('Raw response:', jsonResponse);
                      return null
                  }
              }

              return null // Return null if no response
          } catch (error) {
              console.error(`Error processing recall ${index}:`, error)
              return null
          }
      })
  )
  const validSummaries = summaries.filter((summary) => summary !== null)
  // TODO implement
  const response = {
    statusCode: 200,
    body: JSON.stringify(validSummaries),
  };
  return response;
};

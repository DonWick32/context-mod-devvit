export type ToxicityResult = {
  flagged: boolean;
  confidence: number;
  categories: string[];
};

export const classifyToxicity = async (
  text: string,
  apiKey: string
): Promise<ToxicityResult | undefined> => {
  if (!text || text.trim().length === 0) {
    return { flagged: false, confidence: 0, categories: [] };
  }

  console.log(text);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const prompt = `Analyze the following text for toxicity, hate speech, harassment, and abuse. 
Output ONLY a JSON object with this exact schema:
{
  "flagged": boolean, // true if the text is toxic, hateful, or abusive
  "confidence": number, // a number from 0 to 100 representing confidence of the flagged status (where 100 is highly confident it's toxic/abusive)
  "categories": string[] // list of categories like "hate_speech", "harassment", "toxicity", "insult", "profanity"
}
Do not output markdown formatting like \`\`\`json. Only output the raw JSON object.

Text to analyze:
"""
${text.substring(0, 5000)}
"""`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          topK: 1,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!response.ok) {
      console.error(`Gemini API error: ${response.status} ${response.statusText}`);
      const textResponse = await response.text();
      console.error(textResponse);
      return undefined;
    }

    const data = await response.json();

    console.log(data);
    if (
      !data.candidates ||
      data.candidates.length === 0 ||
      !data.candidates[0].content ||
      !data.candidates[0].content.parts ||
      data.candidates[0].content.parts.length === 0
    ) {
      return undefined;
    }

    const responseText = data.candidates[0].content.parts[0].text;

    // Clean up potential markdown wrapper just in case
    const jsonStr = responseText.replace(/```json\n?/, '').replace(/```\n?$/, '');

    const parsed = JSON.parse(jsonStr);

    return {
      flagged: Boolean(parsed.flagged),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    };
  } catch (error) {
    console.error('Failed to classify toxicity with Gemini:', error);
    return undefined;
  }
};

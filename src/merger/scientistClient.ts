import OpenAI from 'openai';

export type ScientistClient = (prompt: string) => Promise<string>;

const resolveScientistModel = (): string =>
  process.env.FEATURE_HARVEST_SCIENTIST_MODEL || 'gpt-4.1-mini';

export const createDefaultScientistClient = ():
  | ScientistClient
  | undefined => {
  const apiKey =
    process.env.FEATURE_HARVEST_SCIENTIST_API_KEY ||
    process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return undefined;
  }
  const baseURL = process.env.FEATURE_HARVEST_SCIENTIST_BASE_URL;
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

  return async (prompt: string): Promise<string> => {
    const completion = await client.chat.completions.create({
      model: resolveScientistModel(),
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You are Scientist Reviewer. Return only valid JSON that matches the provided instructions.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });
    const content = completion.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('Scientist client returned an empty response.');
    }
    return content;
  };
};

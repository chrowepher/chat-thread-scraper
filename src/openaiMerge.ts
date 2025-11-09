import OpenAI from 'openai';
import { z } from 'zod';
import type {
  MergeRequest,
  MergeResult,
  MergeDecision,
  BrowserConversation,
  ConversationMessage,
  ProviderPreset,
} from './types.js';

const DEFAULT_MODEL = 'gpt-4.1-mini';

interface ProviderConfig {
  apiKeyEnv: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

const PROVIDER_PRESETS: Record<string, ProviderConfig> = {
  openai: {
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  openrouter: {
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseURL: 'https://openrouter.ai/api/v1',
    headers: {
      'HTTP-Referer':
        process.env.OPENROUTER_SITE ??
        'https://github.com/openai/codex-cli',
      'X-Title': process.env.OPENROUTER_TITLE ?? 'Chat Thread Merger',
    },
  },
  custom: {
    apiKeyEnv: 'OPENAI_API_KEY',
  },
};

const mergeSchema = z.object({
  summary: z.string(),
  combined_path: z.array(z.string()),
  merge_decisions: z.array(
    z.object({
      branch_titles: z.array(z.string()),
      decision: z.string(),
      rationale: z.string().optional(),
    }),
  ),
  follow_up_ideas: z.array(z.string()).optional(),
});

export type MergeSchema = z.infer<typeof mergeSchema>;
export const mergeResponseSchema = mergeSchema;

export const parseMergeResponse = (content: string): MergeSchema => {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `parseMergeResponse: invalid JSON payload received. ${String(error)}`,
    );
  }
  return mergeSchema.parse(parsedJson);
};

export const interpretMergeSchema = (
  parsed: MergeSchema,
): Omit<MergeResult, 'rawResponse'> => {
  const decisions: MergeDecision[] = parsed.merge_decisions.map((decision) => {
    const entry: MergeDecision = {
      branchTitles: decision.branch_titles,
      decision: decision.decision,
    };
    if (decision.rationale) {
      entry.rationale = decision.rationale;
    }
    return entry;
  });

  const result: Omit<MergeResult, 'rawResponse'> = {
    summary: parsed.summary,
    combinedPath: parsed.combined_path,
    mergeDecisions: decisions,
  };

  if (parsed.follow_up_ideas) {
    result.followUpIdeas = parsed.follow_up_ideas;
  }

  return result;
};

export interface MergeOptions extends MergeRequest {
  apiKey?: string;
  temperature?: number;
  provider?: ProviderPreset;
  apiBase?: string;
  apiHeaders?: Record<string, string>;
  apiKeyEnv?: string;
}

const defaultInstructions = `
You are an executive synthesizer who fuses multiple ChatGPT conversation branches into one coherent plan.
Produce an authoritative merged narrative that:
- Extracts the strongest insights from each branch.
- Resolves or explicitly selects between conflicting ideas.
- Re-threads the conversation into a single, user-friendly sequence of highlights.
- Identifies any follow-up explorations worth running next.
Return the answer as JSON that strictly follows the schema provided.`.trim();

const formatMessages = (
  messages: ConversationMessage[],
  limit?: number,
): string => {
  const trimmed =
    typeof limit === 'number' ? messages.slice(-Math.abs(limit)) : messages;
  const truncate = (text: string): string => {
    const TRUNCATION_THRESHOLD = 1200;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= TRUNCATION_THRESHOLD) {
      return clean;
    }
    return `${clean.slice(0, TRUNCATION_THRESHOLD)} ...(truncated)`;
  };
  return trimmed
    .map((msg) => `${msg.role.toUpperCase()}: ${truncate(msg.content)}`)
    .join('\n');
};

const describeBranch = (
  branch: BrowserConversation,
  index: number,
  maxMessages?: number,
): string => {
  const header = `Branch ${index + 1}: ${branch.title}\nURL: ${branch.url}`;
  const body = formatMessages(branch.messages, maxMessages);
  return `${header}\n${body}`;
};

export async function mergeBranches(options: MergeOptions): Promise<MergeResult> {
  const {
    branches,
    prompt = defaultInstructions,
    model = DEFAULT_MODEL,
    maxBranchHighlights,
    temperature = 0.2,
    provider = 'openai',
    apiBase,
    apiHeaders,
    apiKey: explicitKey,
    apiKeyEnv,
  } = options;

  if (!branches?.length) {
    throw new Error('mergeBranches: at least one branch is required.');
  }

  const providerConfigInput: ProviderResolutionInput = {
    provider,
  };
  if (apiKeyEnv) {
    providerConfigInput.apiKeyEnv = apiKeyEnv;
  }
  if (apiHeaders && Object.keys(apiHeaders).length) {
    providerConfigInput.apiHeaders = apiHeaders;
  }
  if (apiBase) {
    providerConfigInput.apiBase = apiBase;
  }
  if (explicitKey) {
    providerConfigInput.explicitKey = explicitKey;
  }

  const { apiKey, baseURL, headers } = resolveProviderConfig(
    providerConfigInput,
  );

  if (!apiKey) {
    throw new Error(
      'mergeBranches: API key is missing. Provide --api-key, set the proper environment variable, or configure --api-key-env.',
    );
  }

  const openai = new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: headers,
  });

  const hasPreference =
    typeof maxBranchHighlights === 'number' && Number.isFinite(maxBranchHighlights);
  const normalizedPreference = hasPreference
    ? Math.trunc(maxBranchHighlights)
    : undefined;
  const highlightLimit =
    normalizedPreference === undefined
      ? 12
      : normalizedPreference <= 0
        ? undefined
        : Math.max(1, normalizedPreference);

  const branchPayload = branches
    .map((branch, index) => describeBranch(branch, index, highlightLimit))
    .join('\n\n');

  const completion = await openai.chat.completions.create({
    model,
    temperature,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: prompt,
      },
      {
        role: 'user',
        content: `Here are the ChatGPT branches to merge:\n\n${branchPayload}`,
      },
    ],
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('mergeBranches: empty response from OpenAI.');
  }

  let parsed: MergeSchema;
  try {
    parsed = parseMergeResponse(content);
  } catch (error) {
    throw new Error(
      `mergeBranches: unable to parse JSON response from OpenAI. ${String(error)}`,
    );
  }

  const interpreted = interpretMergeSchema(parsed);

  return {
    ...interpreted,
    rawResponse: completion,
  };
}
interface ProviderResolutionInput {
  provider?: ProviderPreset;
  apiBase?: string;
  apiHeaders?: Record<string, string>;
  apiKeyEnv?: string;
  explicitKey?: string;
}

interface ProviderResolutionResult {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

const resolveProviderConfig = (
  input: ProviderResolutionInput,
): ProviderResolutionResult => {
  const presetKey =
    input.provider && PROVIDER_PRESETS[input.provider]
      ? input.provider
      : input.provider
        ? 'custom'
        : 'openai';
  const preset = (
    (PROVIDER_PRESETS[presetKey] as ProviderConfig | undefined) ??
    PROVIDER_PRESETS.openai
  ) as ProviderConfig;

  const combinedHeaders = {
    ...(preset.headers ?? {}),
    ...(input.apiHeaders ?? {}),
  };

  const resolvedApiKey =
    input.explicitKey ??
    process.env[input.apiKeyEnv ?? preset.apiKeyEnv] ??
    process.env[preset.apiKeyEnv];

  const result: ProviderResolutionResult = {};
  if (resolvedApiKey) {
    result.apiKey = resolvedApiKey;
  }
  const resolvedBase = input.apiBase ?? preset.baseURL;
  if (resolvedBase) {
    result.baseURL = resolvedBase;
  }
  if (Object.keys(combinedHeaders).length > 0) {
    result.headers = combinedHeaders;
  }

  return result;
};

import { performance } from 'node:perf_hooks';
import { runFeatureHarvestMerge } from './featureHarvestMerge.js';
import { DEFAULT_FEATURE_HARVEST_CONFIG } from './config.js';
import { buildScientistPrompt } from './scientistReview.js';
import type {
  FeatureHarvestConfig,
  FeatureHarvestResult,
  PilotLogPayload,
} from './types.js';
import type { BrowserConversation } from '../types.js';
import type { ScientistClient } from './scientistClient.js';
import { logPilotBatch, summarizeMergeResult } from './logger.js';

export interface PilotBatchInput {
  queue: BrowserConversation[][];
  config?: Partial<FeatureHarvestConfig>;
  pilotMode?: boolean;
  scientistClient?: ScientistClient;
}

export interface PilotBatchResult {
  batchId: string;
  mergeResults: FeatureHarvestResult[];
  scientistVerdict?: string;
  logFile?: string;
}

const parseEnvBoolean = (value?: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (/^(0|false|off)$/i.test(value)) {
    return false;
  }
  if (/^(1|true|on)$/i.test(value)) {
    return true;
  }
  return undefined;
};

const mergeConfigs = (
  overrides?: Partial<FeatureHarvestConfig>,
): FeatureHarvestConfig => ({
  ...DEFAULT_FEATURE_HARVEST_CONFIG,
  ...overrides,
  scoreWeights: {
    ...DEFAULT_FEATURE_HARVEST_CONFIG.scoreWeights,
    ...(overrides?.scoreWeights ?? {}),
  },
  guardrails: {
    ...DEFAULT_FEATURE_HARVEST_CONFIG.guardrails,
    ...(overrides?.guardrails ?? {}),
  },
  pilotCaps: {
    ...DEFAULT_FEATURE_HARVEST_CONFIG.pilotCaps,
    ...(overrides?.pilotCaps ?? {}),
  },
  scientistReview: {
    ...DEFAULT_FEATURE_HARVEST_CONFIG.scientistReview,
    ...(overrides?.scientistReview ?? {}),
    ...(parseEnvBoolean(process.env.FEATURE_HARVEST_SCIENTIST) !== undefined
      ? {
          enabled: parseEnvBoolean(process.env.FEATURE_HARVEST_SCIENTIST)!,
        }
      : {}),
  },
});

export const runPilotBatch = async ({
  queue,
  config: overrides,
  pilotMode = true,
  scientistClient,
}: PilotBatchInput): Promise<PilotBatchResult> => {
  const config = mergeConfigs(overrides);
  const start = performance.now();
  const cap = pilotMode ? config.pilotCaps.maxPairs : queue.length;
  const slice = queue.slice(0, cap);
  const mergeResults = slice.map((pair) =>
    runFeatureHarvestMerge({ conversations: pair, config }),
  );
  const runtimeActual = performance.now() - start;
  const batchId = `batch-${Date.now()}`;

  let scientistVerdict: string | undefined;
  let scientistPrompt: string | undefined;
  if (
    scientistClient &&
    config.scientistReview.enabled &&
    mergeResults.length
  ) {
    scientistPrompt = buildScientistPrompt({
      batchId,
      mergeResults,
      configSnapshot: config,
      pilotMode,
      runtimeEstimateMs: config.pilotCaps.maxRuntimeMs,
      runtimeActualMs: runtimeActual,
    });
    scientistVerdict = await scientistClient(scientistPrompt);
  }

  let logFile: string | undefined;
  try {
    const logPayload: PilotLogPayload = {
      batchId,
      timestamp: new Date().toISOString(),
      pilotMode,
      config,
      runtimeEstimateMs: config.pilotCaps.maxRuntimeMs,
      runtimeActualMs: runtimeActual,
      mergeResults: mergeResults.map((result) => summarizeMergeResult(result)),
      ...(scientistPrompt ? { scientistPrompt } : {}),
      ...(scientistVerdict ? { scientistVerdict } : {}),
    };
    logFile = await logPilotBatch(logPayload);
  } catch (error) {
    console.warn('Failed to log feature-harvest pilot batch:', error);
  }

  const result: PilotBatchResult = {
    batchId,
    mergeResults,
    ...(scientistVerdict ? { scientistVerdict } : {}),
    ...(logFile ? { logFile } : {}),
  };

  return result;
};

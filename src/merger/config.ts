import type { FeatureHarvestConfig } from './types.js';

export const DEFAULT_FEATURE_HARVEST_CONFIG: FeatureHarvestConfig = {
  similarityThreshold: 0.42,
  scoreWeights: {
    clarity: 0.3,
    evidence: 0.25,
    freshness: 0.2,
    antiFriction: 0.25,
  },
  guardrails: {
    minUniqueFraction: 0.7,
    maxMergeTokens: 5500,
    wordCaps: [160, 96, 48, 32],
  },
  pilotCaps: {
    maxPairs: 2,
    maxMessages: 200,
    maxTokens: 8000,
    maxRuntimeMs: 90_000,
  },
  scientistReview: {
    enabled: true,
    batchSize: 2,
    fidelityThreshold: 7.5,
    completenessThreshold: 7.5,
  },
};

import type { BrowserConversation, ConversationMessage } from '../types.js';

export type FeatureRole = 'canonical' | 'alternate' | 'unique';

export interface FeatureScores {
  clarity: number;
  evidence: number;
  freshness: number;
  antiFriction: number;
  combined: number;
}

export interface FeatureMetadata {
  wordCount: number;
  sentenceCount: number;
  containsListSyntax: boolean;
  containsNumbers: boolean;
  originatesFromRole: ConversationMessage['role'];
  sourceOrder: number;
  segmentIndex: number;
  isSummary?: boolean;
  summaryLevel?: 'message' | 'conversation';
  summarySourceMessageIndices?: number[];
  summarySourceCount?: number;
  priority?: 'summary' | 'normal';
}

export interface Feature {
  id: string;
  topicId: string;
  topicLabel: string;
  text: string;
  sourceConversationId: string;
  sourceConversationTitle: string;
  sourceMessageIndices: number[];
  role: FeatureRole;
  scores: FeatureScores;
  provenance: string[];
  metadata: FeatureMetadata;
}

export interface FeatureCluster {
  topicId: string;
  topicLabel: string;
  members: Feature[];
  canonicalId?: string;
  alternateIds: string[];
  similarityMatrix: Array<{
    aId: string;
    bId: string;
    score: number;
  }>;
}

export interface ConversationFeatureSet {
  conversation: BrowserConversation;
  features: Feature[];
}

export interface ScoreWeights {
  clarity: number;
  evidence: number;
  freshness: number;
  antiFriction: number;
}

export interface CoverageStats {
  total: number;
  uniqueTotal: number;
  uniqueKept: number;
  uniqueFraction: number;
  summaryCredits?: number;
}

export interface GuardrailReport {
  coverage: Record<string, CoverageStats>;
  coverageAggregates?: Record<string, CoverageStats>;
  coverageFailures: string[];
  initialTokenEstimate: number;
  tokenEstimate: number;
  tokenLimitBreached: boolean;
  compression?: GuardrailCompressionReport;
  droppedUniqueCredits?: Record<string, number>;
  maxMergeTokens?: number;
}

export interface SynthesizedSection {
  topicId: string;
  title: string;
  canonical: Feature[];
  uniques: Feature[];
  alternates: Feature[];
}

export interface SynthesizedConversation {
  summary: string;
  sections: SynthesizedSection[];
  messages: ConversationMessage[];
}

export interface FeatureHarvestResult {
  synthesis: SynthesizedConversation;
  allFeatures: Feature[];
  canonicalFeatures: Feature[];
  alternateFeatures: Feature[];
  uniqueFeatures: Feature[];
  clusters: FeatureCluster[];
  guardrails: GuardrailReport;
}

export interface SimilarityOptions {
  similarityThreshold: number;
}

export interface GuardrailConfig {
  minUniqueFraction: number;
  maxMergeTokens?: number;
  wordCaps?: number[];
}

export interface PilotCaps {
  maxPairs: number;
  maxMessages: number;
  maxTokens: number;
  maxRuntimeMs: number;
}

export interface ScientistReviewConfig {
  enabled: boolean;
  batchSize: number;
  fidelityThreshold: number;
  completenessThreshold: number;
}

export interface FeatureHarvestConfig {
  similarityThreshold: number;
  scoreWeights: ScoreWeights;
  guardrails: GuardrailConfig;
  pilotCaps: PilotCaps;
  scientistReview: ScientistReviewConfig;
}

export interface GuardrailCompressionReport {
  applied: boolean;
  truncatedFeatures: number;
  droppedUniques: number;
  droppedCanonicals: number;
  summaryFallback?: boolean;
  notes?: string;
}

export interface PilotLogMergeExcerpt {
  summary: string;
  canonicalCount: number;
  uniqueCount: number;
  alternateCount: number;
  guardrails: GuardrailReport;
}

export interface PilotLogPayload {
  batchId: string;
  timestamp: string;
  pilotMode: boolean;
  config: FeatureHarvestConfig;
  runtimeEstimateMs: number;
  runtimeActualMs: number;
  mergeResults: PilotLogMergeExcerpt[];
  scientistPrompt?: string;
  scientistVerdict?: string;
}

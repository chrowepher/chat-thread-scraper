import crypto from 'node:crypto';
import { DEFAULT_FEATURE_HARVEST_CONFIG } from './config.js';
import { buildFeatureClusters } from './featureClusterer.js';
import { extractFeaturesFromConversation } from './featureExtractor.js';
import { scoreFeatures } from './featureScorer.js';
import { selectCanonicalFeatures } from './mergeSelector.js';
import { createMergedConversationShell, synthesizeConversation } from './synthesizer.js';
import type {
  BrowserConversation,
  MergeResult,
} from '../types.js';
import type {
  FeatureHarvestConfig,
  FeatureHarvestResult,
  Feature,
} from './types.js';

export interface FeatureHarvestMergeInput {
  conversations: BrowserConversation[];
  config?: Partial<FeatureHarvestConfig>;
  enableSplitting?: boolean;
}

const DEFAULT_MESSAGE_SPLIT_THRESHOLD = 80;
const DEFAULT_MESSAGE_SPLIT_SIZE = 40;
const DEFAULT_FEATURE_SPLIT_THRESHOLD = 100;
const DEFAULT_FEATURE_SPLIT_SIZE = 60;

const MESSAGE_SPLIT_THRESHOLD =
  Number.parseInt(
    process.env.FEATURE_HARVEST_SPLIT_MESSAGE_THRESHOLD ?? '',
    10,
  ) || DEFAULT_MESSAGE_SPLIT_THRESHOLD;
const MESSAGE_SPLIT_SIZE =
  Number.parseInt(process.env.FEATURE_HARVEST_SPLIT_MESSAGE_SIZE ?? '', 10) ||
  DEFAULT_MESSAGE_SPLIT_SIZE;

const FEATURE_SPLIT_THRESHOLD =
  Number.parseInt(
    process.env.FEATURE_HARVEST_SPLIT_FEATURE_THRESHOLD ?? '',
    10,
  ) || DEFAULT_FEATURE_SPLIT_THRESHOLD;
const FEATURE_SPLIT_SIZE =
  Number.parseInt(process.env.FEATURE_HARVEST_SPLIT_FEATURE_SIZE ?? '', 10) ||
  DEFAULT_FEATURE_SPLIT_SIZE;

const SEGMENT_SUFFIX = '__seg';
const FEATURE_SUFFIX = '__feat';

const formatSplitIndex = (index: number): string =>
  (index + 1).toString().padStart(2, '0');

const buildSplitId = (
  baseId: string,
  kind: 'seg' | 'feat',
  index: number,
): string =>
  `${baseId}${
    kind === 'seg' ? SEGMENT_SUFFIX : FEATURE_SUFFIX
  }${formatSplitIndex(index)}`;

type SplitOverrideConfig = {
  messageThreshold?: number;
  messageSize?: number;
  featureThreshold?: number;
  featureSize?: number;
};

type SplitOverrideEntry = {
  matcher: (conversation: BrowserConversation) => boolean;
  config: SplitOverrideConfig;
  key: string;
};

const toPositiveInt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
};

const parseOverrideConfig = (
  raw: unknown,
): SplitOverrideConfig | undefined => {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  const config: SplitOverrideConfig = {};
  const messageThreshold = toPositiveInt(candidate.messageThreshold);
  const messageSize = toPositiveInt(candidate.messageSize);
  const featureThreshold = toPositiveInt(candidate.featureThreshold);
  const featureSize = toPositiveInt(candidate.featureSize);
  if (messageThreshold !== undefined) {
    config.messageThreshold = messageThreshold;
  }
  if (messageSize !== undefined) {
    config.messageSize = messageSize;
  }
  if (featureThreshold !== undefined) {
    config.featureThreshold = featureThreshold;
  }
  if (featureSize !== undefined) {
    config.featureSize = featureSize;
  }
  return Object.keys(config).length ? config : undefined;
};

const matchesConversationId = (
  conversation: BrowserConversation,
  value: string,
): boolean =>
  conversation.tabId === value || conversation.parentTabId === value;

const buildOverrideMatcher = (
  key: string,
): ((conversation: BrowserConversation) => boolean) => {
  const trimmed = key.trim();
  if (trimmed.startsWith('title:')) {
    const needle = trimmed.slice('title:'.length).toLowerCase();
    return (conversation) =>
      conversation.title.toLowerCase().includes(needle);
  }
  if (trimmed.startsWith('url:')) {
    const needle = trimmed.slice('url:'.length);
    return (conversation) => conversation.url.includes(needle);
  }
  if (trimmed.startsWith('tabId:')) {
    const needle = trimmed.slice('tabId:'.length);
    return (conversation) => matchesConversationId(conversation, needle);
  }
  return (conversation) => matchesConversationId(conversation, trimmed);
};

const splitOverrideEntries: SplitOverrideEntry[] = (() => {
  const raw = process.env.FEATURE_HARVEST_SPLIT_OVERRIDES;
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(parsed)
      .map(([key, value]) => {
        const config = parseOverrideConfig(value);
        if (!config) {
          return undefined;
        }
        return {
          key,
          matcher: buildOverrideMatcher(key),
          config,
        };
      })
      .filter((entry): entry is SplitOverrideEntry => Boolean(entry));
  } catch (error) {
    console.warn(
      'Failed to parse FEATURE_HARVEST_SPLIT_OVERRIDES. Expected JSON object.',
      error,
    );
    return [];
  }
})();

const resolveSplitConfig = (
  conversation: BrowserConversation,
): Required<SplitOverrideConfig> => {
  const override = splitOverrideEntries.find((entry) =>
    entry.matcher(conversation),
  )?.config;
  return {
    messageThreshold: override?.messageThreshold ?? MESSAGE_SPLIT_THRESHOLD,
    messageSize: override?.messageSize ?? MESSAGE_SPLIT_SIZE,
    featureThreshold: override?.featureThreshold ?? FEATURE_SPLIT_THRESHOLD,
    featureSize: override?.featureSize ?? FEATURE_SPLIT_SIZE,
  };
};

const summarizeChunkFeatures = (
  chunkFeatures: Feature[],
  chunkId: string,
  chunkTitle: string,
): Feature | undefined => {
  if (!chunkFeatures.length) {
    return undefined;
  }
  const sortedByScore = [...chunkFeatures].sort(
    (a, b) => b.scores.combined - a.scores.combined,
  );
  const labelSnippets = sortedByScore
    .slice(0, 5)
    .map((feature) => feature.topicLabel.trim())
    .filter(Boolean);
  const text = `Segment summary covering ${chunkFeatures.length} unique item(s): ${labelSnippets.join(
    '; ',
  )}.`;
  const referenceFeature = sortedByScore[0] ?? chunkFeatures[0];
  if (!referenceFeature) {
    throw new Error('Unable to derive a reference feature for summary synthesis.');
  }
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const sentenceCount = Math.max(
    1,
    text.split(/[.!?]+/).filter(Boolean).length,
  );
  const messageIndices = Array.from(
    new Set(
      chunkFeatures.flatMap(
        (feature) => feature.sourceMessageIndices ?? [],
      ),
    ),
  ).slice(0, 10);
  return {
    id: crypto.randomUUID(),
    topicId: `${chunkId}-summary`,
    topicLabel: `${chunkTitle} Summary`,
    text,
    sourceConversationId: chunkId,
    sourceConversationTitle: chunkTitle,
    sourceMessageIndices: messageIndices,
    role: 'unique',
    scores: { ...referenceFeature.scores },
    provenance: [chunkId],
    metadata: {
      wordCount,
      sentenceCount,
      containsListSyntax: true,
      containsNumbers: /\d/.test(text),
      originatesFromRole: referenceFeature.metadata.originatesFromRole,
      sourceOrder: referenceFeature.metadata.sourceOrder - 0.01,
      segmentIndex: -1,
      isSummary: true,
      summaryLevel: 'conversation',
      summarySourceCount: chunkFeatures.length,
      priority: 'summary',
    },
  };
};

const splitConversationMessages = (
  conversation: BrowserConversation,
): BrowserConversation[] => {
  const splitConfig = resolveSplitConfig(conversation);
  if (conversation.messages.length <= splitConfig.messageThreshold) {
    return [conversation];
  }
  const segments: BrowserConversation[] = [];
  let partIndex = 0;
  const baseId = conversation.parentTabId ?? conversation.tabId;
  for (
    let start = 0;
    start < conversation.messages.length;
    start += splitConfig.messageSize
  ) {
    const chunk = conversation.messages.slice(
      start,
      start + splitConfig.messageSize,
    );
    const partLabel = `${conversation.title} (Segment ${partIndex + 1})`;
    const segmentId = buildSplitId(baseId, 'seg', partIndex);
    segments.push({
      ...conversation,
      tabId: segmentId,
      parentTabId: baseId,
      title: partLabel,
      messages: chunk,
    });
    partIndex += 1;
  }
  return segments;
};

const normalizeConversations = (
  conversations: BrowserConversation[],
  enableSplitting: boolean,
): BrowserConversation[] =>
  enableSplitting
    ? conversations.flatMap((conversation) =>
        splitConversationMessages(conversation),
      )
    : conversations;

const expandFeatureSetsBySize = (
  sets: Array<{ conversation: BrowserConversation; features: Feature[] }>,
  enableSplitting: boolean,
): Array<{ conversation: BrowserConversation; features: Feature[] }> => {
  if (!enableSplitting) {
    return sets;
  }

  return sets.flatMap((set) => {
    const splitConfig = resolveSplitConfig(set.conversation);
    if (set.features.length <= splitConfig.featureThreshold) {
      const hasConversationSummary = set.features.some(
        (feature) =>
          feature.metadata.isSummary &&
          feature.metadata.summaryLevel === 'conversation',
      );
      if (!hasConversationSummary) {
        const summaryFeature = summarizeChunkFeatures(
          set.features,
          set.conversation.tabId,
          set.conversation.title,
        );
        if (summaryFeature) {
          set.features.push(summaryFeature);
        }
      }
      return [set];
    }
    const sorted = [...set.features].sort(
      (a, b) => a.metadata.sourceOrder - b.metadata.sourceOrder,
    );
    const chunks: Array<{
      conversation: BrowserConversation;
      features: Feature[];
    }> = [];
    for (
      let start = 0;
      start < sorted.length;
      start += splitConfig.featureSize
    ) {
      const chunkFeatures = sorted.slice(
        start,
        start + splitConfig.featureSize,
      );
      const chunkTitle = `${set.conversation.title} (Feature Segment ${
        chunks.length + 1
      })`;
      const chunkId = buildSplitId(
        set.conversation.tabId,
        'feat',
        chunks.length,
      );
      const parentTabId =
        set.conversation.parentTabId ?? set.conversation.tabId;
      chunkFeatures.forEach((feature) => {
        feature.sourceConversationTitle = chunkTitle;
        feature.sourceConversationId = chunkId;
        if (!feature.provenance.includes(chunkId)) {
          feature.provenance.push(chunkId);
        }
      });
      const summaryFeature = summarizeChunkFeatures(
        chunkFeatures,
        chunkId,
        chunkTitle,
      );
      const featuresWithSummary = summaryFeature
        ? [...chunkFeatures, summaryFeature]
        : chunkFeatures;
      chunks.push({
        conversation: {
          ...set.conversation,
          tabId: chunkId,
          parentTabId,
          title: chunkTitle,
        },
        features: featuresWithSummary,
      });
    }
    return chunks;
  });
};

const mergeConfig = (
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
  },
});

export const runFeatureHarvestMerge = ({
  conversations,
  config: overrides,
  enableSplitting = true,
}: FeatureHarvestMergeInput): FeatureHarvestResult => {
  if (!conversations.length) {
    throw new Error('runFeatureHarvestMerge: at least one conversation required.');
  }

  const config = mergeConfig(overrides);
  const normalized = normalizeConversations(conversations, enableSplitting);
  const baseFeatureSets = normalized.map((conversation) =>
    extractFeaturesFromConversation(conversation),
  );
  const featureSets = expandFeatureSetsBySize(baseFeatureSets, enableSplitting);

  const allFeatures = featureSets.flatMap((set) => set.features);
  scoreFeatures(allFeatures, config.scoreWeights);
  const clusters = buildFeatureClusters(allFeatures, {
    similarityThreshold: config.similarityThreshold,
  });

  const selection = selectCanonicalFeatures(clusters, config.guardrails);
  const synthesis = synthesizeConversation(
    selection.canonical,
    selection.uniques,
    selection.alternates,
  );

  return {
    synthesis,
    allFeatures,
    canonicalFeatures: selection.canonical,
    alternateFeatures: selection.alternates,
    uniqueFeatures: selection.uniques,
    clusters,
    guardrails: selection.guardrails,
  };
};

export const toMergeResult = (
  harvestResult: FeatureHarvestResult,
): MergeResult => ({
  summary: harvestResult.synthesis.summary,
  combinedPath: harvestResult.canonicalFeatures.map(
    (feature) => feature.topicLabel,
  ),
  mergeDecisions: harvestResult.clusters
    .filter((cluster) => cluster.canonicalId)
    .map((cluster) => ({
      branchTitles: cluster.members.map(
        (feature) => feature.sourceConversationTitle,
      ),
      decision: cluster.topicLabel,
      rationale: `Canonical feature selected with score ${
        harvestResult.canonicalFeatures.find(
          (feature) => feature.id === cluster.canonicalId,
        )?.scores.combined ?? 0
      }.`,
    })),
  followUpIdeas: harvestResult.uniqueFeatures
    .filter((feature) => /idea|next|follow/i.test(feature.text))
    .map((feature) => feature.text),
});

export const createMergedConversation = (
  harvestResult: FeatureHarvestResult,
): BrowserConversation => createMergedConversationShell(harvestResult.synthesis);

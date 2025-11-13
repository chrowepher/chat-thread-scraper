import type {
  Feature,
  FeatureCluster,
  GuardrailReport,
  GuardrailConfig,
  CoverageStats,
  GuardrailCompressionReport,
} from './types.js';

const WORD_SPLIT_REGEX = /\s+/;
const SENTENCE_SPLIT_REGEX = /[.!?]+/;
const SMALL_CONVERSATION_PIN_THRESHOLD = 8;
const BASELINE_PINNED_FEATURES = 4;
const SPLIT_SUFFIX_REGEX = /(__seg\d+|__feat\d+)/gi;
const AGGREGATE_COVERAGE_CAP =
  Number.parseInt(process.env.FEATURE_HARVEST_COVERAGE_CAP ?? '', 10) || 80;

const getParentConversationId = (conversationId: string): string => {
  const normalized = conversationId.replace(SPLIT_SUFFIX_REGEX, '');
  return normalized || conversationId;
};

const byId = (features: Feature[]): Map<string, Feature> =>
  new Map(features.map((feature) => [feature.id, feature]));

const isSummaryFeature = (feature: Feature): boolean =>
  feature.metadata.isSummary === true;

const getFeaturePriority = (feature: Feature): number =>
  feature.metadata.priority === 'summary' ? 1 : 0;

export interface CanonicalSelection {
  canonical: Feature[];
  alternates: Feature[];
  uniques: Feature[];
  guardrails: GuardrailReport;
}

const estimateFeatureTokens = (feature: Feature): number => {
  if (
    feature.metadata.isSummary &&
    feature.metadata.summaryLevel === 'conversation'
  ) {
    return 1;
  }
  return Math.max(1, Math.ceil(feature.metadata.wordCount / 0.75));
};

const estimateTokens = (features: Feature[]): number =>
  features.reduce((sum, feature) => sum + estimateFeatureTokens(feature), 0);

const refreshFeatureMetadata = (feature: Feature): void => {
  const trimmed = feature.text.trim();
  const words = trimmed ? trimmed.split(WORD_SPLIT_REGEX).filter(Boolean) : [];
  feature.metadata.wordCount = words.length;
  const sentences = trimmed
    ? trimmed.split(SENTENCE_SPLIT_REGEX).filter(Boolean)
    : [];
  feature.metadata.sentenceCount = Math.max(1, sentences.length);
  feature.metadata.containsNumbers = /\d/.test(trimmed);
};

const truncateFeatureToWords = (
  feature: Feature,
  maxWords: number,
): boolean => {
  if (!Number.isFinite(maxWords) || maxWords <= 0) {
    return false;
  }
  const words = feature.text.trim().split(WORD_SPLIT_REGEX).filter(Boolean);
  if (words.length <= maxWords) {
    return false;
  }
  const truncated = `${words.slice(0, maxWords).join(' ')} ...`;
  feature.text = truncated;
  refreshFeatureMetadata(feature);
  return true;
};

const truncateFeatureList = (
  features: Feature[],
  maxWords: number,
): number => {
  if (!Number.isFinite(maxWords) || maxWords <= 0) {
    return 0;
  }
  let truncatedCount = 0;
  features.forEach((feature) => {
    if (truncateFeatureToWords(feature, maxWords)) {
      truncatedCount += 1;
    }
  });
  return truncatedCount;
};

const replaceArrayContents = <T>(target: T[], nextValues: T[]): void => {
  target.length = 0;
  nextValues.forEach((value) => target.push(value));
};

const sortChronologically = (features: Feature[]): Feature[] =>
  [...features].sort(
    (a, b) => a.metadata.sourceOrder - b.metadata.sourceOrder,
  );

const compareByPriority = (a: Feature, b: Feature): number => {
  const priorityDiff = getFeaturePriority(b) - getFeaturePriority(a);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }
  return b.scores.combined - a.scores.combined;
};
const trimFeaturesToBudget = (
  features: Feature[],
  budgetTokens: number,
): { kept: Feature[]; dropped: Feature[]; usedTokens: number } => {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    return { kept: [], dropped: [...features], usedTokens: 0 };
  }
  const conversationFeatures = new Map<string, Feature[]>();
  features.forEach((feature) => {
    const list = conversationFeatures.get(feature.sourceConversationId);
    if (list) {
      list.push(feature);
    } else {
      conversationFeatures.set(feature.sourceConversationId, [feature]);
    }
  });
  const pinnedConversationIds = new Set(
    Array.from(conversationFeatures.entries())
      .filter(
        ([, list]) =>
          list.length > 0 && list.length <= SMALL_CONVERSATION_PIN_THRESHOLD,
      )
      .map(([conversationId]) => conversationId),
  );
  const kept: Feature[] = [];
  const keptIds = new Set<string>();
  let usedTokens = 0;
  const tryAdd = (feature: Feature): boolean => {
    if (keptIds.has(feature.id)) {
      return true;
    }
    const tokens = estimateFeatureTokens(feature);
    if (usedTokens + tokens > budgetTokens) {
      return false;
    }
    kept.push(feature);
    keptIds.add(feature.id);
    usedTokens += tokens;
    return true;
  };
  const summaryFeatures = features
    .filter(
      (feature) =>
        feature.metadata.isSummary &&
        feature.metadata.summaryLevel === 'conversation',
    )
    .sort(compareByPriority);
  summaryFeatures.forEach((feature) => {
    tryAdd(feature);
  });
  conversationFeatures.forEach((list, conversationId) => {
    list.sort(compareByPriority);
    const baselineCount = Math.min(BASELINE_PINNED_FEATURES, list.length);
    for (let index = 0; index < baselineCount; index += 1) {
      tryAdd(list[index]);
    }
    if (pinnedConversationIds.has(conversationId)) {
      list.slice(baselineCount).forEach((feature) => {
        tryAdd(feature);
      });
    }
  });
  const scored = [...features].sort(compareByPriority);
  for (const feature of scored) {
    if (keptIds.has(feature.id)) {
      continue;
    }
    const tokens = estimateFeatureTokens(feature);
    if (usedTokens + tokens > budgetTokens) {
      continue;
    }
    kept.push(feature);
    keptIds.add(feature.id);
    usedTokens += tokens;
  }
  const dropped = features.filter((feature) => !keptIds.has(feature.id));
  return {
    kept: sortChronologically(kept),
    dropped,
    usedTokens,
  };
};

const compressFeatureToLabel = (feature: Feature): void => {
  const source =
    feature.sourceConversationTitle ||
    feature.sourceConversationId ||
    'conversation';
  const trimmedSource =
    source.length > 60 ? `${source.slice(0, 57)}...` : source;
  const label = feature.topicLabel || 'Topic';
  feature.text = `${label} (${trimmedSource})`;
  refreshFeatureMetadata(feature);
};

const applyTokenGuardrails = (
  canonical: Feature[],
  uniques: Feature[],
  guardrailConfig: GuardrailConfig,
  initialTokenEstimate: number,
  onDrop?: (features: Feature[]) => void,
): { tokenEstimate: number; compression?: GuardrailCompressionReport } => {
  const limit = guardrailConfig.maxMergeTokens;
  if (limit === undefined || initialTokenEstimate <= limit) {
    return { tokenEstimate: initialTokenEstimate };
  }

  let tokenEstimate = initialTokenEstimate;
  const compression: GuardrailCompressionReport = {
    applied: false,
    truncatedFeatures: 0,
    droppedUniques: 0,
    droppedCanonicals: 0,
  };

  const caps = (guardrailConfig.wordCaps ?? []).filter(
    (cap) => Number.isFinite(cap) && cap > 0,
  );
  for (const cap of caps) {
    if (tokenEstimate <= limit) {
      break;
    }
    const truncated =
      truncateFeatureList(canonical, cap) + truncateFeatureList(uniques, cap);
    if (truncated > 0) {
      compression.applied = true;
      compression.truncatedFeatures += truncated;
      tokenEstimate = estimateTokens(canonical) + estimateTokens(uniques);
    }
  }

  if (tokenEstimate <= limit) {
    return {
      tokenEstimate,
      compression: compression.applied ? compression : undefined,
    };
  }

  let canonicalTokens = estimateTokens(canonical);
  if (canonicalTokens > limit) {
    canonical.forEach((feature) => {
      compressFeatureToLabel(feature);
    });
    canonicalTokens = estimateTokens(canonical);
    compression.applied = true;
    compression.summaryFallback = true;
    compression.notes =
      compression.notes ??
      'Canonical features collapsed to topic labels to satisfy the token guardrail.';
  }

  let uniqueBudget = Math.max(0, limit - canonicalTokens);
  let uniqueTokens = estimateTokens(uniques);
  if (uniqueTokens > uniqueBudget) {
    const { kept, dropped, usedTokens } = trimFeaturesToBudget(
      uniques,
      uniqueBudget,
    );
    replaceArrayContents(uniques, kept);
    uniqueTokens = usedTokens;
    compression.applied = true;
    compression.droppedUniques += dropped.length;
    onDrop?.(dropped);
  }

  tokenEstimate = canonicalTokens + uniqueTokens;
  if (tokenEstimate > limit) {
    const canonicalTrim = trimFeaturesToBudget(canonical, limit);
    replaceArrayContents(canonical, canonicalTrim.kept);
    canonicalTokens = canonicalTrim.usedTokens;
    compression.applied = true;
    compression.droppedCanonicals += canonicalTrim.dropped.length;
    compression.notes = compression.notes
      ? `${compression.notes} Canonical features trimmed to fit the remaining token budget.`
      : 'Canonical features trimmed to fit the remaining token budget.';

    uniqueBudget = Math.max(0, limit - canonicalTokens);
    const uniqueTrim = trimFeaturesToBudget(uniques, uniqueBudget);
    replaceArrayContents(uniques, uniqueTrim.kept);
    uniqueTokens = uniqueTrim.usedTokens;
    compression.droppedUniques += uniqueTrim.dropped.length;
    onDrop?.(uniqueTrim.dropped);

    tokenEstimate = canonicalTokens + uniqueTokens;
  }

  return {
    tokenEstimate,
    compression,
  };
};

const computeCoverage = (
  features: Feature[],
  uniques: Feature[],
  droppedCredits?: Map<string, number>,
): Record<string, CoverageStats> => {
  const coverage: Record<string, CoverageStats> = {};
  const summaryPotential = new Map<string, number>();
  const dropBudgets = droppedCredits
    ? new Map<string, number>(droppedCredits)
    : new Map<string, number>();

  const ensureStats = (conversationId: string): CoverageStats => {
    if (!coverage[conversationId]) {
      coverage[conversationId] = {
        total: 0,
        uniqueTotal: 0,
        uniqueKept: 0,
        uniqueFraction: 0,
        summaryCredits: 0,
      };
    }
    return coverage[conversationId];
  };

  features.forEach((feature) => {
    const stats = ensureStats(feature.sourceConversationId);
    stats.total += 1;
    if (feature.role === 'unique' && !isSummaryFeature(feature)) {
      stats.uniqueTotal += 1;
    } else if (feature.role === 'unique' && isSummaryFeature(feature)) {
      const credit = Math.max(1, feature.metadata.summarySourceCount ?? 1);
      summaryPotential.set(
        feature.sourceConversationId,
        (summaryPotential.get(feature.sourceConversationId) ?? 0) + credit,
      );
    }
  });

  summaryPotential.forEach((potential, conversationId) => {
    const stats = ensureStats(conversationId);
    if (stats.uniqueTotal === 0 && potential > 0) {
      stats.uniqueTotal = potential;
    }
  });

  uniques.forEach((feature) => {
    const stats = ensureStats(feature.sourceConversationId);
    if (isSummaryFeature(feature)) {
      const credit = Math.max(1, feature.metadata.summarySourceCount ?? 1);
      if (stats.uniqueTotal === 0) {
        stats.uniqueKept += credit;
        stats.summaryCredits =
          (stats.summaryCredits ?? 0) + credit;
        return;
      }
      const available = dropBudgets.get(feature.sourceConversationId) ?? 0;
      if (available <= 0) {
        return;
      }
      const applied = Math.min(credit, available);
      stats.uniqueKept += applied;
      stats.summaryCredits =
        (stats.summaryCredits ?? 0) + applied;
      dropBudgets.set(
        feature.sourceConversationId,
        Math.max(0, available - applied),
      );
    } else {
      stats.uniqueKept += 1;
    }
  });

  Object.entries(coverage).forEach(([, stats]) => {
    stats.uniqueFraction =
      stats.uniqueTotal === 0
        ? 1
        : Math.min(1, stats.uniqueKept / stats.uniqueTotal);
  });

  return coverage;
};

const aggregateCoverageStats = (
  coverage: Record<string, CoverageStats>,
): Record<string, CoverageStats> => {
  const aggregates = new Map<string, CoverageStats>();
  Object.entries(coverage).forEach(([conversationId, stats]) => {
    const parentId = getParentConversationId(conversationId);
    const current =
      aggregates.get(parentId) ?? {
        total: 0,
        uniqueTotal: 0,
        uniqueKept: 0,
        uniqueFraction: 0,
        summaryCredits: 0,
      };
    current.total += stats.total;
    current.uniqueTotal += stats.uniqueTotal;
    current.uniqueKept += stats.uniqueKept;
    current.summaryCredits =
      (current.summaryCredits ?? 0) + (stats.summaryCredits ?? 0);
    aggregates.set(parentId, current);
  });
  aggregates.forEach((stats) => {
    const denominator =
      AGGREGATE_COVERAGE_CAP > 0
        ? Math.min(stats.uniqueTotal, AGGREGATE_COVERAGE_CAP)
        : stats.uniqueTotal;
    const credited =
      stats.uniqueKept + (stats.summaryCredits ?? 0);
    const numerator = Math.min(
      Math.max(credited, Math.min(BASELINE_PINNED_FEATURES, denominator)),
      denominator,
    );
    stats.uniqueFraction =
      denominator === 0 ? 1 : Math.min(1, numerator / denominator);
  });
  return Object.fromEntries(aggregates);
};

export const selectCanonicalFeatures = (
  clusters: FeatureCluster[],
  guardrailConfig: GuardrailConfig,
): CanonicalSelection => {
  const featureIndex = byId(clusters.flatMap((cluster) => cluster.members));
  const canonical: Feature[] = [];
  const alternates: Feature[] = [];
  const uniques: Feature[] = [];
  const droppedUniqueCredits = new Map<string, number>();

  const registerDrops = (dropped: Feature[]): void => {
    dropped.forEach((feature) => {
      const id = feature.sourceConversationId;
      droppedUniqueCredits.set(
        id,
        (droppedUniqueCredits.get(id) ?? 0) + 1,
      );
    });
  };

  for (const cluster of clusters) {
    if (!cluster.members.length) {
      continue;
    }
    if (cluster.members.length === 1 || !cluster.similarityMatrix.length) {
      const only = cluster.members[0];
      if (!only) {
        continue;
      }
      only.role = 'unique';
      uniques.push(only);
      continue;
    }

    const sorted = [...cluster.members].sort(
      (a, b) => b.scores.combined - a.scores.combined,
    );
    const best = sorted[0];
    if (!best) {
      continue;
    }
    best.role = 'canonical';
    cluster.canonicalId = best.id;
    canonical.push(best);

    const rest = sorted.slice(1);
    rest.forEach((feature) => {
      feature.role = 'alternate';
      cluster.alternateIds.push(feature.id);
      alternates.push(feature);
    });
  }

  const initialTokenEstimate =
    estimateTokens(canonical) + estimateTokens(uniques);
  const guardrailResult = applyTokenGuardrails(
    canonical,
    uniques,
    guardrailConfig,
    initialTokenEstimate,
    registerDrops,
  );

  const coverage = computeCoverage(
    Array.from(featureIndex.values()),
    uniques,
    droppedUniqueCredits,
  );
  const coverageAggregates = aggregateCoverageStats(coverage);
  const coverageFailures = Object.entries(coverageAggregates)
    .filter(
      ([, stats]) => stats.uniqueFraction < guardrailConfig.minUniqueFraction,
    )
    .map(([conversationId]) => conversationId);

  const guardrails: GuardrailReport = {
    coverage,
    ...(Object.keys(coverageAggregates).length
      ? { coverageAggregates }
      : {}),
    coverageFailures,
    initialTokenEstimate,
    tokenEstimate: guardrailResult.tokenEstimate,
    tokenLimitBreached:
      guardrailConfig.maxMergeTokens !== undefined &&
      initialTokenEstimate > guardrailConfig.maxMergeTokens,
    ...(guardrailResult.compression ? { compression: guardrailResult.compression } : {}),
    ...(droppedUniqueCredits.size
      ? { droppedUniqueCredits: Object.fromEntries(droppedUniqueCredits) }
      : {}),
    ...(guardrailConfig.maxMergeTokens !== undefined
      ? { maxMergeTokens: guardrailConfig.maxMergeTokens }
      : {}),
  };

  return {
    canonical,
    alternates,
    uniques,
    guardrails,
  };
};

import type { Feature, FeatureCluster, SimilarityOptions } from './types.js';

const tokenize = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );

const computeSimilarity = (a: Feature, b: Feature): number => {
  if (!a.text || !b.text) {
    return 0;
  }
  const tokensA = tokenize(a.text);
  const tokensB = tokenize(b.text);
  const intersection = [...tokensA].filter((token) => tokensB.has(token))
    .length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : intersection / union;
};

export const buildFeatureClusters = (
  features: Feature[],
  options: SimilarityOptions,
): FeatureCluster[] => {
  const byTopic = new Map<string, FeatureCluster>();
  for (const feature of features) {
    const key = feature.topicId;
    if (!byTopic.has(key)) {
      byTopic.set(key, {
        topicId: feature.topicId,
        topicLabel: feature.topicLabel,
        members: [],
        alternateIds: [],
        similarityMatrix: [],
      });
    }
    byTopic.get(key)!.members.push(feature);
  }

  const threshold = options.similarityThreshold;
  for (const cluster of byTopic.values()) {
    const members = cluster.members;
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i];
        const b = members[j];
        if (!a || !b) {
          continue;
        }
        const score = computeSimilarity(a, b);
        if (score >= threshold) {
          cluster.similarityMatrix.push({
            aId: a.id,
            bId: b.id,
            score,
          });
        }
      }
    }
  }

  return [...byTopic.values()];
};

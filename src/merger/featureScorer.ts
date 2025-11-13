import type { Feature, FeatureScores, ScoreWeights } from './types.js';

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

const computeClarity = (feature: Feature): number => {
  const avgSentenceLength =
    feature.metadata.wordCount / feature.metadata.sentenceCount;
  return clamp(1 - Math.abs(avgSentenceLength - 18) / 24);
};

const computeEvidence = (feature: Feature): number => {
  let score = 0;
  if (feature.metadata.containsNumbers) {
    score += 0.4;
  }
  if (feature.text.includes(':') || feature.text.includes('%')) {
    score += 0.2;
  }
  if (feature.text.match(/(because|therefore|evidence|data)/i)) {
    score += 0.2;
  }
  if (feature.metadata.containsListSyntax) {
    score += 0.1;
  }
  return clamp(score);
};

const computeFreshness = (
  feature: Feature,
  newestOrder: number,
): number => {
  if (newestOrder === 0) {
    return 1;
  }
  const normalized = feature.metadata.sourceOrder / newestOrder;
  return clamp(1 - normalized * 0.6);
};

const computeAntiFrictionAlignment = (feature: Feature): number => {
  const keywords = [
    'single approver',
    'definition of done',
    'decision sla',
    'kill criteria',
    'pilot mode',
    'low friction',
  ];
  const lowered = feature.text.toLowerCase();
  const hits = keywords.filter((keyword) => lowered.includes(keyword)).length;
  return clamp(hits / keywords.length + 0.2);
};

const applyWeights = (scores: FeatureScores, weights: ScoreWeights): number =>
  clamp(
    scores.clarity * weights.clarity +
      scores.evidence * weights.evidence +
      scores.freshness * weights.freshness +
      scores.antiFriction * weights.antiFriction,
  );

export const scoreFeatures = (
  features: Feature[],
  weights: ScoreWeights,
): Feature[] => {
  const maxOrder = features.reduce(
    (acc, feature) => Math.max(acc, feature.metadata.sourceOrder),
    0,
  );
  return features.map((feature) => {
    const clarity = computeClarity(feature);
    const evidence = computeEvidence(feature);
    const freshness = computeFreshness(feature, maxOrder);
    const antiFriction = computeAntiFrictionAlignment(feature);
    const combined = applyWeights(
      {
        clarity,
        evidence,
        freshness,
        antiFriction,
        combined: 0,
      },
      weights,
    );
    feature.scores = {
      clarity,
      evidence,
      freshness,
      antiFriction,
      combined,
    };
    return feature;
  });
};

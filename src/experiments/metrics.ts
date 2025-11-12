export interface CoverageStats {
  mean: number;
  median: number;
  min: number;
  values: number[];
}

export interface TournamentScoreInput {
  t3Score: number;
  t2Scores: number[];
}

export interface ContributionInput {
  early: number[];
  late: number[];
}

export interface ConsistencyInput {
  consistentDecisions: number;
  totalExclusiveSets: number;
}

export function cosineSimilarity(vectorA: number[], vectorB: number[]): number {
  if (!vectorA.length || vectorA.length !== vectorB.length) {
    throw new Error('cosineSimilarity requires equal-length vectors.');
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < vectorA.length; i += 1) {
    const a = vectorA[i]!;
    const b = vectorB[i]!;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }
  if (!magA || !magB) {
    return 0;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function computePSI(embeddings: number[][]): number {
  if (embeddings.length < 2) {
    throw new Error('PSI requires at least two embeddings.');
  }
  let sum = 0;
  let count = 0;
  for (let i = 0; i < embeddings.length - 1; i += 1) {
    for (let j = i + 1; j < embeddings.length; j += 1) {
      const first = embeddings[i];
      const second = embeddings[j];
      if (!first || !second) {
        continue;
      }
      sum += cosineSimilarity(first, second);
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

export function computeOSS(params: {
  balanced: number[];
  leftSkew: number[];
  rightSkew: number[];
}): number {
  const simBL = cosineSimilarity(params.balanced, params.leftSkew);
  const simBR = cosineSimilarity(params.balanced, params.rightSkew);
  const simLR = cosineSimilarity(params.leftSkew, params.rightSkew);
  const average = (simBL + simBR + simLR) / 3;
  return 1 - average;
}

export function computeGIG(input: TournamentScoreInput): number {
  if (!input.t2Scores.length) {
    throw new Error('At least one T2 score is required to compute GIG.');
  }
  const bestPair = Math.max(...input.t2Scores);
  return input.t3Score - bestPair;
}

export function computeCoverageStats(values: number[]): CoverageStats {
  if (!values.length) {
    throw new Error('Coverage stats require at least one value.');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  const midIndex = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2
      ? sorted[midIndex]!
      : (sorted[midIndex - 1]! + sorted[midIndex]!) / 2;
  return {
    mean,
    median,
    min: sorted[0]!,
    values: sorted,
  };
}

export function computeEMB(input: ContributionInput): number {
  if (!input.early.length || !input.late.length) {
    throw new Error('EMB requires both early and late contribution arrays.');
  }
  const earlyMean =
    input.early.reduce((total, value) => total + value, 0) / input.early.length;
  const lateMean =
    input.late.reduce((total, value) => total + value, 0) / input.late.length;
  return earlyMean - lateMean;
}

export function computeMERS(input: ConsistencyInput): number {
  if (input.totalExclusiveSets <= 0) {
    throw new Error('totalExclusiveSets must be positive for MERS.');
  }
  const clamped = Math.min(
    Math.max(input.consistentDecisions, 0),
    input.totalExclusiveSets,
  );
  return clamped / input.totalExclusiveSets;
}

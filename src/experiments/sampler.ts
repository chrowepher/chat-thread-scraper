import crypto from 'node:crypto';
import type { SamplingPolicy, TreeShape } from './runner.js';

export interface SamplingOptions {
  threads: string[];
  k: number;
  policy: SamplingPolicy;
  treeShapes: TreeShape[];
  subsetSize?: number;
  seed?: number;
}

export interface PermutationPlan {
  order: string[];
  treeShapes: TreeShape[];
  permId: string;
}

export function generatePermutationPlans(options: SamplingOptions): PermutationPlan[] {
  if (!options.threads.length) {
    throw new Error('At least one thread is required to sample permutations.');
  }
  if (options.k <= 0) {
    throw new Error('k must be positive for permutation sampling.');
  }
  if (options.policy === 'bracket') {
    throw new Error('Bracket policy is not handled by permutation sampler.');
  }

  const rng = createRng(options.seed ?? 42);
  const plans =
    options.policy === 'k-diverse'
      ? sampleDiverse(options, rng)
      : sampleRandom(options, rng);

  return plans.map((plan) => ({
    ...plan,
    permId: createPermId(plan.order, options.treeShapes, options.seed),
    treeShapes: options.treeShapes,
  }));
}

function sampleRandom(
  options: SamplingOptions,
  rng: () => number,
): Array<Omit<PermutationPlan, 'permId'>> {
  const plans: Array<Omit<PermutationPlan, 'permId'>> = [];
  const seen = new Set<string>();
  while (plans.length < options.k) {
    const order = selectSubset(options.threads, options.subsetSize, rng);
    const key = order.join('>');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    plans.push({ order, treeShapes: options.treeShapes });
  }
  return plans;
}

function sampleDiverse(
  options: SamplingOptions,
  rng: () => number,
): Array<Omit<PermutationPlan, 'permId'>> {
  const plans: string[][] = [];
  const seen = new Set<string>();
  const maxIterations = options.k * 20;

  while (plans.length < options.k && plans.length < factorial(options.threads.length)) {
    let bestCandidate: string[] | undefined;
    let bestScore = -1;

    for (let attempt = 0; attempt < maxIterations; attempt += 1) {
      const candidate = selectSubset(options.threads, options.subsetSize, rng);
      const key = candidate.join('>');
      if (seen.has(key)) {
        continue;
      }
      if (plans.length === 0) {
        bestCandidate = candidate;
        bestScore = Number.POSITIVE_INFINITY;
        break;
      }
      const distance = minDistance(candidate, plans);
      if (distance > bestScore) {
        bestScore = distance;
        bestCandidate = candidate;
      }
      if (distance === 1) {
        break;
      }
    }

    if (!bestCandidate) {
      break;
    }
    plans.push(bestCandidate);
    seen.add(bestCandidate.join('>'));
  }

  return plans.map((order) => ({ order, treeShapes: options.treeShapes }));
}

function selectSubset(
  threads: string[],
  subsetSize: number | undefined,
  rng: () => number,
): string[] {
  const shuffled = shuffle(threads, rng);
  if (subsetSize && subsetSize > 0 && subsetSize < shuffled.length) {
    return shuffled.slice(0, subsetSize);
  }
  return shuffled;
}

function shuffle<T>(input: T[], rng: () => number): T[] {
  const result = [...input];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const current = result[i]!;
    const swap = result[j]!;
    result[i] = swap;
    result[j] = current;
  }
  return result;
}

function minDistance(candidate: string[], existing: string[][]): number {
  const distances = existing.map((perm) =>
    normalizedKendallTau(candidate, perm),
  );
  return Math.min(...distances);
}

function normalizedKendallTau(a: string[], b: string[]): number {
  if (a.length !== b.length) {
    throw new Error('Kendall-tau distance requires equal-length permutations.');
  }
  const indexMap = new Map<string, number>();
  b.forEach((value, index) => {
    indexMap.set(value, index);
  });
  let discordant = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = i + 1; j < a.length; j += 1) {
      const leftValue = a[i];
      const rightValue = a[j];
      if (leftValue === undefined || rightValue === undefined) {
        continue;
      }
      const first = indexMap.get(leftValue);
      const second = indexMap.get(rightValue);
      if (first === undefined || second === undefined) {
        continue;
      }
      if (first > second) {
        discordant += 1;
      }
    }
  }
  const totalPairs = (a.length * (a.length - 1)) / 2;
  return totalPairs === 0 ? 0 : discordant / totalPairs;
}

function factorial(n: number): number {
  let result = 1;
  for (let i = 2; i <= n; i += 1) {
    result *= i;
    if (result > Number.MAX_SAFE_INTEGER / 2) {
      break;
    }
  }
  return result;
}

function createPermId(
  order: string[],
  treeShapes: TreeShape[],
  seed?: number,
): string {
  const hash = crypto.createHash('sha1');
  hash.update(order.join('>'));
  hash.update('|');
  hash.update(treeShapes.join(','));
  hash.update('|');
  hash.update(String(seed ?? ''));
  return hash.digest('hex').slice(0, 8);
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

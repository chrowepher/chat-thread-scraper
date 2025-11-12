import { describe, expect, it } from 'vitest';
import { generatePermutationPlans } from '../../src/experiments/sampler.js';

const TREE_SHAPES = ['balanced', 'left-skew', 'right-skew'] as const;

describe('permutation sampler', () => {
  it('generates deterministic k-random permutations', () => {
    const options = {
      threads: ['A', 'B', 'C', 'D'],
      k: 3,
      policy: 'k-random' as const,
      treeShapes: [...TREE_SHAPES],
      seed: 7,
    };
    const first = generatePermutationPlans(options);
    const second = generatePermutationPlans(options);
    expect(second).toEqual(first);
    expect(first).toHaveLength(3);
    expect(new Set(first.map((plan) => plan.permId)).size).toBe(3);
  });

  it('generates diverse permutations with non-zero distances', () => {
    const options = {
      threads: ['A', 'B', 'C', 'D'],
      k: 3,
      policy: 'k-diverse' as const,
      treeShapes: [...TREE_SHAPES],
      seed: 11,
    };
    const plans = generatePermutationPlans(options);
    expect(plans).toHaveLength(3);
    const orders = plans.map((plan) => plan.order);

    for (let i = 0; i < orders.length - 1; i += 1) {
      for (let j = i + 1; j < orders.length; j += 1) {
        expect(kendallTau(orders[i], orders[j])).toBeGreaterThan(0);
      }
    }
  });

  it('respects subset size when sampling permutations', () => {
    const options = {
      threads: ['A', 'B', 'C', 'D', 'E'],
      k: 2,
      policy: 'k-random' as const,
      treeShapes: [...TREE_SHAPES],
      subsetSize: 3,
      seed: 3,
    };
    const plans = generatePermutationPlans(options);
    expect(plans).toHaveLength(2);
    plans.forEach((plan) => {
      expect(plan.order).toHaveLength(3);
    });
  });
});

function kendallTau(a: string[], b: string[]): number {
  expect(a).toHaveLength(b.length);
  let discordant = 0;
  const indexMap = new Map<string, number>();
  b.forEach((value, index) => indexMap.set(value, index));
  for (let i = 0; i < a.length; i += 1) {
    for (let j = i + 1; j < a.length; j += 1) {
      const first = indexMap.get(a[i]) ?? 0;
      const second = indexMap.get(a[j]) ?? 0;
      if (first > second) {
        discordant += 1;
      }
    }
  }
  const totalPairs = (a.length * (a.length - 1)) / 2;
  return totalPairs === 0 ? 0 : discordant / totalPairs;
}

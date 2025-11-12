import { describe, expect, it } from 'vitest';
import {
  computeCoverageStats,
  computeEMB,
  computeGIG,
  computeMERS,
  computeOSS,
  computePSI,
  cosineSimilarity,
} from '../../src/experiments/metrics.js';

describe('metrics utilities', () => {
  it('computes cosine similarity', () => {
    const result = cosineSimilarity([1, 0], [0, 1]);
    expect(result).toBeCloseTo(0, 6);
  });

  it('computes PSI across permutations', () => {
    const psi = computePSI([
      [1, 0],
      [0.5, 0.5],
      [0, 1],
    ]);
    expect(psi).toBeGreaterThan(0);
    expect(psi).toBeLessThan(1);
  });

  it('computes OSS from tree shape similarities', () => {
    const oss = computeOSS({
      balanced: [1, 0],
      leftSkew: [1, 0],
      rightSkew: [0, 1],
    });
    expect(oss).toBeCloseTo(1 - (1 + 0 + 0) / 3, 6);
  });

  it('computes GIG deltas', () => {
    const gig = computeGIG({
      t3Score: 32,
      t2Scores: [29, 27, 30],
    });
    expect(gig).toBe(2);
  });

  it('computes coverage summary statistics', () => {
    const cai = computeCoverageStats([0.9, 0.6, 0.75]);
    expect(cai.mean).toBeCloseTo((0.9 + 0.6 + 0.75) / 3, 6);
    expect(cai.median).toBe(0.75);
    expect(cai.min).toBe(0.6);
  });

  it('computes early-merge bias delta', () => {
    const emb = computeEMB({
      early: [0.4, 0.5],
      late: [0.6, 0.55],
    });
    expect(emb).toBeCloseTo(0.45 - 0.575, 6);
  });

  it('computes MERS consistency', () => {
    const mers = computeMERS({
      consistentDecisions: 6,
      totalExclusiveSets: 8,
    });
    expect(mers).toBeCloseTo(0.75, 6);
  });
});

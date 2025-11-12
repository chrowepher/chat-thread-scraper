import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MetricsRecorder } from '../../src/experiments/metricsRecorder.js';

describe('MetricsRecorder', () => {
  it('records permutations, OSS, GIG, CAI, EMB, and MERS', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'metrics-recorder-'));
    const recorder = await MetricsRecorder.load(dir, 'exp-test');

    const psi = recorder.recordPermutation({
      permId: 'perm-1',
      embeddings: [
        [1, 0],
        [0, 1],
      ],
      treeShape: 'balanced',
    });
    expect(psi).toBeGreaterThanOrEqual(0);

    const oss = recorder.recordTreeShapeSet({
      label: 'core-set',
      balanced: [1, 0],
      leftSkew: [1, 0],
      rightSkew: [0, 1],
    });
    expect(oss).toBeGreaterThanOrEqual(0);

    const gig = recorder.recordGig({
      triple: ['A', 'B', 'C'],
      t3Score: 31,
      t2Scores: [29, 30, 28],
    });
    expect(gig).toBe(1);

    const coverage = recorder.recordCoverage({
      label: 'T2-seed-11',
      coverages: [0.8, 0.7, 0.9],
    });
    expect(coverage.mean).toBeCloseTo((0.8 + 0.7 + 0.9) / 3, 6);

    const emb = recorder.recordEmb({
      label: 'bias-check',
      early: [0.4, 0.5],
      late: [0.55, 0.6],
    });
    expect(emb).toBeLessThan(0);

    const mers = recorder.recordMers({
      consistent: 6,
      total: 8,
    });
    expect(mers).toBeCloseTo(0.75, 6);

    await recorder.save();
    const metricsPath = path.join(dir, 'metrics.json');
    const saved = JSON.parse(await readFile(metricsPath, 'utf-8'));

    expect(saved.permutations).toHaveLength(1);
    expect(saved.oss).toHaveLength(1);
    expect(saved.gig).toHaveLength(1);
    expect(saved.cai).toHaveLength(1);
    expect(saved.emb).toHaveLength(1);
    expect(saved.mers.value).toBeCloseTo(0.75, 6);
  });
});

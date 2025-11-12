import { describe, expect, it } from 'vitest';
import {
  CoverageAnalyzer,
  extractKeyPoints,
} from '../../src/experiments/coverageAnalyzer.js';

describe('CoverageAnalyzer', () => {
  it('extracts key points above minimum length', () => {
    const points = extractKeyPoints('Short.\nThis is a much longer sentence worth keeping.', 10);
    expect(points).toEqual(['This is a much longer sentence worth keeping.']);
  });

  it('computes per-source coverage ratios', () => {
    const analyzer = new CoverageAnalyzer({ minKeyPointLength: 5 });
    const sources = [
      {
        id: 'A',
        content: 'Point one.\nPoint two survives.',
      },
      {
        id: 'B',
        content: 'Another insight worth keeping.',
      },
    ];
    const output = 'Point two survives. Another insight worth keeping.';
    const result = analyzer.analyze(sources, output);
    expect(result.perSource).toHaveLength(2);
    const coverageA = result.perSource.find((entry) => entry.sourceId === 'A');
    const coverageB = result.perSource.find((entry) => entry.sourceId === 'B');
    expect(coverageA?.coverage).toBeCloseTo(0.5, 6);
    expect(coverageB?.coverage).toBe(1);
    expect(result.stats?.mean).toBeCloseTo((0.5 + 1) / 2, 6);
  });
});

import { computeCoverageStats, type CoverageStats } from './metrics.js';

export interface CoverageSource {
  id: string;
  content: string;
  label?: string;
}

export interface CoverageOptions {
  minKeyPointLength?: number;
  caseSensitive?: boolean;
}

export interface SourceCoverage {
  sourceId: string;
  label?: string;
  keyPoints: string[];
  covered: string[];
  coverage: number;
}

export interface CoverageAnalysis {
  perSource: SourceCoverage[];
  stats: CoverageStats | null;
}

const DEFAULT_MIN_LENGTH = 20;

export class CoverageAnalyzer {
  private readonly minLength: number;

  private readonly caseSensitive: boolean;

  constructor(options: CoverageOptions = {}) {
    this.minLength = Math.max(
      options.minKeyPointLength ?? DEFAULT_MIN_LENGTH,
      5,
    );
    this.caseSensitive = Boolean(options.caseSensitive);
  }

  analyze(
    sources: CoverageSource[],
    output: string,
  ): CoverageAnalysis {
    if (!sources.length) {
      return { perSource: [], stats: null };
    }
    const normalizedOutput = this.caseSensitive
      ? output
      : output.toLowerCase();

    const perSource: SourceCoverage[] = sources.map((source) => {
      const keyPoints = extractKeyPoints(source.content, this.minLength);
      const covered = keyPoints.filter((kp) =>
        this.isCovered(kp, normalizedOutput),
      );
      const coverage =
        keyPoints.length === 0 ? 0 : covered.length / keyPoints.length;
      return {
        sourceId: source.id,
        keyPoints,
        covered,
        coverage,
        ...(source.label ? { label: source.label } : {}),
      };
    });

    const coverageValues = perSource.map((entry) => entry.coverage);
    const stats =
      coverageValues.length > 0
        ? computeCoverageStats(coverageValues)
        : null;

    return { perSource, stats };
  }

  private isCovered(keyPoint: string, output: string): boolean {
    if (!keyPoint) {
      return false;
    }
    const haystack = this.caseSensitive ? output : output.toLowerCase();
    const needle = this.caseSensitive ? keyPoint : keyPoint.toLowerCase();
    return haystack.includes(needle);
  }
}

export function extractKeyPoints(
  content: string,
  minLength: number = DEFAULT_MIN_LENGTH,
): string[] {
  return content
    .split(/[\r\n]+|(?<=[.!?])\s+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= minLength);
}

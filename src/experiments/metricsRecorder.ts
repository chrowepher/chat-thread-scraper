import fs from 'node:fs/promises';
import path from 'node:path';
import type { TreeShape } from './runner.js';
import {
  computeCoverageStats,
  computeEMB,
  computeGIG,
  computeMERS,
  computeOSS,
  computePSI,
} from './metrics.js';

export interface PermutationMetricInput {
  permId: string;
  embeddings: number[][];
  treeShape?: TreeShape;
  status?: string;
  notes?: string;
}

export interface TreeShapeMetricInput {
  label: string;
  balanced: number[];
  leftSkew: number[];
  rightSkew: number[];
  notes?: string;
}

export interface GigMetricInput {
  triple: string[];
  t3Score: number;
  t2Scores: number[];
  notes?: string;
}

export interface CoverageMetricInput {
  label: string;
  coverages: number[];
  notes?: string;
}

export interface EmbMetricInput {
  label: string;
  early: number[];
  late: number[];
  notes?: string;
}

export interface MersInput {
  consistent: number;
  total: number;
  notes?: string;
}

interface MetricsFile {
  runId: string;
  createdAt: string;
  updatedAt: string;
  permutations: Array<{
    permId: string;
    psi: number;
    sampleCount: number;
    treeShape?: TreeShape;
    status?: string;
    notes?: string;
  }>;
  oss: Array<{
    label: string;
    oss: number;
    notes?: string;
  }>;
  tournaments: unknown[];
  gig: Array<{
    triple: string[];
    t3Score: number;
    bestPair: number;
    gig: number;
    notes?: string;
  }>;
  cai: Array<{
    label: string;
    mean: number;
    median: number;
    min: number;
    values: number[];
    notes?: string;
  }>;
  emb: Array<{
    label: string;
    delta: number;
    earlyMean: number;
    lateMean: number;
    notes?: string;
  }>;
  mers: {
    value: number;
    consistent: number;
    total: number;
    notes?: string;
  } | null;
  notes?: string;
}

const METRICS_FILENAME = 'metrics.json';

export class MetricsRecorder {
  private readonly filePath: string;

  private data: MetricsFile;

  private constructor(filePath: string, data: MetricsFile) {
    this.filePath = filePath;
    this.data = data;
  }

  static async load(runDir: string, runId: string): Promise<MetricsRecorder> {
    const filePath = path.resolve(runDir, METRICS_FILENAME);
    let data: MetricsFile;
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      data = JSON.parse(raw) as MetricsFile;
    } catch (error) {
      data = {
        runId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        permutations: [],
        oss: [],
        tournaments: [],
        gig: [],
        cai: [],
        emb: [],
        mers: null,
        notes: 'Metrics initialized. Awaiting experiment data.',
      };
    }
    return new MetricsRecorder(filePath, data);
  }

  recordPermutation(input: PermutationMetricInput): number {
    const psi = computePSI(input.embeddings);
    this.data.permutations.push({
      permId: input.permId,
      psi,
      sampleCount: input.embeddings.length,
      ...(input.treeShape !== undefined ? { treeShape: input.treeShape } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    this.touch();
    return psi;
  }

  recordTreeShapeSet(input: TreeShapeMetricInput): number {
    const oss = computeOSS({
      balanced: input.balanced,
      leftSkew: input.leftSkew,
      rightSkew: input.rightSkew,
    });
    this.data.oss.push({
      label: input.label,
      oss,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    this.touch();
    return oss;
  }

  recordGig(input: GigMetricInput): number {
    const gig = computeGIG({
      t3Score: input.t3Score,
      t2Scores: input.t2Scores,
    });
    this.data.gig.push({
      triple: input.triple,
      t3Score: input.t3Score,
      bestPair: Math.max(...input.t2Scores),
      gig,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    this.touch();
    return gig;
  }

  recordCoverage(input: CoverageMetricInput) {
    const stats = computeCoverageStats(input.coverages);
    this.data.cai.push({
      label: input.label,
      ...stats,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    this.touch();
    return stats;
  }

  recordEmb(input: EmbMetricInput): number {
    const delta = computeEMB({
      early: input.early,
      late: input.late,
    });
    const earlyMean =
      input.early.reduce((total, value) => total + value, 0) / input.early.length;
    const lateMean =
      input.late.reduce((total, value) => total + value, 0) / input.late.length;
    this.data.emb.push({
      label: input.label,
      delta,
      earlyMean,
      lateMean,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    this.touch();
    return delta;
  }

  recordMers(input: MersInput): number {
    const value = computeMERS({
      consistentDecisions: input.consistent,
      totalExclusiveSets: input.total,
    });
    this.data.mers = {
      value,
      consistent: input.consistent,
      total: input.total,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };
    this.touch();
    return value;
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(
      this.filePath,
      JSON.stringify(this.data, null, 2),
      'utf-8',
    );
  }

  get snapshot(): MetricsFile {
    return this.data;
  }

  private touch() {
    this.data.updatedAt = new Date().toISOString();
  }
}

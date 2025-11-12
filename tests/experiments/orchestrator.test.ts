import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExperimentOrchestrator } from '../../src/experiments/orchestrator.js';
import {
  EmbeddingService,
  type EmbeddingProvider,
} from '../../src/experiments/embeddingService.js';
import { CoverageAnalyzer } from '../../src/experiments/coverageAnalyzer.js';
import { MergeExecutor } from '../../src/experiments/mergeExecutor.js';
import type { MergeOptions, MergeResult } from '../../src/openaiMerge.js';
import type { CritiqueRunner } from '../../src/experiments/critiqueRunner.js';

describe('ExperimentOrchestrator', () => {
  it('loads schedule/manifest and lists tasks', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-'));
    const schedule = {
      runId: 'exp-abc',
      plan: 'planB',
      branchCount: 'T2',
      samplePolicy: 'k-diverse',
      sampleK: 5,
      treeShapes: ['balanced', 'left-skew', 'right-skew'],
      calcMetrics: true,
      threadCount: 12,
      priorities: ['coherence'],
      stabilityThreshold: 0.92,
      permutationRequests: [
        {
          policy: 'k-diverse',
          count: 5,
          treeShapes: ['balanced', 'left-skew', 'right-skew'],
          notes: 'Permutation probe',
        },
      ],
      tournamentRequests: [
        {
          label: 'T2-seed-11',
          branchCount: 'T2',
          route: 'T2',
          seed: 11,
          description: 'Baseline bracket',
        },
      ],
      comparisonRequests: [
        {
          label: 'T2-vs-T3',
          description: 'Compare champions',
          notes: 'Requires critiques',
        },
      ],
    };
    const manifest = {
      runId: 'exp-abc',
      inputs: {
        threads: ['a.md', 'b.md'],
      },
      parameters: {
        branchCount: 'T2',
      },
    };
    await writeFile(
      path.join(dir, 'schedule.json'),
      JSON.stringify(schedule, null, 2),
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    const orchestrator = await ExperimentOrchestrator.load(dir);
    expect(orchestrator.runId).toBe('exp-abc');
    expect(orchestrator.threads).toHaveLength(2);

    const tasks = orchestrator.listTasks();
    expect(tasks).toHaveLength(3);
    expect(tasks.filter((task) => task.type === 'permutation')).toHaveLength(1);
    expect(tasks.filter((task) => task.type === 'tournament')).toHaveLength(1);
    expect(tasks.filter((task) => task.type === 'comparison')).toHaveLength(1);
  });

  it('executes permutation tasks and records metrics', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-exec-'));
    const threadA = path.join(dir, 'A.md');
    const threadB = path.join(dir, 'B.md');
    await writeFile(threadA, 'Point one.\nPoint two survives.', 'utf-8');
    await writeFile(threadB, 'Another insight worth keeping.', 'utf-8');

    const schedule = {
      runId: 'exp-xyz',
      plan: 'planC',
      branchCount: 'T2',
      samplePolicy: 'k-random',
      sampleK: 2,
      treeShapes: ['balanced', 'left-skew', 'right-skew'],
      calcMetrics: true,
      threadCount: 2,
      priorities: [],
      stabilityThreshold: 0.92,
      permutationRequests: [
        {
          policy: 'k-random',
          count: 2,
          treeShapes: ['balanced', 'left-skew', 'right-skew'],
        },
      ],
      tournamentRequests: [],
      comparisonRequests: [],
    };
    const manifest = {
      runId: 'exp-xyz',
      inputs: {
        threads: [threadA, threadB],
      },
    };
    await writeFile(
      path.join(dir, 'schedule.json'),
      JSON.stringify(schedule, null, 2),
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    const orchestrator = await ExperimentOrchestrator.load(dir);
    const embeddingService = new EmbeddingService({
      provider: new StubEmbeddingProvider(),
    });
    const coverageAnalyzer = new CoverageAnalyzer({
      minKeyPointLength: 5,
    });
    const mergeFn = async (options: MergeOptions): Promise<MergeResult> => ({
      summary: `Merged ${options.branches.map((b) => b.title).join(' + ')}`,
      combinedPath: [],
      mergeDecisions: [],
    });
    const mergeExecutor = new MergeExecutor({ mergeFn });

    const summary = await orchestrator.executePermutationTasks({
      embeddingService,
      coverageAnalyzer,
      executor: mergeExecutor,
    });
    expect(summary.planCount).toBe(2);

    const metrics = JSON.parse(
      await readFile(path.join(dir, 'metrics.json'), 'utf-8'),
    );
    expect(metrics.permutations).toHaveLength(1);
    expect(metrics.cai.length).toBeGreaterThanOrEqual(3);
    const lineage = JSON.parse(
      await readFile(path.join(dir, 'lineage.json'), 'utf-8'),
    );
    expect(lineage.entries.some((entry: { kind: string }) => entry.kind === 'permutation')).toBeTruthy();
  });

  it('executes tournament tasks via merge executor', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-tournament-'));
    const threadA = path.join(dir, 'A.md');
    const threadB = path.join(dir, 'B.md');
    const threadC = path.join(dir, 'C.md');
    await writeFile(threadA, 'Alpha content', 'utf-8');
    await writeFile(threadB, 'Beta content', 'utf-8');
    await writeFile(threadC, 'Gamma content', 'utf-8');

    const schedule = {
      runId: 'exp-tournament',
      plan: 'planA',
      branchCount: 'T2',
      samplePolicy: 'k-random',
      sampleK: 2,
      treeShapes: ['balanced', 'left-skew', 'right-skew'],
      calcMetrics: true,
      threadCount: 3,
      priorities: [],
      stabilityThreshold: 0.92,
      permutationRequests: [],
      tournamentRequests: [
        {
          label: 'T2-seed-11',
          branchCount: 'T2',
          route: 'T2',
          seed: 11,
        },
      ],
      comparisonRequests: [],
    };
    const manifest = {
      runId: 'exp-tournament',
      inputs: {
        threads: [threadA, threadB, threadC],
      },
    };
    await writeFile(
      path.join(dir, 'schedule.json'),
      JSON.stringify(schedule, null, 2),
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    const orchestrator = await ExperimentOrchestrator.load(dir);
    const mergeFn = async (options: MergeOptions): Promise<MergeResult> => ({
      summary: `Merged ${options.branches.map((b) => b.title).join(' + ')}`,
      combinedPath: [],
      mergeDecisions: [],
    });
    const executor = new MergeExecutor({ mergeFn });
    const coverageAnalyzer = new CoverageAnalyzer({
      minKeyPointLength: 5,
    });

    const summary = await orchestrator.executeTournamentTasks({
      executor,
      coverageAnalyzer,
    });
    expect(summary.mergeCount).toBeGreaterThanOrEqual(2);

    const metrics = JSON.parse(
      await readFile(path.join(dir, 'metrics.json'), 'utf-8'),
    );
    expect(metrics.cai.some((entry: { label: string }) => entry.label.includes('champion'))).toBeTruthy();
    const lineage = JSON.parse(
      await readFile(path.join(dir, 'lineage.json'), 'utf-8'),
    );
    expect(lineage.entries.some((entry: { kind: string }) => entry.kind === 'tournament')).toBeTruthy();
  });

  it('executes comparison tasks and records gig metrics', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-comparison-'));
    const threadA = path.join(dir, 'A.md');
    const threadB = path.join(dir, 'B.md');
    const threadC = path.join(dir, 'C.md');
    await writeFile(threadA, 'Alpha content', 'utf-8');
    await writeFile(threadB, 'Beta content', 'utf-8');
    await writeFile(threadC, 'Gamma content', 'utf-8');

    const schedule = {
      runId: 'exp-comparison',
      plan: 'planB',
      branchCount: 'T2',
      samplePolicy: 'k-random',
      sampleK: 2,
      treeShapes: ['balanced', 'left-skew', 'right-skew'],
      calcMetrics: true,
      threadCount: 3,
      priorities: [],
      stabilityThreshold: 0.92,
      permutationRequests: [],
      tournamentRequests: [
        {
          label: 'T3-groups',
          branchCount: 'T3',
          route: 'T3',
        },
        {
          label: 'T2-parallel',
          branchCount: 'T2',
          route: 'T2',
        },
      ],
      comparisonRequests: [
        {
          label: 'T2-vs-T3',
          description: 'Compare champions',
          leftTournament: 'T3-groups',
          rightTournament: 'T2-parallel',
        },
      ],
    };
    const manifest = {
      runId: 'exp-comparison',
      inputs: {
        threads: [threadA, threadB, threadC],
      },
    };
    await writeFile(
      path.join(dir, 'schedule.json'),
      JSON.stringify(schedule, null, 2),
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    const orchestrator = await ExperimentOrchestrator.load(dir);
    const mergeFn = async (options: MergeOptions): Promise<MergeResult> => ({
      summary: `Merged ${options.branches.map((b) => b.title).join(' + ')}`,
      combinedPath: [],
      mergeDecisions: [],
    });
    const executor = new MergeExecutor({ mergeFn });
    const coverageAnalyzer = new CoverageAnalyzer({
      minKeyPointLength: 5,
    });
    await orchestrator.executeTournamentTasks({
      executor,
      coverageAnalyzer,
    });

    const comparisonSummary = await orchestrator.executeComparisonTasks({
      critiqueRunner: new StubCritiqueRunner(),
    });
    expect(comparisonSummary.completed).toBe(1);

    const metrics = JSON.parse(
      await readFile(path.join(dir, 'metrics.json'), 'utf-8'),
    );
    expect(metrics.gig).toHaveLength(1);

    const comparisonDir = path.join(
      dir,
      'comparisons',
      sanitize('T2-vs-T3'),
    );
    const files = await readdir(comparisonDir);
    expect(files.length).toBeGreaterThan(0);
  });
});

class StubEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text, index) => [text.length + index]);
  }
}

class StubCritiqueRunner implements CritiqueRunner {
  async runComparison(options: {
    label: string;
    leftPath: string;
    rightPath: string;
    outputDir: string;
  }) {
    await mkdir(options.outputDir, { recursive: true });
    await writeFile(
      path.join(options.outputDir, `${sanitize(options.label)}.critique.md`),
      'Stub critique',
      'utf-8',
    );
    const scorecardPath = path.join(
      options.outputDir,
      `${sanitize(options.label)}.scorecard.json`,
    );
    await writeFile(
      scorecardPath,
      JSON.stringify({
        left: 5,
        right: 3,
      }),
      'utf-8',
    );
    return {
      leftScore: 5,
      rightScore: 3,
      markdownPath: path.join(
        options.outputDir,
        `${sanitize(options.label)}.critique.md`,
      ),
      scorecardPath,
    };
  }
}

const sanitize = (label: string) =>
  label.replace(/[^a-z0-9-_]/gi, '_').replace(/_+/g, '_');

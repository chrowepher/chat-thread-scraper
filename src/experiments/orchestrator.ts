import fs from 'node:fs/promises';
import path from 'node:path';
import { MetricsRecorder } from './metricsRecorder.js';
import { LineageRecorder } from './lineageRecorder.js';
import type { LineageEntry } from './lineageRecorder.js';
import type { ExperimentSchedule, PermutationRequest } from './runner.js';
import {
  generatePermutationPlans,
  type PermutationPlan,
  type SamplingOptions,
} from './sampler.js';
import type { TreeShape } from './runner.js';
import type { CoverageSource } from './coverageAnalyzer.js';
import { CoverageAnalyzer } from './coverageAnalyzer.js';
import { EmbeddingService } from './embeddingService.js';
import { MergeExecutor } from './mergeExecutor.js';
import type { CritiqueRunner } from './critiqueRunner.js';

interface ExperimentManifest {
  runId: string;
  createdAt?: string;
  description?: string;
  inputs?: {
    threads?: string[];
    signature?: string;
  };
  parameters?: Record<string, unknown>;
}

export type ExperimentTask =
  | {
      type: 'permutation';
      policy: PermutationRequest['policy'];
      count: number;
      treeShapes: string[];
      subsetSize?: number;
      notes?: string;
      index: number;
    }
  | {
      type: 'tournament';
      label: string;
      branchCount: string;
      route: string;
      seed?: number;
      description?: string;
      index: number;
    }
  | {
      type: 'comparison';
      label: string;
      description: string;
      notes?: string;
      index: number;
    };

export class ExperimentOrchestrator {
  private readonly runDir: string;

  private readonly schedule: ExperimentSchedule;

  private readonly manifest: ExperimentManifest;

  private readonly metrics: MetricsRecorder;

  private readonly lineage: LineageRecorder;

  private readonly tournamentChampions = new Map<string, ChampionRecord>();

  private defaultComparisonPromptPath?: string;

  private threadCache?: Map<string, string>;

  private constructor(options: {
    runDir: string;
    schedule: ExperimentSchedule;
    manifest: ExperimentManifest;
    metrics: MetricsRecorder;
    lineage: LineageRecorder;
  }) {
    this.runDir = options.runDir;
    this.schedule = options.schedule;
    this.manifest = options.manifest;
    this.metrics = options.metrics;
    this.lineage = options.lineage;
  }

  static async load(runDir: string): Promise<ExperimentOrchestrator> {
    const resolved = path.resolve(runDir);
    const [schedule, manifest] = await Promise.all([
      readJson<ExperimentSchedule>(path.join(resolved, 'schedule.json')),
      readJson<ExperimentManifest>(path.join(resolved, 'manifest.json')),
    ]);
    if (!schedule?.runId) {
      throw new Error('Schedule file is missing runId.');
    }
    const manifestRunId = manifest?.runId ?? schedule.runId;
    if (manifestRunId !== schedule.runId) {
      throw new Error(
        `Manifest runId (${manifestRunId}) does not match schedule runId (${schedule.runId}).`,
      );
    }
    const metrics = await MetricsRecorder.load(resolved, schedule.runId);
    const lineage = await LineageRecorder.load(
      resolved,
      schedule.runId,
      schedule.branchCount ?? 'T2',
    );
    return new ExperimentOrchestrator({
      runDir: resolved,
      schedule,
      manifest,
      metrics,
      lineage,
    });
  }

  listTasks(): ExperimentTask[] {
    const tasks: ExperimentTask[] = [];
    this.schedule.permutationRequests.forEach((request, index) => {
      const task: ExperimentTask = {
        type: 'permutation',
        policy: request.policy,
        count: request.count,
        treeShapes: request.treeShapes,
        index,
        ...(request.subsetSize !== undefined
          ? { subsetSize: request.subsetSize }
          : {}),
        ...(request.notes !== undefined ? { notes: request.notes } : {}),
      };
      tasks.push(task);
    });
    this.schedule.tournamentRequests.forEach((request, index) => {
      const task: ExperimentTask = {
        type: 'tournament',
        label: request.label,
        branchCount: request.branchCount,
        route: request.route,
        index,
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
        ...(request.description !== undefined
          ? { description: request.description }
          : {}),
      };
      tasks.push(task);
    });
    this.schedule.comparisonRequests.forEach((request, index) => {
      const task: ExperimentTask = {
        type: 'comparison',
        label: request.label,
        description: request.description,
        index,
        ...(request.notes !== undefined ? { notes: request.notes } : {}),
      };
      tasks.push(task);
    });
    return tasks;
  }

  get runId(): string {
    return this.schedule.runId;
  }

  get threads(): string[] {
    return this.manifest.inputs?.threads ?? [];
  }

  get description(): string | undefined {
    return this.manifest.description;
  }

  get metricsRecorder(): MetricsRecorder {
    return this.metrics;
  }

  get scheduleSnapshot(): ExperimentSchedule {
    return this.schedule;
  }

  get runDirectory(): string {
    return this.runDir;
  }

  async executePermutationTasks(options: PermutationExecutionOptions): Promise<PermutationExecutionSummary> {
    if (!this.schedule.permutationRequests.length) {
      return { requestCount: 0, planCount: 0 };
    }
    const threadContents = await this.loadThreadContents();
    const summary: PermutationExecutionSummary = {
      requestCount: 0,
      planCount: 0,
    };
    await fs.mkdir(path.join(this.runDir, 'permutations'), { recursive: true });

    for (let index = 0; index < this.schedule.permutationRequests.length; index += 1) {
      const request = this.schedule.permutationRequests[index]!;
      summary.requestCount += 1;

      const treeShapes: TreeShape[] =
        request.treeShapes?.length
          ? request.treeShapes
          : (['balanced', 'left-skew', 'right-skew'] as TreeShape[]);
      const samplingOptions: SamplingOptions = {
        threads: this.threads,
        k: request.count,
        policy: request.policy,
        treeShapes,
      };
      if (request.subsetSize !== undefined) {
        samplingOptions.subsetSize = request.subsetSize;
      }
      if (this.schedule.seed !== undefined) {
        samplingOptions.seed = this.schedule.seed + index;
      }
      const plans = generatePermutationPlans(samplingOptions);
      if (!plans.length) {
        continue;
      }

      const psiOutputs: string[] = [];
      const requestLabel = `${request.policy}-${index + 1}`;

      for (const plan of plans) {
        summary.planCount += 1;
        const planLabel = `${requestLabel}-${plan.permId}`;
        const shapeOutputs: Partial<Record<TreeShape, string>> = {};

        for (const shape of treeShapes) {
          const treeResult = await executeTreeShapeMerge({
            order: plan.order,
            treeShape: shape,
            executor: options.executor,
            requestLabel: requestLabel,
            runDir: this.runDir,
            planLabel,
            threadContents,
          });
          shapeOutputs[shape] = treeResult.content;

          const coverageSources: CoverageSource[] = plan.order.map((threadPath) => ({
            id: threadPath,
            label: path.basename(threadPath),
            content: threadContents.get(threadPath) ?? '',
          }));
          const coverage = options.coverageAnalyzer.analyze(coverageSources, treeResult.content);
          if (coverage.stats) {
            this.metrics.recordCoverage({
              label: `${planLabel}-${shape}`,
              coverages: coverage.perSource.map((entry) => entry.coverage),
              notes: `treeShape=${shape}`,
            });
          }

          const lineageEntry: Omit<
            LineageEntry,
            'rpTag'
          > = {
            label: `${planLabel}-${shape}`,
            kind: 'permutation',
            newick: treeResult.newick,
            treeShape: shape,
            orderSpec: plan.order.join('>'),
            permId: plan.permId,
            outputPath: treeResult.outputPath,
          };
          if (this.schedule.seed !== undefined) {
            lineageEntry.seed = this.schedule.seed;
          }
          if (request.notes) {
            lineageEntry.notes = request.notes;
          }
          this.lineage.record(lineageEntry);
        }

        const balancedOutput = shapeOutputs['balanced'];
        if (balancedOutput) {
          psiOutputs.push(balancedOutput);
        }
        const leftSkewOutput = shapeOutputs['left-skew'];
        const rightSkewOutput = shapeOutputs['right-skew'];
        if (balancedOutput && leftSkewOutput && rightSkewOutput) {
          const ossEmbeddings = await options.embeddingService.embed([
            balancedOutput,
            leftSkewOutput,
            rightSkewOutput,
          ]);
          const [balancedVector, leftSkewVector, rightSkewVector] = ossEmbeddings;
          if (!balancedVector || !leftSkewVector || !rightSkewVector) {
            throw new Error('Embedding service returned incomplete OSS vectors.');
          }
          const treeShapeRecord = {
            label: planLabel,
            balanced: balancedVector,
            leftSkew: leftSkewVector,
            rightSkew: rightSkewVector,
            ...(request.notes ? { notes: request.notes } : {}),
          };
          this.metrics.recordTreeShapeSet(treeShapeRecord);
        }
      }

      const embeddings = await options.embeddingService.embed(psiOutputs);
      if (embeddings.length >= 2) {
        const permutationRecord = {
          permId: requestLabel,
          embeddings,
          ...(request.notes ? { notes: request.notes } : {}),
        };
        this.metrics.recordPermutation(permutationRecord);
      }
    }

    await this.metrics.save();
    await this.lineage.save();
    return summary;
  }

  async executeTournamentTasks(options: TournamentExecutionOptions): Promise<TournamentExecutionSummary> {
    if (!this.schedule.tournamentRequests.length) {
      return { requestCount: 0, mergeCount: 0 };
    }
    const threadContents = await this.loadThreadContents();
    const summary: TournamentExecutionSummary = {
      requestCount: 0,
      mergeCount: 0,
    };

    for (let index = 0; index < this.schedule.tournamentRequests.length; index += 1) {
      const request = this.schedule.tournamentRequests[index]!;
      summary.requestCount += 1;
      const safeLabel = sanitizeLabel(request.label ?? `tournament-${index + 1}`);
      const tournamentDir = path.join(this.runDir, 'tournaments', safeLabel);
      await fs.mkdir(tournamentDir, { recursive: true });

      let roundInputs = this.threads.map((threadPath) => ({
        path: threadPath,
        label: path.basename(threadPath),
        newick: path.basename(threadPath),
      }));
      let round = 1;

      while (roundInputs.length > 1) {
        const nextRound: Array<{ path: string; label: string; newick: string }> = [];
        for (let i = 0; i < roundInputs.length; i += 2) {
          const first = roundInputs[i];
          if (!first) {
            continue;
          }
          const second = roundInputs[i + 1];
          if (!second) {
            nextRound.push(first);
            break;
          }
          const matchLabel = `${request.label ?? `T`}${round}-M${Math.floor(i / 2) + 1}`;
          const executionResult = await options.executor.execute({
            label: matchLabel,
            outputDir: tournamentDir,
            threadPaths: [first.path, second.path],
            metadata: {
              branchCount: request.branchCount,
              route: request.route,
              round,
              matchIndex: i / 2,
            },
          });
          summary.mergeCount += 1;
          nextRound.push({
            path: executionResult.outputPath,
            label: matchLabel,
            newick: `(${first.newick},${second.newick})`,
          });
        }
        roundInputs = nextRound;
        round += 1;
      }

      const championPath = roundInputs[0]?.path;
      const championNewick = roundInputs[0]?.newick;
      if (championPath) {
        const championContent = await fs.readFile(championPath, 'utf-8');
        const coverageSources: CoverageSource[] = this.threads.map((threadPath) => ({
          id: threadPath,
          label: path.basename(threadPath),
          content: threadContents.get(threadPath) ?? '',
        }));
        const coverage = options.coverageAnalyzer.analyze(coverageSources, championContent);
        if (coverage.stats) {
          const coverageRecord = {
            label: `${safeLabel}-champion`,
            coverages: coverage.perSource.map((entry) => entry.coverage),
            ...(request.description ? { notes: request.description } : {}),
          };
          this.metrics.recordCoverage(coverageRecord);
        }
        if (championNewick) {
          const lineageEntry: Omit<LineageEntry, 'rpTag'> = {
            label: `${safeLabel}-champion`,
            kind: 'tournament',
            newick: championNewick,
            treeShape: request.route,
            orderSpec: this.threads.join('>'),
            outputPath: championPath,
          };
          const seedValue = request.seed ?? this.schedule.seed;
          if (seedValue !== undefined) {
            lineageEntry.seed = seedValue;
          }
          if (request.description) {
            lineageEntry.notes = request.description;
          }
          this.lineage.record(lineageEntry);
        }
        const championKey =
          request.label ?? `${request.branchCount}-${index + 1}`;
        const championRecord: ChampionRecord = {
          label: championKey,
          outputPath: championPath,
          orderSpec: this.threads.join('>'),
          route: request.route,
        };
        if (championNewick) {
          championRecord.newick = championNewick;
        }
        this.tournamentChampions.set(championKey, championRecord);
      }
    }

    await this.metrics.save();
    await this.lineage.save();
    return summary;
  }

  async executeComparisonTasks(
    options: ComparisonExecutionOptions,
  ): Promise<ComparisonExecutionSummary> {
    if (!this.schedule.comparisonRequests?.length) {
      return { requestCount: 0, completed: 0 };
    }
    const summary: ComparisonExecutionSummary = {
      requestCount: 0,
      completed: 0,
    };

    for (const request of this.schedule.comparisonRequests) {
      summary.requestCount += 1;
      const leftKey = request.leftTournament ?? request.label;
      const rightKey = request.rightTournament ?? request.label;
      const leftChampion = leftKey
        ? this.tournamentChampions.get(leftKey)
        : undefined;
      const rightChampion = rightKey
        ? this.tournamentChampions.get(rightKey)
        : undefined;
      if (!leftChampion || !rightChampion) {
        console.warn(
          `Comparison "${request.label}" is missing champions (${leftKey ?? 'left'} vs ${rightKey ?? 'right'}). Run tournaments first.`,
        );
        continue;
      }

      const comparisonDir = path.join(
        this.runDir,
        'comparisons',
        sanitizeLabel(request.label),
      );
      await fs.mkdir(comparisonDir, { recursive: true });
      const promptPath = request.promptPath
        ? path.resolve(request.promptPath)
        : await this.ensureDefaultComparisonPrompt();
      const replicates =
        request.replicates ?? this.schedule.evalReplicates ?? 1;

      const critique = await options.critiqueRunner.runComparison({
        label: request.label,
        leftPath: leftChampion.outputPath,
        rightPath: rightChampion.outputPath,
        outputDir: comparisonDir,
        promptPath,
        replicates,
      });

      const gigRecord = {
        triple: [leftChampion.label, rightChampion.label],
        t3Score: critique.leftScore,
        t2Scores: [critique.rightScore],
        ...(request.description ? { notes: request.description } : {}),
      };
      this.metrics.recordGig(gigRecord);

      const lineageEntry: Omit<LineageEntry, 'rpTag'> = {
        label: `${sanitizeLabel(request.label)}-comparison`,
        kind: 'comparison',
        newick: `(${sanitizeLabel(leftChampion.label)},${sanitizeLabel(rightChampion.label)})`,
        treeShape: 'comparison',
        orderSpec: `${leftChampion.label}>${rightChampion.label}`,
        outputPath: critique.scorecardPath,
      };
      const comparisonNotes = request.notes ?? request.description;
      if (comparisonNotes) {
        lineageEntry.notes = comparisonNotes;
      }
      this.lineage.record(lineageEntry);

      summary.completed += 1;
    }

    await this.metrics.save();
    await this.lineage.save();

    return summary;
  }

  private async ensureDefaultComparisonPrompt(): Promise<string> {
    if (this.defaultComparisonPromptPath) {
      return this.defaultComparisonPromptPath;
    }
    const promptPath = path.join(this.runDir, 'default-comparison-prompt.md');
    const content = [
      '# Comparison Prompt',
      '',
      'Compare LEFT and RIGHT documents.',
      'Score which output better preserves coverage, accuracy, and clarity, and explain briefly.',
    ].join('\n');
    await fs.writeFile(promptPath, content, 'utf-8');
    this.defaultComparisonPromptPath = promptPath;
    return promptPath;
  }

  private async loadThreadContents(): Promise<Map<string, string>> {
    if (this.threadCache) {
      return this.threadCache;
    }
    const map = new Map<string, string>();
    await Promise.all(
      this.threads.map(async (threadPath) => {
        try {
          const resolved = path.resolve(threadPath);
          const contents = await fs.readFile(resolved, 'utf-8');
          map.set(threadPath, contents);
        } catch (error) {
          console.warn(`Failed to read thread ${threadPath}:`, error);
          map.set(threadPath, '');
        }
      }),
    );
    this.threadCache = map;
    return map;
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

interface PermutationExecutionOptions {
  embeddingService: EmbeddingService;
  coverageAnalyzer: CoverageAnalyzer;
  executor: MergeExecutor;
}

interface PermutationExecutionSummary {
  requestCount: number;
  planCount: number;
}

interface TournamentExecutionOptions {
  executor: MergeExecutor;
  coverageAnalyzer: CoverageAnalyzer;
}

interface TournamentExecutionSummary {
  requestCount: number;
  mergeCount: number;
}

interface ComparisonExecutionOptions {
  critiqueRunner: CritiqueRunner;
}

interface ComparisonExecutionSummary {
  requestCount: number;
  completed: number;
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-z0-9-_]/gi, '_').replace(/_+/g, '_');
}

interface ChampionRecord {
  label: string;
  outputPath: string;
  newick?: string;
  orderSpec: string;
  route: string;
}

interface TreeMergeOptions {
  order: string[];
  treeShape: TreeShape;
  executor: MergeExecutor;
  requestLabel: string;
  planLabel: string;
  runDir: string;
  threadContents: Map<string, string>;
}

async function executeTreeShapeMerge(
  options: TreeMergeOptions,
): Promise<{ outputPath: string; content: string; newick: string }> {
  const workDir = path.join(
    options.runDir,
    'permutations',
    options.planLabel,
    options.treeShape,
  );
  await fs.mkdir(workDir, { recursive: true });

  let nodes = options.order.map((threadPath, index) => ({
    path: threadPath,
    label: `leaf-${index + 1}`,
    newick: sanitizeLabel(path.basename(threadPath)),
  }));

  let round = 1;
  let mergeIndex = 1;

  while (nodes.length > 1) {
    if (options.treeShape === 'balanced') {
      const nextRound: typeof nodes = [];
      for (let i = 0; i < nodes.length; i += 2) {
        const leftNode = nodes[i];
        if (!leftNode) {
          continue;
        }
        const rightNode = nodes[i + 1];
        if (!rightNode) {
          nextRound.push(leftNode);
          continue;
        }
        const label = `${options.planLabel}-${options.treeShape}-R${round}-M${mergeIndex}`;
        const result = await options.executor.execute({
          label,
          outputDir: workDir,
          threadPaths: [leftNode.path, rightNode.path],
          metadata: {
            treeShape: options.treeShape,
            round,
            matchIndex: mergeIndex,
          },
        });
        mergeIndex += 1;
        nextRound.push({
          path: result.outputPath,
          label,
          newick: `(${leftNode.newick},${rightNode.newick})`,
        });
      }
      nodes = nextRound;
    } else if (options.treeShape === 'left-skew') {
      const [first, second, ...rest] = nodes;
      if (!first || !second) {
        break;
      }
      const label = `${options.planLabel}-${options.treeShape}-R${round}-M${mergeIndex}`;
      const result = await options.executor.execute({
        label,
        outputDir: workDir,
        threadPaths: [first.path, second.path],
        metadata: {
          treeShape: options.treeShape,
          round,
          matchIndex: mergeIndex,
        },
      });
      mergeIndex += 1;
      nodes = [
        {
          path: result.outputPath,
          label,
          newick: `(${first.newick},${second.newick})`,
        },
        ...rest,
      ];
    } else {
      const last = nodes.pop();
      const penultimate = nodes.pop();
      if (!last || !penultimate) {
        break;
      }
      const label = `${options.planLabel}-${options.treeShape}-R${round}-M${mergeIndex}`;
      const result = await options.executor.execute({
        label,
        outputDir: workDir,
        threadPaths: [penultimate.path, last.path],
        metadata: {
          treeShape: options.treeShape,
          round,
          matchIndex: mergeIndex,
        },
      });
      mergeIndex += 1;
      nodes.push({
        path: result.outputPath,
        label,
        newick: `(${penultimate.newick},${last.newick})`,
      });
    }
    round += 1;
  }

  const finalNode = nodes[0];
  if (!finalNode) {
    throw new Error('Tree merge did not produce a final output.');
  }
  const content = await fs.readFile(finalNode.path, 'utf-8');
  return { outputPath: finalNode.path, content, newick: finalNode.newick };
}

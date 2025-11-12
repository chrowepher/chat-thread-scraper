import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type BranchCount = 'T2' | 'T3';
export type SamplingPolicy = 'k-random' | 'k-diverse' | 'bracket';
export type TreeShape = 'balanced' | 'left-skew' | 'right-skew';
export type ExperimentPlanId = 'planA' | 'planB' | 'planC';

export interface ExperimentRunnerOptions {
  threads: string[];
  branchCount?: BranchCount | string;
  samplePolicy?: SamplingPolicy | string;
  sampleK?: number;
  treeShapes?: string[];
  seed?: number;
  calcMetrics?: boolean;
  writeTree?: string;
  writeOutput?: string;
  writeMetadata?: string;
  freshnessWeight?: number;
  noveltyWeight?: number;
  evalReplicates?: number;
  priorities?: string[];
  tieBreak?: string;
  stabilityThreshold?: number;
  plan?: ExperimentPlanId | string;
  runId?: string;
  description?: string;
}

export interface ExperimentRunnerResult {
  runId: string;
  runDir: string;
  threadPaths: string[];
  schedule: ExperimentSchedule;
}

export interface ExperimentSchedule {
  runId: string;
  plan?: ExperimentPlanId;
  branchCount: BranchCount;
  samplePolicy: SamplingPolicy;
  sampleK: number;
  treeShapes: TreeShape[];
  calcMetrics: boolean;
  threadCount: number;
  seed?: number;
  priorities: string[];
  tieBreak?: string;
  stabilityThreshold: number;
  freshnessWeight?: number;
  noveltyWeight?: number;
  evalReplicates?: number;
  planDetails?: PlanDefinition;
  permutationRequests: PermutationRequest[];
  tournamentRequests: TournamentRequest[];
  comparisonRequests: ComparisonRequest[];
}

export interface PermutationRequest {
  policy: SamplingPolicy;
  count: number;
  treeShapes: TreeShape[];
  subsetSize?: number;
  notes?: string;
}

export interface TournamentRequest {
  label: string;
  branchCount: BranchCount;
  seed?: number;
  route: 'T2' | 'T3';
  description?: string;
}

export interface ComparisonRequest {
  label: string;
  description: string;
  notes?: string;
  leftTournament?: string;
  rightTournament?: string;
  promptPath?: string;
  replicates?: number;
}

interface NormalizedOptions {
  threadInputs: string[];
  branchCount: BranchCount;
  samplePolicy: SamplingPolicy;
  sampleK: number;
  treeShapes: TreeShape[];
  calcMetrics: boolean;
  priorities: string[];
  stabilityThreshold: number;
  seed?: number;
  writeTree?: string;
  writeOutput?: string;
  writeMetadata?: string;
  freshnessWeight?: number;
  noveltyWeight?: number;
  evalReplicates?: number;
  tieBreak?: string;
  plan?: ExperimentPlanId;
  runId?: string;
  description?: string;
}

interface PlanDefinition {
  id: ExperimentPlanId;
  description: string;
  mergesEstimate: number;
  tournaments?: TournamentRequest[];
  comparisonRequests?: ComparisonRequest[];
  permutationRequest?: PermutationRequest;
}

const DEFAULT_TREE_SHAPES: TreeShape[] = [
  'balanced',
  'left-skew',
  'right-skew',
];

const TREE_SHAPE_ALIASES: Record<string, TreeShape> = {
  balanced: 'balanced',
  'left-skew': 'left-skew',
  left: 'left-skew',
  'right-skew': 'right-skew',
  right: 'right-skew',
};

const PLAN_DEFINITIONS: Record<ExperimentPlanId, PlanDefinition> = {
  planA: {
    id: 'planA',
    description: 'Tournament-only baseline with two balanced T2 brackets.',
    mergesEstimate: 22,
    tournaments: [
      {
        label: 'T2-seed-11',
        branchCount: 'T2',
        route: 'T2',
        seed: 11,
        description: 'Balanced bracket with seed 11 to probe ordering variance.',
      },
      {
        label: 'T2-seed-99',
        branchCount: 'T2',
        route: 'T2',
        seed: 99,
        description: 'Second bracket to measure early-merge bias and coverage.',
      },
    ],
  },
  planB: {
    id: 'planB',
    description:
      'Stage 1 uses grouped T3 merges, followed by T2 finals and a parallel T2 baseline.',
    mergesEstimate: 18,
    tournaments: [
      {
        label: 'T3-groups',
        branchCount: 'T3',
        route: 'T3',
        description:
          'Four triples (A-L) merged to capture triadic synergies before finals.',
      },
      {
        label: 'T2-finals',
        branchCount: 'T2',
        route: 'T2',
        description:
          'Winners from T3 groups battle via T2 rounds to crown champion.',
      },
      {
        label: 'T2-parallel-seed-77',
        branchCount: 'T2',
        route: 'T2',
        seed: 77,
        description: 'Full T2 tournament with alternate seeding for comparison.',
      },
    ],
    comparisonRequests: [
      {
        label: 'T2-vs-T3',
        description:
          'Compare T3 champion vs T2 champion; compute Group Interaction Gain.',
        notes: 'Requires rubric deltas and rpTag lineage.',
        leftTournament: 'T3-groups',
        rightTournament: 'T2-parallel-seed-77',
      },
    ],
  },
  planC: {
    id: 'planC',
    description:
      'Permutation probe on a 6-thread subset to compute PSI and OSS (k=5).',
    mergesEstimate: 15,
    permutationRequest: {
      policy: 'k-diverse',
      count: 5,
      treeShapes: DEFAULT_TREE_SHAPES,
      subsetSize: 6,
      notes: 'Pairs each permutation with balanced/left/right tree shapes.',
    },
  },
};

export async function runExperiment(
  options: ExperimentRunnerOptions,
): Promise<ExperimentRunnerResult> {
  const normalized = normalizeOptions(options);
  const threadPaths = await expandThreadInputs(normalized.threadInputs);
  if (!threadPaths.length) {
    throw new Error(
      'No thread sources resolved. Provide at least one --threads value or @list file.',
    );
  }

  const runId = normalized.runId ?? generateRunId();
  const runDir = path.resolve('runs', runId);
  await fs.mkdir(runDir, { recursive: true });

  const manifest = buildManifest(runId, normalized, threadPaths);
  await fs.writeFile(
    path.join(runDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );

  const schedule = buildSchedule(runId, normalized, threadPaths.length);
  await fs.writeFile(
    path.join(runDir, 'schedule.json'),
    JSON.stringify(schedule, null, 2),
    'utf-8',
  );

  if (normalized.calcMetrics) {
    await writeMetricsSkeleton(runDir, runId);
  }

  console.log(
    [
      `Experiment ${runId} scaffolded.`,
      `${threadPaths.length} thread${threadPaths.length === 1 ? '' : 's'} configured.`,
      normalized.plan
        ? `Plan preset: ${normalized.plan} (~${PLAN_DEFINITIONS[normalized.plan].mergesEstimate} merges).`
        : `Policy: ${normalized.samplePolicy} (k=${normalized.sampleK}).`,
    ].join(' '),
  );

  return {
    runId,
    runDir,
    threadPaths,
    schedule,
  };
}

function normalizeOptions(options: ExperimentRunnerOptions): NormalizedOptions {
  const threadInputs =
    options.threads?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  if (!threadInputs.length) {
    throw new Error(
      'At least one --threads value must be supplied (file path or @list).',
    );
  }

  const branchCount = normalizeBranchCount(options.branchCount);
  const samplePolicy = normalizeSamplingPolicy(options.samplePolicy);
  const treeShapes = normalizeTreeShapes(options.treeShapes);
  const sampleK = normalizeSampleK(options.sampleK);
  const priorities = normalizePriorityList(options.priorities);
  const plan = normalizePlan(options.plan);
  const stabilityThreshold =
    typeof options.stabilityThreshold === 'number' &&
    Number.isFinite(options.stabilityThreshold)
      ? options.stabilityThreshold
      : 0.92;

  const normalized: NormalizedOptions = {
    threadInputs,
    branchCount,
    samplePolicy,
    sampleK,
    treeShapes,
    calcMetrics: Boolean(options.calcMetrics),
    priorities,
    stabilityThreshold,
  };

  const seed = normalizeOptionalInteger(options.seed);
  if (seed !== undefined) {
    normalized.seed = seed;
  }

  if (options.writeTree) {
    normalized.writeTree = options.writeTree;
  }
  if (options.writeOutput) {
    normalized.writeOutput = options.writeOutput;
  }
  if (options.writeMetadata) {
    normalized.writeMetadata = options.writeMetadata;
  }

  const freshness = normalizeWeight(options.freshnessWeight, 'freshness-weight');
  if (freshness !== undefined) {
    normalized.freshnessWeight = freshness;
  }
  const novelty = normalizeWeight(options.noveltyWeight, 'novelty-weight');
  if (novelty !== undefined) {
    normalized.noveltyWeight = novelty;
  }

  const evalReplicates = normalizeOptionalInteger(options.evalReplicates);
  if (evalReplicates !== undefined) {
    normalized.evalReplicates = evalReplicates;
  }

  if (options.tieBreak?.trim()) {
    normalized.tieBreak = options.tieBreak.trim();
  }

  if (plan) {
    normalized.plan = plan;
  }

  const runId = options.runId?.trim();
  if (runId) {
    normalized.runId = runId;
  }

  const description = options.description?.trim();
  if (description) {
    normalized.description = description;
  }

  return normalized;
}

function normalizeBranchCount(
  value?: BranchCount | string,
): BranchCount {
  const normalized = typeof value === 'string' ? value.toUpperCase() : value;
  if (normalized === 'T2' || normalized === 'T3') {
    return normalized;
  }
  return 'T2';
}

function normalizeSamplingPolicy(
  value?: SamplingPolicy | string,
): SamplingPolicy {
  const normalized = value?.toLowerCase();
  if (normalized === 'k-diverse') {
    return 'k-diverse';
  }
  if (normalized === 'k-random') {
    return 'k-random';
  }
  return 'bracket';
}

function normalizeTreeShapes(input?: string[]): TreeShape[] {
  if (!input?.length) {
    return [...DEFAULT_TREE_SHAPES];
  }
  const resolved = new Set<TreeShape>();
  for (const entry of input) {
    const key = entry.toLowerCase();
    const mapped = TREE_SHAPE_ALIASES[key];
    if (mapped) {
      resolved.add(mapped);
    }
  }
  return resolved.size ? Array.from(resolved) : [...DEFAULT_TREE_SHAPES];
}

function normalizeSampleK(value?: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return 3;
}

function normalizePriorityList(values?: string[]): string[] {
  if (!values?.length) {
    return [];
  }
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) {
      seen.add(trimmed);
    }
  }
  return Array.from(seen);
}

function normalizeWeight(value: number | undefined, label: string):
  | number
  | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1.`);
  }
  return value;
}

function normalizeOptionalInteger(value?: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  return undefined;
}

function normalizePlan(value?: ExperimentPlanId | string): ExperimentPlanId | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const directKey = trimmed as ExperimentPlanId;
  if (PLAN_DEFINITIONS[directKey]) {
    return directKey;
  }
  const lowerKey = trimmed.toLowerCase() as ExperimentPlanId;
  if (PLAN_DEFINITIONS[lowerKey]) {
    return lowerKey;
  }
  throw new Error(
    `Unknown plan "${value}". Expected one of: ${Object.keys(PLAN_DEFINITIONS).join(', ')}.`,
  );
}

async function expandThreadInputs(entries: string[]): Promise<string[]> {
  const resolved = new Set<string>();
  for (const entry of entries) {
    if (entry.startsWith('@')) {
      const listPath = path.resolve(entry.slice(1));
      const contents = await fs.readFile(listPath, 'utf-8');
      for (const line of contents.split(/\r?\n/g)) {
        const sanitized = line.replace(/#.*/, '').trim();
        if (sanitized) {
          resolved.add(path.resolve(sanitized));
        }
      }
    } else {
      resolved.add(path.resolve(entry));
    }
  }
  return Array.from(resolved);
}

function buildManifest(
  runId: string,
  options: NormalizedOptions,
  threadPaths: string[],
) {
  return {
    runId,
    createdAt: new Date().toISOString(),
    description: options.description,
    inputs: {
      threads: threadPaths,
    },
    parameters: {
      branchCount: options.branchCount,
      samplePolicy: options.samplePolicy,
      sampleK: options.sampleK,
      treeShapes: options.treeShapes,
      seed: options.seed ?? null,
      plan: options.plan ?? null,
      freshnessWeight: options.freshnessWeight ?? null,
      noveltyWeight: options.noveltyWeight ?? null,
      evalReplicates: options.evalReplicates ?? null,
      priorities: options.priorities,
      tieBreak: options.tieBreak ?? null,
      stabilityThreshold: options.stabilityThreshold,
      calcMetrics: options.calcMetrics,
      writeTree: options.writeTree ?? null,
      writeOutput: options.writeOutput ?? null,
      writeMetadata: options.writeMetadata ?? null,
    },
  };
}

function buildSchedule(
  runId: string,
  options: NormalizedOptions,
  threadCount: number,
): ExperimentSchedule {
  const planDetails = options.plan ? PLAN_DEFINITIONS[options.plan] : undefined;

  const permutationRequests: PermutationRequest[] = [];
  if (planDetails?.permutationRequest) {
    permutationRequests.push(planDetails.permutationRequest);
  } else if (options.samplePolicy !== 'bracket') {
    permutationRequests.push({
      policy: options.samplePolicy,
      count: options.sampleK,
      treeShapes: options.treeShapes,
      notes: 'Ad-hoc permutation sampling request.',
    });
  }

  const tournamentRequests: TournamentRequest[] = planDetails?.tournaments
    ? planDetails.tournaments
    : [
        {
          label: `${options.branchCount}-primary`,
          branchCount: options.branchCount,
          route: options.branchCount,
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
          description: 'Default tournament run derived from CLI arguments.',
        },
      ];

  const comparisonRequests: ComparisonRequest[] =
    planDetails?.comparisonRequests ?? [];

  return {
    runId,
    ...(options.plan ? { plan: options.plan } : {}),
    branchCount: options.branchCount,
    samplePolicy: options.samplePolicy,
    sampleK: options.sampleK,
    treeShapes: options.treeShapes,
    calcMetrics: options.calcMetrics,
    threadCount,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    priorities: options.priorities,
    ...(options.tieBreak ? { tieBreak: options.tieBreak } : {}),
    stabilityThreshold: options.stabilityThreshold,
    ...(options.freshnessWeight !== undefined
      ? { freshnessWeight: options.freshnessWeight }
      : {}),
    ...(options.noveltyWeight !== undefined
      ? { noveltyWeight: options.noveltyWeight }
      : {}),
    ...(options.evalReplicates !== undefined
      ? { evalReplicates: options.evalReplicates }
      : {}),
    ...(planDetails ? { planDetails } : {}),
    permutationRequests,
    tournamentRequests,
    comparisonRequests,
  };
}

async function writeMetricsSkeleton(runDir: string, runId: string) {
  const skeleton = {
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
    notes:
      'Metrics pending. Populate via merge executions and post-processing pipeline.',
  };
  await fs.writeFile(
    path.join(runDir, 'metrics.json'),
    JSON.stringify(skeleton, null, 2),
    'utf-8',
  );
}

function generateRunId(): string {
  return `exp-${crypto.randomBytes(3).toString('hex')}`;
}

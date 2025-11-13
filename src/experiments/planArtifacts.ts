import fs from 'node:fs/promises';
import path from 'node:path';
import type { LineageEntry } from './lineageRecorder.js';
import type { ExperimentPlanId, PlanDefinition, TreeShape } from './runner.js';

export interface PlanRepresentative {
  label: string;
  outputPath: string;
  kind: 'tournament' | 'permutation';
  notes?: string;
}

export async function resolvePlanRepresentative(options: {
  planId: ExperimentPlanId;
  runDir: string;
  definition?: PlanDefinition;
}): Promise<PlanRepresentative> {
  const lineage = await readLineage(options.runDir);
  const representativeConfig = options.definition?.representative;
  if (representativeConfig?.type === 'tournament') {
    const entry = resolveTournamentRepresentative(lineage, representativeConfig);
    if (entry) {
      return entry;
    }
    throw new Error(
      `Plan ${options.planId} does not have a recorded champion for ${representativeConfig.label}.`,
    );
  }
  if (representativeConfig?.type === 'permutationCoverage') {
    const metrics = await readMetrics(options.runDir);
    const entry = resolvePermutationRepresentative(
      lineage,
      metrics,
      representativeConfig,
    );
    if (entry) {
      return entry;
    }
    throw new Error(
      `Plan ${options.planId} is missing permutation outputs for treeShape=${representativeConfig.treeShape ?? 'balanced'}.`,
    );
  }

  // Fallback: first tournament champion if nothing was configured.
  const fallbackTournament = lineage.entries.find(
    (entry) => entry.kind === 'tournament' && entry.label.endsWith('-champion'),
  );
  if (fallbackTournament) {
    return {
      label: fallbackTournament.label,
      outputPath: fallbackTournament.outputPath,
      kind: 'tournament',
      ...(fallbackTournament.notes ? { notes: fallbackTournament.notes } : {}),
    };
  }
  throw new Error(
    `Plan ${options.planId} has no representative configuration and no tournament champions.`,
  );
}

function resolveTournamentRepresentative(
  lineage: { entries: LineageEntry[] },
  config: NonNullable<PlanDefinition['representative']> & {
    type: 'tournament';
  },
): PlanRepresentative | undefined {
  const candidates = [
    config.label,
    ...(config.fallbackLabels ?? []),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const targetLabel = candidate.endsWith('-champion')
      ? candidate
      : `${candidate}-champion`;
    const entry = lineage.entries.find(
      (item) =>
        item.kind === 'tournament' && item.label === targetLabel && item.outputPath,
    );
    if (entry) {
      return {
        label: entry.label,
        outputPath: entry.outputPath,
        kind: 'tournament',
        ...(entry.notes ? { notes: entry.notes } : {}),
      };
    }
  }
  return undefined;
}

function resolvePermutationRepresentative(
  lineage: { entries: LineageEntry[] },
  metrics: MetricsSnapshot | undefined,
  config: NonNullable<PlanDefinition['representative']> & {
    type: 'permutationCoverage';
  },
): PlanRepresentative | undefined {
  const desiredShape: TreeShape = config.treeShape ?? 'balanced';
  const candidates = collectPermutationMetrics(metrics, desiredShape);
  const best = candidates.sort((a, b) => b.mean - a.mean)[0];
  const targetLabel = best?.label;
  if (!targetLabel) {
    return undefined;
  }
  const entry = lineage.entries.find(
    (item) =>
      item.kind === 'permutation' &&
      item.label === targetLabel &&
      (item.treeShape === desiredShape ||
        sanitizeTreeShape(item.treeShape) === desiredShape),
  );
  if (!entry) {
    return undefined;
  }
  return {
    label: entry.label,
    outputPath: entry.outputPath,
    kind: 'permutation',
    ...(entry.notes ? { notes: entry.notes } : {}),
  };
}

function collectPermutationMetrics(
  metrics: MetricsSnapshot | undefined,
  desiredShape: TreeShape,
): Array<{ label: string; mean: number }> {
  if (!metrics?.cai?.length) {
    return [];
  }
  return metrics.cai
    .filter(
      (entry) =>
        typeof entry.label === 'string' &&
        (entry.notes?.includes(`treeShape=${desiredShape}`) ??
          entry.label.endsWith(`-${desiredShape}`)),
    )
    .map((entry) => ({
      label: entry.label,
      mean: entry.mean ?? 0,
    }));
}

async function readLineage(
  runDir: string,
): Promise<{ entries: LineageEntry[] }> {
  const lineagePath = path.join(runDir, 'lineage.json');
  const raw = await fs.readFile(lineagePath, 'utf-8');
  const parsed = JSON.parse(raw) as { entries: LineageEntry[] };
  return parsed;
}

async function readMetrics(runDir: string): Promise<MetricsSnapshot | undefined> {
  try {
    const metricsPath = path.join(runDir, 'metrics.json');
    const raw = await fs.readFile(metricsPath, 'utf-8');
    return JSON.parse(raw) as MetricsSnapshot;
  } catch {
    return undefined;
  }
}

interface MetricsSnapshot {
  cai?: Array<{
    label: string;
    mean?: number;
    notes?: string;
  }>;
}

function sanitizeTreeShape(
  treeShape?: string | null,
): TreeShape | undefined {
  if (!treeShape) {
    return undefined;
  }
  if (treeShape === 'balanced' || treeShape === 'left-skew' || treeShape === 'right-skew') {
    return treeShape;
  }
  return undefined;
}

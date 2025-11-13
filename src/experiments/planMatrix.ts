import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CritiqueRunner,
  CritiqueRunOptions,
} from './critiqueRunner.js';
import type { ExperimentPlanId } from './runner.js';
import type { PlanRepresentative } from './planArtifacts.js';

export interface PlanRunSummary {
  planId: ExperimentPlanId;
  runId: string;
  runDir: string;
  representative: PlanRepresentative;
}

interface MatrixMetadata {
  matrixId: string;
  inputSignature: string;
  updatedAt: string;
  plans: Array<{
    planId: ExperimentPlanId;
    runId: string;
    representative: PlanRepresentative;
  }>;
}

export async function ensurePlanMatrixComparisons(options: {
  inputSignature: string;
  planRuns: PlanRunSummary[];
  critiqueRunner: CritiqueRunner;
  replicates?: number;
}): Promise<{
  executed: number;
  reused: number;
  matrixDir: string;
}> {
  if (options.planRuns.length < 2) {
    return { executed: 0, reused: 0, matrixDir: '' };
  }
  const shortSig = options.inputSignature.slice(0, 12);
  const matrixDir = path.resolve('runs', `plan-matrix-${shortSig}`);
  await fs.mkdir(path.join(matrixDir, 'comparisons'), { recursive: true });
  await writeMatrixManifest(matrixDir, {
    matrixId: `plan-matrix-${shortSig}`,
    inputSignature: options.inputSignature,
    updatedAt: new Date().toISOString(),
    plans: options.planRuns.map((run) => ({
      planId: run.planId,
      runId: run.runId,
      representative: run.representative,
    })),
  });

  let executed = 0;
  let reused = 0;
  const critiqueRunner = options.critiqueRunner;

  for (let i = 0; i < options.planRuns.length; i += 1) {
    for (let j = i + 1; j < options.planRuns.length; j += 1) {
      const orderedPair = [options.planRuns[i]!, options.planRuns[j]!];
      orderedPair.sort((a, b) => a.planId.localeCompare(b.planId));
      const left = orderedPair[0]!;
      const right = orderedPair[1]!;
      const pairLabel = `${left.planId}-vs-${right.planId}`;
      const pairDir = path.join(matrixDir, 'comparisons', pairLabel);
      await fs.mkdir(pairDir, { recursive: true });
      const metadataPath = path.join(pairDir, 'metadata.json');
      const critiquePaths = buildCritiquePaths(pairDir, pairLabel);
      const cacheHit = await isComparisonCached({
        metadataPath,
        inputSignature: options.inputSignature,
        left,
        right,
        critiquePaths,
      });
      if (cacheHit) {
        reused += 1;
        continue;
      }

      const comparisonRequest: CritiqueRunOptions = {
        label: pairLabel,
        leftPath: left.representative.outputPath,
        rightPath: right.representative.outputPath,
        outputDir: pairDir,
      };
      if (options.replicates !== undefined) {
        comparisonRequest.replicates = options.replicates;
      }
      const critique = await critiqueRunner.runComparison(comparisonRequest);
      executed += 1;

      const metadata = {
        inputSignature: options.inputSignature,
        generatedAt: new Date().toISOString(),
        left: {
          planId: left.planId,
          runId: left.runId,
          representative: left.representative,
        },
        right: {
          planId: right.planId,
          runId: right.runId,
          representative: right.representative,
        },
        markdownPath: path.relative(matrixDir, critique.markdownPath),
        scorecardPath: path.relative(matrixDir, critique.scorecardPath),
      };
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    }
  }

  return { executed, reused, matrixDir };
}

async function writeMatrixManifest(
  matrixDir: string,
  metadata: MatrixMetadata,
): Promise<void> {
  const manifestPath = path.join(matrixDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(metadata, null, 2), 'utf-8');
}

function buildCritiquePaths(pairDir: string, label: string): {
  markdown: string;
  scorecard: string;
} {
  const sanitized = label.replace(/[^a-z0-9-_]/gi, '_');
  return {
    markdown: path.join(pairDir, `${sanitized}.critique.md`),
    scorecard: path.join(pairDir, `${sanitized}.scorecard.json`),
  };
}

async function isComparisonCached(options: {
  metadataPath: string;
  inputSignature: string;
  left: PlanRunSummary;
  right: PlanRunSummary;
  critiquePaths: { markdown: string; scorecard: string };
}): Promise<boolean> {
  try {
    const raw = await fs.readFile(options.metadataPath, 'utf-8');
    const metadata = JSON.parse(raw) as {
      inputSignature?: string;
      left?: { planId?: string; runId?: string; representative?: PlanRepresentative };
      right?: { planId?: string; runId?: string; representative?: PlanRepresentative };
    };
    if (metadata.inputSignature !== options.inputSignature) {
      return false;
    }
    if (
      metadata.left?.planId !== options.left.planId ||
      metadata.left?.runId !== options.left.runId ||
      metadata.left?.representative?.label !== options.left.representative.label ||
      metadata.left?.representative?.outputPath !== options.left.representative.outputPath
    ) {
      return false;
    }
    if (
      metadata.right?.planId !== options.right.planId ||
      metadata.right?.runId !== options.right.runId ||
      metadata.right?.representative?.label !== options.right.representative.label ||
      metadata.right?.representative?.outputPath !== options.right.representative.outputPath
    ) {
      return false;
    }
    await Promise.all([
      fs.stat(options.critiquePaths.markdown),
      fs.stat(options.critiquePaths.scorecard),
    ]);
    return true;
  } catch {
    return false;
  }
}

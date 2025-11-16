import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BrowserConversation } from '../types.js';
import type {
  MergeReportPayload,
  ComparisonSummary,
} from '../mergeSnapshot.js';
import type { PlanRunSummary } from '../experiments/planMatrix.js';
import { computeConversationHash } from '../utils/conversationHash.js';

export interface SuccessCriteriaAttachment {
  path: string;
  content: string;
}

export interface FinalOutputBundle {
  version: number;
  generatedAt: string;
  runId: string;
  autopilot: {
    runDirectory: string;
    options: Record<string, unknown>;
    steps: {
      scrape: boolean;
      merge: boolean;
      experiments: boolean;
    };
  };
  snapshot: {
    path: string;
    digest: string;
    conversationCount: number;
    conversations: Array<{
      index: number;
      title: string;
      url: string;
      tabId: string;
      messageCount: number;
      hash: string;
    }>;
  };
  merge?: {
    report: {
      summary: string;
      combinedPath: string[];
      mergeDecisions: Array<{
        branchTitles: string[];
        decision: string;
        rationale?: string;
      }>;
      followUpIdeas?: string[];
    };
    harvestResult?: MergeReportPayload['harvestResult'];
    scientistVerdict?: string;
    metadata: {
      branchesProvided: number;
      htmlReportPath?: string;
      notePath?: string;
      tasksPath?: string;
      responseDebugPath?: string;
    };
  };
  experiments?: {
    plans: Array<{
      planId: string;
      runId: string;
      runDir: string;
      representativeLabel?: string;
      representativeNotes?: string;
      representativePath?: string;
    }>;
    comparisons?: ComparisonSummary[];
    matrixComparisonDir?: string;
  };
  successCriteria?: {
    path: string;
    digest: string;
    content: string;
  };
  decisionRationale: {
    mergeSummary?: string;
    mergeCombinedPath?: string[];
    followUpIdeas?: string[];
    planHighlights?: Array<{
      planId: string;
      representativeLabel?: string;
      representativeNotes?: string;
    }>;
    comparisonSignals?: Array<{
      label: string;
      winner?: 'left' | 'right' | 'tie';
      summary?: string;
    }>;
  };
}

export interface WriteFinalOutputBundleOptions {
  runId: string;
  runDirectory: string;
  outputPath: string;
  autopilotOptions: Record<string, unknown>;
  snapshotPath: string;
  snapshotConversations: BrowserConversation[];
  mergePayload?: MergeReportPayload;
  mergeHtmlPath?: string;
  mergeNotePath?: string;
  mergeTasksPath?: string;
  mergeResponseDebugPath?: string;
  planRunSummaries: PlanRunSummary[];
  comparisonSummaries?: ComparisonSummary[];
  matrixComparisonDir?: string;
  successCriteria?: SuccessCriteriaAttachment;
}

export interface WriteFinalOutputBundleResult {
  bundle: FinalOutputBundle;
  digest: string;
}

const FINAL_BUNDLE_VERSION = 1;

export async function writeFinalOutputBundle(
  options: WriteFinalOutputBundleOptions,
): Promise<WriteFinalOutputBundleResult> {
  const runDirectory = relativeToProject(options.runDirectory);
  const snapshotPath = relativeToProject(options.snapshotPath);
  const sanitizedOptions = sanitizeOptionsSnapshot(options.autopilotOptions);
  const autopilotFlags = options.autopilotOptions as {
    skipScrape?: boolean;
    skipMerge?: boolean;
    skipExperiments?: boolean;
  };
  const snapshotDigest = await hashFile(options.snapshotPath);
  const conversationSummaries = options.snapshotConversations.map(
    (conversation, index) => ({
      index: index + 1,
      title: conversation.title || `Conversation ${index + 1}`,
      url: conversation.url,
      tabId: conversation.tabId,
      messageCount: conversation.messages?.length ?? 0,
      hash: computeConversationHash(conversation),
    }),
  );

  const normalizedPlanSummaries = options.planRunSummaries.map((plan) => {
    const entry: {
      planId: string;
      runId: string;
      runDir: string;
      representativeLabel?: string;
      representativeNotes?: string;
      representativePath?: string;
    } = {
      planId: plan.planId,
      runId: plan.runId,
      runDir: relativeToProject(plan.runDir),
    };
    if (plan.representative.label) {
      entry.representativeLabel = plan.representative.label;
    }
    if (plan.representative.notes) {
      entry.representativeNotes = plan.representative.notes;
    }
    if (plan.representative.outputPath) {
      entry.representativePath = relativeToProject(
        plan.representative.outputPath,
      );
    }
    return entry;
  });

  const normalizedComparisons = (options.comparisonSummaries ?? []).map(
    (comparison) => ({
      ...comparison,
      left: {
        ...comparison.left,
        outputPath: comparison.left?.outputPath
          ? relativeToProject(comparison.left.outputPath)
          : undefined,
      },
      right: {
        ...comparison.right,
        outputPath: comparison.right?.outputPath
          ? relativeToProject(comparison.right.outputPath)
          : undefined,
      },
      markdownPath: comparison.markdownPath
        ? relativeToProject(comparison.markdownPath)
        : undefined,
      scorecardPath: comparison.scorecardPath
        ? relativeToProject(comparison.scorecardPath)
        : undefined,
    }),
  );

  const mergeSection = options.mergePayload
    ? buildMergeSection({
        payload: options.mergePayload,
        branchCount: options.snapshotConversations.length,
        ...(options.mergeHtmlPath
          ? { htmlReportPath: options.mergeHtmlPath }
          : {}),
        ...(options.mergeNotePath ? { notePath: options.mergeNotePath } : {}),
        ...(options.mergeTasksPath ? { tasksPath: options.mergeTasksPath } : {}),
        ...(options.mergeResponseDebugPath
          ? { responseDebugPath: options.mergeResponseDebugPath }
          : {}),
      })
    : undefined;

  const successCriteriaSection = options.successCriteria
    ? {
        path: relativeToProject(options.successCriteria.path),
        digest: hashText(options.successCriteria.content),
        content: options.successCriteria.content,
      }
    : undefined;

  const decisionRationale: FinalOutputBundle['decisionRationale'] = {};
  if (mergeSection?.report.summary) {
    decisionRationale.mergeSummary = mergeSection.report.summary;
  }
  if (mergeSection?.report.combinedPath?.length) {
    decisionRationale.mergeCombinedPath = mergeSection.report.combinedPath;
  }
  if (mergeSection?.report.followUpIdeas?.length) {
    decisionRationale.followUpIdeas = mergeSection.report.followUpIdeas;
  }
  if (normalizedPlanSummaries.length) {
    decisionRationale.planHighlights = normalizedPlanSummaries.map((plan) => {
      const highlight: {
        planId: string;
        representativeLabel?: string;
        representativeNotes?: string;
      } = { planId: plan.planId };
      if (plan.representativeLabel) {
        highlight.representativeLabel = plan.representativeLabel;
      }
      if (plan.representativeNotes) {
        highlight.representativeNotes = plan.representativeNotes;
      }
      return highlight;
    });
  }
  if (normalizedComparisons.length) {
    decisionRationale.comparisonSignals = normalizedComparisons.map(
      (comparison) => {
        const signal: {
          label: string;
          winner?: 'left' | 'right' | 'tie';
          summary?: string;
        } = { label: comparison.label };
        if (comparison.winner) {
          signal.winner = comparison.winner;
        }
        if (comparison.summary) {
          signal.summary = comparison.summary;
        }
        return signal;
      },
    );
  }

  let experimentsSection: FinalOutputBundle['experiments'];
  if (normalizedPlanSummaries.length || normalizedComparisons.length) {
    const experiments: NonNullable<
      FinalOutputBundle['experiments']
    > = {
      plans: normalizedPlanSummaries,
    };
    if (normalizedComparisons.length) {
      experiments.comparisons = normalizedComparisons;
    }
    if (options.matrixComparisonDir) {
      experiments.matrixComparisonDir = relativeToProject(
        options.matrixComparisonDir,
      );
    }
    experimentsSection = experiments;
  }

  const bundle: FinalOutputBundle = {
    version: FINAL_BUNDLE_VERSION,
    generatedAt: new Date().toISOString(),
    runId: options.runId,
    autopilot: {
      runDirectory,
      options: sanitizedOptions,
      steps: {
        scrape: autopilotFlags.skipScrape !== true,
        merge: autopilotFlags.skipMerge !== true,
        experiments: autopilotFlags.skipExperiments !== true,
      },
    },
    snapshot: {
      path: snapshotPath,
      digest: snapshotDigest,
      conversationCount: options.snapshotConversations.length,
      conversations: conversationSummaries,
    },
    ...(mergeSection ? { merge: mergeSection } : {}),
    ...(experimentsSection ? { experiments: experimentsSection } : {}),
    ...(successCriteriaSection
      ? { successCriteria: successCriteriaSection }
      : {}),
    decisionRationale,
  };

  const serialized = JSON.stringify(bundle, null, 2);
  const digest = hashText(serialized);
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.writeFile(options.outputPath, serialized, 'utf-8');

  return { bundle, digest };
}

function sanitizeOptionsSnapshot(
  options: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(options));
  } catch {
    return {};
  }
}

function relativeToProject(target: string): string {
  const absolute = path.resolve(target);
  const relative = path.relative(process.cwd(), absolute);
  return relative || path.basename(absolute);
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function hashFile(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function buildMergeSection(options: {
  payload: MergeReportPayload;
  branchCount: number;
  htmlReportPath?: string;
  notePath?: string;
  tasksPath?: string;
  responseDebugPath?: string;
}): FinalOutputBundle['merge'] {
  const { payload } = options;
  const { mergeResult } = payload;
  const { rawResponse, ...sanitizedResult } = mergeResult ?? {};
  const report: NonNullable<FinalOutputBundle['merge']>['report'] = {
    summary: sanitizedResult.summary ?? '',
    combinedPath: sanitizedResult.combinedPath ?? [],
    mergeDecisions: sanitizedResult.mergeDecisions ?? [],
  };
  if (sanitizedResult.followUpIdeas) {
    report.followUpIdeas = sanitizedResult.followUpIdeas;
  }

  const metadata: NonNullable<
    FinalOutputBundle['merge']
  >['metadata'] = {
    branchesProvided: options.branchCount,
  };
  if (options.htmlReportPath) {
    metadata.htmlReportPath = relativeToProject(options.htmlReportPath);
  }
  if (options.notePath) {
    metadata.notePath = relativeToProject(options.notePath);
  }
  if (options.tasksPath) {
    metadata.tasksPath = relativeToProject(options.tasksPath);
  }
  if (options.responseDebugPath) {
    metadata.responseDebugPath = relativeToProject(options.responseDebugPath);
  }

  const mergeSection: FinalOutputBundle['merge'] = {
    report,
    metadata,
  };
  if (payload.harvestResult) {
    mergeSection.harvestResult = payload.harvestResult;
  }
  if (payload.scientistVerdict) {
    mergeSection.scientistVerdict = payload.scientistVerdict;
  }
  return mergeSection;
}

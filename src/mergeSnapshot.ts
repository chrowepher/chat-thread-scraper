#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import { mergeBranches } from './openaiMerge.js';
import type { MergeOptions } from './openaiMerge.js';
import { appendMarkdownNote } from './output/noteSink.js';
import { appendTasksFromIdeas } from './output/taskSink.js';
import { publishNotionSummary } from './output/integrations/notion.js';
import { syncTodoistTasks } from './output/integrations/todoist.js';
import type {
  BrowserConversation,
  ProviderPreset,
  MergeResult,
} from './types.js';
import { runFeatureHarvestMerge, toMergeResult } from './merger/featureHarvestMerge.js';
import { DEFAULT_FEATURE_HARVEST_CONFIG } from './merger/config.js';
import { runPilotBatch } from './merger/pilotRunner.js';
import { createDefaultScientistClient } from './merger/scientistClient.js';
import type {
  FeatureHarvestResult,
  GuardrailReport,
  CoverageStats,
} from './merger/types.js';

export interface MergeCliOptions {
  input?: string;
  branchLimit?: number;
  model?: string;
  maxBranchHighlights?: number;
  temperature?: number;
  provider?: ProviderPreset;
  apiBase?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  apiHeader?: Record<string, string>;
  notePath?: string;
  tasksPath?: string;
  taskSource?: string;
  notionDatabaseId?: string;
  notionTokenEnv?: string;
  notionTitleProp?: string;
  notionSummaryProp?: string;
  todoistProjectId?: string;
  todoistTokenEnv?: string;
  todoistPriority?: number;
  todoistDueString?: string;
  responseDebug?: string;
  verbose?: boolean;
  harvest?: boolean;
}

const conversationSchema = z.object({
  tabId: z.string(),
  parentTabId: z.string().optional(),
  title: z.string(),
  url: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
      timestamp: z.string().optional(),
    }),
  ),
});

const conversationArraySchema = z.array(conversationSchema);
const threadSnapshotSchema = z.object({
  conversations: conversationArraySchema,
});

const loadBranchesFromSnapshot = async (
  snapshotPath: string,
): Promise<BrowserConversation[]> => {
  const resolved = path.resolve(snapshotPath);
  const raw = await fs.readFile(resolved, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return conversationArraySchema.parse(parsed);
  }
  return threadSnapshotSchema.parse(parsed).conversations;
};

export async function runMergeWorkflow(
  cliOptions: MergeCliOptions,
): Promise<void> {
  const {
    input,
    branchLimit,
    model = 'gpt-4.1-mini',
    maxBranchHighlights,
    temperature,
    provider = 'openai',
    apiBase,
    apiKey,
    apiKeyEnv = 'OPENAI_API_KEY',
    apiHeader = {},
    notePath,
    tasksPath,
    taskSource = 'chat-thread-merger',
    notionDatabaseId,
    notionTokenEnv = 'NOTION_API_KEY',
    notionTitleProp = 'Name',
    notionSummaryProp = 'Summary',
    todoistProjectId,
    todoistTokenEnv = 'TODOIST_API_KEY',
    todoistPriority,
    todoistDueString,
    responseDebug,
    verbose,
    harvest = false,
  } = cliOptions;

  if (!input) {
    throw new Error('You must provide an --input snapshot path to merge.');
  }

  let branches = await loadBranchesFromSnapshot(input);
  if (branchLimit && branchLimit > 0 && branches.length > branchLimit) {
    if (verbose) {
      console.log(
        `Trimming snapshot to the first ${branchLimit} branches (found ${branches.length}).`,
      );
    }
    branches = branches.slice(0, branchLimit);
  }

  if (!branches.length) {
    throw new Error('No conversations found in the provided snapshot.');
  }

  if (verbose) {
    console.log(`Merging ${branches.length} conversation branch(es)...`);
  }

  let result: MergeResult;
  let harvestResult: FeatureHarvestResult | undefined;
  let harvestLogPath: string | undefined;
  let scientistVerdict: string | undefined;
  if (harvest) {
    const scientistClient = createDefaultScientistClient();
    if (!scientistClient && verbose) {
      console.warn(
        'Scientist reviewer not configured (set OPENAI_API_KEY or FEATURE_HARVEST_SCIENTIST_API_KEY). Skipping automated verdict.',
      );
    }
    const pilotRun = await runPilotBatch({
      queue: [branches],
      pilotMode: false,
      scientistClient,
    });
    harvestResult = pilotRun.mergeResults[0];
    if (!harvestResult) {
      throw new Error('Feature harvest did not return a merge result.');
    }
    result = toMergeResult(harvestResult);
    harvestLogPath = pilotRun.logFile;
    scientistVerdict = pilotRun.scientistVerdict;
    if (scientistVerdict) {
      console.log(`Scientist verdict: ${scientistVerdict}`);
    }
    if (verbose && harvestLogPath) {
      console.log(`Feature-harvest log written to ${harvestLogPath}.`);
    }
  } else {
    const mergeOptions: MergeOptions = {
      branches,
      model,
      provider,
      apiKeyEnv,
    };
    if (typeof maxBranchHighlights === 'number') {
      mergeOptions.maxBranchHighlights = maxBranchHighlights;
    }
    if (typeof temperature === 'number') {
      mergeOptions.temperature = temperature;
    }
    if (typeof apiBase === 'string') {
      mergeOptions.apiBase = apiBase;
    }
    if (typeof apiKey === 'string') {
      mergeOptions.apiKey = apiKey;
    }
    if (Object.keys(apiHeader).length) {
      mergeOptions.apiHeaders = apiHeader;
    }
    if (typeof responseDebug === 'string') {
      mergeOptions.responseDebugPath = path.resolve(responseDebug);
    }

    result = await mergeBranches(mergeOptions);
  }

  console.log('=== Summary ===');
  console.log(result.summary.trim());
  console.log('\n=== Recombined Path ===');
  result.combinedPath.forEach((entry, index) => {
    console.log(`${index + 1}. ${entry}`);
  });

  if (result.mergeDecisions.length) {
    console.log('\n=== Decisions ===');
    for (const decision of result.mergeDecisions) {
      console.log(`- Branches: ${decision.branchTitles.join(', ')}`);
      console.log(`  Decision: ${decision.decision}`);
      if (decision.rationale) {
        console.log(`  Rationale: ${decision.rationale}`);
      }
    }
  }

  if (result.followUpIdeas?.length) {
    console.log('\n=== Follow-up Ideas ===');
    result.followUpIdeas.forEach((idea, index) => {
      console.log(`${index + 1}. ${idea}`);
    });
  } else {
    console.log('\nNo follow-up ideas returned.');
  }

  if (harvestResult) {
    logHarvestGuardrails(harvestResult, harvestLogPath);
    if (harvestResult.guardrails.coverageFailures.length) {
      const summaryDir =
        harvestLogPath && path.dirname(harvestLogPath)
          ? path.join(path.dirname(harvestLogPath), 'remediation')
          : undefined;
      const remediation = await runCoverageRemediation(
        branches,
        harvestResult,
        summaryDir,
      );
      if (remediation.length) {
        console.log('\n=== Coverage Remediation Checks ===');
        remediation.forEach((report) => {
          const before = describeCoverage(report.before);
          const after = describeCoverage(report.after);
          const dropNote =
            report.droppedUniqueCredits && report.droppedUniqueCredits > 0
              ? `; dropped uniques pre-remediation: ${report.droppedUniqueCredits}`
              : '';
          console.log(
            ` - ${report.title} (${report.conversationId}) [coverage ${report.coverageId}]\n    Before: ${before}${dropNote}\n    After: ${after} (tokens ${report.guardrails.tokenEstimate})`,
          );
          if (report.summaryPath) {
            console.log(`    Summary: ${path.resolve(report.summaryPath)}`);
          }
        });
      }
    }
  }

  if (notePath) {
    try {
      await appendMarkdownNote({
        notePath,
        result,
        branches,
      });
      if (verbose) {
        console.log(`Appended merge summary to ${path.resolve(notePath)}.`);
      }
    } catch (error) {
      console.error('Failed to append Markdown note:', error);
    }
  }

  if (tasksPath) {
    if (!result.followUpIdeas?.length) {
      if (verbose) {
        console.log('No follow-up ideas returned; skipping task export.');
      }
    } else {
      try {
        await appendTasksFromIdeas({
          taskPath: tasksPath,
          ideas: result.followUpIdeas,
          source: taskSource,
        });
        if (verbose) {
          console.log(
            `Recorded ${result.followUpIdeas.length} task(s) to ${path.resolve(tasksPath)}.`,
          );
        }
      } catch (error) {
        console.error('Failed to append JSON tasks:', error);
      }
    }
  }

  if (notionDatabaseId) {
    const notionToken = notionTokenEnv ? process.env[notionTokenEnv] : undefined;
    if (!notionToken) {
      console.error(
        `Skipping Notion sync: environment variable ${notionTokenEnv} is not set.`,
      );
    } else {
      try {
        await publishNotionSummary({
          databaseId: notionDatabaseId,
          token: notionToken,
          result,
          branches,
          titleProperty: notionTitleProp,
          summaryProperty: notionSummaryProp,
        });
        if (verbose) {
          console.log(`Synced merge summary to Notion database ${notionDatabaseId}.`);
        }
      } catch (error) {
        console.error('Failed to publish Notion summary:', error);
      }
    }
  }

if (todoistProjectId) {
  if (!result.followUpIdeas?.length) {
      if (verbose) {
        console.log(
          `No follow-up ideas returned; skipping Todoist export for project ${todoistProjectId}.`,
        );
      }
    } else {
      const todoistToken = todoistTokenEnv
        ? process.env[todoistTokenEnv]
        : undefined;
      if (!todoistToken) {
        console.error(
          `Skipping Todoist sync: environment variable ${todoistTokenEnv} is not set.`,
        );
      } else {
        try {
          const todoistPayload: Parameters<
            typeof syncTodoistTasks
          >[0] = {
            token: todoistToken,
            projectId: todoistProjectId,
            ideas: result.followUpIdeas,
            sourceLabel: taskSource,
            ...(todoistPriority !== undefined
              ? { priority: todoistPriority }
              : {}),
            ...(todoistDueString ? { dueString: todoistDueString } : {}),
          };
          await syncTodoistTasks(todoistPayload);
          if (verbose) {
            console.log(
              `Created ${result.followUpIdeas.length} Todoist task(s) in project ${todoistProjectId}.`,
            );
          }
        } catch (error) {
          console.error('Failed to sync Todoist tasks:', error);
        }
      }
    }
  }
}

const logHarvestGuardrails = (
  harvestResult: FeatureHarvestResult,
  logPath?: string,
): void => {
  const guardrails = harvestResult.guardrails;
  console.log('\n=== Feature Harvest Guardrails ===');
  console.log(`Initial token estimate: ${guardrails.initialTokenEstimate}`);
  console.log(`Final token estimate: ${guardrails.tokenEstimate}`);
  console.log(
    `Token limit breached: ${guardrails.tokenLimitBreached ? 'yes' : 'no'}`,
  );
  if (guardrails.compression?.applied) {
    const compression = guardrails.compression;
    const parts = [
      `${compression.truncatedFeatures} truncated`,
      `${compression.droppedUniques} uniques dropped`,
      `${compression.droppedCanonicals} canonicals dropped`,
    ];
    console.log(
      `Compression applied: ${parts.join(', ')}${
        compression.summaryFallback ? ' (summary fallback)' : ''
      }`,
    );
    if (compression.notes) {
      console.log(`  Notes: ${compression.notes}`);
    }
  } else {
    console.log('Compression applied: no');
  }
  if (logPath) {
    console.log(`Guardrail log: ${logPath}`);
  }
  if (guardrails.coverageFailures.length) {
    console.log(`Coverage failures: ${guardrails.coverageFailures.join(', ')}`);
  } else {
    console.log('Coverage failures: none');
  }
  Object.entries(guardrails.coverage).forEach(([conversationId, stats]) => {
    console.log(
      ` - ${conversationId}: ${(stats.uniqueFraction * 100).toFixed(
        1,
      )}% unique coverage (${stats.uniqueKept}/${stats.uniqueTotal})`,
    );
  });
  if (guardrails.coverageAggregates) {
    console.log('Aggregated coverage per branch:');
    Object.entries(guardrails.coverageAggregates).forEach(
      ([conversationId, stats]) => {
        console.log(
          ` * ${conversationId}: ${(stats.uniqueFraction * 100).toFixed(
            1,
          )}% unique coverage (${stats.uniqueKept}/${stats.uniqueTotal})`,
        );
      },
    );
  }
};

const REMEDIATION_TOKEN_MULTIPLIER =
  Number.parseFloat(process.env.FEATURE_HARVEST_REMEDIATION_MULTIPLIER ?? '') ||
  3;

interface RemediationReport {
  conversationId: string;
  title: string;
  guardrails: GuardrailReport;
  coverageId: string;
  before?: CoverageStats;
  after?: CoverageStats;
  droppedUniqueCredits?: number;
  summaryPath?: string;
}

const COVERAGE_SUFFIX_REGEX = /(__seg\d+|__feat\d+)/gi;

const normalizeCoverageConversationId = (conversationId: string): string => {
  const normalized = conversationId.replace(COVERAGE_SUFFIX_REGEX, '');
  return normalized || conversationId;
};

const describeCoverage = (stats?: CoverageStats): string => {
  if (!stats) {
    return 'n/a';
  }
  const percent = (stats.uniqueFraction * 100).toFixed(1);
  const base = `${percent}% (${stats.uniqueKept}/${stats.uniqueTotal})`;
  const summaryCredits =
    stats.summaryCredits && stats.summaryCredits > 0
      ? ` +${stats.summaryCredits} summary`
      : '';
  return `${base}${summaryCredits}`;
};

const sanitizeForFilename = (value: string): string =>
  value
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'conversation';

const writeRemediationSummary = async ({
  summaryDir,
  conversation,
  coverageId,
  before,
  after,
  droppedUniqueCredits,
  remediated,
}: {
  summaryDir?: string;
  conversation: BrowserConversation;
  coverageId: string;
  before?: CoverageStats;
  after?: CoverageStats;
  droppedUniqueCredits?: number;
  remediated: FeatureHarvestResult;
}): Promise<string | undefined> => {
  if (!summaryDir) {
    return undefined;
  }
  try {
    await fs.mkdir(summaryDir, { recursive: true });
  } catch (error) {
    console.warn('Failed to create remediation summary directory:', error);
    return undefined;
  }
  const safeName = sanitizeForFilename(
    conversation.tabId || conversation.title || 'conversation',
  );
  const summaryPath = path.join(summaryDir, `coverage-${safeName}.md`);
  const highlightLines = remediated.uniqueFeatures
    .slice(0, 8)
    .map((feature) => {
      const text = feature.text.length > 320
        ? `${feature.text.slice(0, 317)}...`
        : feature.text;
      return `- **${feature.topicLabel}** — ${text}`;
    })
    .join('\n');
  const highlightsBlock =
    highlightLines || '- No additional unique features recovered.';
const content = `# Coverage remediation – ${conversation.title}

- Tab ID: ${conversation.tabId}
- Coverage ID: ${coverageId}
- URL: ${conversation.url}

| Metric | Before | After |
| --- | --- | --- |
| Unique coverage | ${describeCoverage(before)} | ${describeCoverage(after)} |
| Unique kept | ${before ? before.uniqueKept : 'n/a'} | ${
    after ? after.uniqueKept : 'n/a'
  } |

Dropped unique credits (initial run): ${droppedUniqueCredits ?? 0}
Remediation token estimate: ${remediated.guardrails.tokenEstimate}

## Unique highlights recovered
${highlightsBlock}
`;
  try {
    await fs.writeFile(summaryPath, `${content.trim()}\n`, 'utf-8');
    return summaryPath;
  } catch (error) {
    console.warn('Failed to write remediation summary:', error);
    return undefined;
  }
};

const runCoverageRemediation = async (
  branches: BrowserConversation[],
  harvestResult: FeatureHarvestResult,
  summaryDir?: string,
): Promise<RemediationReport[]> => {
  const { coverageFailures } = harvestResult.guardrails;
  if (!coverageFailures.length) {
    return [];
  }
  const impacted = coverageFailures
    .map((coverageId) => {
      const normalizedId = normalizeCoverageConversationId(coverageId);
      const conversation = branches.find(
        (branch) => branch.tabId === normalizedId,
      );
      if (!conversation) {
        return undefined;
      }
      return { coverageId, conversation };
    })
    .filter(
      (
        entry,
      ): entry is { coverageId: string; conversation: BrowserConversation } =>
        Boolean(entry),
    );
  if (!impacted.length) {
    return [];
  }
  const configuredMaxTokens =
    harvestResult.guardrails.maxMergeTokens ??
    DEFAULT_FEATURE_HARVEST_CONFIG.guardrails.maxMergeTokens ??
    5500;
  const maxTokens = configuredMaxTokens * REMEDIATION_TOKEN_MULTIPLIER;

  const summariesDirResolved = summaryDir
    ? path.resolve(summaryDir)
    : undefined;

  const reports: RemediationReport[] = [];
  for (const { coverageId, conversation } of impacted) {
    const remediated = runFeatureHarvestMerge({
      conversations: [conversation],
      config: {
        guardrails: {
          ...DEFAULT_FEATURE_HARVEST_CONFIG.guardrails,
          maxMergeTokens,
        },
        scientistReview: {
          ...DEFAULT_FEATURE_HARVEST_CONFIG.scientistReview,
          enabled: false,
        },
      },
      enableSplitting: false,
    });
    const after = remediated.guardrails.coverage[conversation.tabId];
    const before =
      harvestResult.guardrails.coverageAggregates?.[coverageId] ??
      harvestResult.guardrails.coverage[coverageId];
    const dropped =
      harvestResult.guardrails.droppedUniqueCredits?.[
        coverageId
      ];
    const summaryPath = await writeRemediationSummary({
      summaryDir: summariesDirResolved,
      conversation,
      coverageId,
      before,
      after,
      droppedUniqueCredits: dropped,
      remediated,
    });
    reports.push({
      conversationId: conversation.tabId,
      title: conversation.title,
      guardrails: remediated.guardrails,
      coverageId,
      before,
      after,
      droppedUniqueCredits: dropped,
      ...(summaryPath ? { summaryPath } : {}),
    });
  }
  return reports;
};

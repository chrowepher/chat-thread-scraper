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
  MergeDecision,
  ProviderPreset,
  MergeResult,
} from './types.js';
import { MESSAGE_ROLES } from './types.js';
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
  htmlReportPath?: string;
  openHtmlReport?: boolean;
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

export interface MergeReportPayload {
  inputPath: string;
  mergeResult: MergeResult;
  branches: BrowserConversation[];
  harvestResult?: FeatureHarvestResult;
  scientistVerdict?: string;
}

export interface MergeWorkflowOutput {
  payload: MergeReportPayload;
  harvestLogPath?: string | undefined;
  scientistVerdict?: string | undefined;
}

export interface PlanSummaryInfo {
  planId: string;
  runId: string;
  runDir?: string | undefined;
  representativeLabel?: string | undefined;
  representativeNotes?: string | undefined;
  representativePath?: string | undefined;
}

export interface ComparisonSideInfo {
  planId?: string | undefined;
  runId?: string | undefined;
  representativeLabel?: string | undefined;
  outputPath?: string | undefined;
}

export interface ComparisonCriterionSummary {
  name: string;
  left?: number | undefined;
  right?: number | undefined;
  delta?: number | undefined;
}

export interface ComparisonSummary {
  label: string;
  description?: string | undefined;
  winner?: 'left' | 'right' | 'tie' | undefined;
  left: ComparisonSideInfo;
  right: ComparisonSideInfo;
  summary?: string | undefined;
  markdownPath?: string | undefined;
  scorecardPath?: string | undefined;
  criteria?: ComparisonCriterionSummary[] | undefined;
}

const conversationSchema = z.object({
  tabId: z.string(),
  parentTabId: z.string().optional(),
  title: z.string(),
  url: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(MESSAGE_ROLES),
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
    return conversationArraySchema.parse(parsed) as BrowserConversation[];
  }
  const snapshot = threadSnapshotSchema.parse(parsed);
  return snapshot.conversations as BrowserConversation[];
};

export async function runMergeWorkflow(
  cliOptions: MergeCliOptions,
): Promise<MergeWorkflowOutput> {
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

  const zeroMessageBranches = branches.filter(
    (branch) => !branch.messages?.length,
  );
  if (zeroMessageBranches.length) {
    console.warn(
      `Warning: ${zeroMessageBranches.length} branch${
        zeroMessageBranches.length === 1 ? '' : 'es'
      } in ${path.basename(input)} contained 0 captured messages. ` +
        'This usually means the ChatGPT tab did not finish loading before the scraper timed out. ' +
        'Open the affected URLs in Chrome, confirm the transcript is visible, and rerun the scrape if you expect history there.',
    );
    zeroMessageBranches.slice(0, 5).forEach((branch) => {
      const label = branch.title || branch.url || branch.tabId;
      console.warn(` - ${label} (${branch.url || 'no URL recorded'})`);
    });
    if (zeroMessageBranches.length > 5) {
      console.warn(
        ` ...and ${zeroMessageBranches.length - 5} more branch${
          zeroMessageBranches.length - 5 === 1 ? '' : 'es'
        }`,
      );
    }
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
      ...(scientistClient ? { scientistClient } : {}),
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

  const payload: MergeReportPayload = {
    inputPath: input,
    mergeResult: result,
    branches,
    ...(harvestResult ? { harvestResult } : {}),
    ...(scientistVerdict ? { scientistVerdict } : {}),
  };

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

  return {
    payload,
    harvestLogPath,
    scientistVerdict,
  };
}

interface HtmlReportOptions {
  outputPath: string;
  payload: MergeReportPayload;
  planSummaries?: PlanSummaryInfo[] | undefined;
  comparisonSummaries?: ComparisonSummary[] | undefined;
}

export async function writeMergeHtmlReport(
  options: HtmlReportOptions,
): Promise<void> {
  const resolved = path.resolve(options.outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const html = renderHtmlReport({
    payload: options.payload,
    planSummaries: options.planSummaries,
    comparisonSummaries: options.comparisonSummaries,
  });
  await fs.writeFile(resolved, html, 'utf-8');
}

function renderHtmlReport(options: {
  payload: MergeReportPayload;
  planSummaries?: PlanSummaryInfo[] | undefined;
  comparisonSummaries?: ComparisonSummary[] | undefined;
}): string {
  const { payload, planSummaries, comparisonSummaries } = options;
  const {
    mergeResult,
    branches,
    harvestResult,
    scientistVerdict,
    inputPath,
  } = payload;
  const generatedAtIso = new Date().toISOString();
  const snapshotDisplay = formatDisplayPath(inputPath);
  const summaryHtml = formatSummaryBlock(mergeResult.summary);
  const combinedHtml = renderCombinedPath(mergeResult.combinedPath);
  const decisionsHtml = renderMergeDecisions(mergeResult.mergeDecisions);
  const followUpsHtml = renderFollowUpIdeas(mergeResult.followUpIdeas ?? []);
  const branchHtml = renderBranchCatalog(branches);
  const guardrailsHtml = renderGuardrailSection(harvestResult, scientistVerdict);
  const planSummariesHtml = renderPlanSummarySection(planSummaries);
  const comparisonHtml = renderComparisonSection(comparisonSummaries);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Chat Thread Merge Report</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        line-height: 1.5;
      }
      body {
        margin: 0;
        background: #0f1115;
        color: #f3f4f6;
      }
      @media (prefers-color-scheme: light) {
        body {
          background: #f7f7fb;
          color: #111827;
        }
      }
      header {
        padding: 32px;
        background: linear-gradient(135deg, #0f172a, #1e293b);
        color: #f8fafc;
      }
      header h1 {
        margin: 0 0 8px 0;
        font-size: 28px;
      }
      header .meta {
        font-size: 14px;
        opacity: 0.85;
      }
      main {
        padding: 32px;
        max-width: 960px;
        margin: 0 auto;
      }
      section {
        margin-bottom: 32px;
        padding: 24px;
        border-radius: 12px;
        background: rgba(15, 23, 42, 0.75);
      }
      @media (prefers-color-scheme: light) {
        section {
          background: #ffffff;
          box-shadow: 0 10px 25px rgba(15, 23, 42, 0.08);
        }
      }
      section h2 {
        margin-top: 0;
        font-size: 20px;
      }
      ol,
      ul {
        padding-left: 24px;
      }
      li + li {
        margin-top: 8px;
      }
      .combined-path li {
        background: rgba(255, 255, 255, 0.04);
        padding: 10px 12px;
        border-radius: 8px;
      }
      @media (prefers-color-scheme: light) {
        .combined-path li {
          background: rgba(15, 23, 42, 0.04);
        }
      }
      .badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 12px;
        background: rgba(59, 130, 246, 0.2);
        color: #7dd3fc;
        margin-right: 8px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 16px;
      }
      .card {
        padding: 16px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.03);
      }
      @media (prefers-color-scheme: light) {
        .card {
          background: rgba(15, 23, 42, 0.03);
        }
      }
      .json-block {
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
        background: rgba(15, 23, 42, 0.9);
        color: #e0f2fe;
        padding: 16px;
        border-radius: 10px;
        white-space: pre-wrap;
        overflow-x: auto;
      }
      @media (prefers-color-scheme: light) {
        .json-block {
          background: rgba(15, 23, 42, 0.08);
          color: #0f172a;
        }
      }
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 16px;
      }
      .summary-card {
        background: rgba(255, 255, 255, 0.03);
        padding: 16px;
        border-radius: 12px;
      }
      @media (prefers-color-scheme: light) {
        .summary-card {
          background: rgba(15, 23, 42, 0.04);
        }
      }
      .summary-card h3 {
        margin-top: 0;
        font-size: 16px;
      }
      .summary-fieldset {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .summary-field {
        display: flex;
        flex-direction: column;
        padding: 8px 0;
        border-bottom: 1px solid rgba(148, 163, 184, 0.15);
      }
      .summary-field:last-child {
        border-bottom: none;
      }
      .summary-label {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.7;
        margin-bottom: 2px;
      }
      .summary-value > ul {
        margin: 4px 0 0;
      }
      .summary-list {
        padding-left: 18px;
      }
      .comparison-card {
        padding: 20px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.03);
        margin-bottom: 20px;
        border: 1px solid rgba(148, 163, 184, 0.2);
      }
      @media (prefers-color-scheme: light) {
        .comparison-card {
          background: rgba(15, 23, 42, 0.02);
        }
      }
      .comparison-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }
      .winner-pill {
        font-size: 12px;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(34, 197, 94, 0.2);
        color: #4ade80;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .table-wrapper {
        overflow-x: auto;
        margin-top: 12px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        text-align: left;
        padding: 8px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.2);
      }
      .warn {
        color: #fbbf24;
      }
      .muted {
        opacity: 0.75;
      }
      footer {
        padding: 24px 32px 48px;
        font-size: 13px;
        text-align: center;
        color: rgba(248, 250, 252, 0.7);
      }
      @media (prefers-color-scheme: light) {
        footer {
          color: rgba(15, 23, 42, 0.6);
        }
      }
      a {
        color: #7dd3fc;
      }
      @media (prefers-color-scheme: light) {
        a {
          color: #2563eb;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Chat Thread Merge Report</h1>
      <div class="meta">
        Snapshot: ${escapeHtml(snapshotDisplay)} • Generated ${escapeHtml(
          generatedAtIso,
        )}
      </div>
    </header>
    <main>
      <section>
        <h2>Executive Summary</h2>
        ${summaryHtml}
      </section>
      <section>
        <h2>Recombined Path</h2>
        ${combinedHtml}
      </section>
      <section>
        <h2>Merge Analysis</h2>
        ${decisionsHtml}
      </section>
      <section>
        <h2>Follow-up Ideas</h2>
        ${followUpsHtml}
      </section>
      ${guardrailsHtml}
      ${planSummariesHtml}
      ${comparisonHtml}
      <section>
        <h2>Branch Catalog</h2>
        ${branchHtml}
      </section>
    </main>
    <footer>
      Generated by chat-thread-merger autopilot • ${escapeHtml(generatedAtIso)}
    </footer>
  </body>
</html>`;
}

function formatSummaryBlock(summary: string): string {
  const trimmed = summary.trim();
  if (!trimmed) {
    return '<p class="muted">No summary was returned.</p>';
  }
  const parsed = tryParseJson(trimmed);
  if (parsed !== undefined) {
    return renderSummaryObject(parsed);
  }
  return formatSummaryParagraphs(trimmed);
}

function formatSummaryParagraphs(summary: string): string {
  const paragraphs = summary
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  return paragraphs
    .map(
      (paragraph) =>
        `<p>${escapeHtml(paragraph).replace(/\n/g, '<br />')}</p>`,
    )
    .join('\n');
}

function renderSummaryObject(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return '<p class="muted">Structured summary was empty.</p>';
  }
  if (Array.isArray(payload)) {
    if (!payload.length) {
      return '<p class="muted">Structured summary list is empty.</p>';
    }
    const cards = payload
      .map(
        (entry, index) => `<article class="summary-card">
            <h3>${escapeHtml(`Item ${index + 1}`)}</h3>
            ${renderSummaryValue(entry)}
          </article>`,
      )
      .join('\n');
    return `<div class="summary-grid">${cards}</div>`;
  }
  if (typeof payload !== 'object') {
    return `<p>${escapeHtml(String(payload))}</p>`;
  }
  const entries = Object.entries(payload as Record<string, unknown>);
  if (!entries.length) {
    return '<p class="muted">Structured summary was empty.</p>';
  }
  const sections = entries
    .map(([key, value]) => renderSummarySection(key, value))
    .join('\n');
  return `<div class="summary-grid">${sections}</div>`;
}

function renderSummarySection(label: string, value: unknown): string {
  return `<article class="summary-card">
    <h3>${escapeHtml(formatSummaryLabel(label))}</h3>
    ${renderSummaryValue(value)}
  </article>`;
}

function renderSummaryValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '<p class="muted">No data.</p>';
  }
  if (typeof value === 'string') {
    return `<p>${escapeHtml(value)}</p>`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `<p><code>${escapeHtml(String(value))}</code></p>`;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      return '<p class="muted">No entries.</p>';
    }
    const items = value
      .map((entry) => `<li>${renderSummaryListItem(entry)}</li>`)
      .join('\n');
    return `<ul class="summary-list">${items}</ul>`;
  }
  if (typeof value === 'object') {
    const rows = Object.entries(value as Record<string, unknown>);
    if (!rows.length) {
      return '<p class="muted">No fields.</p>';
    }
    const fields = rows
      .map(
        ([childKey, childValue]) => `<div class="summary-field">
          <div class="summary-label">${escapeHtml(formatSummaryLabel(childKey))}</div>
          <div class="summary-value">${renderSummaryValue(childValue)}</div>
        </div>`,
      )
      .join('\n');
    return `<div class="summary-fieldset">${fields}</div>`;
  }
  return `<p>${escapeHtml(String(value))}</p>`;
}

function renderSummaryListItem(value: unknown): string {
  if (value === null || value === undefined) {
    return '<span class="muted">n/a</span>';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return escapeHtml(String(value));
  }
  if (Array.isArray(value) || typeof value === 'object') {
    return renderSummaryValue(value);
  }
  return escapeHtml(String(value));
}

function formatSummaryLabel(label: string): string {
  return label
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function renderCombinedPath(entries: string[]): string {
  if (!entries.length) {
    return '<p class="muted">No recombined steps were emitted.</p>';
  }
  const listItems = entries
    .map((entry) => `<li>${escapeHtml(entry)}</li>`)
    .join('\n');
  return `<ol class="combined-path">${listItems}</ol>`;
}

function renderMergeDecisions(decisions: MergeDecision[]): string {
  if (!decisions.length) {
    return '<p class="muted">The merge workflow did not record any explicit decisions.</p>';
  }
  return decisions
    .map((decision) => {
      const rationale = decision.rationale
        ? `<div class="muted">${escapeHtml(decision.rationale)}</div>`
        : '';
      return `<div class="card">
        <div><span class="badge">Branches</span>${escapeHtml(
          decision.branchTitles.join(', '),
        )}</div>
        <div><span class="badge">Decision</span>${escapeHtml(
          decision.decision,
        )}</div>
        ${rationale}
      </div>`;
    })
    .join('\n');
}

function renderFollowUpIdeas(ideas: string[]): string {
  if (!ideas.length) {
    return '<p class="muted">No follow-up ideas were generated.</p>';
  }
  const items = ideas
    .map((idea) => `<li>${escapeHtml(idea)}</li>`)
    .join('\n');
  return `<ul>${items}</ul>`;
}

function renderBranchCatalog(branches: BrowserConversation[]): string {
  if (!branches.length) {
    return '<p class="muted">No branches were available in the snapshot.</p>';
  }
  const items = branches
    .map((branch, index) => {
      const title = branch.title || `Conversation ${index + 1}`;
      const url = branch.url
        ? `<a href="${escapeAttribute(branch.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
            branch.url,
          )}</a>`
        : 'n/a';
      const messageCount = branch.messages?.length ?? 0;
      const zeroNotice =
        messageCount === 0
          ? '<div class="warn">No messages captured — open the link in Chrome and ensure you are logged in before re-running the scrape.</div>'
          : '';
      return `<div class="card">
        <div><span class="badge">B${index + 1}</span>${escapeHtml(title)}</div>
        <div class="muted">${url}</div>
        <div class="muted">${messageCount} message${
          messageCount === 1 ? '' : 's'
        }</div>
        ${zeroNotice}
      </div>`;
    })
    .join('\n');
  return `<div class="grid">${items}</div>`;
}

function renderGuardrailSection(
  harvestResult?: FeatureHarvestResult,
  scientistVerdict?: string,
): string {
  if (!harvestResult && !scientistVerdict) {
    return '';
  }
  const guardrails = harvestResult?.guardrails;
  const verdictBlock = scientistVerdict
    ? `<p><span class="badge">Scientist verdict</span>${escapeHtml(
        scientistVerdict,
      )}</p>`
    : '';

  if (!guardrails) {
    return `<section>
      <h2>Feature Harvest Insights</h2>
      ${verdictBlock || '<p class="muted">No guardrail telemetry available.</p>'}
    </section>`;
  }

  const coverageRows = guardrails.coverage
    ? Object.entries(guardrails.coverage)
        .map(
          ([conversationId, stats]) => `<tr>
        <td>${escapeHtml(conversationId)}</td>
        <td>${formatPercent(stats.uniqueFraction)}</td>
        <td>${stats.uniqueKept}/${stats.uniqueTotal}</td>
        <td>${stats.summaryCredits ?? 0}</td>
      </tr>`,
        )
        .join('\n')
    : '';

  const coverageTable = coverageRows
    ? `<div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Conversation</th>
              <th>Unique coverage</th>
              <th>Unique kept</th>
              <th>Summary credits</th>
            </tr>
          </thead>
          <tbody>${coverageRows}</tbody>
        </table>
      </div>`
    : '<p class="muted">No per-branch coverage stats were recorded.</p>';

  const compressionNotes = guardrails.compression?.applied
    ? `<p>Compression: ${guardrails.compression.truncatedFeatures} truncated • ${guardrails.compression.droppedUniques} unique(s) dropped • ${guardrails.compression.droppedCanonicals} canonical(s) dropped ${
        guardrails.compression.summaryFallback ? '• summary fallback' : ''
      }</p>${guardrails.compression.notes ? `<p class="muted">${escapeHtml(guardrails.compression.notes)}</p>` : ''}`
    : '<p>Compression: not applied.</p>';

  const failures = guardrails.coverageFailures?.length
    ? `<p class="warn">Coverage failures: ${escapeHtml(
        guardrails.coverageFailures.join(', '),
      )}</p>`
    : '<p>Coverage failures: none.</p>';

  return `<section>
    <h2>Feature Harvest Insights</h2>
    <div class="grid">
      <div class="card">
        <div><span class="badge">Token estimate</span>${guardrails.initialTokenEstimate} → ${guardrails.tokenEstimate}</div>
        <div><span class="badge">Token limit</span>${
          guardrails.tokenLimitBreached ? 'breached' : 'within limits'
        }</div>
      </div>
      <div class="card">
        ${verdictBlock || '<div class="muted">Scientist reviewer not configured.</div>'}
      </div>
    </div>
    ${failures}
    ${compressionNotes}
    ${coverageTable}
  </section>`;
}

function renderPlanSummarySection(
  planSummaries?: PlanSummaryInfo[],
): string {
  if (!planSummaries?.length) {
    return '';
  }
  const cards = planSummaries
    .map((plan) => {
      const runDisplay = plan.runDir
        ? formatDisplayPath(plan.runDir)
        : plan.runId;
      const repPath = plan.representativePath
        ? formatDisplayPath(plan.representativePath)
        : undefined;
      const notes =
        plan.representativeNotes && plan.representativeNotes.length
          ? `<div class="muted">${escapeHtml(plan.representativeNotes)}</div>`
          : '';
      return `<div class="card">
        <div><span class="badge">Plan</span>${escapeHtml(plan.planId)}</div>
        <div class="muted">Run: ${escapeHtml(plan.runId)}</div>
        ${
          runDisplay
            ? `<div class="muted">${escapeHtml(runDisplay)}</div>`
            : ''
        }
        ${
          plan.representativeLabel
            ? `<div><span class="badge">Representative</span>${escapeHtml(
                plan.representativeLabel,
              )}</div>`
            : ''
        }
        ${
          repPath
            ? `<div class="muted">Output: ${escapeHtml(repPath)}</div>`
            : ''
        }
        ${notes}
      </div>`;
    })
    .join('\n');
  return `<section>
    <h2>Experiment Plans</h2>
    <div class="grid">${cards}</div>
  </section>`;
}

function renderComparisonSection(
  comparisons?: ComparisonSummary[],
): string {
  if (!comparisons?.length) {
    return '';
  }
  const cards = comparisons
    .map((comparison) => {
      const winnerLabel =
        comparison.winner === 'left'
          ? comparison.left.representativeLabel ?? 'Left'
          : comparison.winner === 'right'
            ? comparison.right.representativeLabel ?? 'Right'
            : 'n/a';
      const summaryBlock = comparison.summary
        ? `<p>${escapeHtml(comparison.summary)}</p>`
        : '';
      const resourceLines = [
        comparison.markdownPath
          ? `<div class="muted">Critique: ${escapeHtml(
              formatDisplayPath(comparison.markdownPath),
            )}</div>`
          : '',
        comparison.scorecardPath
          ? `<div class="muted">Scorecard: ${escapeHtml(
              formatDisplayPath(comparison.scorecardPath),
            )}</div>`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      const criteriaTable = renderComparisonCriteria(comparison.criteria);
      return `<div class="comparison-card">
        <div class="comparison-header">
          <h3>${escapeHtml(comparison.label)}</h3>
          <div class="winner-pill">Winner: ${escapeHtml(winnerLabel)}</div>
        </div>
        ${
          comparison.description
            ? `<p class="muted">${escapeHtml(comparison.description)}</p>`
            : ''
        }
        ${summaryBlock}
        ${criteriaTable}
        ${resourceLines}
      </div>`;
    })
    .join('\n');
  return `<section>
    <h2>Comparison Results</h2>
    ${cards}
  </section>`;
}

function renderComparisonCriteria(
  criteria?: ComparisonCriterionSummary[],
): string {
  if (!criteria?.length) {
    return '<p class="muted">No score details were recorded.</p>';
  }
  const rows = criteria
    .map(
      (criterion) => `<tr>
        <td>${escapeHtml(criterion.name)}</td>
        <td>${criterion.left ?? '—'}</td>
        <td>${criterion.right ?? '—'}</td>
        <td>${criterion.delta ?? '—'}</td>
      </tr>`,
    )
    .join('\n');
  return `<div class="table-wrapper">
    <table>
      <thead>
        <tr>
          <th>Criterion</th>
          <th>Left</th>
          <th>Right</th>
          <th>Δ</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function formatDisplayPath(target: string): string {
  const resolved = path.resolve(target);
  const relative = path.relative(process.cwd(), resolved);
  if (relative && !relative.startsWith('..')) {
    return relative;
  }
  return resolved;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/\(/g, '&#40;').replace(/\)/g, '&#41;');
}

function formatPercent(value?: number): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }
  return `${(value * 100).toFixed(1)}%`;
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
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
          maxMergeTokens: maxTokens,
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
    const summaryPayload = {
      ...(summariesDirResolved ? { summaryDir: summariesDirResolved } : {}),
      conversation,
      coverageId,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(dropped !== undefined ? { droppedUniqueCredits: dropped } : {}),
      remediated,
    };
    const summaryPath = await writeRemediationSummary(summaryPayload);
    const report: RemediationReport = {
      conversationId: conversation.tabId,
      title: conversation.title,
      guardrails: remediated.guardrails,
      coverageId,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(dropped !== undefined ? { droppedUniqueCredits: dropped } : {}),
      ...(summaryPath ? { summaryPath } : {}),
    };
    reports.push(report);
  }
  return reports;
};

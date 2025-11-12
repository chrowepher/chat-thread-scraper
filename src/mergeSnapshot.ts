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
} from './types.js';

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
}

const conversationSchema = z.object({
  tabId: z.string(),
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

  const result = await mergeBranches(mergeOptions);

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

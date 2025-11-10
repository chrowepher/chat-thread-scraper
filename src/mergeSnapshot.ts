#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
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

interface MergeCliOptions {
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

const parseInteger = (label: string) => (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`${label} must be a number.`);
  }
  return parsed;
};

const parseFloatOption = (label: string) => (value: string): number => {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`${label} must be a number.`);
  }
  return parsed;
};

const collectHeaderOption = (
  value: string,
  previous: Record<string, string> = {},
): Record<string, string> => {
  const separatorIndex = value.indexOf('=');
  if (separatorIndex === -1) {
    throw new InvalidArgumentError(
      '--api-header values must be in the form key=value',
    );
  }
  const key = value.slice(0, separatorIndex).trim();
  const headerValue = value.slice(separatorIndex + 1).trim();
  if (!key || !headerValue) {
    throw new InvalidArgumentError(
      '--api-header values must supply both a key and a value',
    );
  }
  return {
    ...previous,
    [key]: headerValue,
  };
};

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

const program = new Command();

program
  .name('chat-thread-merge-snapshot')
  .description(
    'Merge ChatGPT conversation branches from an existing snapshot JSON file.',
  )
  .option(
    '--input <path>',
    'Path to the snapshot JSON produced by chat-thread-scraper.',
    path.join('snapshots', 'digital-nomad.json'),
  )
  .option(
    '--branch-limit <number>',
    'Limit how many branches from the snapshot are merged.',
    parseInteger('branch-limit'),
  )
  .option('--model <name>', 'OpenAI or compatible model name.', 'gpt-4.1-mini')
  .option(
    '--max-branch-highlights <number>',
    'Preferred maximum number of message highlights per branch.',
    parseInteger('max-branch-highlights'),
  )
  .option(
    '--temperature <number>',
    'Sampling temperature for the merge model.',
    parseFloatOption('temperature'),
  )
  .option('--provider <name>', 'Model provider preset.', 'openai')
  .option('--api-base <url>', 'Override the API base URL.')
  .option('--api-key <key>', 'Explicit API key for the provider.')
  .option(
    '--api-key-env <name>',
    'Environment variable that stores the API key.',
    'OPENAI_API_KEY',
  )
  .option(
    '--api-header <key=value>',
    'Additional header to include when calling the API (repeatable).',
    collectHeaderOption,
    {},
  )
  .option('--note-path <path>', 'Append the merge as Markdown to this file.')
  .option(
    '--tasks-path <path>',
    'Append follow-up ideas as JSON tasks to this file.',
  )
  .option(
    '--task-source <name>',
    'Label recorded with exported tasks.',
    'chat-thread-merger',
  )
  .option(
    '--notion-database-id <id>',
    'Notion database ID to sync merge summaries into.',
  )
  .option(
    '--notion-token-env <name>',
    'Environment variable that stores the Notion API token.',
    'NOTION_API_KEY',
  )
  .option(
    '--notion-title-prop <name>',
    'Title property for Notion records.',
    'Name',
  )
  .option(
    '--notion-summary-prop <name>',
    'Rich text property for the merge summary in Notion.',
    'Summary',
  )
  .option(
    '--todoist-project-id <id>',
    'Todoist project ID for exporting follow-up ideas.',
  )
  .option(
    '--todoist-token-env <name>',
    'Environment variable that stores the Todoist API token.',
    'TODOIST_API_KEY',
  )
  .option(
    '--todoist-priority <1-4>',
    'Todoist priority value applied to exported tasks.',
    parseInteger('todoist-priority'),
  )
  .option(
    '--todoist-due-string <text>',
    'Natural-language due date applied to Todoist tasks.',
  )
  .option(
    '--response-debug <path>',
    'Write the raw OpenAI response JSON to this file for inspection.',
  )
  .option('--verbose', 'Print additional progress information.')
  .showHelpAfterError();

async function main(cliOptions: MergeCliOptions): Promise<void> {
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
          await syncTodoistTasks({
            token: todoistToken,
            projectId: todoistProjectId,
            ideas: result.followUpIdeas,
            priority: todoistPriority,
            dueString: todoistDueString,
            sourceLabel: taskSource,
          });
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

program
  .action(async (options: MergeCliOptions) => {
    try {
      await main(options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  })
  .parseAsync(process.argv)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

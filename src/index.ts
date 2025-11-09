#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import {
  collectChatGPTConversations,
  collectConversationsForUrls,
} from './chromeCollector.js';
import type {
  ChromeCollectorOptions,
  CollectByUrlOptions,
} from './chromeCollector.js';
import { mergeBranches } from './openaiMerge.js';
import type { MergeOptions } from './openaiMerge.js';
import { appendMarkdownNote } from './output/noteSink.js';
import { appendTasksFromIdeas } from './output/taskSink.js';
import { publishNotionSummary } from './output/integrations/notion.js';
import { syncTodoistTasks } from './output/integrations/todoist.js';
import { loadBookmarkFolderEntries } from './bookmarks.js';
import type { BookmarkEntry, BookmarkLoadOptions } from './bookmarks.js';
import type {
  BrowserConversation,
  MergeDecision,
  MergeResult,
  ProviderPreset,
} from './types.js';

interface CliOptions {
  host?: string;
  port?: number;
  include?: string[];
  fromFile?: string;
  saveSnapshot?: string;
  model?: string;
  maxBranchHighlights?: number;
  dryRun?: boolean;
  verbose?: boolean;
  temperature?: number;
  notePath?: string;
  tasksPath?: string;
  taskSource?: string;
  provider?: ProviderPreset;
  apiBase?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  apiHeader?: Record<string, string>;
  notionDatabaseId?: string;
  notionTokenEnv?: string;
  notionTitleProp?: string;
  notionSummaryProp?: string;
  todoistProjectId?: string;
  todoistTokenEnv?: string;
  todoistPriority?: number;
  todoistDueString?: string;
  autoChatGPT?: boolean;
  chatgptMode?: string;
  chatgptPython?: string;
  chatgptScript?: string;
  bookmarkFolder?: string[];
  bookmarkProfile?: string;
  bookmarkPath?: string;
  bookmarkCachePath?: string;
  bookmarkCaseSensitive?: boolean;
  bookmarkKeepTabs?: boolean;
}

const program = new Command();

const parseInteger = (value: string, fallback: number): number => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseFloatOption = (value: string, fallback: number): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const ensureArray = (value?: string | string[]): string[] => {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

const collectHeaderOption = (
  value: string,
  previous: Record<string, string> = {},
): Record<string, string> => {
  const index = value.indexOf('=');
  if (index === -1) {
    console.warn(
      `Ignoring --api-header "${value}" because it is missing the "=" delimiter.`,
    );
    return previous;
  }

  const key = value.slice(0, index).trim();
  const headerValue = value.slice(index + 1).trim();
  if (!key) {
    console.warn(
      `Ignoring --api-header "${value}" because the header name is empty.`,
    );
    return previous;
  }

  return {
    ...previous,
    [key]: headerValue,
  };
};

const snapshotSchema = z.array(
  z.object({
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
  }),
);

interface ChatGPTAutomationPayload {
  generatedAt: string;
  summary: string;
  combinedPath: string[];
  mergeDecisions: MergeDecision[];
  followUpIdeas: string[];
  branches: Array<{
    title: string;
    url: string;
    messageCount: number;
  }>;
  message: string;
}

const buildChatGPTAutomationPayload = ({
  result,
  branches,
}: {
  result: MergeResult;
  branches: BrowserConversation[];
}): ChatGPTAutomationPayload => {
  const timestamp = new Date().toISOString();
  return {
    generatedAt: timestamp,
    summary: result.summary,
    combinedPath: result.combinedPath,
    mergeDecisions: result.mergeDecisions,
    followUpIdeas: result.followUpIdeas ?? [],
    branches: branches.map((branch) => ({
      title: branch.title,
      url: branch.url,
      messageCount: branch.messages.length,
    })),
    message: formatChatGPTMessage(result, branches, timestamp),
  };
};

const formatChatGPTMessage = (
  result: MergeResult,
  branches: BrowserConversation[],
  timestamp: string,
): string => {
  const lines: string[] = [];
  lines.push(`Merged ChatGPT Streams — ${timestamp}`);
  lines.push('');
  lines.push('Summary:');
  lines.push(result.summary.trim());
  if (result.combinedPath.length) {
    lines.push('');
    lines.push('Combined Path:');
    result.combinedPath.forEach((entry, index) => {
      lines.push(`${index + 1}. ${entry}`);
    });
  }
  if (result.mergeDecisions.length) {
    lines.push('');
    lines.push('Merge Decisions:');
    result.mergeDecisions.forEach((decision, index) => {
      const titles = decision.branchTitles?.length
        ? decision.branchTitles.join(' + ')
        : `Decision ${index + 1}`;
      lines.push(`- ${titles}: ${decision.decision}`);
      if (decision.rationale) {
        lines.push(`  Rationale: ${decision.rationale}`);
      }
    });
  }
  if (result.followUpIdeas?.length) {
    lines.push('');
    lines.push('Follow-up Ideas:');
    result.followUpIdeas.forEach((idea, index) => {
      lines.push(`${index + 1}. ${idea}`);
    });
  }
  if (branches.length) {
    lines.push('');
    lines.push('Source Branches:');
    branches.forEach((branch) => {
      lines.push(`- ${branch.title} (${branch.url}) — ${branch.messages.length} messages`);
    });
  }
  lines.push('');
  lines.push(
    'Please review this merged narrative and continue the conversation from here.',
  );
  return lines.join('\n');
};

interface RunChatGPTAutomationOptions {
  payload: ChatGPTAutomationPayload;
  pythonPath: string;
  scriptPath: string;
  mode: 'auto' | 'confirm';
  host: string;
  port: number;
  verbose?: boolean;
}

const runChatGPTAutomation = async ({
  payload,
  pythonPath,
  scriptPath,
  mode,
  host,
  port,
  verbose,
}: RunChatGPTAutomationOptions): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (verbose) {
      console.log(
        `Launching ChatGPT automation helper (${pythonPath} ${scriptPath})...`,
      );
    }
    const args = [
      scriptPath,
      '--mode',
      mode,
      '--cdp-host',
      host,
      '--cdp-port',
      String(port),
    ];
    const child = spawn(pythonPath, args, {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.on('error', (error) => {
      reject(error);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `ChatGPT automation helper exited with status ${code ?? 'unknown'}.`,
          ),
        );
      }
    });
    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  });

program.parseAsync().catch((error) => {
  console.error(error);
  process.exit(1);
});
};

program
  .name('chat-thread-merger')
  .description(
    'Collect open ChatGPT conversations from Chrome and merge them into one stream.',
  )
  .option('--host <host>', 'Chrome remote debugging host', '127.0.0.1')
  .option('--port <port>', 'Chrome remote debugging port', (value) =>
    parseInteger(value, 9222),
  )
  .option(
    '--include <pattern>',
    'Include only tabs whose URL matches this regex (repeatable).',
    (value: string, previous: string[] = []) => [...previous, value],
    [] as string[],
  )
  .option(
    '--from-file <path>',
    'Load previously saved conversation data instead of talking to Chrome.',
  )
  .option(
    '--save-snapshot <path>',
    'Write the collected conversation data to a JSON file for reuse.',
  )
  .option('--model <model>', 'OpenAI model to use', 'gpt-4.1-mini')
  .option(
    '--max-branch-highlights <count>',
    'Limit the number of messages pulled from each branch.',
    (value) => parseInteger(value, 12),
    12,
  )
  .option('--dry-run', 'Collect threads but skip the OpenAI merge call', false)
  .option('--verbose', 'Enable verbose logging', false)
  .option(
    '--temperature <value>',
    'Sampling temperature for the OpenAI call (0-1).',
    (value) => parseFloatOption(value, 0.2),
  )
  .option(
    '--provider <name>',
    'Model provider preset (openai|openrouter|custom).',
    'openai',
  )
  .option(
    '--api-base <url>',
    'Override the OpenAI-compatible base URL (use with --provider custom).',
  )
  .option('--api-key <key>', 'Explicit API key (overrides environment).')
  .option(
    '--api-key-env <name>',
    'Environment variable to read the API key from.',
    'OPENAI_API_KEY',
  )
  .option(
    '--api-header <key=value>',
    'Additional HTTP header for the model provider (repeatable).',
    collectHeaderOption,
    {},
  )
  .option(
    '--note-path <path>',
    'Append the merged summary to this Markdown file (note-taking sink).',
  )
  .option(
    '--tasks-path <path>',
    'Append follow-up ideas to this JSON file (task tracker sink).',
  )
  .option(
    '--task-source <label>',
    'Label to attach to exported tasks.',
    'chat-thread-merger',
  )
  .option(
    '--notion-database-id <id>',
    'Notion database ID for syncing merge summaries.',
  )
  .option(
    '--notion-token-env <name>',
    'Environment variable that stores the Notion integration token.',
    'NOTION_API_KEY',
  )
  .option(
    '--notion-title-prop <name>',
    'Title property name in the Notion database.',
    'Name',
  )
  .option(
    '--notion-summary-prop <name>',
    'Rich text property to store the merge summary.',
    'Summary',
  )
  .option(
    '--todoist-project-id <id>',
    'Todoist project ID for follow-up ideas.',
  )
  .option(
    '--todoist-token-env <name>',
    'Environment variable with the Todoist API token.',
    'TODOIST_API_KEY',
  )
  .option(
    '--todoist-priority <1-4>',
    'Todoist priority level for created tasks.',
    (value) => parseInteger(value, 1),
    1,
  )
  .option(
    '--todoist-due-string <text>',
    'Natural language due string for Todoist tasks (e.g., "tomorrow").',
  )
  .option(
    '--bookmark-folder <name>',
    'Name of a Chrome bookmarks folder to harvest URLs from (repeatable).',
    (value: string, previous: string[] = []) => [...previous, value],
    [] as string[],
  )
  .option(
    '--bookmark-profile <name>',
    'Chrome profile directory that stores the Bookmarks file.',
    'Default',
  )
  .option(
    '--bookmark-path <path>',
    'Explicit path to a Chrome Bookmarks file (overrides --bookmark-profile).',
  )
  .option(
    '--bookmark-cache <path>',
    'Write the resolved bookmark URLs to this JSON file for inspection.',
  )
  .option(
    '--bookmark-case-sensitive',
    'Treat bookmark-folder matching as case-sensitive.',
  )
  .option(
    '--bookmark-keep-tabs',
    'Keep any tabs opened from bookmarks alive after extraction.',
  )
  .option('--auto-chatgpt', 'Send the merged narrative into ChatGPT automatically.')
  .option(
    '--chatgpt-mode <mode>',
    'Automation mode: "auto" to send immediately or "confirm" to wait for manual approval.',
    'auto',
  )
  .option(
    '--chatgpt-python <path>',
    'Python executable to launch the ChatGPT automation helper.',
    'python',
  )
  .option(
    '--chatgpt-script <path>',
    'Path to the ChatGPT automation helper script.',
    'scripts/post_to_chatgpt.py',
  )
  .action(async (cliOptions) => {
    const options = cliOptions as CliOptions;
    const {
      host = '127.0.0.1',
      port = 9222,
      model = 'gpt-4.1-mini',
      maxBranchHighlights,
      dryRun,
      verbose,
      notePath,
      tasksPath,
      taskSource = 'chat-thread-merger',
      provider = 'openai',
      apiBase,
      apiKey,
      apiKeyEnv = 'OPENAI_API_KEY',
      apiHeader: apiHeaders = {},
      notionDatabaseId,
      notionTokenEnv = 'NOTION_API_KEY',
      notionTitleProp = 'Name',
      notionSummaryProp = 'Summary',
      todoistProjectId,
      todoistTokenEnv = 'TODOIST_API_KEY',
      todoistPriority = 1,
      todoistDueString,
      autoChatGPT = false,
      chatgptMode = 'auto',
      chatgptPython = 'python',
      chatgptScript = 'scripts/post_to_chatgpt.py',
      bookmarkFolder = [],
      bookmarkProfile = 'Default',
      bookmarkPath,
      bookmarkCachePath,
      bookmarkCaseSensitive = false,
      bookmarkKeepTabs = false,
    } = options;

    const includePatterns = ensureArray(options.include);
    const bookmarkFolders = ensureArray(bookmarkFolder);
    const highlightPreferenceRaw =
      typeof maxBranchHighlights === 'number' && Number.isFinite(maxBranchHighlights)
        ? Math.trunc(maxBranchHighlights)
        : 12;
    const highlightLimitForCollector =
      highlightPreferenceRaw > 0 ? highlightPreferenceRaw : undefined;

    let branches: BrowserConversation[] = [];
    let bookmarkEntries: BookmarkEntry[] = [];

    if (!options.fromFile && bookmarkFolders.length) {
      try {
        const bookmarkLoadOptions: BookmarkLoadOptions = {
          folderNames: bookmarkFolders,
          caseSensitive: Boolean(bookmarkCaseSensitive),
        };
        if (bookmarkPath) {
          bookmarkLoadOptions.bookmarksPath = path.resolve(bookmarkPath);
        } else {
          bookmarkLoadOptions.profile = bookmarkProfile;
        }
        const bookmarkResult = await loadBookmarkFolderEntries(
          bookmarkLoadOptions,
        );
        bookmarkEntries = bookmarkResult.entries;
        console.log(
          `Loaded ${bookmarkEntries.length} bookmark URLs from ${bookmarkFolders.join(', ')} (source: ${bookmarkResult.resolvedPath}).`,
        );
        if (verbose && bookmarkResult.folderSummaries.length) {
          bookmarkResult.folderSummaries.forEach((summary) => {
            console.log(
              `  • ${summary.folderPath} → ${summary.entryCount} URLs`,
            );
          });
        }
        if (bookmarkCachePath) {
          const resolvedCache = path.resolve(bookmarkCachePath);
          await fs.writeFile(
            resolvedCache,
            JSON.stringify(bookmarkEntries, null, 2),
            'utf-8',
          );
          if (verbose) {
            console.log(`Wrote bookmark cache to ${resolvedCache}`);
          }
        }
      } catch (error) {
        throw new Error(`Unable to load bookmarks: ${String(error)}`);
      }
    }

    if (options.fromFile) {
      const resolved = path.resolve(options.fromFile);
      if (verbose) {
        console.log(`Loading conversation data from ${resolved}`);
      }
      try {
        const raw = await fs.readFile(resolved, 'utf-8');
        const parsed = snapshotSchema.parse(JSON.parse(raw));
        branches = parsed as BrowserConversation[];
      } catch (error) {
        throw new Error(
          `Unable to load conversation snapshot at ${resolved}: ${String(error)}`,
        );
      }
    } else if (bookmarkEntries.length) {
      const urls = bookmarkEntries.map((entry) => entry.url);
      const urlCollectorOptions: CollectByUrlOptions = {
        urls,
        host,
        port,
        keepOpen: Boolean(bookmarkKeepTabs),
      };
      if (typeof highlightLimitForCollector === 'number') {
        urlCollectorOptions.maxMessagesPerConversation = highlightLimitForCollector;
      }
      if (typeof verbose === 'boolean') {
        urlCollectorOptions.verbose = verbose;
      }
      branches = await collectConversationsForUrls(urlCollectorOptions);
    } else {
      if (verbose) {
        console.log(
          `Connecting to Chrome DevTools protocol at ${host}:${port}...`,
        );
      }
      const patterns = includePatterns.length
        ? includePatterns.map((pattern) => new RegExp(pattern, 'i'))
        : undefined;
      const collectorOptions: ChromeCollectorOptions = {
        host,
        port,
      };
      if (typeof verbose === 'boolean') {
        collectorOptions.verbose = verbose;
      }
      if (typeof highlightLimitForCollector === 'number') {
        collectorOptions.maxMessagesPerConversation = highlightLimitForCollector;
      }
      if (patterns) {
        collectorOptions.includeUrlPatterns = patterns;
      }
      branches = await collectChatGPTConversations(collectorOptions);
    }

    if (!branches.length) {
      console.error(
        'No ChatGPT branches found. Ensure Chrome is running with remote debugging enabled or provide a valid snapshot file.',
      );
      process.exitCode = 1;
      return;
    }

    if (options.saveSnapshot) {
      const snapshotPath = path.resolve(options.saveSnapshot);
      await fs.writeFile(
        snapshotPath,
        JSON.stringify(branches, null, 2),
        'utf-8',
      );
      if (verbose || !dryRun) {
        console.log(`Saved raw conversation snapshot to ${snapshotPath}`);
      }
    }

    if (dryRun) {
      console.log(
        `Collected ${branches.length} branches. Skipping merge because --dry-run was provided.`,
      );
      return;
    }

    try {
      const mergeOptions: MergeOptions = {
        branches,
        model,
        provider,
        apiKeyEnv,
      };
      if (apiBase) {
        mergeOptions.apiBase = apiBase;
      }
      if (apiKey) {
        mergeOptions.apiKey = apiKey;
      }
      if (apiHeaders && Object.keys(apiHeaders).length) {
        mergeOptions.apiHeaders = apiHeaders;
      }
      mergeOptions.maxBranchHighlights = highlightPreferenceRaw;
      if (typeof options.temperature === 'number') {
        mergeOptions.temperature = options.temperature;
      }

      const result = await mergeBranches(mergeOptions);

      console.log('=== Summary ===');
      console.log(result.summary);
      console.log('\n=== Recombined Path ===');
      result.combinedPath.forEach((item, index) => {
        console.log(`${index + 1}. ${item}`);
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
      }

      if (notePath) {
        try {
          await appendMarkdownNote({
            notePath,
            result,
            branches,
          });
          if (verbose) {
            console.log(`Appended note to ${path.resolve(notePath)}`);
          }
        } catch (error) {
          console.error(
            `Failed to write note to ${path.resolve(notePath)}:`,
            error,
          );
        }
      }

      if (tasksPath) {
        if (result.followUpIdeas?.length) {
          try {
            await appendTasksFromIdeas({
              taskPath: tasksPath,
              ideas: result.followUpIdeas,
              source: taskSource,
            });
            if (verbose) {
              console.log(
                `Appended ${result.followUpIdeas.length} follow-up ideas to ${path.resolve(tasksPath)}`,
              );
            }
          } catch (error) {
            console.error(
              `Failed to sync follow-up ideas to ${path.resolve(tasksPath)}:`,
              error,
            );
          }
        } else if (verbose) {
          console.log(
            `No follow-up ideas returned; skipping task export to ${path.resolve(tasksPath)}.`,
          );
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
              console.log(
                `Synced merge summary to Notion database ${notionDatabaseId}.`,
              );
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
              const todoistPayload: Parameters<typeof syncTodoistTasks>[0] = {
                token: todoistToken,
                projectId: todoistProjectId,
                ideas: result.followUpIdeas,
                priority: todoistPriority,
                sourceLabel: taskSource,
              };
              if (todoistDueString) {
                todoistPayload.dueString = todoistDueString;
              }
              await syncTodoistTasks(todoistPayload);
              if (verbose) {
                console.log(
                  `Created ${result.followUpIdeas.length} Todoist tasks in project ${todoistProjectId}.`,
                );
              }
            } catch (error) {
              console.error('Failed to send tasks to Todoist:', error);
            }
          }
      }
    }

    if (autoChatGPT) {
      const supportedModes = new Set(['auto', 'confirm']);
      const normalizedMode = chatgptMode.toLowerCase();
      const resolvedMode = supportedModes.has(normalizedMode)
        ? (normalizedMode as 'auto' | 'confirm')
        : 'auto';
      if (!supportedModes.has(normalizedMode)) {
        console.warn(
          `Unknown --chatgpt-mode "${chatgptMode}". Falling back to "auto".`,
        );
      }

      const resolvedScriptPath = path.resolve(chatgptScript);
      const automationPayload = buildChatGPTAutomationPayload({
        result,
        branches,
      });

      try {
        const automationOptions: RunChatGPTAutomationOptions = {
          payload: automationPayload,
          pythonPath: chatgptPython,
          scriptPath: resolvedScriptPath,
          mode: resolvedMode,
          host,
          port,
        };
        if (typeof verbose === 'boolean') {
          automationOptions.verbose = verbose;
        }
        await runChatGPTAutomation(automationOptions);
      } catch (automationError) {
        console.error(
          'ChatGPT automation helper failed. Review the logs above for details.',
          automationError,
        );
      }
    }
  } catch (error) {
    console.error('Failed to merge branches via OpenAI:', error);
    process.exitCode = 1;
  }
});


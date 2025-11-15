#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import path from 'node:path';
import process from 'node:process';
import {
  runMergeWorkflow,
  writeMergeHtmlReport,
  type MergeCliOptions,
} from './mergeSnapshot.js';

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
    '--html-report-path <path>',
    'Write the merged summary and analysis to an HTML report.',
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
  .option(
    '--harvest',
    'Use the experimental feature-harvest merger instead of OpenAI.',
  )
  .option('--verbose', 'Print additional progress information.')
  .showHelpAfterError();

program
  .action(async (options: MergeCliOptions) => {
    try {
      const output = await runMergeWorkflow(options);
      if (options.htmlReportPath) {
        await writeMergeHtmlReport({
          outputPath: path.resolve(options.htmlReportPath),
          payload: output.payload,
        });
      }
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

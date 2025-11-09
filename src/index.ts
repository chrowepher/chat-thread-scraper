#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { loadBookmarkFolderEntries } from './bookmarks.js';
import type { BookmarkLoadResult } from './bookmarks.js';
import {
  collectConversationsForUrls,
  type CollectByUrlOptions,
} from './chromeCollector.js';
import type { ThreadSnapshot } from './types.js';

interface CliOptions {
  host: string;
  port: number;
  bookmarkFolder: string[];
  bookmarkPath?: string;
  bookmarkProfile?: string;
  bookmarkCaseSensitive?: boolean;
  maxMessages?: number;
  keepTabs?: boolean;
  verbose?: boolean;
  output: string;
  pretty?: boolean;
  url: string[];
}

const collectValues = (value: string, previous: string[] = []): string[] => {
  return previous.concat(value);
};

const parseInteger = (label: string) => (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`${label} must be a number.`);
  }
  return parsed;
};

const program = new Command();

program
  .name('chat-thread-scraper')
  .description(
    'Open ChatGPT URLs from Chrome bookmarks (or explicit URLs) and save the threads to disk.',
  )
  .option('--host <host>', 'Chrome DevTools host', '127.0.0.1')
  .option('--port <number>', 'Chrome DevTools port', parseInteger('Port'), 9222)
  .option(
    '--bookmark-folder <name>',
    'Bookmark folder that contains ChatGPT threads (repeatable).',
    collectValues,
    [],
  )
  .option(
    '--bookmark-profile <name>',
    'Chrome profile directory to load bookmarks from.',
    'Default',
  )
  .option(
    '--bookmark-path <path>',
    'Explicit path to a Chrome Bookmarks JSON file.',
  )
  .option(
    '--bookmark-case-sensitive',
    'Match bookmark folder names case-sensitively.',
    false,
  )
  .option(
    '--url <chatgpt-url>',
    'Explicit ChatGPT conversation URL to scrape (repeatable).',
    collectValues,
    [],
  )
  .option(
    '--max-messages <number>',
    'Limit how many messages are captured per thread.',
    parseInteger('max-messages'),
  )
  .option(
    '--keep-tabs',
    'Keep the temporary tabs opened from bookmarks alive after scraping.',
    false,
  )
  .option(
    '--output <path>',
    'Where to write the JSON snapshot.',
    path.join('snapshots', 'latest.json'),
  )
  .option('--pretty', 'Pretty-print the snapshot JSON.', false)
  .option('--verbose', 'Enable verbose logging.', false)
  .showHelpAfterError();

program.parse(process.argv);
const cliOptions = program.opts<CliOptions>();

async function resolveBookmarkUrls(
  folders: string[],
  options: {
    path?: string;
    profile?: string;
    caseSensitive?: boolean;
  },
  verbose?: boolean,
): Promise<{ urls: Set<string>; meta?: BookmarkLoadResult }> {
  const urls = new Set<string>();
  if (!folders.length) {
    return { urls };
  }

  if (verbose) {
    console.log(
      `Loading Chrome bookmarks for folders: ${folders.join(', ')}...`,
    );
  }

  const meta = await loadBookmarkFolderEntries({
    folderNames: folders,
    bookmarksPath: options.path,
    profile: options.profile,
    caseSensitive: options.caseSensitive,
  });

  for (const entry of meta.entries) {
    if (entry.url) {
      urls.add(entry.url);
    }
  }

  if (verbose) {
    for (const summary of meta.folderSummaries) {
      console.log(
        ` - ${summary.folderPath}: ${summary.entryCount} URL${summary.entryCount === 1 ? '' : 's'}`,
      );
    }
  }

  return { urls, meta };
}

async function writeSnapshot(
  snapshot: ThreadSnapshot,
  outputPath: string,
  pretty: boolean,
): Promise<void> {
  const resolved = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const spacing = pretty ? 2 : undefined;
  await fs.writeFile(resolved, JSON.stringify(snapshot, null, spacing), 'utf-8');
  console.log(
    `Saved ${snapshot.conversations.length} conversation${snapshot.conversations.length === 1 ? '' : 's'} to ${resolved}.`,
  );
}

async function main(options: CliOptions): Promise<void> {
  const {
    host,
    port,
    bookmarkFolder,
    bookmarkPath,
    bookmarkProfile,
    bookmarkCaseSensitive,
    url,
    verbose,
    maxMessages,
    keepTabs,
    output,
    pretty,
  } = options;

  const bookmarkResult = await resolveBookmarkUrls(
    bookmarkFolder,
    {
      path: bookmarkPath,
      profile: bookmarkProfile,
      caseSensitive: bookmarkCaseSensitive,
    },
    verbose,
  );

  const requestedUrls = new Set([
    ...bookmarkResult.urls,
    ...(url ?? []),
  ].filter(Boolean));

  if (!requestedUrls.size) {
    throw new Error(
      'No URLs to scrape. Add at least one --bookmark-folder or --url value.',
    );
  }

  if (verbose) {
    console.log(
      `Opening ${requestedUrls.size} ChatGPT URL${requestedUrls.size === 1 ? '' : 's'} via Chrome at ${host}:${port}...`,
    );
  }

  const scrapeOptions: CollectByUrlOptions = {
    host,
    port,
    urls: Array.from(requestedUrls),
    keepOpen: keepTabs,
  };
  if (typeof maxMessages === 'number') {
    scrapeOptions.maxMessagesPerConversation = maxMessages;
  }
  if (typeof verbose === 'boolean') {
    scrapeOptions.verbose = verbose;
  }

  const conversations = await collectConversationsForUrls(scrapeOptions);
  if (!conversations.length) {
    console.warn('No conversations were captured from the provided URLs.');
  }

  const snapshot: ThreadSnapshot = {
    scrapedAt: new Date().toISOString(),
    source: {
      host,
      port,
      urls: scrapeOptions.urls,
    },
    conversations,
  };

  if (bookmarkResult.meta) {
    snapshot.source.bookmarks = {
      path: bookmarkResult.meta.resolvedPath,
      folders: bookmarkResult.meta.folderSummaries,
    };
  }

  await writeSnapshot(snapshot, output, Boolean(pretty));
}

main(cliOptions).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

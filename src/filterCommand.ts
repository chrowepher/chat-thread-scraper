import { Command, InvalidArgumentError } from 'commander';
import fs from 'node:fs/promises';
import { FilterDeckStore } from './filters/store.js';
import type { FilterDeckKind } from './filters/constants.js';
import { extractAnchors } from './filters/anchorExtractor.js';
import { generateTemplateSuggestions } from './filters/templateMatcher.js';
import type { ThreadSnapshot } from './types.js';
import { runFilterUiServer } from './filters/uiServer.js';

export function createFilterCommand(): Command {
  const filters = new Command('filters');
  filters.description('Inspect, edit, and export AI analysis filter decks.');

  filters
    .command('init')
    .description('Ensure the filter-deck workspace exists with seed data.')
    .action(async () => {
      const store = new FilterDeckStore();
      await store.ensureInitialized();
      const summaries = await store.summaries();
      for (const summary of summaries) {
        console.log(
          `${summary.kind} deck ready (${summary.rowCount} rows, updated ${summary.updatedAt}).`,
        );
      }
    });

  filters
    .command('list')
    .description('List deck summaries or include detailed rows.')
    .option('--deck <deck>', 'Restrict output to a single deck (flag|suggest).')
    .option('--rows', 'Include row details in the output.')
    .action(async (options: { deck?: string; rows?: boolean }) => {
      const store = new FilterDeckStore();
      const decks = options.deck
        ? [await store.loadDeck(parseDeckKind(options.deck))]
        : await store.loadAllDecks();

      for (const deck of decks) {
        console.log(`\nDeck: ${deck.kind} (${deck.rows.length} rows, updated ${deck.updatedAt})`);
        if (options.rows) {
          deck.rows.forEach((row) => {
            console.log(`- ${row.label} [${row.priority}/${row.status}] (${row.id})`);
          });
        }
      }
    });

  filters
    .command('export-csv')
    .description('Export both decks into a single CSV workbook.')
    .option(
      '--output <path>',
      'Destination CSV path.',
      'notes/filter-decks/filter-board.csv',
    )
    .action(async (options: { output: string }) => {
      const store = new FilterDeckStore();
      await store.exportCsv(options.output);
      console.log(`Wrote ${options.output}`);
    });

  filters
    .command('suggest')
    .description('Scan a snapshot and add template-based suggestions into the Suggest deck.')
    .requiredOption('--snapshot <path>', 'Path to the chat snapshot JSON.')
    .option('--limit <number>', 'Maximum suggestions to add (default 5).', parsePositiveInt, 5)
    .option('--dry-run', 'Preview suggestions without writing to disk.')
    .action(
      async (options: { snapshot: string; limit: number; dryRun?: boolean | undefined }) => {
        const snapshot = await loadSnapshot(options.snapshot);
        const anchors = extractAnchors(snapshot.conversations);
        const store = new FilterDeckStore();
        const decks = await store.loadAllDecks();
        const existingLabels = new Set(
          decks.flatMap((deck) => deck.rows.map((row) => row.label.toLowerCase())),
        );

        const suggestions = generateTemplateSuggestions(anchors, {
          limit: options.limit,
          existingLabels,
        });

        if (!suggestions.length) {
          console.log('No new suggestions matched the current anchors.');
          return;
        }

        console.log(
          `Generated ${suggestions.length} suggestion(s) from anchors: ${formatAnchorSummary(
            anchors,
          )}`,
        );
        suggestions.forEach((row) => {
          console.log(`- ${row.label} (${row.intentQuestion})`);
        });

        if (options.dryRun) {
          console.log('Dry run mode enabled; did not modify suggest deck.');
          return;
        }

        await store.upsertRows('suggest', suggestions);
        console.log('Suggest deck updated.');
      },
    );

  filters
    .command('ui')
    .description('Launch a local web UI for editing and dragging filters between decks.')
    .option('--host <host>', 'Host to bind the UI server to.', '127.0.0.1')
    .option('--port <number>', 'Port for the UI server.', parsePositiveInt, 4343)
    .option('--open', 'Automatically open the UI in your browser.')
    .action(
      async (options: { host: string; port: number; open?: boolean | undefined }) => {
        await runFilterUiServer({
          host: options.host,
          port: options.port,
          open: Boolean(options.open),
        });
      },
    );

  return filters;
}

const parseDeckKind = (value: string): FilterDeckKind => {
  if (value === 'flag' || value === 'suggest') {
    return value;
  }
  throw new InvalidArgumentError(`Deck must be "flag" or "suggest" (received "${value}").`);
};

const parsePositiveInt = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Value must be a positive integer.');
  }
  return parsed;
};

const loadSnapshot = async (snapshotPath: string): Promise<ThreadSnapshot> => {
  const raw = await fs.readFile(snapshotPath, 'utf8');
  return JSON.parse(raw) as ThreadSnapshot;
};

const formatAnchorSummary = (anchors: ReturnType<typeof extractAnchors>): string => {
  const parts: string[] = [];
  if (anchors.geographies.length) {
    parts.push(`geo: ${anchors.geographies.join(', ')}`);
  }
  if (anchors.stakeholders.length) {
    parts.push(`stakeholders: ${anchors.stakeholders.join(', ')}`);
  }
  if (anchors.themes.length) {
    parts.push(`themes: ${anchors.themes.slice(0, 3).join(', ')}`);
  }
  if (anchors.risks.length) {
    parts.push(`risks: ${anchors.risks.slice(0, 3).join(', ')}`);
  }
  return parts.join(' | ') || 'no anchors found';
};

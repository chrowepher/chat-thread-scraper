#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { loadBookmarkFolderEntries } from './bookmarks.js';
import { createGuideCommand } from './guideCommand.js';
import type { BookmarkLoadResult } from './bookmarks.js';
import {
  collectConversationsForUrls,
  type CollectByUrlOptions,
} from './chromeCollector.js';
import { runExperiment } from './experiments/runner.js';
import type { ExperimentRunnerOptions } from './experiments/runner.js';
import { ExperimentOrchestrator } from './experiments/orchestrator.js';
import type { ExperimentTask } from './experiments/orchestrator.js';
import { EmbeddingService } from './experiments/embeddingService.js';
import { CoverageAnalyzer } from './experiments/coverageAnalyzer.js';
import { MergeExecutor } from './experiments/mergeExecutor.js';
import { PythonCritiqueRunner } from './experiments/critiqueRunner.js';
import { FileStatsCritiqueRunner } from './experiments/critiqueRunner.js';
import { materializeExperimentThreads } from './experiments/threadMaterializer.js';
import { runMergeWorkflow, type MergeCliOptions } from './mergeSnapshot.js';
import type { ThreadSnapshot } from './types.js';

interface ScrapeCliOptions {
  host: string;
  port: number;
  bookmarkFolder?: string[];
  bookmarkPath?: string;
  bookmarkProfile?: string;
  bookmarkCaseSensitive?: boolean;
  maxMessages?: number;
  keepTabs?: boolean;
  maxConcurrentTabs?: number;
  verbose?: boolean;
  output: string;
  pretty?: boolean;
  url?: string[];
}

interface ExperimentCliOptions {
  threads: string[];
  branchCount?: string;
  samplePolicy?: string;
  sampleK?: number;
  treeShapes?: string[];
  seed?: number;
  plan?: string;
  calcMetrics?: boolean;
  writeTree?: string;
  writeOutput?: string;
  writeMetadata?: string;
  freshnessWeight?: number;
  noveltyWeight?: number;
  evalReplicates?: number;
  priorities?: string[];
  tieBreak?: string;
  stabilityThreshold?: number;
  runId?: string;
  description?: string;
}

interface RunCliOptions {
  runDir: string;
  listTasks?: boolean;
  executePermutations?: boolean;
  executeTournaments?: boolean;
  executeComparisons?: boolean;
}

interface AutopilotCliOptions {
  host: string;
  port: number;
  bookmarkFolder?: string[];
  bookmarkPath?: string;
  bookmarkProfile?: string;
  bookmarkCaseSensitive?: boolean;
  url?: string[];
  snapshot?: string;
  pretty?: boolean;
  keepTabs?: boolean;
  maxMessages?: number;
  skipScrape?: boolean;
  skipMerge?: boolean;
  skipExperiments?: boolean;
  skipPermutations?: boolean;
  skipTournaments?: boolean;
  skipComparisons?: boolean;
  mergeBranchLimit?: number;
  mergeMaxHighlights?: number;
  mergeModel?: string;
  mergeTemperature?: number;
  mergeNote?: string;
  mergeTasks?: string;
  mergeTaskSource?: string;
  mergeResponseDebug?: string;
  threads?: string[];
  plan?: string;
  runId?: string;
  experimentDescription?: string;
  experimentThreadsDir?: string;
  experimentMaxMessages?: number;
  experimentMaxChars?: number;
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

const parseFloatOption = (label: string) => (value: string): number => {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`${label} must be a number.`);
  }
  return parsed;
};

const parseCsvList = (value: string): string[] => {
  return value
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean);
};

const program = new Command();
program
  .name('chat-thread-merger')
  .description(
    'Scrape ChatGPT conversation threads or scaffold merge experiments with sampling policies.',
  )
  .showHelpAfterError();

program.addCommand(createScrapeCommand(), { isDefault: true });
program.addCommand(createAutopilotCommand());
program.addCommand(createGuideCommand());
program.addCommand(createExperimentCommand());
program.addCommand(createRunCommand());

program
  .parseAsync(process.argv)
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

function createAutopilotCommand(): Command {
  const autopilot = new Command('autopilot');
  autopilot
    .description(
      'Opinionated end-to-end pipeline: scrape bookmarks/URLs, merge them, and run the default experiment plan.',
    )
    .option('--host <host>', 'Chrome DevTools host', '127.0.0.1')
    .option('--port <number>', 'Chrome DevTools port', parseInteger('Port'), 9222)
    .option(
      '--bookmark-folder <name>',
      'Bookmark folder that contains ChatGPT threads (repeatable).',
      collectValues,
      ['Digital Nomad'],
    )
    .option('--bookmark-path <path>', 'Explicit path to the Chrome Bookmarks file.')
    .option(
      '--bookmark-profile <name>',
      'Chrome profile directory to load bookmarks from.',
      'Default',
    )
    .option(
      '--bookmark-case-sensitive',
      'Treat bookmark folder names as case-sensitive.',
    )
    .option(
      '--url <chatgpt-url>',
      'Explicit ChatGPT URL to scrape (repeatable).',
      collectValues,
    )
    .option(
      '--snapshot <path>',
      'Snapshot output path.',
      path.join('snapshots', 'autopilot-latest.json'),
    )
    .option('--keep-tabs', 'Leave the scraped Chrome tabs open after capture.')
    .option(
      '--max-messages <number>',
      'Maximum messages to keep per conversation.',
      parseInteger('max-messages'),
    )
    .option('--no-pretty', 'Disable pretty-printed snapshot JSON output.')
    .option('--skip-scrape', 'Skip the scrape step (expects snapshot to exist).')
    .option('--skip-merge', 'Skip the merge step.')
    .option(
      '--merge-branch-limit <number>',
      'Limit how many branches are merged.',
      parseInteger('merge-branch-limit'),
    )
    .option(
      '--merge-max-highlights <number>',
      'Maximum highlights per branch in the merge.',
      parseInteger('merge-max-highlights'),
    )
    .option(
      '--merge-model <model>',
      'Model used for the merge step.',
      'gpt-4.1-mini',
    )
    .option(
      '--merge-temperature <number>',
      'Sampling temperature for merges.',
      parseFloatOption('merge-temperature'),
      0.2,
    )
    .option('--merge-note <path>', 'Append merge output to this Markdown note.')
    .option('--merge-tasks <path>', 'Write follow-up ideas as JSON tasks.')
    .option(
      '--merge-task-source <label>',
      'Label recorded with exported tasks.',
      'Autopilot',
    )
    .option(
      '--merge-response-debug <path>',
      'Write the raw merge response JSON for debugging.',
      path.join('dist', 'autopilot-merge.json'),
    )
    .option('--skip-experiments', 'Skip scaffolding/exec of the experiment plan.')
    .option(
      '--threads <path>',
      'Override experiment thread inputs (repeatable).',
      collectValues,
    )
    .option(
      '--experiment-threads-dir <path>',
      'Directory for experiment thread artifacts (default: runs/<runId>/threads).',
    )
    .option(
      '--experiment-max-messages <number>',
      'Maximum messages captured per branch for experiments.',
      parseInteger('experiment-max-messages'),
    )
    .option(
      '--experiment-max-chars <number>',
      'Maximum characters retained per message snippet for experiments.',
      parseInteger('experiment-max-chars'),
    )
    .option('--plan <plan>', 'Experiment plan id (planA|planB|planC).', 'planB')
    .option('--run-id <id>', 'Experiment run identifier (auto-generated if blank).')
    .option(
      '--experiment-description <text>',
      'Description embedded in the experiment manifest.',
    )
    .option('--skip-permutations', 'Do not execute permutation tasks.')
    .option('--skip-tournaments', 'Do not execute tournament tasks.')
    .option('--skip-comparisons', 'Do not execute comparison tasks.')
    .action(async (options: AutopilotCliOptions) => {
      try {
        await runAutopilot(options);
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    });
  return autopilot;
}

function createScrapeCommand(): Command {
  const scrape = new Command('scrape');
  scrape
    .description(
      'Open ChatGPT URLs from Chrome bookmarks (or explicit URLs) and save the threads to disk.',
    )
    .option('--host <host>', 'Chrome DevTools host', '127.0.0.1')
    .option(
      '--port <number>',
      'Chrome DevTools port',
      parseInteger('Port'),
      9222,
    )
    .option(
      '--bookmark-folder <name>',
      'Bookmark folder that contains ChatGPT threads (repeatable).',
      collectValues,
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
    )
    .option(
      '--max-messages <number>',
      'Limit how many messages are captured per thread.',
      parseInteger('max-messages'),
    )
    .option('--keep-tabs', 'Keep the temporary tabs opened from bookmarks alive after scraping.', false)
    .option(
      '--max-concurrent-tabs <number>',
      'Maximum number of ChatGPT tabs to open simultaneously when scraping bookmarks.',
      parseInteger('max-concurrent-tabs'),
      3,
    )
    .option(
      '--output <path>',
      'Where to write the JSON snapshot.',
      path.join('snapshots', 'latest.json'),
    )
    .option('--pretty', 'Pretty-print the snapshot JSON.', false)
    .option('--verbose', 'Enable verbose logging.', false)
    .action(async (options: ScrapeCliOptions) => {
      try {
        await runScrape(options);
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    });
  return scrape;
}

function createExperimentCommand(): Command {
  const experiment = new Command('experiment');
  experiment
    .description(
      'Design merge experiments with permutation sampling, tree shapes, and metrics scaffolding.',
    )
    .requiredOption(
      '--threads <path>',
      'Paths to thread files (repeatable) or @list references.',
      collectValues,
    )
    .option('--branch-count <type>', 'Branch count (T2 or T3).', 'T2')
    .option(
      '--sample-policy <policy>',
      'Sampling policy: k-random | k-diverse | bracket.',
    )
    .option(
      '--sample-k <number>',
      'How many permutations to sample for k-* policies.',
      parseInteger('sample-k'),
    )
    .option(
      '--tree-shapes <list>',
      'Comma-separated tree shapes (balanced,left-skew,right-skew).',
      parseCsvList,
    )
    .option(
      '--seed <number>',
      'Seed for sampling or tournament seeding.',
      parseInteger('seed'),
    )
    .option('--plan <plan>', 'Experiment preset planA | planB | planC.')
    .option('--calc-metrics', 'Write metrics.json scaffold for the run.')
    .option('--write-tree <path>', 'Path to write merge_tree.newick outputs.')
    .option('--write-output <path>', 'Path to write recombined markdown output.')
    .option(
      '--write-metadata <path>',
      'Path to write metadata.json for each merge.',
    )
    .option(
      '--freshness-weight <number>',
      'Freshness weighting (0-1) to mitigate early merge bias.',
      parseFloatOption('freshness-weight'),
    )
    .option(
      '--novelty-weight <number>',
      'Novelty weighting (0-1) to penalize dropping unique KPs.',
      parseFloatOption('novelty-weight'),
    )
    .option(
      '--eval-replicates <number>',
      'How many critique replicates (r) to request.',
      parseInteger('eval-replicates'),
    )
    .option(
      '--priorities <list>',
      'Comma-separated priorities for mutual-optima arbitration.',
      parseCsvList,
    )
    .option(
      '--tie-break <order>',
      'Tie-break rule, e.g. actionability>coherence>coverage.',
    )
    .option(
      '--stability-threshold <number>',
      'PSI threshold to stop permutation sampling (default 0.92).',
      parseFloatOption('stability-threshold'),
    )
    .option('--run-id <id>', 'Explicit run identifier.')
    .option(
      '--description <text>',
      'Description to embed inside the run manifest.',
    )
    .action(async (options: ExperimentCliOptions) => {
      const runnerOptions: ExperimentRunnerOptions = {
        threads: options.threads,
      };
      if (options.branchCount) {
        runnerOptions.branchCount = options.branchCount;
      }
      if (options.samplePolicy) {
        runnerOptions.samplePolicy = options.samplePolicy;
      }
      if (options.sampleK !== undefined) {
        runnerOptions.sampleK = options.sampleK;
      }
      if (options.treeShapes) {
        runnerOptions.treeShapes = options.treeShapes;
      }
      if (options.seed !== undefined) {
        runnerOptions.seed = options.seed;
      }
      if (options.plan) {
        runnerOptions.plan = options.plan;
      }
      if (options.calcMetrics) {
        runnerOptions.calcMetrics = true;
      }
      if (options.writeTree) {
        runnerOptions.writeTree = options.writeTree;
      }
      if (options.writeOutput) {
        runnerOptions.writeOutput = options.writeOutput;
      }
      if (options.writeMetadata) {
        runnerOptions.writeMetadata = options.writeMetadata;
      }
      if (options.freshnessWeight !== undefined) {
        runnerOptions.freshnessWeight = options.freshnessWeight;
      }
      if (options.noveltyWeight !== undefined) {
        runnerOptions.noveltyWeight = options.noveltyWeight;
      }
      if (options.evalReplicates !== undefined) {
        runnerOptions.evalReplicates = options.evalReplicates;
      }
      if (options.priorities) {
        runnerOptions.priorities = options.priorities;
      }
      if (options.tieBreak) {
        runnerOptions.tieBreak = options.tieBreak;
      }
      if (options.stabilityThreshold !== undefined) {
        runnerOptions.stabilityThreshold = options.stabilityThreshold;
      }
      if (options.runId) {
        runnerOptions.runId = options.runId;
      }
      if (options.description) {
        runnerOptions.description = options.description;
      }
      try {
        await runExperiment(runnerOptions);
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    });
  return experiment;
}

function createRunCommand(): Command {
  const run = new Command('run');
  run
    .description(
      'Inspect a prepared experiment run (manifest + schedule) and list pending tasks.',
    )
    .requiredOption('--run-dir <path>', 'Path to the run directory under ./runs.')
    .option('--list-tasks', 'List scheduled tasks (default).', true)
    .option(
      '--execute-permutations',
      'Execute permutation tasks with placeholder merges and record metrics.',
    )
    .option(
      '--execute-tournaments',
      'Execute tournament tasks using the merge executor and record champion coverage.',
    )
    .option(
      '--execute-comparisons',
      'Execute comparison tasks (e.g., T2 vs T3) and record GIG metrics.',
    )
    .action(async (options: RunCliOptions) => {
      try {
        const orchestrator = await ExperimentOrchestrator.load(options.runDir);
        console.log(`Experiment ${orchestrator.runId} @ ${orchestrator.runDirectory}`);
        if (orchestrator.description) {
          console.log(`Description: ${orchestrator.description}`);
        }
        console.log(
          `${orchestrator.threads.length} thread${orchestrator.threads.length === 1 ? '' : 's'} configured.`,
        );

        if (options.listTasks !== false) {
          const tasks = orchestrator.listTasks();
          if (!tasks.length) {
            console.log('No scheduled tasks found.');
          } else {
            console.log('\nScheduled tasks:');
            tasks.forEach((task, index) => {
              console.log(` ${index + 1}. ${describeTask(task)}`);
            });
            console.log(
              '\nExecution engine not wired yet; use this listing to plan manual runs.',
            );
          }
        }

        await executeExperimentTaskSet(orchestrator, {
          permutations: Boolean(options.executePermutations),
          tournaments: Boolean(options.executeTournaments),
          comparisons: Boolean(options.executeComparisons),
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    });
  return run;
}

async function executeExperimentTaskSet(
  orchestrator: ExperimentOrchestrator,
  options: {
    permutations?: boolean;
    tournaments?: boolean;
    comparisons?: boolean;
  },
): Promise<void> {
  const { permutations, tournaments, comparisons } = options;
  if (!permutations && !tournaments && !comparisons) {
    return;
  }

  const coverageAnalyzer = new CoverageAnalyzer();
  const mergeExecutor = new MergeExecutor();
  const critiqueRunner = new PythonCritiqueRunner();

  if (permutations) {
    const embeddingCachePath = path.join(
      orchestrator.runDirectory,
      'embedding-cache.json',
    );
    const embeddingService = new EmbeddingService({
      cachePath: embeddingCachePath,
    });
    await embeddingService.loadCache();
    const summary = await orchestrator.executePermutationTasks({
      embeddingService,
      coverageAnalyzer,
      executor: mergeExecutor,
    });
    await embeddingService.saveCache();
    console.log(
      `Executed ${summary.planCount} permutation output${summary.planCount === 1 ? '' : 's'} across ${summary.requestCount} request${summary.requestCount === 1 ? '' : 's'}.`,
    );
  }

  if (tournaments) {
    const tournamentSummary = await orchestrator.executeTournamentTasks({
      executor: mergeExecutor,
      coverageAnalyzer,
    });
    console.log(
      `Executed ${tournamentSummary.mergeCount} tournament merge${tournamentSummary.mergeCount === 1 ? '' : 's'} across ${tournamentSummary.requestCount} request${tournamentSummary.requestCount === 1 ? '' : 's'}.`,
    );
  }

  if (comparisons) {
    const comparisonSummary = await orchestrator.executeComparisonTasks({
      critiqueRunner,
    });
    console.log(
      `Executed ${comparisonSummary.completed} comparison${comparisonSummary.completed === 1 ? '' : 's'} across ${comparisonSummary.requestCount} request${comparisonSummary.requestCount === 1 ? '' : 's'}.`,
    );
  }
}

async function runAutopilot(options: AutopilotCliOptions): Promise<void> {
  const snapshotTarget = path.resolve(
    options.snapshot ?? path.join('snapshots', 'autopilot-latest.json'),
  );
  const prettySnapshot = options.pretty !== false;
  const bookmarkFolders =
    options.bookmarkFolder?.filter(Boolean) ?? ['Digital Nomad'];
  const manualUrls = options.url?.filter(Boolean);
  const planId = options.plan ?? 'planB';
  const runId = options.runId ?? `autopilot-${formatTimestampSlug()}`;
  const displaySnapshot = path.relative(process.cwd(), snapshotTarget);
  let lastExperimentDir: string | undefined;

  const logStep = (message: string) => {
    console.log(`\n[Autopilot] ${message}`);
  };

  if (!options.skipScrape) {
    logStep(
      `Step 1/3: Scraping ${bookmarkFolders.join(', ')} to ${displaySnapshot}...`,
    );
    const scrapeOptions: ScrapeCliOptions = {
      host: options.host,
      port: options.port,
      output: snapshotTarget,
      pretty: prettySnapshot,
      verbose: true,
    };
    if (bookmarkFolders.length) {
      scrapeOptions.bookmarkFolder = bookmarkFolders;
    }
    if (options.bookmarkPath) {
      scrapeOptions.bookmarkPath = options.bookmarkPath;
    }
    if (options.bookmarkProfile) {
      scrapeOptions.bookmarkProfile = options.bookmarkProfile;
    }
    if (typeof options.bookmarkCaseSensitive === 'boolean') {
      scrapeOptions.bookmarkCaseSensitive = options.bookmarkCaseSensitive;
    }
    if (manualUrls?.length) {
      scrapeOptions.url = manualUrls;
    }
    if (typeof options.keepTabs === 'boolean') {
      scrapeOptions.keepTabs = options.keepTabs;
    }
    if (typeof options.maxMessages === 'number') {
      scrapeOptions.maxMessages = options.maxMessages;
    }
    await runScrape(scrapeOptions);
  } else {
    if (!(await fileExists(snapshotTarget))) {
      throw new Error(
        `Snapshot ${snapshotTarget} not found. Remove --skip-scrape or point --snapshot to an existing file.`,
      );
    }
    logStep('Step 1/3: Skipping scrape (per flag).');
  }

  if (!options.skipMerge) {
    logStep('Step 2/3: Merging snapshot into a champion summary...');
    const responseDebugPath = path.resolve(
      options.mergeResponseDebug ?? path.join('dist', 'autopilot-merge.json'),
    );
    await fs.mkdir(path.dirname(responseDebugPath), { recursive: true });
    const mergeOptions: MergeCliOptions = {
      input: snapshotTarget,
      model: options.mergeModel ?? 'gpt-4.1-mini',
      taskSource: options.mergeTaskSource ?? 'Autopilot',
      responseDebug: responseDebugPath,
      verbose: true,
    };
    if (typeof options.mergeBranchLimit === 'number') {
      mergeOptions.branchLimit = options.mergeBranchLimit;
    }
    if (typeof options.mergeMaxHighlights === 'number') {
      mergeOptions.maxBranchHighlights = options.mergeMaxHighlights;
    }
    if (typeof options.mergeTemperature === 'number') {
      mergeOptions.temperature = options.mergeTemperature;
    }
    if (options.mergeNote) {
      mergeOptions.notePath = options.mergeNote;
    }
    if (options.mergeTasks) {
      mergeOptions.tasksPath = options.mergeTasks;
    }
    await runMergeWorkflow(mergeOptions);
  } else {
    logStep('Step 2/3: Skipping merge (per flag).');
  }

  if (!options.skipExperiments) {
    logStep(`Step 3/3: Running experiment plan ${planId}...`);
    let experimentThreads: string[];
    if (options.threads?.filter(Boolean).length) {
      experimentThreads = (options.threads ?? []).filter(Boolean);
    } else {
      const materialized = await materializeExperimentThreads({
        snapshotPath: snapshotTarget,
        runId,
        outputDir: options.experimentThreadsDir
          ? path.resolve(options.experimentThreadsDir)
          : undefined,
        maxMessagesPerThread: options.experimentMaxMessages,
        maxCharsPerMessage: options.experimentMaxChars,
      });
      experimentThreads = materialized.threadPaths;
      logStep(
        `Prepared ${materialized.conversationCount} experiment thread${materialized.conversationCount === 1 ? '' : 's'} at ${path.relative(process.cwd(), materialized.outputDir)}.`,
      );
    }
    const experimentResult = await runExperiment({
      threads: experimentThreads,
      plan: planId,
      calcMetrics: true,
      runId,
      description:
        options.experimentDescription ??
        `Autopilot ${planId} baseline from ${path.basename(snapshotTarget)}`,
    });
    lastExperimentDir = experimentResult.runDir;
    console.log(
      `[Autopilot] Experiment ${experimentResult.runId} scaffolded at ${experimentResult.runDir}.`,
    );
    const orchestrator = await ExperimentOrchestrator.load(
      experimentResult.runDir,
    );
    await executeExperimentTaskSet(orchestrator, {
      permutations: !options.skipPermutations,
      tournaments: !options.skipTournaments,
      comparisons: !options.skipComparisons,
    });
  } else {
    logStep('Step 3/3: Skipping experiments (per flag).');
  }

  console.log('\n[Autopilot] Complete.');
  console.log(` - Snapshot: ${displaySnapshot}`);
  if (options.mergeNote) {
    console.log(
      ` - Merge note: ${path.relative(process.cwd(), path.resolve(options.mergeNote))}`,
    );
  }
  if (lastExperimentDir) {
    console.log(
      ` - Experiment outputs: ${path.relative(process.cwd(), lastExperimentDir)}`,
    );
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function formatTimestampSlug(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

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

  const loaderOptions: Parameters<typeof loadBookmarkFolderEntries>[0] = {
    folderNames: folders,
  };
  if (typeof options.path === 'string') {
    loaderOptions.bookmarksPath = options.path;
  }
  if (typeof options.profile === 'string') {
    loaderOptions.profile = options.profile;
  }
  if (typeof options.caseSensitive === 'boolean') {
    loaderOptions.caseSensitive = options.caseSensitive;
  }

  const meta = await loadBookmarkFolderEntries(loaderOptions);
  if (meta.entries.length === 0) {
    if (verbose) {
      console.warn(
        'No bookmark entries matched the requested folders. Continuing with explicit URLs only.',
      );
    }
    return { urls, meta };
  }

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

async function runScrape(options: ScrapeCliOptions): Promise<void> {
  const {
    host,
    port,
    bookmarkFolder = [],
    bookmarkPath,
    bookmarkProfile,
    bookmarkCaseSensitive,
    url,
    verbose,
    maxMessages,
    keepTabs,
    maxConcurrentTabs,
    output,
    pretty,
  } = options;

  const bookmarkOptions: {
    path?: string;
    profile?: string;
    caseSensitive?: boolean;
  } = {};
  if (typeof bookmarkPath === 'string') {
    bookmarkOptions.path = bookmarkPath;
  }
  if (typeof bookmarkProfile === 'string') {
    bookmarkOptions.profile = bookmarkProfile;
  }
  if (typeof bookmarkCaseSensitive === 'boolean') {
    bookmarkOptions.caseSensitive = bookmarkCaseSensitive;
  }

  const bookmarkResult = await resolveBookmarkUrls(
    bookmarkFolder ?? [],
    bookmarkOptions,
    verbose,
  );

  const requestedUrls = new Set(
    [
      ...bookmarkResult.urls,
      ...(url ?? []),
    ].filter(Boolean),
  );

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
  };
  if (typeof keepTabs === 'boolean') {
    scrapeOptions.keepOpen = keepTabs;
  }
  if (typeof maxConcurrentTabs === 'number') {
    scrapeOptions.maxConcurrentTabs = maxConcurrentTabs;
  }
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
function describeTask(task: ExperimentTask): string {
  switch (task.type) {
    case 'permutation': {
      const shapes = task.treeShapes.join(',');
      const subset = task.subsetSize ? ` subset=${task.subsetSize}` : '';
      return `Permutation x${task.count} [policy=${task.policy} shapes=${shapes}${subset}]${task.notes ? ` — ${task.notes}` : ''}`;
    }
    case 'tournament':
      return `Tournament ${task.label} (${task.branchCount}, route=${task.route}${task.seed !== undefined ? ` seed=${task.seed}` : ''})${task.description ? ` — ${task.description}` : ''}`;
    case 'comparison':
      return `Comparison ${task.label}: ${task.description}${task.notes ? ` — ${task.notes}` : ''}`;
    default:
      return `Unknown task`;
  }
}

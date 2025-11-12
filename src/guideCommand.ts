import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';

type GuideOptionAction = 'back' | 'home' | 'exit';

type GuideNodeId =
  | 'home'
  | 'pilot.intro'
  | 'scrape.intro'
  | 'scrape.chrome'
  | 'scrape.sources'
  | 'scrape.bookmarks'
  | 'scrape.urls'
  | 'scrape.hybrid'
  | 'scrape.command'
  | 'scrape.next'
  | 'merge.intro'
  | 'merge.snapshot'
  | 'merge.tuning'
  | 'merge.outputs'
  | 'merge.command'
  | 'merge.next'
  | 'experiment.intro'
  | 'experiment.threads'
  | 'experiment.strategy'
  | 'experiment.command'
  | 'experiment.followup';

interface GuideOption {
  key: string;
  label: string;
  detail?: string;
  next?: GuideNodeId;
  action?: GuideOptionAction;
}

type GuideCommandSource = GuideCommand | (() => GuideCommand | undefined);

interface GuideNode {
  id: GuideNodeId;
  title: string;
  body: string[];
  options: GuideOption[];
  command?: GuideCommandSource;
}

interface GuideCommand {
  suggested: string;
  note?: string;
}

interface ThreadCandidate {
  label: string;
  value: string;
  type: 'snapshot' | 'list';
}

interface GuideContext {
  selectedThreads: string[];
}

const guideContext: GuideContext = {
  selectedThreads: [],
};

const navOptions = {
  back: (): GuideOption => ({
    key: 'b',
    label: 'Back to the previous step',
    action: 'back',
  }),
  home: (): GuideOption => ({
    key: 'h',
    label: 'Return to mission control',
    action: 'home',
  }),
  exit: (): GuideOption => ({
    key: 'x',
    label: 'Exit the guide',
    action: 'exit',
  }),
};

const GUIDE_NODES: Record<GuideNodeId, GuideNode> = {
  home: {
    id: 'home',
    title: 'Mission Control',
    body: [
      'Welcome to the chat-thread-merger How-To guide. Launch the autopilot for a full scrape→merge→experiment run, or dive into the manual paths to customize each phase.',
      'Type the key shown in brackets to move forward. Use B to step back, H to return here, or X to quit whenever those options are shown.',
    ],
    options: [
      {
        key: 'a',
        label: 'Autopilot (scrape→merge→planB)',
        detail: 'Runs the full pipeline with defaults; edit flags only if needed.',
        next: 'pilot.intro',
      },
      {
        key: '1',
        label: 'Scrape ChatGPT threads into a snapshot',
        detail: 'Use Chrome bookmarks or manual URLs + the scrape command.',
        next: 'scrape.intro',
      },
      {
        key: '2',
        label: 'Merge a snapshot into a single champion summary',
        detail: 'Run OpenAI merges and sync notes/tasks.',
        next: 'merge.intro',
      },
      {
        key: '3',
        label: 'Plan + run merge experiments',
        detail: 'Generate tournament schedules and execute tasks.',
        next: 'experiment.intro',
      },
      navOptions.exit(),
    ],
  },
  'pilot.intro': {
    id: 'pilot.intro',
    title: 'Autopilot - Default Pipeline',
    body: [
      'Fire off the entire scrape→merge→experiment workflow with one command. The autopilot scrapes the default "Digital Nomad" bookmark folder (plus any URLs you add), merges the snapshot, and runs experiment planB with critiques.',
      'Make sure Chrome is already running with remote debugging enabled (Start-ChromeDebug.ps1 can help). When prompted you can run the autopilot as-is or edit the command to swap folders, snapshot paths, or plan IDs.',
    ],
    options: [
      {
        key: 'm',
        label: 'Switch to the manual walkthrough',
        next: 'scrape.intro',
      },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
    command: {
      suggested:
        'npx chat-thread-merger autopilot --bookmark-folder "Digital Nomad" --plan planB',
      note: 'Press Y to launch the autopilot now, N to skip, or E to edit the flags before running.',
    },
  },
  'scrape.intro': {
    id: 'scrape.intro',
    title: 'Scrape - Overview',
    body: [
      'Collect new ChatGPT conversations via the `scrape` command (what `npm start` already runs).',
      'You will: (1) prep Chrome, (2) choose URL sources, (3) run the scraper, (4) validate the snapshot.',
    ],
    options: [
      { key: '1', label: 'Step 1 - Prep Chrome remote debugging', next: 'scrape.chrome' },
      { key: '2', label: 'Step 2 - Choose which chats to capture', next: 'scrape.sources' },
      { key: '3', label: 'Step 3 - Run the scraper command', next: 'scrape.command' },
      { key: '4', label: 'Step 4 - Review the snapshot + next moves', next: 'scrape.next' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
  },
  'scrape.chrome': {
    id: 'scrape.chrome',
    title: 'Scrape - Step 1 - Prep Chrome',
    body: [
      'Close other Chrome windows so nothing else binds the DevTools port you plan to use (default 9222).',
      'Fast path: run `pwsh ./Start-ChromeDebug.ps1 -Port 9222 -ProfileName RemoteDebug`. The script shuts down Chrome, launches a clean profile, and waits for http://127.0.0.1:9222/json/version to respond.',
      'Manual path: `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\\Google\\Chrome\\RemoteDebug"`.',
      'Keep that Chrome instance open until scraping finishes; the CLI drives it through the DevTools protocol. When prompted you can launch the helper script directly from this guide.',
    ],
    options: [
      { key: 'n', label: 'Ready for Step 2 (source selection)', next: 'scrape.sources' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
    command: {
      suggested:
        'pwsh ./Start-ChromeDebug.ps1 -Port 9222 -ProfileName RemoteDebug',
      note: 'Edit before running if Chrome lives elsewhere or you want another port/profile.',
    },
  },
  'scrape.sources': {
    id: 'scrape.sources',
    title: 'Scrape - Step 2 - Pick sources',
    body: [
      'Decide how to build the list of ChatGPT URLs. You can pull straight from Chrome bookmarks, supply explicit URLs, or mix both approaches.',
    ],
    options: [
      {
        key: '1',
        label: 'Use Chrome bookmark folders',
        detail: 'Repeatable --bookmark-folder flags.',
        next: 'scrape.bookmarks',
      },
      {
        key: '2',
        label: 'Paste explicit ChatGPT URLs',
        detail: 'Use --url for each conversation link.',
        next: 'scrape.urls',
      },
      {
        key: '3',
        label: 'Mix bookmarks + direct URLs',
        detail: 'Combine every flag you need.',
        next: 'scrape.hybrid',
      },
      { key: 'c', label: 'Skip ahead to the scraper command', next: 'scrape.command' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
  },
  'scrape.bookmarks': {
    id: 'scrape.bookmarks',
    title: 'Scrape - Bookmark folders',
    body: [
      'Add one `--bookmark-folder "Name"` flag per folder. Repeat the flag to merge multiple folders in the same run.',
      'Need a specific Chrome profile? Add `--bookmark-profile Default` (or `Profile 2`).',
      'Point directly at a Bookmarks file with `--bookmark-path C:/Users/me/AppData/Local/Google/Chrome/User Data/Default/Bookmarks` (overrides the profile shortcut).',
      'Set `--bookmark-case-sensitive` if folders differ only by casing.',
      'You can still append `--url ...` afterward if you want to mix explicit links.',
    ],
    options: [
      { key: 's', label: 'Back to the source picker', next: 'scrape.sources' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
  },
  'scrape.urls': {
    id: 'scrape.urls',
    title: 'Scrape - Explicit URLs',
    body: [
      'Add as many `--url https://chatgpt.com/c/...` flags as you need. Each flag captures one conversation link.',
      'Paste any share URL; duplicates are deduplicated before Chrome opens them.',
      'Mix with bookmark folders or keep it fully manual for ad-hoc captures.',
    ],
    options: [
      { key: 's', label: 'Back to the source picker', next: 'scrape.sources' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
  },
  'scrape.hybrid': {
    id: 'scrape.hybrid',
    title: 'Scrape - Hybrid strategy',
    body: [
      'Flags stack together, so you can combine bookmark folders plus direct URLs in a single command.',
      'Trim transcripts with `--max-messages 25` (per conversation) and add `--keep-tabs` if you want Chrome to leave each ChatGPT tab open for manual review.',
      'Use `--verbose` to watch bookmark discovery and CDP commands in real time.',
    ],
    options: [
      { key: 's', label: 'Back to the source picker', next: 'scrape.sources' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
  },
  'scrape.command': {
    id: 'scrape.command',
    title: 'Scrape - Step 3 - Run the command',
    body: [
      'Kick things off from the repo root. `npm start --` already calls `chat-thread-merger scrape`.',
      'Example (PowerShell one-liner):',
      '  npm start -- --bookmark-folder "Research" --bookmark-folder "Ideas/AI" --url https://chatgpt.com/c/abc123 --output snapshots/research.json --pretty --keep-tabs --max-messages 40 --verbose',
      'Prefer direct CLI access? `npx chat-thread-merger scrape --bookmark-folder Research --output snapshots/research.json` works the same way.',
      'Watch stderr for progress logs (e.g., "Opening 4 ChatGPT URLs..." and "Saved N conversations..."). When the prompt appears you can run the example command (or an edited version) immediately.',
    ],
    options: [
      { key: 'f', label: 'Continue to Step 4 (review outputs)', next: 'scrape.next' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
    command: {
      suggested:
        'npm start -- --bookmark-folder "Research" --bookmark-folder "Ideas/AI" --url https://chatgpt.com/c/abc123 --output snapshots/research.json --pretty --keep-tabs --max-messages 40 --verbose',
      note: 'Edit the folders/URLs/output path before running to match your environment.',
    },
  },
  'scrape.next': {
    id: 'scrape.next',
    title: 'Scrape - Step 4 - Review + next moves',
    body: [
      'Snapshot files live wherever you pointed `--output` (defaults to `snapshots/latest.json`). Open the JSON to confirm the `conversations` array looks right.',
      'Consider committing the snapshot or copying it somewhere durable; it contains every scraped branch.',
      'Ready to summarize those branches into a single champion? Jump straight into the merge walkthrough.',
    ],
    options: [
      {
        key: 'm',
        label: 'Go to the merge How-To',
        detail: 'Use the new snapshot as --input for the merge script.',
        next: 'merge.intro',
      },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
  },
  'merge.intro': {
    id: 'merge.intro',
    title: 'Merge - Overview',
    body: [
      'Turn a snapshot of branches into one champion answer (plus follow-ups) via `npm run merge -- --input <file> ...`.',
      'We will: (1) pick the snapshot, (2) tune merge settings, (3) enable downstream exports, (4) run the command.',
    ],
    options: [
      { key: '1', label: 'Step 1 - Point at the right snapshot', next: 'merge.snapshot' },
      { key: '2', label: 'Step 2 - Tune merge + model settings', next: 'merge.tuning' },
      { key: '3', label: 'Step 3 - Configure notes/tasks exports', next: 'merge.outputs' },
      { key: '4', label: 'Step 4 - Run the merge script', next: 'merge.command' },
      { key: '5', label: 'What happens after the merge?', next: 'merge.next' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
  },
  'merge.snapshot': {
    id: 'merge.snapshot',
    title: 'Merge - Step 1 - Select input snapshot',
    body: [
      'Use the JSON you just scraped (or any file that matches the ThreadSnapshot schema). Pass it via `--input snapshots/digital-nomad.json`.',
      'If you omit `--input`, the script falls back to `snapshots/digital-nomad.json`, so set the flag explicitly to avoid surprises.',
      'Need to trim noise? Add `--branch-limit 5` to only merge the most recent branches inside the snapshot.',
    ],
    options: [
      { key: 'n', label: 'Next - Tune the merge request', next: 'merge.tuning' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
  },
  'merge.tuning': {
    id: 'merge.tuning',
    title: 'Merge - Step 2 - Tune settings',
    body: [
      'Pick the model + temperature: e.g., `--model gpt-4.1-mini --temperature 0.2` for steadier merges.',
      'Control detail with `--max-branch-highlights 4` (how many bullet highlights per source branch).',
      'Set the provider knob if you have a preset (e.g., `--provider openai`). Override endpoints with `--api-base https://api.openai.com/v1` and pass secrets via `--api-key` or `--api-key-env MY_TOKEN`.',
      'Need custom headers (Azure, Helicone, etc.)? Repeat `--api-header key=value` to append them.',
      'Add `--response-debug dist/last-merge.json` plus `--verbose` if you want to inspect the raw response.',
    ],
    options: [
      { key: 'n', label: 'Next - Configure exports', next: 'merge.outputs' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
  },
  'merge.outputs': {
    id: 'merge.outputs',
    title: 'Merge - Step 3 - Notes + tasks',
    body: [
      'Append Markdown automatically with `--note-path notes/digital-nomad.md`.',
      'Capture follow-up actions as JSON via `--tasks-path snapshots/digital-nomad-tasks.json` and label the source with `--task-source "Digital Nomad Merge"`.',
      'Sync Notion by passing `--notion-database-id <guid> --notion-token-env NOTION_TOKEN --notion-title-prop Name --notion-summary-prop Summary`.',
      'Sync Todoist tasks with `--todoist-project-id <id> --todoist-token-env TODOIST_TOKEN --todoist-priority 3 --todoist-due-string "tomorrow 9am"`.',
    ],
    options: [
      { key: 'n', label: 'Next - Run the merge command', next: 'merge.command' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
  },
  'merge.command': {
    id: 'merge.command',
    title: 'Merge - Step 4 - Run it',
    body: [
      'From the repo root, run the dedicated script (it is wired to tsx):',
      '  npm run merge -- --input snapshots/digital-nomad.json --branch-limit 4 --model gpt-4.1-mini --temperature 0.2 --note-path notes/digital-nomad.md --tasks-path snapshots/digital-nomad-tasks.json --task-source "Digital Nomad" --response-debug dist/last-merge.json',
      'Need to run it directly? `npx tsx src/mergeSnapshot.ts --input ...` is equivalent during development.',
      'Watch stdout for the merged summary, highlights, ideas, and any export confirmations. Pick Yes at the prompt to execute the merge right away.',
    ],
    options: [
      { key: 'f', label: 'See what to do with the results', next: 'merge.next' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
    command: {
      suggested:
        'npm run merge -- --input snapshots/digital-nomad.json --branch-limit 4 --model gpt-4.1-mini --temperature 0.2 --note-path notes/digital-nomad.md --tasks-path snapshots/digital-nomad-tasks.json --task-source "Digital Nomad" --response-debug dist/last-merge.json',
      note: 'Edit the snapshot, note path, and integration flags before launching the merge.',
    },
  },
  'merge.next': {
    id: 'merge.next',
    title: 'Merge - After the run',
    body: [
      'Markdown notes land wherever `--note-path` points. Task lists show up in the JSON file and optionally in Todoist.',
      'Set `--response-debug` to capture the full API payload for troubleshooting/metrics.',
      'Want to stress-test different merge plans? Continue into the experiments path for permutation/tournament scaffolding.',
    ],
    options: [
      {
        key: 'e',
        label: 'Go to the experiments How-To',
        detail: 'Design tournament schedules + comparison tasks.',
        next: 'experiment.intro',
      },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
  },
  'experiment.intro': {
    id: 'experiment.intro',
    title: 'Experiments - Overview',
    body: [
      'Experiments scaffold large merge studies: permutation probes, tournaments, and comparison tasks. Run them via `chat-thread-merger experiment`.',
      'Flow: (1) pick thread inputs, (2) choose a sampling / plan strategy, (3) scaffold the run, (4) execute tasks via `chat-thread-merger run`.',
    ],
    options: [
      { key: '1', label: 'Step 1 - Supply thread inputs', next: 'experiment.threads' },
      { key: '2', label: 'Step 2 - Pick policies or presets', next: 'experiment.strategy' },
      { key: '3', label: 'Step 3 - Generate the run directory', next: 'experiment.command' },
      { key: '4', label: 'Step 4 - Execute + monitor tasks', next: 'experiment.followup' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
  },
  'experiment.threads': {
    id: 'experiment.threads',
    title: 'Experiments - Step 1 - Thread inputs',
    body: [
      'Provide one or more `--threads <path>` arguments. Each path should point to a snapshot or branch list JSON file.',
      'Long lists? Create a text file with one path per line and pass it as `--threads @lists/travel.txt`. Comment lines starting with `#` are ignored.',
      'Paths are resolved relative to the repo; duplicates are removed automatically.',
      'Run the detector below to auto-list every snapshot / @lists file in this repo, pick what you need, and optionally generate a new long-list file.',
    ],
    options: [
      { key: 'n', label: 'Next - Choose a strategy', next: 'experiment.strategy' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
  },
  'experiment.strategy': {
    id: 'experiment.strategy',
    title: 'Experiments - Step 2 - Strategy + presets',
    body: [
      'Set `--branch-count T2` or `T3` depending on how many branches each merge should juggle.',
      'Sampling policies: `--sample-policy k-diverse` (or k-random/bracket) plus `--sample-k 5` and `--tree-shapes balanced,left-skew,right-skew`.',
      'Use `--plan planB` (or planA/planC) for canned tournament schedules. Plans automatically seed permutation/tournament/comparison tasks.',
      'Fine-tune scoring with `--freshness-weight 0.4 --novelty-weight 0.6`, tie breaks via `--priorities coverage,actionability --tie-break coherence>clarity`, and stability with `--stability-threshold 0.92`.',
      'Request critiques per comparison with `--eval-replicates 3`. Write helper artifacts via `--write-tree`, `--write-output`, or `--write-metadata` as needed.',
    ],
    options: [
      { key: 'n', label: 'Next - Generate the run directory', next: 'experiment.command' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
  },
  'experiment.command': {
    id: 'experiment.command',
    title: 'Experiments - Step 3 - Scaffold the run',
    body: [
      'Example command:',
      '  npx chat-thread-merger experiment --threads snapshots/research.json --threads snapshots/ops.json --plan planB --run-id exp-nov-12 --calc-metrics --description "Ops refinement study"',
      'The CLI writes `runs/<runId>/manifest.json`, `schedule.json`, and optional metrics skeletons. Use `--seed 42` to make tournament seeding deterministic.',
      'If you omit `--run-id`, one is generated automatically (timestamp based).',
      'Confirm at the prompt to run the scaffold command now, or edit it inline first.',
    ],
    options: [
      { key: 'n', label: 'Next - Execute and monitor tasks', next: 'experiment.followup' },
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
    command: () => buildExperimentCommand(),
  },
  'experiment.followup': {
    id: 'experiment.followup',
    title: 'Experiments - Step 4 - Execute tasks',
    body: [
      'List scheduled work: `npx chat-thread-merger run --run-dir runs/exp-nov-12 --list-tasks`.',
      'Run permutation probes with `--execute-permutations` (this spins up the embedding cache at `<run>/embedding-cache.json`).',
      'Execute tournaments via `--execute-tournaments` to call the merge executor, or comparisons via `--execute-comparisons` to launch critique runs.',
      'The orchestrator prints how many requests completed and writes artifacts back into the run directory (coverage summaries, champion files, etc.).',
      'Use the prompt below to run the orchestrator right away—add the `--execute-*` flags you need before confirming.',
    ],
    options: [
      navOptions.back(),
      navOptions.home(),
      navOptions.exit(),
    ],
    command: {
      suggested:
        'npx chat-thread-merger run --run-dir runs/exp-nov-12 --list-tasks',
      note: 'Edit to add --execute-permutations / --execute-tournaments / --execute-comparisons as needed.',
    },
  },
};

async function runGuide(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const history: GuideNodeId[] = [];
  let currentNode: GuideNode = GUIDE_NODES.home;

  const closeGuide = () => {
    rl.close();
    console.log('Guide closed. Re-run `chat-thread-merger guide` anytime.');
  };

  while (true) {
    renderNode(currentNode);
    await maybeHandleNodeExtras(rl, currentNode);
    const commandDescriptor = resolveGuideCommand(currentNode.command);
    if (commandDescriptor) {
      await offerCommandExecution(rl, commandDescriptor);
    }
    const answerRaw = await rl.question('Choose an option: ');
    const answer = answerRaw.trim().toLowerCase();
    if (!answer) {
      console.log('Type one of the option keys shown above.');
      continue;
    }

    const option = currentNode.options.find(
      (entry) => entry.key.toLowerCase() === answer,
    );
    if (!option) {
      console.log(`"${answerRaw}" is not on the menu. Try again.`);
      continue;
    }

    if (option.action === 'exit') {
      closeGuide();
      break;
    }

    if (option.action === 'home') {
      history.length = 0;
      currentNode = GUIDE_NODES.home;
      continue;
    }

    if (option.action === 'back') {
      const previousId = history.pop() ?? 'home';
      currentNode = GUIDE_NODES[previousId];
      continue;
    }

    if (option.next) {
      history.push(currentNode.id);
      currentNode = GUIDE_NODES[option.next];
      continue;
    }

    console.log('No next step wired for that option. Please choose another one.');
  }
}

function renderNode(node: GuideNode): void {
  console.log('\n==================================================');
  console.log(node.title);
  console.log('--------------------------------------------------');
  node.body.forEach((paragraph) => {
    console.log(paragraph);
    console.log('');
  });
  console.log('Options:');
  node.options.forEach((option) => {
    const detail = option.detail ? ` - ${option.detail}` : '';
    console.log(` [${option.key}] ${option.label}${detail}`);
  });
  console.log('');
}

function resolveGuideCommand(
  source?: GuideCommandSource,
): GuideCommand | undefined {
  if (!source) {
    return undefined;
  }
  if (typeof source === 'function') {
    return source();
  }
  return source;
}

async function maybeHandleNodeExtras(
  rl: readline.Interface,
  node: GuideNode,
): Promise<void> {
  if (node.id === 'experiment.threads') {
    await handleThreadSelection(rl);
  }
}

async function handleThreadSelection(rl: readline.Interface): Promise<void> {
  if (guideContext.selectedThreads.length) {
    console.log(
      `Current thread inputs: ${guideContext.selectedThreads.join(', ')}.`,
    );
    const rebuild = (
      await rl.question('Rebuild this selection? [y/N]: ')
    )
      .trim()
      .toLowerCase();
    if (rebuild !== 'y') {
      return;
    }
  }

  const candidates = await collectThreadCandidates();
  if (!candidates.length) {
    console.log(
      'No snapshot JSON files detected under ./snapshots or @lists files under ./lists. Run the scraper first or add files manually.',
    );
    return;
  }

  console.log('\nDetected thread sources:');
  candidates.forEach((candidate, index) => {
    const badge = candidate.type === 'snapshot' ? 'snapshot' : '@list';
    console.log(
      ` ${index + 1}. ${candidate.label} (${badge})`,
    );
  });
  console.log(
    'Enter numbers (comma/space separated), "a" for all, or paste a custom path. Leave blank to skip.',
  );
  const selectionInput = (await rl.question('Selection: ')).trim();
  if (!selectionInput) {
    if (!guideContext.selectedThreads.length) {
      console.log('No selections captured. Threads remain unspecified.');
    } else {
      console.log('Keeping previous thread selection.');
    }
    return;
  }

  let selectedValues: string[] = [];
  if (selectionInput.toLowerCase() === 'a') {
    selectedValues = candidates.map((candidate) => candidate.value);
  } else {
    const tokens = selectionInput.split(/[\s,]+/).filter(Boolean);
    for (const token of tokens) {
      if (/^\d+$/.test(token)) {
        const idx = Number.parseInt(token, 10) - 1;
        const candidate = candidates[idx];
        if (candidate) {
          selectedValues.push(candidate.value);
        } else {
          console.log(`Index ${token} is out of range; skipping.`);
        }
        continue;
      }
      selectedValues.push(token);
    }
  }
  if (!selectedValues.length) {
    console.log('No valid selections captured; thread inputs unchanged.');
    return;
  }

  guideContext.selectedThreads = dedupePreserveOrder(selectedValues);

  const directPaths = guideContext.selectedThreads.filter(
    (entry) => !entry.startsWith('@'),
  );
  if (directPaths.length > 1) {
    const writeList = (
      await rl.question(
        'Write these selections to lists/<name>.txt for reuse? [y/N]: ',
      )
    )
      .trim()
      .toLowerCase();
    if (writeList === 'y') {
      const defaultListPath = path.join(
        'lists',
        `threads-${new Date().toISOString().replace(/[:]/g, '-')}.txt`,
      );
      const customPathInput = await rl.question(
        `List path [${defaultListPath}]: `,
      );
      const normalizedListPath = path
        .normalize(customPathInput.trim() || defaultListPath)
        .replace(/^@/, '');
      await fs.mkdir(path.dirname(normalizedListPath), { recursive: true });
      await fs.writeFile(
        normalizedListPath,
        directPaths.join('\n') + '\n',
        'utf-8',
      );
      const reference = `@${normalizedListPath}`;
      guideContext.selectedThreads = [
        reference,
        ...guideContext.selectedThreads.filter((entry) => entry.startsWith('@')),
      ];
      console.log(
        `Saved thread list to ${normalizedListPath}. Use ${reference} with --threads.`,
      );
    }
  }

  console.log(
    `Thread inputs ready: ${guideContext.selectedThreads.join(', ')}.`,
  );
}

async function collectThreadCandidates(): Promise<ThreadCandidate[]> {
  const candidates: ThreadCandidate[] = [];
  const snapshotDir = path.resolve('snapshots');
  try {
    const entries = await fs.readdir(snapshotDir, { withFileTypes: true });
    entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.toLowerCase().endsWith('.json'),
      )
      .forEach((entry) => {
        const relative = path.join('snapshots', entry.name);
        candidates.push({
          label: relative,
          value: relative,
          type: 'snapshot',
        });
      });
  } catch {
    // ignore missing snapshots directory
  }

  const listsDir = path.resolve('lists');
  try {
    const entries = await fs.readdir(listsDir, { withFileTypes: true });
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          /\.(txt|list|lst)$/i.test(entry.name),
      )
      .forEach((entry) => {
        const relative = path.join('lists', entry.name);
        candidates.push({
          label: `@${relative}`,
          value: `@${relative}`,
          type: 'list',
        });
      });
  } catch {
    // ignore missing lists directory
  }

  return candidates.sort((a, b) => a.label.localeCompare(b.label));
}

function dedupePreserveOrder<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function buildExperimentCommand(): GuideCommand {
  const threadArgs =
    guideContext.selectedThreads.length > 0
      ? guideContext.selectedThreads
      : ['snapshots/digital-nomad.json'];
  const threadSegment = threadArgs
    .map((entry) => `--threads ${quoteArg(entry)}`)
    .join(' ');
  const suggested = `npx chat-thread-merger experiment ${threadSegment} --plan planB --run-id exp-nov-12 --calc-metrics --description "Ops refinement study"`;
  const note = guideContext.selectedThreads.length
    ? `Using thread inputs: ${threadArgs.join(', ')}`
    : 'Edit the --threads values to match your snapshots before running.';
  return { suggested, note };
}

function quoteArg(value: string): string {
  if (/[\\s"]/u.test(value)) {
    return `"${value.replace(/(["\\\\])/g, '\\\\$1')}"`;
  }
  return value;
}

async function offerCommandExecution(
  rl: readline.Interface,
  command: GuideCommand,
): Promise<void> {
  console.log('Suggested command:');
  console.log(`  ${command.suggested}`);
  if (command.note) {
    console.log(command.note);
  }

  while (true) {
    const decision = (
      await rl.question('Run now? [Y]es / [n]o / [e]dit command: ')
    )
      .trim()
      .toLowerCase();
    if (decision === '' || decision === 'y') {
      const exitCode = await runShellCommand(rl, command.suggested);
      reportCommandResult(exitCode);
      break;
    }
    if (decision === 'n') {
      console.log('Skipping execution for now.');
      break;
    }
    if (decision === 'e') {
      const custom = await rl.question('Enter the command to run: ');
      if (!custom.trim()) {
        console.log('Blank command; skip or try again.');
        continue;
      }
      const exitCode = await runShellCommand(rl, custom.trim());
      reportCommandResult(exitCode);
      break;
    }
    console.log('Please respond with Y, N, or E.');
  }
}

async function runShellCommand(
  rl: readline.Interface,
  commandLine: string,
): Promise<number> {
  console.log(`\n>>> Executing: ${commandLine}\n`);
  rl.pause();
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(commandLine, {
        shell: true,
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        resolve(code ?? 0);
      });
    });
    return exitCode;
  } finally {
    rl.resume();
  }
}

function reportCommandResult(exitCode: number): void {
  if (exitCode === 0) {
    console.log('\nCommand completed successfully.\n');
  } else {
    console.log(
      `\nCommand exited with code ${exitCode}. Review the output above before continuing.\n`,
    );
  }
}

export function createGuideCommand(): Command {
  return new Command('guide')
    .description(
      'Interactive choose-your-own-adventure walkthrough of scraping, merging, and experiment workflows.',
    )
    .action(async () => {
      await runGuide();
    });
}





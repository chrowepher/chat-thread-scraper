import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const startScript = path.resolve(projectRoot, 'Start-ChromeDebug.ps1');

const serverPort = Number(process.env.AUTOPILOT_UI_PORT ?? 4571);

if (!fs.existsSync(startScript)) {
  console.error(`Start-ChromeDebug.ps1 not found at ${startScript}`);
  process.exit(1);
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  command: string;
}

const htmlEscape = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const quoteArg = (arg: string) => (/[\s"]/.test(arg) ? '"' + arg.replace(/"/g, '\\"') + '"' : arg);

const buildArgsFromForm = (form: URLSearchParams) => {
  const args: string[] = [];
  const get = (key: string, fallback = '') => form.get(key) ?? fallback;
  const isChecked = (key: string, defaultValue = false) => {
    const value = form.get(key);
    if (value === null) {
      return defaultValue;
    }
    return value === 'on' || value === 'true';
  };

  const port = get('port', '9222') || '9222';
  const host = get('host', '127.0.0.1') || '127.0.0.1';
  const profileName = get('profileName', 'RemoteDebug') || 'RemoteDebug';
  args.push('-Port', port, '-DevToolsHost', host, '-ProfileName', profileName);

  if (!isChecked('launchChrome', true)) {
    args.push('-SkipChrome');
  }
  if (!isChecked('runScraper', true)) {
    args.push('-SkipScraper');
  }

  const workflow = get('workflow', 'autopilot');
  if (workflow === 'legacy') {
    args.push('-LegacyWorkflow');
    if (isChecked('runMerge', true)) {
      args.push('-RunMerge');
    }

    const scraperArgs: string[] = [];
    if (isChecked('verboseScraper', true)) {
      scraperArgs.push('--verbose');
    }
    const bookmarkFolder = get('bookmarkFolder', 'Digital Nomad') || 'Digital Nomad';
    const snapshotPath = get('snapshotPath', 'snapshots/digital-nomad.json') || 'snapshots/digital-nomad.json';
    scraperArgs.push('--bookmark-folder', bookmarkFolder, '--output', snapshotPath, '--pretty');

    const mergeNote = get('notePath', 'notes/digital-nomad.md') || 'notes/digital-nomad.md';
    const mergeTasks = get('tasksPath', 'snapshots/digital-nomad-tasks.json') || 'snapshots/digital-nomad-tasks.json';
    const branchLimit = get('branchLimit', '5') || '5';
    const mergeArgs = ['--input', snapshotPath, '--note-path', mergeNote, '--tasks-path', mergeTasks, '--branch-limit', branchLimit];

    args.push('-ScraperArgs', ...scraperArgs);
    if (isChecked('runMerge', true)) {
      args.push('-MergeArgs', ...mergeArgs);
    }
  } else {
    const autopilotArgs: string[] = [];
    const bookmarkFolder = get('bookmarkFolder', 'Digital Nomad') || 'Digital Nomad';
    const snapshotPath = get('snapshotPath', 'snapshots/digital-nomad.json') || 'snapshots/digital-nomad.json';
    const mergeNote = get('notePath', 'notes/digital-nomad.md') || 'notes/digital-nomad.md';
    const mergeTasks = get('tasksPath', 'snapshots/digital-nomad-tasks.json') || 'snapshots/digital-nomad-tasks.json';
    const branchLimit = get('branchLimit', '5') || '5';

    autopilotArgs.push(
      '--bookmark-folder',
      bookmarkFolder,
      '--snapshot',
      snapshotPath,
      '--merge-note',
      mergeNote,
      '--merge-tasks',
      mergeTasks,
      '--merge-branch-limit',
      branchLimit,
    );

    const maxTabs = get('maxTabs');
    if (maxTabs) {
      autopilotArgs.push('--max-concurrent-tabs', maxTabs);
    }
    const conversationTimeout = get('conversationTimeout');
    if (conversationTimeout) {
      autopilotArgs.push('--conversation-timeout', conversationTimeout);
    }
    const hydrateIterations = get('hydrateIterations');
    if (hydrateIterations) {
      autopilotArgs.push('--hydrate-iterations', hydrateIterations);
    }
    const hydrateDelay = get('hydrateDelay');
    if (hydrateDelay) {
      autopilotArgs.push('--hydrate-delay', hydrateDelay);
    }

    if (isChecked('keepTabs', false)) {
      autopilotArgs.push('--keep-tabs');
    }
    if (isChecked('openHtml', true)) {
      autopilotArgs.push('--open-merge-html');
    } else {
      args.push('-DisableHtmlPreview');
    }

    const mergeHtml = get('mergeHtml', 'dist/autopilot-merge.html') || 'dist/autopilot-merge.html';
    args.push('-MergeHtmlReport', mergeHtml);
    args.push('-AutopilotArgs', ...autopilotArgs);
  }

  return args;
};

const runStartScript = (args: string[]): Promise<RunResult> =>
  new Promise((resolve) => {
    const psExecutable = process.env.POWERSHELL ?? (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
    const psArgs = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', startScript, ...args];
    const child = spawn(psExecutable, psArgs, { cwd: projectRoot });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr, command: ['Start-ChromeDebug.ps1', ...args].map(quoteArg).join(' ') });
    });
  });

const renderForm = () => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Chat Thread Autopilot Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #0f172a; color: #e2e8f0; }
    fieldset { margin-bottom: 1.5rem; border: 1px solid #334155; padding: 1rem; border-radius: 0.5rem; }
    legend { padding: 0 0.5rem; font-weight: bold; }
    label { display: flex; flex-direction: column; margin-bottom: 0.75rem; font-size: 0.95rem; }
    input[type="text"], input[type="number"] { padding: 0.35rem 0.5rem; border-radius: 0.35rem; border: 1px solid #475569; background: #1e293b; color: #e2e8f0; }
    .inline { display: flex; gap: 1rem; flex-wrap: wrap; }
    .checkbox-row { display: flex; gap: 1rem; }
    button { background: #22d3ee; border: none; color: #0f172a; font-weight: 600; padding: 0.75rem 1.5rem; border-radius: 999px; cursor: pointer; }
    button:hover { filter: brightness(1.1); }
    .hint { font-size: 0.8rem; color: #94a3b8; }
    .radio-row { display: flex; gap: 1rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <h1>Chat Thread Autopilot Dashboard</h1>
  <form method="POST" action="/run">
    <fieldset>
      <legend>Chrome Remote Debugging</legend>
      <div class="inline">
        <label>DevTools Host<input type="text" name="host" value="127.0.0.1" /></label>
        <label>Port<input type="number" name="port" value="9222" /></label>
        <label>Profile<input type="text" name="profileName" value="RemoteDebug" /></label>
      </div>
      <div class="checkbox-row">
        <label><input type="checkbox" name="launchChrome" checked /> Launch Chrome</label>
        <label><input type="checkbox" name="runScraper" checked /> Run scraper</label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Workflow</legend>
      <div class="radio-row">
        <label><input type="radio" name="workflow" value="autopilot" checked /> Autopilot (npm start autopilot)</label>
        <label><input type="radio" name="workflow" value="legacy" /> Legacy (separate scrape + merge)</label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Shared Inputs</legend>
      <div class="inline">
        <label>Bookmark Folder<input type="text" name="bookmarkFolder" value="Digital Nomad" /></label>
        <label>Snapshot Path<input type="text" name="snapshotPath" value="snapshots/digital-nomad.json" /></label>
      </div>
      <div class="inline">
        <label>Note Path<input type="text" name="notePath" value="notes/digital-nomad.md" /></label>
        <label>Tasks Path<input type="text" name="tasksPath" value="snapshots/digital-nomad-tasks.json" /></label>
        <label>Branch Limit<input type="number" name="branchLimit" value="5" /></label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Autopilot Options</legend>
      <label>Merge HTML Report<input type="text" name="mergeHtml" value="dist/autopilot-merge.html" /></label>
      <div class="inline">
        <label>Max Concurrent Tabs<input type="number" name="maxTabs" placeholder="default" /></label>
        <label>Conversation Timeout (ms)<input type="number" name="conversationTimeout" placeholder="default" /></label>
        <label>Hydrate Iterations<input type="number" name="hydrateIterations" placeholder="default" /></label>
        <label>Hydrate Delay (ms)<input type="number" name="hydrateDelay" placeholder="default" /></label>
      </div>
      <div class="checkbox-row">
        <label><input type="checkbox" name="keepTabs" /> Keep tabs open</label>
        <label><input type="checkbox" name="openHtml" checked /> Open HTML report</label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Legacy Options</legend>
      <div class="checkbox-row">
        <label><input type="checkbox" name="verboseScraper" checked /> Verbose scraper</label>
        <label><input type="checkbox" name="runMerge" checked /> Run merge after scrape</label>
      </div>
    </fieldset>

    <button type="submit">Run Start-ChromeDebug</button>
  </form>
</body>
</html>`;

const renderResult = (result: RunResult) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Autopilot Run</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #0f172a; color: #e2e8f0; }
    pre { background: #020617; padding: 1rem; border-radius: 0.5rem; overflow-x: auto; }
    a { color: #22d3ee; }
  </style>
</head>
<body>
  <h1>Autopilot run finished (exit ${result.exitCode})</h1>
  <p>Command: <code>${htmlEscape(result.command)}</code></p>
  <h2>Stdout</h2>
  <pre>${htmlEscape(result.stdout || '(no output)')}</pre>
  <h2>Stderr</h2>
  <pre>${htmlEscape(result.stderr || '(no output)')}</pre>
  <p><a href="/">Run another</a></p>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderForm());
    return;
  }

  if (req.method === 'POST' && req.url === '/run') {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString();
      const form = new URLSearchParams(body);
      const args = buildArgsFromForm(form);
      const result = await runStartScript(args);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderResult(result));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(serverPort, () => {
  console.log(`Autopilot dashboard ready at http://localhost:${serverPort}`);
});





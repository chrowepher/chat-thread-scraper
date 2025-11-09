import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

export interface ChromeManagementOptions {
  host: string;
  port: number;
  chromePath?: string;
  userDataDir?: string;
  profileDirectory?: string;
  additionalFlags?: string[];
  timeoutMs?: number;
  allowForceRestart?: boolean;
  verbose?: boolean;
}

interface LaunchPlan {
  label: string;
  userDataDir: string;
  profileDirectory: string;
  requiresCleanSlate?: boolean;
  hint?: string;
}

interface LaunchOptions {
  executable: string;
  port: number;
  userDataDir: string;
  profileDirectory: string;
  additionalFlags?: string[];
  verbose?: boolean;
}

interface BuildLaunchOptionsArgs {
  executable: string;
  plan: LaunchPlan;
  port: number;
  additionalFlags?: string[];
  verbose?: boolean;
}

export class ChromeManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChromeManagementError';
  }
}

export async function ensureChromeWithRemoteDebugging(
  options: ChromeManagementOptions,
): Promise<void> {
  const {
    host,
    port,
    chromePath,
    userDataDir,
    profileDirectory,
    additionalFlags,
    timeoutMs = 10_000,
    allowForceRestart = true,
    verbose,
  } = options;

  const initialPortState = await describePortState(host, port);
  if (initialPortState.reachable) {
    if (verbose) {
      console.log(
        `Chrome remote debugging already reachable on ${host}:${port}.`,
      );
    }
    return;
  }

  const executable = await resolveChromeExecutable(chromePath);
  const resolvedUserDataDir = await resolveUserDataDir(userDataDir);
  const resolvedProfileDir = await resolveProfileDirectory(
    profileDirectory,
    resolvedUserDataDir,
  );
  const tempUserDataDir = await createEphemeralUserDataDir();

  const launchPlans: LaunchPlan[] = [
    {
      label: 'existing profile',
      userDataDir: resolvedUserDataDir,
      profileDirectory: resolvedProfileDir,
    },
  ];

  if (allowForceRestart) {
    launchPlans.push({
      label: 'existing profile after restart',
      userDataDir: resolvedUserDataDir,
      profileDirectory: resolvedProfileDir,
      requiresCleanSlate: true,
    });
    launchPlans.push({
      label: 'temporary profile',
      userDataDir: tempUserDataDir,
      profileDirectory: 'Default',
      requiresCleanSlate: true,
      hint:
        'Switching to an isolated Chrome profile because the default profile did not expose DevTools.',
    });
  }

  const failureReasons: string[] = [];

  for (const plan of launchPlans) {
    if (plan.requiresCleanSlate) {
      const closed = await closeChromeInstances(verbose);
      if (verbose) {
        console.warn(
          closed
            ? 'Closed existing Chrome instances to enable remote debugging.'
            : 'No running Chrome instances detected before relaunch.',
        );
      }
      await delay(800);
    }

    if (plan.hint && verbose) {
      console.warn(plan.hint);
    }

    if (verbose) {
      console.log(
        `Launching Chrome (${plan.label}) on ${host}:${port} using profile "${plan.profileDirectory}".`,
      );
    }

    const launchOptionArgs: BuildLaunchOptionsArgs = {
      executable,
      plan,
      port,
    };
    if (additionalFlags && additionalFlags.length) {
      launchOptionArgs.additionalFlags = additionalFlags;
    }
    if (typeof verbose === 'boolean') {
      launchOptionArgs.verbose = verbose;
    }
    const launchOptions = buildLaunchOptions(launchOptionArgs);
    await launchChrome(launchOptions);

    if (await waitForDevTools(host, port, timeoutMs, verbose)) {
      if (plan.userDataDir === tempUserDataDir) {
        console.warn(
          `Remote debugging is running inside a temporary Chrome profile at ${tempUserDataDir}. Sign in to ChatGPT in that window if needed.`,
        );
      }
      return;
    }

    failureReasons.push(
      `Attempt "${plan.label}" did not expose DevTools within ${timeoutMs}ms.`,
    );

    if (!allowForceRestart) {
      break;
    }
  }

  const portBusy = await isPortBusy(host, port);
  const diag = portBusy
    ? `Port ${port} is still occupied by another process. Re-run with --port <free-port> or ensure other Chrome instances are closed.`
    : 'Chrome launched but never acknowledged the remote-debugging flag (common with managed or kiosk builds).';
  const reasonSummary =
    failureReasons.length > 0 ? failureReasons.join(' ') : '';

  throw new ChromeManagementError(
    `Unable to reach Chrome DevTools on ${host}:${port}. ${reasonSummary} ${diag}`,
  );
}

async function resolveChromeExecutable(explicitPath?: string): Promise<string> {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const candidates = getDefaultChromeCandidates();
  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) {
        return candidate;
      }
    } catch {
      // ignore missing candidates
    }
  }

  throw new ChromeManagementError(
    'Unable to locate the Google Chrome executable. Pass --chrome-path <path>.',
  );
}

async function resolveUserDataDir(explicitPath?: string): Promise<string> {
  const dir = explicitPath ?? getDefaultUserDataDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function resolveProfileDirectory(
  explicitProfile?: string,
  userDataDir?: string,
): Promise<string> {
  if (explicitProfile) {
    return explicitProfile;
  }

  const baseDir = userDataDir ?? getDefaultUserDataDir();
  const localStatePath = path.join(baseDir, 'Local State');
  try {
    const raw = await fs.readFile(localStatePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const lastUsed = parsed?.profile?.last_used;
    if (typeof lastUsed === 'string' && lastUsed.trim().length) {
      return lastUsed;
    }
  } catch {
    // ignore errors and fall back to Default
  }
  return 'Default';
}

async function createEphemeralUserDataDir(): Promise<string> {
  const base = path.join(os.tmpdir(), 'chat-thread-merger', 'chrome-profiles');
  const id = crypto.randomUUID();
  const dir = path.join(base, id);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function getDefaultChromeCandidates(): string[] {
  const platform = process.platform;
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? '';
    const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files';
    const programFilesX86 =
      process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    return [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(
        programFilesX86,
        'Google',
        'Chrome',
        'Application',
        'chrome.exe',
      ),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }

  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(
        os.homedir(),
        'Applications',
        'Google Chrome.app',
        'Contents',
        'MacOS',
        'Google Chrome',
      ),
    ];
  }

  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
}

function getDefaultUserDataDir(): string {
  const platform = process.platform;
  const home = os.homedir();
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      return path.join(localAppData, 'Google', 'Chrome', 'User Data');
    }
    return path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }

  if (platform === 'darwin') {
    return path.join(
      home,
      'Library',
      'Application Support',
      'Google',
      'Chrome',
    );
  }

  return path.join(home, '.config', 'google-chrome');
}

function buildLaunchOptions({
  executable,
  plan,
  port,
  additionalFlags,
  verbose,
}: BuildLaunchOptionsArgs): LaunchOptions {
  const launchOptions: LaunchOptions = {
    executable,
    port,
    userDataDir: plan.userDataDir,
    profileDirectory: plan.profileDirectory,
  };
  if (additionalFlags && additionalFlags.length) {
    launchOptions.additionalFlags = additionalFlags;
  }
  if (typeof verbose === 'boolean') {
    launchOptions.verbose = verbose;
  }
  return launchOptions;
}

async function launchChrome(options: LaunchOptions): Promise<void> {
  const {
    executable,
    port,
    userDataDir,
    profileDirectory,
    additionalFlags,
    verbose,
  } = options;

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileDirectory}`,
    '--remote-allow-origins=*',
    '--disable-features=ChromeLabs',
    '--disable-features=OptimizationHints',
    '--disable-background-networking',
    '--no-first-run',
    '--no-default-browser-check',
  ];

  if (Array.isArray(additionalFlags) && additionalFlags.length) {
    args.push(...additionalFlags);
  }

  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  if (verbose) {
    console.log(
      `Spawned Chrome (${executable}) with args: ${args
        .map((arg) => JSON.stringify(arg))
        .join(' ')}`,
    );
  }
}

async function waitForDevTools(
  host: string,
  port: number,
  totalTimeoutMs: number,
  verbose?: boolean,
): Promise<boolean> {
  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    if (await isDevToolsAvailable(host, port)) {
      if (verbose) {
        console.log(`Chrome DevTools reachable on ${host}:${port}.`);
      }
      return true;
    }
    await delay(300);
  }
  return false;
}

async function isDevToolsAvailable(
  host: string,
  port: number,
  timeoutMs = 1_000,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${host}:${port}/json/version`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }
    await response.text();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function closeChromeInstances(verbose?: boolean): Promise<boolean> {
  if (!(await isChromeRunning())) {
    if (verbose) {
      console.log('No running Chrome instances detected.');
    }
    return false;
  }

  if (verbose) {
    console.warn('Closing existing Chrome instances to enable remote debugging.');
  }

  const platform = process.platform;
  try {
    if (platform === 'win32') {
      await execFileAsync('taskkill', ['/IM', 'chrome.exe', '/T', '/F']);
    } else if (platform === 'darwin') {
      await execFileAsync('pkill', ['-x', 'Google Chrome']);
    } else {
      await execFileAsync('pkill', ['-f', 'chrome']);
    }
    await delay(750);
    return true;
  } catch (error) {
    if (verbose) {
      console.error('Failed to close Chrome automatically:', formatError(error));
    }
    return false;
  }
}

async function isChromeRunning(): Promise<boolean> {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', [
        '/FI',
        'IMAGENAME eq chrome.exe',
      ]);
      return stdout.toLowerCase().includes('chrome.exe');
    }

    if (platform === 'darwin') {
      await execFileAsync('pgrep', ['-x', 'Google Chrome']);
      return true;
    }

    await execFileAsync('pgrep', ['-f', 'chrome']);
    return true;
  } catch {
    return false;
  }
}

async function isPortBusy(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    tester.once('listening', () => {
      tester.close(() => resolve(false));
    });
    tester.listen(port, host);
  });
}

interface PortState {
  reachable: boolean;
  message?: string;
}

async function describePortState(host: string, port: number): Promise<PortState> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const response = await fetch(`http://${host}:${port}/json/version`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (response.ok) {
      return { reachable: true };
    }
    return {
      reachable: false,
      message: `Received HTTP ${response.status} from ${host}:${port}`,
    };
  } catch (error) {
    return { reachable: false, message: formatError(error) };
  }
}

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

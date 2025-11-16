import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { pathExists } from './fileSystem.js';

export async function openHtmlReportInChrome(
  reportPath: string,
  contextLabel = 'HTML',
): Promise<void> {
  const resolved = path.resolve(reportPath);
  try {
    await fs.access(resolved);
  } catch {
    console.warn(`[${contextLabel}] HTML report not found at ${resolved}.`);
    return;
  }
  const chromeExecutable = await findChromeExecutable(contextLabel);
  if (!chromeExecutable) {
    console.warn(
      `[${contextLabel}] Unable to locate Google Chrome to preview the HTML report. Set CHROME_PATH to override.`,
    );
    return;
  }
  try {
    launchDetachedProcess(chromeExecutable, ['--new-window', resolved]);
    console.log(
      `[${contextLabel}] Opened HTML merge report in Chrome: ${resolved}`,
    );
  } catch (error) {
    console.warn(
      `[${contextLabel}] Failed to open Chrome for the HTML report:`,
      error instanceof Error ? error.message : error,
    );
  }
}

async function findChromeExecutable(
  contextLabel: string,
): Promise<string | undefined> {
  const explicit =
    process.env.CHROME_PATH ?? process.env.GOOGLE_CHROME_BIN ?? undefined;
  if (explicit && (await pathExists(explicit))) {
    return explicit;
  }
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const programFiles = process.env.PROGRAMFILES;
    const programFilesX86 = process.env['PROGRAMFILES(X86)'];
    const localAppData = process.env.LOCALAPPDATA;
    if (programFiles) {
      candidates.push(
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      );
    }
    if (programFilesX86) {
      candidates.push(
        path.join(
          programFilesX86,
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        ),
      );
    }
    if (localAppData) {
      candidates.push(
        path.join(
          localAppData,
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        ),
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(
        process.env.HOME ?? '~',
        'Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ),
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }
  for (const candidate of candidates) {
    if (candidate && (await pathExists(candidate))) {
      return candidate;
    }
  }
  console.warn(
    `[${contextLabel}] Unable to locate Chrome executable (checked ${candidates.length} path${candidates.length === 1 ? '' : 's'}).`,
  );
  return undefined;
}

function launchDetachedProcess(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

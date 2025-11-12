#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distEntry = path.join(repoRoot, 'dist', 'index.js');

if (await shouldRebuild(distEntry, path.join(repoRoot, 'src'))) {
  runBuild();
}

await import(pathToFileURL(distEntry).href);

async function shouldRebuild(distPath, sourceDir) {
  let distStat;
  try {
    distStat = await fs.stat(distPath);
  } catch {
    return true;
  }
  const latestSource = await findLatestSourceMtime(sourceDir);
  return latestSource > distStat.mtimeMs;
}

async function findLatestSourceMtime(targetDir) {
  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  let latest = 0;
  for (const entry of entries) {
    const entryPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, await findLatestSourceMtime(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      const stat = await fs.stat(entryPath);
      latest = Math.max(latest, stat.mtimeMs);
    }
  }
  return latest;
}

function runBuild() {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCommand, ['run', 'build'], {
    stdio: 'inherit',
    cwd: repoRoot,
  });
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

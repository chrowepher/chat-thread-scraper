#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });

const runMergeCli = async () => {
  const cliArgs = process.argv.slice(2);
  const tsxRunner = path.join(
    'node_modules',
    'tsx',
    'dist',
    'cli.mjs',
  );
  await run(process.execPath, [tsxRunner, 'src/mergeSnapshotCli.ts', ...cliArgs]);
};

const runReport = async () => {
  const nodeBin = process.execPath;
  await run(nodeBin, [path.join('scripts', 'render-harvest-report.mjs')]);
};

const main = async () => {
  await runMergeCli();
  await runReport();
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

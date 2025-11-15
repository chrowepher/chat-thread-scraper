import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

const tsxRunner = path.join(
  process.cwd(),
  'node_modules',
  'tsx',
  'dist',
  'cli.mjs',
);

const runCli = (
  entry: string,
  args: string[] = ['--help'],
): { status: number | null; stdout: string; stderr: string } => {
  const resolvedEntry = path.join(process.cwd(), entry);
  const result = spawnSync('node', [tsxRunner, resolvedEntry, ...args], {
    encoding: 'utf-8',
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
};

describe('CLI help output', () => {
  it('prints the primary help menu', () => {
    const result = runCli('src/index.ts');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('chat-thread-merger');
    expect(result.stdout).toContain('autopilot');
  });

  it('prints merge snapshot help', () => {
    const result = runCli('src/mergeSnapshotCli.ts');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('chat-thread-merge-snapshot');
    expect(result.stdout).toContain('--input <path>');
  });
});

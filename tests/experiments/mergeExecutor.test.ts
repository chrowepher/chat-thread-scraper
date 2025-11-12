import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MergeExecutor } from '../../src/experiments/mergeExecutor.js';
import type { MergeOptions, MergeResult } from '../../src/openaiMerge.js';

describe('MergeExecutor', () => {
  it('loads thread files, calls merge function, and writes outputs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'merge-executor-'));
    const threadA = path.join(dir, 'threadA.md');
    const threadB = path.join(dir, 'threadB.md');
    await writeFile(threadA, 'Content A', 'utf-8');
    await writeFile(threadB, 'Content B', 'utf-8');

    const mergeFn = async (options: MergeOptions): Promise<MergeResult> => {
      expect(options.branches).toHaveLength(2);
      return {
        summary: `Merged ${options.branches.map((b) => b.title).join(' + ')}`,
        combinedPath: [],
        mergeDecisions: [],
      };
    };

    const executor = new MergeExecutor({ mergeFn });
    const result = await executor.execute({
      label: 'T2-match',
      outputDir: path.join(dir, 'out'),
      threadPaths: [threadA, threadB],
    });

    const output = await readFile(result.outputPath, 'utf-8');
    expect(output).toContain('Merged threadA.md + threadB.md');

    const metadata = JSON.parse(
      await readFile(result.metadataPath, 'utf-8'),
    ) as { threads: string[] };
    expect(metadata.threads).toEqual([threadA, threadB]);
  });
});

import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LineageRecorder } from '../../src/experiments/lineageRecorder.js';

describe('LineageRecorder', () => {
  it('records entries with rpTags', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lineage-recorder-'));
    const recorder = await LineageRecorder.load(dir, 'exp-123', 'T2');
    recorder.record({
      label: 'perm-balanced',
      kind: 'permutation',
      newick: '((A,B),(C,D))',
      treeShape: 'balanced',
      orderSpec: 'A>B>C>D',
      permId: 'abc123',
      seed: 42,
      outputPath: path.join(dir, 'output.md'),
      notes: 'example',
    });
    await recorder.save();

    const saved = JSON.parse(
      await readFile(path.join(dir, 'lineage.json'), 'utf-8'),
    );
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0].rpTag).toMatch(/^RP\/T2-exp-123/);
    expect(saved.entries[0].treeShape).toBe('balanced');
  });
});

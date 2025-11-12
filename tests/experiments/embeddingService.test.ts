import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EmbeddingService,
  type EmbeddingProvider,
} from '../../src/experiments/embeddingService.js';

class FakeProvider implements EmbeddingProvider {
  public callCount = 0;

  async embed(texts: string[]): Promise<number[][]> {
    this.callCount += 1;
    return texts.map((text, index) => [text.length + index + this.callCount]);
  }
}

describe('EmbeddingService', () => {
  it('caches embeddings between calls and persists to disk', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'embedding-cache-'));
    const cachePath = path.join(dir, 'embeddings.json');
    const provider = new FakeProvider();
    const service = new EmbeddingService({ provider, cachePath });
    await service.loadCache();

    const first = await service.embed(['alpha', 'beta']);
    expect(first).toHaveLength(2);
    expect(provider.callCount).toBe(1);
    await service.saveCache();

    const newProvider = new FakeProvider();
    const service2 = new EmbeddingService({ provider: newProvider, cachePath });
    await service2.loadCache();
    const second = await service2.embed(['alpha']);
    expect(second[0]).toEqual(first[0]);
    expect(newProvider.callCount).toBe(0);
  });
});

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExperimentPlanId } from './runner.js';

interface PlanCacheRecord {
  planId: ExperimentPlanId;
  inputSignature: string;
  runId: string;
  runDir: string;
  updatedAt: string;
}

interface PlanCacheFile {
  records: PlanCacheRecord[];
  version: 1;
}

const DEFAULT_CACHE_PATH = path.resolve('cache', 'plan-index.json');

export class PlanRunCache {
  private constructor(
    private readonly cachePath: string,
    private readonly records: Map<string, PlanCacheRecord>,
  ) {}

  static async load(cachePath: string = DEFAULT_CACHE_PATH): Promise<PlanRunCache> {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    try {
      const raw = await fs.readFile(cachePath, 'utf-8');
      const parsed = JSON.parse(raw) as PlanCacheFile;
      const map = new Map(
        parsed.records.map((record) => [
          PlanRunCache.buildKey(record.planId, record.inputSignature),
          record,
        ]),
      );
      return new PlanRunCache(cachePath, map);
    } catch {
      return new PlanRunCache(cachePath, new Map());
    }
  }

  async find(
    planId: ExperimentPlanId,
    inputSignature: string,
  ): Promise<PlanCacheRecord | undefined> {
    const key = PlanRunCache.buildKey(planId, inputSignature);
    const record = this.records.get(key);
    if (!record) {
      return undefined;
    }
    const manifestSignature = await readManifestSignature(record.runDir);
    if (manifestSignature !== inputSignature) {
      this.records.delete(key);
      await this.save();
      return undefined;
    }
    return record;
  }

  async upsert(record: PlanCacheRecord): Promise<void> {
    const key = PlanRunCache.buildKey(record.planId, record.inputSignature);
    this.records.set(key, {
      ...record,
      updatedAt: new Date().toISOString(),
    });
    await this.save();
  }

  private async save(): Promise<void> {
    const payload: PlanCacheFile = {
      version: 1,
      records: Array.from(this.records.values()),
    };
    await fs.writeFile(
      this.cachePath,
      JSON.stringify(payload, null, 2),
      'utf-8',
    );
  }

  private static buildKey(planId: string, signature: string): string {
    return `${planId}::${signature}`;
  }
}

async function readManifestSignature(runDir: string): Promise<string | undefined> {
  try {
    const manifestPath = path.join(runDir, 'manifest.json');
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      inputs?: { signature?: string };
    };
    return parsed.inputs?.signature ?? undefined;
  } catch {
    return undefined;
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { TreeShape } from './runner.js';

export interface LineageEntry {
  rpTag: string;
  label: string;
  kind: 'permutation' | 'tournament' | 'comparison';
  newick: string;
  treeShape?: TreeShape | string;
  orderSpec: string;
  permId?: string;
  seed?: number;
  outputPath: string;
  notes?: string;
}

interface LineageFile {
  runId: string;
  branchCount: string;
  entries: LineageEntry[];
  updatedAt: string;
}

const FILENAME = 'lineage.json';

export class LineageRecorder {
  private readonly filePath: string;

  private readonly runId: string;

  private readonly branchCount: string;

  private data: LineageFile;

  private constructor(filePath: string, runId: string, branchCount: string, data: LineageFile) {
    this.filePath = filePath;
    this.runId = runId;
    this.branchCount = branchCount;
    this.data = data;
  }

  static async load(
    runDir: string,
    runId: string,
    branchCount: string,
  ): Promise<LineageRecorder> {
    const filePath = path.join(runDir, FILENAME);
    let data: LineageFile;
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      data = JSON.parse(raw) as LineageFile;
    } catch {
      data = {
        runId,
        branchCount,
        entries: [],
        updatedAt: new Date().toISOString(),
      };
    }
    return new LineageRecorder(filePath, runId, branchCount, data);
  }

  record(entry: Omit<LineageEntry, 'rpTag'>): void {
    const rpTag = buildRpTag({
      branchCount: this.branchCount,
      runId: this.runId,
      orderSpec: entry.orderSpec,
      newick: entry.newick,
    });
    this.data.entries.push({
      ...entry,
      rpTag,
    });
    this.touch();
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(
      this.filePath,
      JSON.stringify(this.data, null, 2),
      'utf-8',
    );
  }

  get entries(): LineageEntry[] {
    return this.data.entries;
  }

  private touch(): void {
    this.data.updatedAt = new Date().toISOString();
  }
}

function buildRpTag(input: {
  branchCount: string;
  runId: string;
  orderSpec: string;
  newick: string;
}): string {
  const hash = crypto.createHash('sha1');
  hash.update(input.newick);
  const short = hash.digest('hex').slice(0, 6);
  return `RP/${input.branchCount}-${input.runId}/${sanitizeOrderSpec(input.orderSpec)}/${short}`;
}

function sanitizeOrderSpec(order: string): string {
  return order.replace(/[^a-z0-9->]/gi, '_');
}

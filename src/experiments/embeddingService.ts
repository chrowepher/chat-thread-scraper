import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';

export interface EmbeddingProvider {
  embed(texts: string[], model: string): Promise<number[][]>;
}

export interface EmbeddingServiceOptions {
  model?: string;
  provider?: EmbeddingProvider;
  apiKey?: string;
  apiKeyEnv?: string;
  apiBase?: string;
  cachePath?: string;
}

const DEFAULT_MODEL = 'text-embedding-3-small';

export class EmbeddingService {
  private readonly model: string;

  private readonly provider: EmbeddingProvider;

  private readonly cachePath: string | undefined;

  private cache = new Map<string, number[]>();

  private dirty = false;

  constructor(options: EmbeddingServiceOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    if (options.provider) {
      this.provider = options.provider;
    } else {
      const providerOptions: {
        apiKey?: string;
        apiKeyEnv?: string;
        apiBase?: string;
      } = {};
      if (options.apiKey !== undefined) {
        providerOptions.apiKey = options.apiKey;
      }
      if (options.apiKeyEnv !== undefined) {
        providerOptions.apiKeyEnv = options.apiKeyEnv;
      }
      if (options.apiBase !== undefined) {
        providerOptions.apiBase = options.apiBase;
      }
      this.provider = new OpenAIEmbeddingProvider(providerOptions);
    }
    this.cachePath = options.cachePath
      ? path.resolve(options.cachePath)
      : undefined;
  }

  async loadCache(): Promise<void> {
    const cachePath = this.cachePath;
    if (!cachePath) {
      return;
    }
    const targetPath = cachePath!;
    try {
      const raw = await fs.readFile(targetPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, number[]>;
      this.cache = new Map(Object.entries(parsed));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `EmbeddingService: failed to load cache at ${targetPath}:`,
          error,
        );
      }
    }
  }

  async saveCache(): Promise<void> {
    const cachePath = this.cachePath;
    if (!cachePath || !this.dirty) {
      return;
    }
    const targetPath = cachePath!;
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const payload = Object.fromEntries(this.cache.entries());
    await fs.writeFile(
      targetPath,
      JSON.stringify(payload, null, 2),
      'utf-8',
    );
    this.dirty = false;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) {
      return [];
    }
    const pending: { index: number; text: string; key: string }[] = [];
    const results: Array<number[] | undefined> = new Array(texts.length);

    for (let i = 0; i < texts.length; i += 1) {
      const text = texts[i];
      if (text === undefined) {
        continue;
      }
      const key = this.createCacheKey(text);
      const cached = this.cache.get(key);
      if (cached) {
        results[i] = cached;
      } else {
        pending.push({ index: i, text, key });
      }
    }

    if (pending.length) {
      const vectors = await this.provider.embed(
        pending.map((entry) => entry.text),
        this.model,
      );
      pending.forEach((entry, idx) => {
        const vector = vectors[idx];
        if (!vector) {
          throw new Error(
            `Embedding provider returned insufficient vectors (expected ${pending.length}).`,
          );
        }
        results[entry.index] = vector;
        this.cache.set(entry.key, vector);
      });
      this.dirty = true;
    }

    return results.map((vector) => vector ?? []);
  }

  private createCacheKey(text: string): string {
    const hash = crypto.createHash('sha1');
    hash.update(this.model);
    hash.update('|');
    hash.update(text);
    return hash.digest('hex');
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly client: OpenAI;

  private readonly apiKey: string;

  constructor(options: {
    apiKey?: string;
    apiKeyEnv?: string;
    apiBase?: string;
  }) {
    this.apiKey =
      options.apiKey ??
      (options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined) ??
      process.env.OPENAI_API_KEY ??
      '';
    if (!this.apiKey) {
      throw new Error(
        'OpenAIEmbeddingProvider: missing API key (set via --api-key or environment variable).',
      );
    }
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: options.apiBase,
    });
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    if (!texts.length) {
      return [];
    }
    const response = await this.client.embeddings.create({
      model,
      input: texts,
    });
    return response.data.map((item) => item.embedding as number[]);
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { mergeBranches } from '../openaiMerge.js';
import type { MergeOptions } from '../openaiMerge.js';
import type { BrowserConversation, MergeResult } from '../types.js';

export interface MergeExecutorOptions {
  model?: string;
  temperature?: number;
  prompt?: string;
  maxBranchHighlights?: number;
  mergeFn?: (options: MergeOptions) => Promise<MergeResult>;
}

export interface MergeExecutionRequest {
  label: string;
  outputDir: string;
  threadPaths: string[];
  metadata?: Record<string, unknown>;
}

export interface MergeExecutionResult {
  label: string;
  outputPath: string;
  metadataPath: string;
  mergeResult: MergeResult;
}

export class MergeExecutor {
  private readonly model: string | undefined;

  private readonly temperature: number | undefined;

  private readonly prompt: string | undefined;

  private readonly maxBranchHighlights: number | undefined;

  private readonly mergeFn: (options: MergeOptions) => Promise<MergeResult>;

  constructor(options: MergeExecutorOptions = {}) {
    this.model = options.model;
    this.temperature = options.temperature;
    this.prompt = options.prompt;
    this.maxBranchHighlights = options.maxBranchHighlights;
    this.mergeFn = options.mergeFn ?? mergeBranches;
  }

  async execute(request: MergeExecutionRequest): Promise<MergeExecutionResult> {
    if (request.threadPaths.length < 2) {
      throw new Error('MergeExecutor requires at least two thread paths.');
    }

    await fs.mkdir(request.outputDir, { recursive: true });

    const branches = await Promise.all(
      request.threadPaths.map(async (threadPath, index) =>
        this.loadBranch(threadPath, index),
      ),
    );

    const mergeOptions: MergeOptions = {
      branches,
    };
    if (this.model !== undefined) {
      mergeOptions.model = this.model;
    }
    if (this.temperature !== undefined) {
      mergeOptions.temperature = this.temperature;
    }
    if (this.prompt !== undefined) {
      mergeOptions.prompt = this.prompt;
    }
    if (this.maxBranchHighlights !== undefined) {
      mergeOptions.maxBranchHighlights = this.maxBranchHighlights;
    }

    const mergeResult = await this.mergeFn(mergeOptions);

    const safeLabel = sanitizeLabel(request.label);
    const outputPath = path.join(request.outputDir, `${safeLabel}.md`);
    const metadataPath = path.join(
      request.outputDir,
      `${safeLabel}.metadata.json`,
    );

    await fs.writeFile(outputPath, formatMergeOutput(request.label, mergeResult), 'utf-8');
    await fs.writeFile(
      metadataPath,
      JSON.stringify(
        {
          label: request.label,
          threads: request.threadPaths,
          metadata: request.metadata ?? {},
          mergeResult,
        },
        null,
        2,
      ),
      'utf-8',
    );

    return {
      label: request.label,
      outputPath,
      metadataPath,
      mergeResult,
    };
  }

  private async loadBranch(
    threadPath: string,
    index: number,
  ): Promise<BrowserConversation> {
    const content = await fs.readFile(threadPath, 'utf-8');
    return {
      tabId: `${index}-${threadPath}`,
      title: path.basename(threadPath),
      url: threadPath,
      messages: [
        {
          role: 'assistant',
          content,
        },
      ],
    };
  }
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-z0-9-_]/gi, '_').replace(/_+/g, '_');
}

function formatMergeOutput(label: string, result: MergeResult): string {
  const decisions = result.mergeDecisions
    .map((decision: MergeResult['mergeDecisions'][number]) => {
      const rationale = decision.rationale
        ? ` (${decision.rationale})`
        : '';
      return `- ${decision.branchTitles.join(' + ')}: ${decision.decision}${rationale}`;
    })
    .join('\n');
  const followUps = result.followUpIdeas
    ? `\n\n## Follow-up Ideas\n${result.followUpIdeas
        .map((idea: string, idx: number) => `${idx + 1}. ${idea}`)
        .join('\n')}\n`
    : '';
  return [
    `# ${label}`,
    '',
    result.summary,
    '',
    '## Merge Decisions',
    decisions || '(none recorded)',
    followUps,
  ].join('\n');
}

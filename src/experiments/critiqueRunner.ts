import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface CritiqueRunOptions {
  label: string;
  leftPath: string;
  rightPath: string;
  outputDir: string;
  promptPath?: string;
  replicates?: number;
}

export interface CritiqueRunResult {
  leftScore: number;
  rightScore: number;
  markdownPath: string;
  scorecardPath: string;
}

export interface CritiqueRunner {
  runComparison(options: CritiqueRunOptions): Promise<CritiqueRunResult>;
}

export class FileStatsCritiqueRunner implements CritiqueRunner {
  async runComparison(options: CritiqueRunOptions): Promise<CritiqueRunResult> {
    await fs.mkdir(options.outputDir, { recursive: true });
    const leftContent = await fs.readFile(options.leftPath, 'utf-8');
    const rightContent = await fs.readFile(options.rightPath, 'utf-8');
    const leftScore = scoreText(leftContent);
    const rightScore = scoreText(rightContent);

    const markdownPath = path.join(
      options.outputDir,
      `${sanitizeLabel(options.label)}.critique.md`,
    );
    const scorecardPath = path.join(
      options.outputDir,
      `${sanitizeLabel(options.label)}.scorecard.json`,
    );

    const markdown = [
      `# Critique: ${options.label}`,
      '',
      `- Left score: ${leftScore.toFixed(2)}`,
      `- Right score: ${rightScore.toFixed(2)}`,
      '',
      leftScore >= rightScore
        ? 'Left output preserves more unique content.'
        : 'Right output preserves more unique content.',
    ].join('\n');

    const scorecard = {
      model: 'file-stats',
      replicate_count: 1,
      aggregate: {
        left: {
          mean: leftScore,
          ci95: 0,
          replicates: 1,
        },
        right: {
          mean: rightScore,
          ci95: 0,
          replicates: 1,
        },
        delta: {
          mean: leftScore - rightScore,
          ci95: 0,
          replicates: 1,
        },
      },
      replicates: [
        {
          index: 1,
          winner: leftScore >= rightScore ? 'left' : 'right',
          criteria: [
            {
              name: 'unique_token_score',
              left: leftScore,
              right: rightScore,
              rationale: 'Placeholder deterministic critique.',
            },
          ],
          summary_markdown: markdown,
          raw: {},
          token_usage: {},
        },
      ],
    };

    await fs.writeFile(markdownPath, markdown, 'utf-8');
    await fs.writeFile(
      scorecardPath,
      JSON.stringify(scorecard, null, 2),
      'utf-8',
    );

    return {
      leftScore,
      rightScore,
      markdownPath,
      scorecardPath,
    };
  }
}

export interface PythonCritiqueRunnerOptions {
  scriptPath?: string;
  pythonPath?: string;
  temperature?: number;
  defaultReplicates?: number;
  env?: NodeJS.ProcessEnv;
}

export class PythonCritiqueRunner implements CritiqueRunner {
  private readonly scriptPath: string;

  private readonly pythonPath: string;

  private readonly temperature: number;

  private readonly defaultReplicates: number;

  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(options: PythonCritiqueRunnerOptions = {}) {
    this.scriptPath = path.resolve(
      options.scriptPath ?? path.join('scripts', 'post_to_chatgpt.py'),
    );
    this.pythonPath = options.pythonPath ?? 'python';
    this.temperature = options.temperature ?? 0;
    this.defaultReplicates = options.defaultReplicates ?? 1;
    this.env = options.env;
  }

  async runComparison(options: CritiqueRunOptions): Promise<CritiqueRunResult> {
    await fs.mkdir(options.outputDir, { recursive: true });
    await this.assertScriptExists();
    const promptPath =
      options.promptPath ??
      (await writeDefaultPrompt(options.outputDir, options.label));
    const replicates =
      options.replicates && options.replicates > 0
        ? options.replicates
        : this.defaultReplicates;

    const markdownPath = path.join(
      options.outputDir,
      `${sanitizeLabel(options.label)}.critique.md`,
    );
    const scorecardPath = path.join(
      options.outputDir,
      `${sanitizeLabel(options.label)}.scorecard.json`,
    );

    const args = [
      this.scriptPath,
      '--left',
      options.leftPath,
      '--right',
      options.rightPath,
      '--prompt',
      promptPath,
      '--replicates',
      String(replicates),
      '--temperature',
      String(this.temperature),
      '--out-markdown',
      markdownPath,
      '--out-scorecard',
      scorecardPath,
    ];

    const processOptions = this.env ? { env: this.env } : undefined;
    await runProcess(this.pythonPath, args, processOptions);

    const scorecard = await readScorecard(scorecardPath);
    return {
      leftScore: scorecard.left,
      rightScore: scorecard.right,
      markdownPath,
      scorecardPath,
    };
  }

  private async assertScriptExists(): Promise<void> {
    try {
      await fs.stat(this.scriptPath);
    } catch {
      throw new Error(
        `Critique script not found at ${this.scriptPath}. Ensure scripts/post_to_chatgpt.py exists.`,
      );
    }
  }
}

async function runProcess(
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(options?.env ?? {}),
      },
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}

async function writeDefaultPrompt(outputDir: string, label: string): Promise<string> {
  const promptPath = path.join(
    outputDir,
    `${sanitizeLabel(label)}.prompt.md`,
  );
  const content = [
    '# Comparison Prompt',
    '',
    'Compare the LEFT and RIGHT documents.',
    'Score which output provides better coverage, accuracy, and clarity. Explain briefly.',
  ].join('\n');
  await fs.writeFile(promptPath, content, 'utf-8');
  return promptPath;
}

async function readScorecard(scorecardPath: string): Promise<{
  left: number;
  right: number;
}> {
  const raw = await fs.readFile(scorecardPath, 'utf-8');
  const parsed = JSON.parse(raw) as {
    aggregate?: {
      left?: { mean?: number };
      right?: { mean?: number };
    };
  };
  return {
    left: parsed.aggregate?.left?.mean ?? 0,
    right: parsed.aggregate?.right?.mean ?? 0,
  };
}

function scoreText(text: string): number {
  const words = new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
  return words.size;
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-z0-9-_]/gi, '_').replace(/_+/g, '_');
}

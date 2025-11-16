#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import { pathExists } from './utils/fileSystem.js';
import type { AuditRecord, QaRecord } from './autopilot/auditService.js';

interface CalibrationOptions {
  sampleSize: number;
  lookbackDays: number;
  model: string;
  output: string;
}

interface AuditQaPair {
  runId: string;
  audit: AuditRecord;
  qa: QaRecord;
  auditPath: string;
  qaPath: string;
}

interface CalibrationReport {
  generatedAt: string;
  lookbackDays: number;
  sampleSize: number;
  model: string;
  trend: 'stable' | 'improving' | 'regressing';
  summary: string;
  drifts: Array<{
    label: string;
    detail: string;
    impactedRuns: string[];
  }>;
  recommendations: string[];
  samples: Array<{
    runId: string;
    auditVerdict: string;
    auditStatus: string;
    qaVerdict?: string;
    qaSeverity?: string;
  }>;
}

export function createCalibrationCommand(): Command {
  const calibration = new Command('calibrate');
  calibration
    .description(
      'Sample recent chatgpt-audit/chatgpt-qa pairs and check for calibration drift.',
    )
    .option(
      '--sample-size <number>',
      'How many audit/QA pairs to analyze (default 5).',
      toPositiveInt('sample-size'),
      5,
    )
    .option(
      '--lookback-days <number>',
      'Only consider runs from the last N days (default 7).',
      toPositiveInt('lookback-days'),
      7,
    )
    .option(
      '--model <name>',
      'OpenAI (or compatible) model used for calibration analysis.',
      'gpt-4.1',
    )
    .option(
      '--output <path>',
      'Destination JSON report path.',
      path.join('dist', 'audit-calibration.json'),
    )
    .action(async (raw: CalibrationOptions) => {
      try {
        await runCalibration({
          sampleSize: raw.sampleSize,
          lookbackDays: raw.lookbackDays,
          model: raw.model,
          output: path.resolve(raw.output),
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    });
  return calibration;
}

async function runCalibration(options: CalibrationOptions): Promise<void> {
  const pairs = await collectAuditQaPairs({
    lookbackDays: options.lookbackDays,
  });
  if (!pairs.length) {
    console.log(
      `[calibrate] No audit/QA pairs found within the last ${options.lookbackDays} days.`,
    );
    return;
  }
  const sample = pairs.slice(0, options.sampleSize);
  const promptPayload = sample.map((pair) => ({
    runId: pair.runId,
    audit: {
      verdict: pair.audit.verdict,
      status: pair.audit.status,
      summary: pair.audit.summary,
      risks: pair.audit.risks,
      recommendations: pair.audit.recommendations,
      generatedAt: pair.audit.generatedAt,
    },
    qa: pair.qa
      ? {
          verdict: pair.qa.verdict,
          severity: pair.qa.severity,
          summary: pair.qa.summary,
          recommendations: pair.qa.recommendations,
          generatedAt: pair.qa.generatedAt,
        }
      : null,
  }));
  const systemPrompt = [
    'You are the calibration officer for ChatGPT Autopilot audits.',
    'Given several audit + QA pairs, identify calibration drift, false positives/negatives, and trend direction.',
    'Return JSON only.',
  ].join(' ');
  const userPrompt = [
    `Sample size: ${sample.length}, lookback ${options.lookbackDays} days.`,
    'Pairs:',
    '```json',
    JSON.stringify(promptPayload, null, 2),
    '```',
    '',
    'Return JSON matching:',
    JSON.stringify(
      {
        trend: 'stable|improving|regressing',
        summary: 'one paragraph',
        drifts: [
          {
            label: 'false_positive|false_negative|coverage_gap',
            detail: 'description',
            impactedRuns: ['run-id'],
          },
        ],
        recommendations: ['action'],
      },
      null,
      2,
    ),
  ].join('\n');

  const client = new OpenAI();
  const completion = await client.chat.completions.create({
    model: options.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });
  const content = completion.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('calibrate: model returned an empty response.');
  }
  const parsed = parseJson(content, 'calibrate');
  const trend = normalizeTrend(parsed.trend);
  const report: CalibrationReport = {
    generatedAt: new Date().toISOString(),
    lookbackDays: options.lookbackDays,
    sampleSize: sample.length,
    model: options.model,
    trend,
    summary: parsed.summary ?? '',
    drifts: Array.isArray(parsed.drifts)
      ? parsed.drifts.map((drift: any) => ({
          label: sanitizeString(drift?.label) || 'unspecified',
          detail: sanitizeString(drift?.detail) || '',
          impactedRuns: Array.isArray(drift?.impactedRuns)
            ? drift.impactedRuns
                .map((run: any) => sanitizeString(run))
                .filter(Boolean)
            : [],
        }))
      : [],
    recommendations: toStringArray(parsed.recommendations),
    samples: sample.map((pair) => {
      const entry: CalibrationReport['samples'][number] = {
        runId: pair.runId,
        auditVerdict: pair.audit.verdict,
        auditStatus: pair.audit.status,
      };
      if (pair.qa.verdict) {
        entry.qaVerdict = pair.qa.verdict;
      }
      if (pair.qa.severity) {
        entry.qaSeverity = pair.qa.severity;
      }
      return entry;
    }),
  };

  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, JSON.stringify(report, null, 2), 'utf-8');
  const markdownPath = options.output.replace(/\.json$/i, '.md');
  await fs.writeFile(markdownPath, renderCalibrationMarkdown(report), 'utf-8');
  const rawPath = options.output.replace(/\.json$/i, '.raw.json');
  await fs.writeFile(
    rawPath,
    JSON.stringify(completion, null, 2),
    'utf-8',
  );

  console.log(
    `[calibrate] Trend: ${report.trend}. Report written to ${path.relative(process.cwd(), options.output)}.`,
  );
}

async function collectAuditQaPairs(options: {
  lookbackDays: number;
}): Promise<AuditQaPair[]> {
  const runsDir = path.resolve('runs');
  if (!(await pathExists(runsDir))) {
    return [];
  }
  const dirents = await fs.readdir(runsDir, { withFileTypes: true });
  const cutoff = Date.now() - options.lookbackDays * 24 * 60 * 60 * 1000;
  const pairs: AuditQaPair[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const runId = dirent.name;
    const auditPath = path.join(runsDir, runId, 'audit', 'chatgpt-audit.json');
    const qaPath = path.join(runsDir, runId, 'audit', 'chatgpt-qa.json');
    if (!(await pathExists(auditPath)) || !(await pathExists(qaPath))) {
      continue;
    }
    const audit = await readJson<AuditRecord>(auditPath);
    const qa = await readJson<QaRecord>(qaPath);
    if (!audit?.generatedAt || !qa) {
      continue;
    }
    const timestamp = Date.parse(audit.generatedAt);
    if (Number.isNaN(timestamp) || timestamp < cutoff) {
      continue;
    }
    pairs.push({
      runId,
      audit,
      qa,
      auditPath,
      qaPath,
    });
  }
  pairs.sort((a, b) => {
    const left = Date.parse(a.audit.generatedAt ?? '');
    const right = Date.parse(b.audit.generatedAt ?? '');
    return right - left;
  });
  return pairs;
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function renderCalibrationMarkdown(report: CalibrationReport): string {
  const lines: string[] = [];
  lines.push(`# Audit Calibration (${report.trend})`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(
    `Sample: ${report.sampleSize} runs · Lookback: ${report.lookbackDays} days · Model: ${report.model}`,
  );
  lines.push('');
  lines.push('## Summary');
  lines.push(report.summary || '_No summary supplied._');
  lines.push('');
  if (report.drifts.length) {
    lines.push('## Drift Signals');
    for (const drift of report.drifts) {
      lines.push(
        `- **${drift.label}** (${drift.impactedRuns.join(', ') || 'runs n/a'}): ${drift.detail}`,
      );
    }
    lines.push('');
  }
  if (report.recommendations.length) {
    lines.push('## Recommendations');
    for (const rec of report.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function parseJson(content: string, label: string): any {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${label}: unable to parse JSON response. ${error}`);
  }
}

function normalizeTrend(value: any): 'stable' | 'improving' | 'regressing' {
  const normalized = String(value ?? '')
    .toLowerCase()
    .trim();
  if (normalized === 'improving') {
    return 'improving';
  }
  if (normalized === 'regressing') {
    return 'regressing';
  }
  return 'stable';
}

function sanitizeString(value: any): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toStringArray(value: any): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => sanitizeString(entry))
    .filter(Boolean);
}

function toPositiveInt(label: string) {
  return (value: string): number => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new InvalidArgumentError(`${label} must be a positive integer.`);
    }
    return parsed;
  };
}

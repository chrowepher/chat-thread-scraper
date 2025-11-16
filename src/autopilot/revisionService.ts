import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import type { FinalOutputBundle } from './finalBundle.js';
import type { AuditArtifact, QaArtifact } from './auditService.js';

export interface RevisionSummary {
  revisedSummary: string;
  improvements: Array<{
    gap: string;
    improvement: string;
    impact: string;
    severity?: string;
    reference?: string;
  }>;
  followUpAdjustments?: string[] | undefined;
  residualRisks?: string[] | undefined;
}

export interface RevisionArtifact extends RevisionSummary {
  jsonPath: string;
  markdownPath: string;
  rawResponsePath: string;
}

interface RevisionOptions {
  model: string;
  bundle: FinalOutputBundle;
  bundlePath: string;
  auditRecord?: AuditArtifact | undefined;
  qaRecord?: QaArtifact | undefined;
  outputDir: string;
  apiKey?: string;
}

export async function runAuditDrivenRevision(
  options: RevisionOptions,
): Promise<RevisionArtifact> {
  const client = new OpenAI({
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
  });
  await fs.mkdir(options.outputDir, { recursive: true });

  const bundleJson = JSON.stringify(options.bundle, null, 2);
  const auditJson = options.auditRecord
    ? JSON.stringify(stripArtifactPaths(options.auditRecord), null, 2)
    : null;
  const qaJson = options.qaRecord
    ? JSON.stringify(stripQaPaths(options.qaRecord), null, 2)
    : null;

  const userPrompt = [
    `Final Output Bundle (${path.relative(process.cwd(), options.bundlePath)}):`,
    '```json',
    bundleJson,
    '```',
    '',
    options.auditRecord
      ? [
          'Audit Findings:',
          '```json',
          auditJson,
          '```',
        ].join('\n')
      : 'Audit Findings: (none provided)',
    '',
    options.qaRecord
      ? [
          'QA Review:',
          '```json',
          qaJson,
          '```',
        ].join('\n')
      : 'QA Review: (none provided)',
    '',
    'Return JSON matching:',
    JSON.stringify(
      {
        revised_summary: 'updated executive summary text',
        improvements: [
          {
            gap: 'short description of audit/qa gap',
            improvement: 'concrete fix or enhancement',
            impact: 'how the fix strengthens the artifact',
            severity: 'low|medium|high',
            reference: 'bundle or audit pointer',
          },
        ],
        follow_up_adjustments: ['new or refined action item'],
        residual_risks: ['risk that still needs monitoring'],
      },
      null,
      2,
    ),
  ].join('\n');

  const completion = await client.chat.completions.create({
    model: options.model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You revise autopilot reports after audits. Strengthen the executive summary, list targeted improvements tied to each gap, and highlight any new follow-ups or residual risks. Respond with JSON only.',
      },
      {
        role: 'user',
        content: userPrompt,
      },
    ],
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('runAuditDrivenRevision: model returned an empty response.');
  }

  const parsed = parseJson(content, 'runAuditDrivenRevision');
  const record: RevisionSummary = {
    revisedSummary: sanitizeString(parsed.revised_summary),
    improvements: Array.isArray(parsed.improvements)
      ? parsed.improvements.map((entry: any) => ({
          gap: sanitizeString(entry?.gap),
          improvement: sanitizeString(entry?.improvement),
          impact: sanitizeString(entry?.impact),
          severity: sanitizeString(entry?.severity) || undefined,
          reference: sanitizeString(entry?.reference) || undefined,
        }))
      : [],
    followUpAdjustments: toStringArray(parsed.follow_up_adjustments),
    residualRisks: toStringArray(parsed.residual_risks),
  };

  if (!record.revisedSummary) {
    record.revisedSummary =
      'No additional revisions were required; audit and QA found no actionable gaps.';
  }

  const jsonPath = path.join(options.outputDir, 'chatgpt-revision.json');
  const markdownPath = path.join(options.outputDir, 'chatgpt-revision.md');
  const rawResponsePath = path.join(options.outputDir, 'chatgpt-revision.raw.json');

  await fs.writeFile(jsonPath, JSON.stringify(record, null, 2), 'utf-8');
  await fs.writeFile(markdownPath, renderRevisionMarkdown(record), 'utf-8');
  await fs.writeFile(
    rawResponsePath,
    JSON.stringify(completion, null, 2),
    'utf-8',
  );

  return {
    ...record,
    jsonPath,
    markdownPath,
    rawResponsePath,
  };
}

function renderRevisionMarkdown(record: RevisionSummary): string {
  const lines: string[] = [];
  lines.push('# Audit-Driven Revisions');
  lines.push('');
  lines.push('## Revised Summary');
  lines.push(record.revisedSummary || '_No summary provided._');
  lines.push('');
  lines.push('## Improvements');
  if (record.improvements.length) {
    for (const item of record.improvements) {
      lines.push(
        `- **Gap:** ${item.gap || 'n/a'}\n  - Improvement: ${item.improvement || 'n/a'}\n  - Impact: ${item.impact || 'n/a'}${item.severity ? `\n  - Severity: ${item.severity}` : ''}${item.reference ? `\n  - Reference: ${item.reference}` : ''}`,
      );
    }
  } else {
    lines.push('- No additional improvements were required.');
  }
  lines.push('');
  if (record.followUpAdjustments?.length) {
    lines.push('## Follow-up Adjustments');
    for (const followUp of record.followUpAdjustments) {
      lines.push(`- ${followUp}`);
    }
    lines.push('');
  }
  if (record.residualRisks?.length) {
    lines.push('## Residual Risks');
    for (const risk of record.residualRisks) {
      lines.push(`- ${risk}`);
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

function stripArtifactPaths(artifact: AuditArtifact): Omit<
  AuditArtifact,
  'jsonPath' | 'markdownPath' | 'rawResponsePath'
> {
  const { jsonPath, markdownPath, rawResponsePath, ...rest } = artifact;
  return rest;
}

function stripQaPaths(artifact: QaArtifact): Omit<
  QaArtifact,
  'jsonPath' | 'markdownPath' | 'rawResponsePath'
> {
  const { jsonPath, markdownPath, rawResponsePath, ...rest } = artifact;
  return rest;
}

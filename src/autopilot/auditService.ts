import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import type {
  FinalOutputBundle,
  SuccessCriteriaAttachment,
} from './finalBundle.js';

export interface AuditEvidence {
  criterion: string;
  met: boolean;
  evidence?: string;
  gaps?: string;
  references?: string[];
}

export interface AuditRecord {
  verdict: string;
  status: 'pass' | 'fail' | 'provisional';
  summary: string;
  evidence: AuditEvidence[];
  risks: string[];
  recommendations: string[];
  bundleDigest: string;
  successCriteriaDigest: string;
  model: string;
  promptVersion: string;
  generatedAt: string;
}

export interface AuditArtifact extends AuditRecord {
  jsonPath: string;
  markdownPath: string;
  rawResponsePath: string;
}

export interface QaIssue {
  type: string;
  detail: string;
  severity: 'low' | 'medium' | 'high';
}

export interface QaRecord {
  verdict: 'calibrated' | 'needs_followup';
  severity: 'low' | 'medium' | 'high';
  summary: string;
  issues: QaIssue[];
  recommendations: string[];
  bundleDigest: string;
  successCriteriaDigest: string;
  auditVerdict: string;
  auditStatus: string;
  model: string;
  promptVersion: string;
  generatedAt: string;
}

export interface QaArtifact extends QaRecord {
  jsonPath: string;
  markdownPath: string;
  rawResponsePath: string;
}

interface AuditRunOptions {
  model: string;
  bundle: FinalOutputBundle;
  bundlePath: string;
  bundleDigest: string;
  successCriteria: SuccessCriteriaAttachment;
  outputDir: string;
  apiKey?: string;
}

interface QaRunOptions {
  model: string;
  auditRecord: AuditArtifact;
  bundleDigest: string;
  successCriteria: SuccessCriteriaAttachment;
  outputDir: string;
  apiKey?: string;
}

const AUDIT_PROMPT_VERSION = '2025-11-15.a1';
const QA_PROMPT_VERSION = '2025-11-15.q1';

export async function runChatgptAudit(
  options: AuditRunOptions,
): Promise<AuditArtifact> {
  const client = createClient(options.apiKey);
  await fs.mkdir(options.outputDir, { recursive: true });
  const successCriteriaDigest =
    options.bundle.successCriteria?.digest ??
    hashText(options.successCriteria.content);
  const relativeBundlePath = path.relative(process.cwd(), options.bundlePath);
  const bundleJson = JSON.stringify(options.bundle, null, 2);
  const systemPrompt = [
    'You are the ChatGPT Autopilot Auditor.',
    'Given a structured final output bundle from an automation run and the success criteria, decide whether the run meets the bar.',
    'Cite evidence from the bundle when defending each finding.',
    'Flag blockers or missing data and classify the run as pass, fail, or provisional (needs follow-up).',
    'Respond with JSON only.',
  ].join(' ');
  const userPrompt = [
    `Final Output Bundle (${relativeBundlePath}, sha256 ${options.bundleDigest}):`,
    '```json',
    bundleJson,
    '```',
    '',
    'Success Criteria:',
    '```markdown',
    options.successCriteria.content.trim(),
    '```',
    '',
    'Return JSON matching:',
    JSON.stringify(
      {
        verdict: 'pass|fail|provisional',
        status: 'pass|fail|provisional',
        summary: 'one paragraph rationale',
        evidence: [
          {
            criterion: 'name',
            met: true,
            evidence: 'quote or reference from bundle',
            gaps: 'missing work, if any',
            references: ['bundle.section.path'],
          },
        ],
        risks: ['short bullet'],
        recommendations: ['next step'],
      },
      null,
      2,
    ),
  ].join('\n');

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
    throw new Error('chatgpt-audit: empty response from model.');
  }
  const parsed = parseJson(content, 'chatgpt-audit');
  const record: AuditRecord = {
    verdict: normalizeAuditStatus(parsed.verdict ?? parsed.status),
    status: normalizeAuditStatus(parsed.status ?? parsed.verdict),
    summary: parsed.summary ?? '',
    evidence: Array.isArray(parsed.evidence)
      ? parsed.evidence.map((item: any) => ({
          criterion: sanitizeString(item?.criterion) || 'unnamed',
          met: Boolean(item?.met),
          evidence: sanitizeOptionalString(item?.evidence),
          gaps: sanitizeOptionalString(item?.gaps),
          references: Array.isArray(item?.references)
            ? item.references
                .map((ref: any) => sanitizeString(ref))
                .filter(Boolean)
            : undefined,
        }))
      : [],
    risks: toStringArray(parsed.risks),
    recommendations: toStringArray(parsed.recommendations),
    bundleDigest: options.bundleDigest,
    successCriteriaDigest,
    model: options.model,
    promptVersion: AUDIT_PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
  };

  const jsonPath = path.join(options.outputDir, 'chatgpt-audit.json');
  const markdownPath = path.join(options.outputDir, 'chatgpt-audit.md');
  const rawResponsePath = path.join(options.outputDir, 'chatgpt-audit.raw.json');

  await fs.writeFile(jsonPath, JSON.stringify(record, null, 2), 'utf-8');
  await fs.writeFile(markdownPath, renderAuditMarkdown(record), 'utf-8');
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

export async function runChatgptQa(options: QaRunOptions): Promise<QaArtifact> {
  const client = createClient(options.apiKey);
  await fs.mkdir(options.outputDir, { recursive: true });
  const successCriteriaDigest = hashText(options.successCriteria.content);
  const auditRecord = stripArtifactPaths(options.auditRecord);
  const systemPrompt = [
    'You are the QA reviewer for ChatGPT Autopilot audits.',
    'Inspect the provided audit transcript and success criteria.',
    'Identify missed requirements, hallucinated evidence, or calibration drift.',
    'Respond with JSON only and recommend follow-up if needed.',
  ].join(' ');
  const userPrompt = [
    `Audit Transcript (sha256 bundle digest ${options.bundleDigest}):`,
    '```json',
    JSON.stringify(auditRecord, null, 2),
    '```',
    '',
    'Success Criteria:',
    '```markdown',
    options.successCriteria.content.trim(),
    '```',
    '',
    'Return JSON matching:',
    JSON.stringify(
      {
        verdict: 'calibrated|needs_followup',
        severity: 'low|medium|high',
        summary: 'one paragraph',
        issues: [
          {
            type: 'missed_requirement|hallucination|gap',
            detail: 'description',
            severity: 'low|medium|high',
          },
        ],
        recommendations: ['remediation step'],
      },
      null,
      2,
    ),
  ].join('\n');

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
    throw new Error('chatgpt-qa: empty response from model.');
  }
  const parsed = parseJson(content, 'chatgpt-qa');
  const record: QaRecord = {
    verdict: normalizeQaVerdict(parsed.verdict),
    severity: normalizeQaSeverity(parsed.severity),
    summary: parsed.summary ?? '',
    issues: Array.isArray(parsed.issues)
      ? parsed.issues.map((issue: any) => ({
          type: sanitizeString(issue?.type) || 'gap',
          detail: sanitizeString(issue?.detail) || '',
          severity: normalizeQaSeverity(issue?.severity),
        }))
      : [],
    recommendations: toStringArray(parsed.recommendations),
    bundleDigest: options.bundleDigest,
    successCriteriaDigest,
    auditVerdict: options.auditRecord.verdict,
    auditStatus: options.auditRecord.status,
    model: options.model,
    promptVersion: QA_PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
  };

  const jsonPath = path.join(options.outputDir, 'chatgpt-qa.json');
  const markdownPath = path.join(options.outputDir, 'chatgpt-qa.md');
  const rawResponsePath = path.join(options.outputDir, 'chatgpt-qa.raw.json');

  await fs.writeFile(jsonPath, JSON.stringify(record, null, 2), 'utf-8');
  await fs.writeFile(markdownPath, renderQaMarkdown(record), 'utf-8');
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

function renderAuditMarkdown(record: AuditRecord): string {
  const lines: string[] = [];
  lines.push(`# chatgpt-audit (verdict: ${record.verdict})`);
  lines.push(`Generated: ${record.generatedAt}`);
  lines.push(`Model: ${record.model} (${record.promptVersion})`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push(record.summary || '_No summary supplied._');
  lines.push('');
  if (record.evidence.length) {
    lines.push('## Evidence by Criterion');
    for (const item of record.evidence) {
      lines.push(
        `- **${item.criterion}** → ${item.met ? 'Met' : 'Not Met'}${item.references?.length ? ` (refs: ${item.references.join(', ')})` : ''}`,
      );
      if (item.evidence) {
        lines.push(`  - Evidence: ${item.evidence}`);
      }
      if (item.gaps) {
        lines.push(`  - Gaps: ${item.gaps}`);
      }
    }
    lines.push('');
  }
  if (record.risks.length) {
    lines.push('## Risks');
    for (const risk of record.risks) {
      lines.push(`- ${risk}`);
    }
    lines.push('');
  }
  if (record.recommendations.length) {
    lines.push('## Recommendations');
    for (const rec of record.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function renderQaMarkdown(record: QaRecord): string {
  const lines: string[] = [];
  lines.push(`# chatgpt-qa (verdict: ${record.verdict})`);
  lines.push(`Generated: ${record.generatedAt}`);
  lines.push(`Model: ${record.model} (${record.promptVersion})`);
  lines.push(`Audit Verdict: ${record.auditVerdict}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(record.summary || '_No summary supplied._');
  lines.push('');
  if (record.issues.length) {
    lines.push('## Issues');
    for (const issue of record.issues) {
      lines.push(
        `- (${issue.severity}) [${issue.type}] ${issue.detail}`,
      );
    }
    lines.push('');
  }
  if (record.recommendations.length) {
    lines.push('## Recommendations');
    for (const rec of record.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function createClient(apiKey?: string): OpenAI {
  return new OpenAI({
    apiKey: apiKey ?? process.env.OPENAI_API_KEY,
  });
}

function parseJson(content: string, label: string): any {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${label}: unable to parse JSON response. ${error}`);
  }
}

function normalizeAuditStatus(value: any): 'pass' | 'fail' | 'provisional' {
  const normalized = String(value ?? '')
    .toLowerCase()
    .trim();
  if (normalized === 'pass') {
    return 'pass';
  }
  if (normalized === 'fail') {
    return 'fail';
  }
  return 'provisional';
}

function normalizeQaVerdict(
  value: any,
): 'calibrated' | 'needs_followup' {
  const normalized = String(value ?? '')
    .toLowerCase()
    .trim();
  return normalized === 'calibrated' ? 'calibrated' : 'needs_followup';
}

function normalizeQaSeverity(value: any): 'low' | 'medium' | 'high' {
  const normalized = String(value ?? '')
    .toLowerCase()
    .trim();
  if (normalized === 'high') {
    return 'high';
  }
  if (normalized === 'low') {
    return 'low';
  }
  return 'medium';
}

function sanitizeString(value: any): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeOptionalString(value: any): string | undefined {
  const trimmed = sanitizeString(value);
  return trimmed ? trimmed : undefined;
}

function toStringArray(value: any): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => sanitizeString(entry))
    .filter(Boolean);
}

function stripArtifactPaths(artifact: AuditArtifact): AuditRecord {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { jsonPath, markdownPath, rawResponsePath, ...record } = artifact;
  return record;
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

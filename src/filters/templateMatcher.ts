import { randomUUID } from 'node:crypto';
import type { AnchorSet } from './anchorExtractor.js';
import type { FilterRow } from './types.js';

export interface TemplateGenerationOptions {
  limit?: number;
  existingLabels?: Set<string>;
}

type FilterTemplate = (context: TemplateContext) => FilterRow[];

interface TemplateContext {
  anchors: AnchorSet;
  now: string;
}

const templates: FilterTemplate[] = [
  (context) => generateGeoPerspectiveRows(context),
  (context) => generateStakeholderRows(context),
  (context) => generateThemeRows(context),
  (context) => generateRiskRows(context),
];

export const generateTemplateSuggestions = (
  anchors: AnchorSet,
  options: TemplateGenerationOptions = {},
): FilterRow[] => {
  const now = new Date().toISOString();
  const context: TemplateContext = { anchors, now };
  const existingLabels = options.existingLabels ?? new Set<string>();
  const limit = options.limit ?? 5;
  const results: FilterRow[] = [];

  for (const template of templates) {
    const rows = template(context);
    for (const row of rows) {
      const labelKey = row.label.toLowerCase();
      if (existingLabels.has(labelKey)) {
        continue;
      }
      results.push(row);
      existingLabels.add(labelKey);
      if (results.length >= limit) {
        return results;
      }
    }
  }

  return results;
};

const generateGeoPerspectiveRows = ({ anchors, now }: TemplateContext): FilterRow[] => {
  return anchors.geographies.slice(0, 3).map((geo) => ({
    id: randomUUID(),
    label: `${geo} opportunity scan`,
    intentQuestion: `What opportunities, blockers, and decision owners surface when we isolate ${geo}?`,
    scope: `Threads referencing ${geo}`,
    signalsToPull: 'Named stakeholders, funding constraints, enabling policies, quant metrics.',
    outputLens: 'Risk vs opportunity grid + open questions list.',
    priority: 'medium',
    status: 'suggested',
    evidenceFloor: 'Quote',
    perspectivePairing: 'Regulators ↔ Operators',
    tags: [`geo:${geo}`, 'lens:geo'],
    triggerSummary: `Geo anchor detected for ${geo}.`,
    deck: 'suggest',
    createdAt: now,
    updatedAt: now,
  }));
};

const generateStakeholderRows = ({ anchors, now }: TemplateContext): FilterRow[] => {
  if (anchors.stakeholders.length < 2) {
    return [];
  }
  const [primary, secondary] = anchors.stakeholders;
  return [
    {
      id: randomUUID(),
      label: `${primary} vs ${secondary}`,
      intentQuestion: `How do priorities diverge between ${primary} and ${secondary}?`,
      scope: 'Stakeholder mentions across all threads.',
      signalsToPull:
        'Direct quotes, implicit signals, and commitments tied to each stakeholder.',
      outputLens: 'Dual-column comparison with tensions + resolution ideas.',
      priority: 'medium',
      status: 'suggested',
      evidenceFloor: 'Quote',
      perspectivePairing: `${primary} ↔ ${secondary}`,
      tags: ['lens:stakeholder'],
      triggerSummary: `Stakeholder anchors found for ${primary} and ${secondary}.`,
      deck: 'suggest',
      createdAt: now,
      updatedAt: now,
    },
  ];
};

const generateThemeRows = ({ anchors, now }: TemplateContext): FilterRow[] => {
  return anchors.themes.slice(0, 4).map((theme) => ({
    id: randomUUID(),
    label: `${theme} deep dive`,
    intentQuestion: `What decisions, data, and blockers shape the ${theme} theme?`,
    scope: `Messages referencing ${theme}`,
    signalsToPull: 'Decisions, metrics, cited tools, and pending questions.',
    outputLens: 'Decision + data board with next hypotheses.',
    priority: 'medium',
    status: 'suggested',
    evidenceFloor: 'Quote or metric',
    tags: [`theme:${theme}`],
    triggerSummary: `Theme keyword detected: ${theme}`,
    deck: 'suggest',
    createdAt: now,
    updatedAt: now,
  }));
};

const generateRiskRows = ({ anchors, now }: TemplateContext): FilterRow[] => {
  if (!anchors.risks.length) {
    return [];
  }
  return [
    {
      id: randomUUID(),
      label: 'Risk + friction audit',
      intentQuestion:
        'Which risks, bottlenecks, or friction points are repeating and how do we close them?',
      scope: 'Any message containing risk/failure keywords.',
      signalsToPull: 'Root causes, mitigation owners, confidence levels, timelines.',
      outputLens: 'Risk ledger with severity + mitigation status.',
      priority: 'medium',
      status: 'suggested',
      evidenceFloor: 'Quote',
      tags: ['lens:risk'],
      triggerSummary: `Risk keywords detected: ${anchors.risks.join(', ')}`,
      deck: 'suggest',
      createdAt: now,
      updatedAt: now,
    },
  ];
};

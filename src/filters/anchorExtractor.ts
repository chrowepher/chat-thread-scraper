import type { BrowserConversation } from '../types.js';

export interface AnchorSet {
  geographies: string[];
  stakeholders: string[];
  themes: string[];
  risks: string[];
  timelineMarkers: string[];
  moneyMentions: string[];
}

const GEO_KEYWORDS: Record<string, string> = {
  'south africa': 'South Africa',
  'johannesburg': 'Johannesburg',
  'joburg': 'Johannesburg',
  'gauteng': 'Gauteng',
  'cape town': 'Cape Town',
  'africa': 'Africa',
  'kenya': 'Kenya',
  'nigeria': 'Nigeria',
  'us': 'United States',
  'u.s.': 'United States',
  'usa': 'United States',
  'united states': 'United States',
  'new york': 'New York',
  'texas': 'Texas',
  'europe': 'Europe',
};

const STAKEHOLDER_KEYWORDS: Record<string, string> = {
  regulator: 'Regulators',
  regulatory: 'Regulators',
  investor: 'Investors',
  investors: 'Investors',
  city: 'City officials',
  municipal: 'Municipal leaders',
  municipality: 'Municipal leaders',
  tenant: 'Tenants',
  tenants: 'Tenants',
  developer: 'Developers',
  developers: 'Developers',
  founder: 'Founders',
  founders: 'Founders',
  cto: 'CTO',
  cio: 'CIO',
  pm: 'Program leadership',
  stakeholder: 'Stakeholders',
  board: 'Board / Execs',
  union: 'Labor groups',
};

const THEME_KEYWORDS: Record<string, string> = {
  housing: 'Housing + urban systems',
  'cost of living': 'Cost of living',
  visa: 'Visa & immigration',
  relocation: 'Relocation planning',
  consulting: 'Fractional consulting',
  ai: 'AI governance & risk',
  'grid': 'Grid modernization',
  'load shedding': 'Power stability',
  power: 'Infrastructure reliability',
  'sro': 'SRO housing',
  'policy': 'Policy levers',
  'funding': 'Funding structures',
  'risk': 'Risk diagnostics',
  'compliance': 'Regulatory compliance',
};

const RISK_KEYWORDS = [
  'risk',
  'bottleneck',
  'bottlenecks',
  'blocker',
  'blockers',
  'gap',
  'gaps',
  'load shedding',
  'fraud',
  'delay',
  'delays',
  'constraint',
  'constraints',
];

const TIMELINE_PATTERNS = [
  /\bday\s+\d+/i,
  /\bweek\s+\d+/i,
  /\bmonth\s+\d+/i,
  /\bq[1-4]\b/i,
  /\b90[-\s]?day\b/i,
];

const MONEY_PATTERN = /(\$|€|£)\s?\d[\d,\.\s]*|\b\d+\s?(k|m|million|billion)\b/gi;

export const extractAnchors = (
  conversations: BrowserConversation[],
  maxMessagesPerThread = 50,
): AnchorSet => {
  const anchors: AnchorSet = {
    geographies: [],
    stakeholders: [],
    themes: [],
    risks: [],
    timelineMarkers: [],
    moneyMentions: [],
  };

  for (const convo of conversations) {
    const mergedText = [
      convo.title ?? '',
      ...convo.messages.slice(0, maxMessagesPerThread).map((msg) => msg.content ?? ''),
    ]
      .join('\n')
      .toLowerCase();

    collectFromDictionary(mergedText, GEO_KEYWORDS, anchors.geographies);
    collectFromDictionary(mergedText, STAKEHOLDER_KEYWORDS, anchors.stakeholders);
    collectFromDictionary(mergedText, THEME_KEYWORDS, anchors.themes);

    for (const token of RISK_KEYWORDS) {
      if (mergedText.includes(token)) {
        anchors.risks.push(token);
      }
    }

    for (const pattern of TIMELINE_PATTERNS) {
      const match = mergedText.match(pattern);
      if (match) {
        anchors.timelineMarkers.push(...match);
      }
    }

    const moneyMatches = mergedText.match(MONEY_PATTERN);
    if (moneyMatches) {
      anchors.moneyMentions.push(
        ...moneyMatches.map((entry) => entry.trim()).filter(Boolean),
      );
    }
  }

  return {
    geographies: dedupe(anchors.geographies),
    stakeholders: dedupe(anchors.stakeholders),
    themes: dedupe(anchors.themes),
    risks: dedupe(anchors.risks),
    timelineMarkers: dedupe(anchors.timelineMarkers),
    moneyMentions: dedupe(anchors.moneyMentions),
  };
};

const collectFromDictionary = (
  haystack: string,
  dictionary: Record<string, string>,
  target: string[],
) => {
  for (const [needle, label] of Object.entries(dictionary)) {
    if (haystack.includes(needle)) {
      target.push(label);
    }
  }
};

const dedupe = <T>(values: T[]): T[] => {
  return Array.from(new Set(values));
};

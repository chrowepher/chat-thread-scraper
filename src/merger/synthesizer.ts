import type {
  ConversationMessage,
  BrowserConversation,
} from '../types.js';
import type {
  Feature,
  SynthesizedConversation,
  SynthesizedSection,
} from './types.js';

const formatSection = (section: SynthesizedSection): string => {
  const lines: string[] = [];
  lines.push(`### ${section.title}`);
  section.canonical.forEach((feature) => {
    lines.push(`- ✅ ${feature.text}`);
  });
  section.uniques.forEach((feature) => {
    lines.push(`- ℹ️ ${feature.text}`);
  });
  section.alternates.forEach((feature) => {
    lines.push(`- ⚖️ Alternate (${feature.sourceConversationTitle}): ${feature.text}`);
  });
  return lines.join('\n');
};

const buildAssistantMessage = (sections: SynthesizedSection[]): string =>
  sections.map((section) => formatSection(section)).join('\n\n');

export interface SynthesisOptions {
  mergedTitle?: string;
}

export const synthesizeConversation = (
  canonical: Feature[],
  uniques: Feature[],
  alternates: Feature[],
  options: SynthesisOptions = {},
): SynthesizedConversation => {
  const sectionMap = new Map<string, SynthesizedSection>();
  const ensureSection = (feature: Feature): SynthesizedSection => {
    if (!sectionMap.has(feature.topicId)) {
      sectionMap.set(feature.topicId, {
        topicId: feature.topicId,
        title: feature.topicLabel || 'General',
        canonical: [],
        uniques: [],
        alternates: [],
      });
    }
    return sectionMap.get(feature.topicId)!;
  };

  canonical.forEach((feature) => {
    ensureSection(feature).canonical.push(feature);
  });
  uniques.forEach((feature) => {
    ensureSection(feature).uniques.push(feature);
  });
  alternates.forEach((feature) => {
    ensureSection(feature).alternates.push(feature);
  });

  const sections = [...sectionMap.values()].sort((a, b) =>
    a.topicId.localeCompare(b.topicId),
  );

  const messages: ConversationMessage[] = [
    {
      role: 'system',
      content:
        'Merged conversation synthesized via feature harvesting pipeline.',
    },
    {
      role: 'assistant',
      content: buildAssistantMessage(sections),
    },
  ];

  return {
    summary:
      options.mergedTitle ??
      'Optimized merged conversation based on harvested features.',
    sections,
    messages,
  };
};

export const createMergedConversationShell = (
  synthesis: SynthesizedConversation,
): BrowserConversation => ({
  tabId: `merged-${Date.now()}`,
  title: synthesis.summary,
  url: 'about:feature-harvest',
  messages: synthesis.messages,
});

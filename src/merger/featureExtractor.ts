import crypto from 'node:crypto';
import { slugify } from '../utils/slugify.js';
import type {
  BrowserConversation,
  ConversationMessage,
} from '../types.js';
import type { ConversationFeatureSet, Feature } from './types.js';

export interface FeatureExtractionOptions {
  minSegmentLength?: number;
}

const DEFAULT_MIN_SEGMENT_LENGTH = 24;
const SENTENCE_SPLIT_REGEX = /[.!?]\s+/g;
const FIRST_SENTENCE_REGEX = /[^.!?]+[.!?]?/;
const BULLET_REGEX = /^\s*(?:[-*•]|[0-9]+\.)\s+/;

const MESSAGE_SUMMARY_MIN_SEGMENTS = 3;
const MESSAGE_SUMMARY_MIN_WORDS = 120;
const MESSAGE_SUMMARY_MAX_SENTENCES = 3;
const CONVERSATION_SUMMARY_MIN_MESSAGES = 3;
const CONVERSATION_SUMMARY_MAX_ITEMS = 6;
const CONVERSATION_FEATURE_CAP = 200;

const inferTopicId = (content: string): { topicId: string; label: string } => {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const candidates = lines.filter(Boolean);
  const firstMeaningful = candidates[0] ?? 'general';
  const label = firstMeaningful.slice(0, 60);
  const topicId = slugify(label || 'general');
  return { topicId, label: label || 'General' };
};

const estimateWordCount = (text: string): number =>
  text.split(/\s+/).filter(Boolean).length;

const extractLeadingSentence = (text: string): string => {
  const match = text.match(FIRST_SENTENCE_REGEX);
  if (match?.[0]) {
    return match[0].trim();
  }
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(0, 20).join(' ').trim();
};

const segmentMessage = (
  message: ConversationMessage,
  minLength: number,
): string[] => {
  const trimmed = message.content.trim();
  if (!trimmed) {
    return [];
  }

  const lines = trimmed.split(/\r?\n/);
  const bulletSegments: string[] = [];
  let buffer: string[] = [];
  for (const line of lines) {
    if (BULLET_REGEX.test(line)) {
      if (buffer.length) {
        bulletSegments.push(buffer.join(' ').trim());
        buffer = [];
      }
      bulletSegments.push(line.replace(BULLET_REGEX, '').trim());
    } else if (!line.trim()) {
      if (buffer.length) {
        bulletSegments.push(buffer.join(' ').trim());
        buffer = [];
      }
    } else {
      buffer.push(line.trim());
    }
  }
  if (buffer.length) {
    bulletSegments.push(buffer.join(' ').trim());
  }

  const segments = bulletSegments.length ? bulletSegments : [trimmed];
  return segments.filter((segment) => segment.length >= minLength);
};

const buildMessageSummary = (
  segments: string[],
  maxSentences: number,
): string | undefined => {
  if (!segments.length) {
    return undefined;
  }
  const summaryPieces: string[] = [];
  for (const segment of segments) {
    const sentence = extractLeadingSentence(segment);
    if (sentence) {
      summaryPieces.push(sentence);
    }
    if (summaryPieces.length >= maxSentences) {
      break;
    }
  }
  if (!summaryPieces.length) {
    return undefined;
  }
  return summaryPieces.join(' ');
};

const shouldSummarizeMessage = (
  segments: string[],
  totalWordCount: number,
): boolean =>
  segments.length >= MESSAGE_SUMMARY_MIN_SEGMENTS ||
  totalWordCount >= MESSAGE_SUMMARY_MIN_WORDS;

const buildConversationSummaryFeature = ({
  conversation,
  features,
  nextOrder,
}: {
  conversation: BrowserConversation;
  features: Feature[];
  nextOrder: () => number;
}): Feature | undefined => {
  const summaryCandidates = features
    .filter(
      (feature) =>
        feature.metadata.isSummary &&
        feature.metadata.summaryLevel === 'message',
    )
    .sort((a, b) => a.metadata.sourceOrder - b.metadata.sourceOrder);

  if (
    summaryCandidates.length < CONVERSATION_SUMMARY_MIN_MESSAGES &&
    features.length < CONVERSATION_FEATURE_CAP
  ) {
    return undefined;
  }

  const selected =
    summaryCandidates.length > 0
      ? summaryCandidates.slice(0, CONVERSATION_SUMMARY_MAX_ITEMS)
      : features
          .filter((feature) => !feature.metadata.isSummary)
          .sort((a, b) => a.metadata.sourceOrder - b.metadata.sourceOrder)
          .slice(0, CONVERSATION_SUMMARY_MAX_ITEMS);

  if (!selected.length) {
    return undefined;
  }

  const bulletLines = selected.map((feature) => {
    const leadingSentence = extractLeadingSentence(feature.text);
    return `• ${leadingSentence}`;
  });
  const summaryText = bulletLines.join('\n');
  if (!summaryText.trim()) {
    return undefined;
  }

  const { topicId, label } = inferTopicId(summaryText);
  const sourceMessageSet = new Set<number>();
  let sourceCountTotal = 0;
  selected.forEach((feature) => {
    feature.sourceMessageIndices.forEach((index) =>
      sourceMessageSet.add(index),
    );
    sourceCountTotal += feature.metadata.summarySourceCount ?? 1;
  });

  const wordCount = estimateWordCount(summaryText);
  const sentenceCount = Math.max(
    1,
    summaryText.split(SENTENCE_SPLIT_REGEX).filter(Boolean).length,
  );

  return {
    id: crypto.randomUUID(),
    topicId,
    topicLabel: label,
    text: summaryText,
    sourceConversationId: conversation.tabId,
    sourceConversationTitle: conversation.title,
    sourceMessageIndices: Array.from(sourceMessageSet),
    role: 'unique',
    scores: {
      clarity: 0,
      evidence: 0,
      freshness: 0,
      antiFriction: 0,
      combined: 0,
    },
    provenance: [conversation.tabId],
    metadata: {
      wordCount,
      sentenceCount,
      containsListSyntax: true,
      containsNumbers: /\d/.test(summaryText),
      originatesFromRole: 'assistant',
      sourceOrder: nextOrder(),
      segmentIndex: -1,
      isSummary: true,
      summaryLevel: 'conversation',
      summarySourceMessageIndices: Array.from(sourceMessageSet),
      summarySourceCount: Math.max(
        sourceCountTotal,
        selected.length,
        features.length,
      ),
      priority: 'summary',
    },
  };
};

const enforceConversationFeatureCap = (features: Feature[]): void => {
  if (features.length <= CONVERSATION_FEATURE_CAP) {
    return;
  }

  const summaries = features
    .filter((feature) => feature.metadata.isSummary)
    .sort((a, b) => {
      const levelA = a.metadata.summaryLevel === 'conversation' ? 1 : 0;
      const levelB = b.metadata.summaryLevel === 'conversation' ? 1 : 0;
      if (levelA !== levelB) {
        return levelB - levelA;
      }
      return a.metadata.sourceOrder - b.metadata.sourceOrder;
    });

  const raw = features
    .filter((feature) => !feature.metadata.isSummary)
    .sort((a, b) => a.metadata.sourceOrder - b.metadata.sourceOrder);

  const keep: Feature[] = [];
  let remainingSlots = CONVERSATION_FEATURE_CAP;

  const summarySelection = summaries.slice(0, remainingSlots);
  keep.push(...summarySelection);
  remainingSlots -= summarySelection.length;

  const rawSelection =
    remainingSlots > 0 ? raw.slice(0, remainingSlots) : [];
  keep.push(...rawSelection);

  const dropped = [
    ...summaries.slice(summarySelection.length),
    ...raw.slice(rawSelection.length),
  ];

  const conversationSummary = keep.find(
    (feature) => feature.metadata.summaryLevel === 'conversation',
  );
  if (conversationSummary) {
    const droppedUniqueCount = dropped.filter(
      (feature) => feature.role === 'unique' && !feature.metadata.isSummary,
    ).length;
    if (droppedUniqueCount > 0) {
      conversationSummary.metadata.summarySourceCount =
        (conversationSummary.metadata.summarySourceCount ?? 0) +
        droppedUniqueCount;
    }
    const droppedMessages = new Set<number>(
      conversationSummary.metadata.summarySourceMessageIndices ?? [],
    );
    dropped.forEach((feature) => {
      feature.sourceMessageIndices.forEach((index) =>
        droppedMessages.add(index),
      );
    });
    conversationSummary.metadata.summarySourceMessageIndices = Array.from(
      droppedMessages,
    );
  }

  features.length = 0;
  keep
    .sort((a, b) => a.metadata.sourceOrder - b.metadata.sourceOrder)
    .forEach((feature) => features.push(feature));
};

export const extractFeaturesFromConversation = (
  conversation: BrowserConversation,
  options: FeatureExtractionOptions = {},
): ConversationFeatureSet => {
  const minSegment = options.minSegmentLength ?? DEFAULT_MIN_SEGMENT_LENGTH;
  const features: Feature[] = [];
  let globalOrder = 0;

  conversation.messages.forEach((message, messageIndex) => {
    const segments = segmentMessage(message, minSegment);
    const segmentFeatures: Feature[] = [];
    segments.forEach((segment, segmentIndex) => {
      const { topicId, label } = inferTopicId(segment);
      const wordCount = estimateWordCount(segment);
      const sentenceCount = Math.max(
        1,
        segment.split(SENTENCE_SPLIT_REGEX).filter(Boolean).length,
      );
      const feature: Feature = {
        id: crypto.randomUUID(),
        topicId,
        topicLabel: label,
        text: segment.trim(),
        sourceConversationId: conversation.tabId,
        sourceConversationTitle: conversation.title,
        sourceMessageIndices: [messageIndex],
        role: 'unique',
        scores: {
          clarity: 0,
          evidence: 0,
          freshness: 0,
          antiFriction: 0,
          combined: 0,
        },
        provenance: [conversation.tabId],
        metadata: {
          wordCount,
          sentenceCount,
          containsListSyntax: BULLET_REGEX.test(message.content),
          containsNumbers: /\d/.test(segment),
          originatesFromRole: message.role,
          sourceOrder: globalOrder++,
          segmentIndex,
          priority: 'normal',
        },
      };
      features.push(feature);
      segmentFeatures.push(feature);
    });

    const messageWordCount = segments.reduce(
      (sum, segment) => sum + estimateWordCount(segment),
      0,
    );

    if (
      segmentFeatures.length &&
      shouldSummarizeMessage(segments, messageWordCount)
    ) {
      const summaryText = buildMessageSummary(
        segments,
        MESSAGE_SUMMARY_MAX_SENTENCES,
      );
      if (summaryText) {
        const { topicId, label } = inferTopicId(summaryText);
        const wordCount = estimateWordCount(summaryText);
        const sentenceCount = Math.max(
          1,
          summaryText.split(SENTENCE_SPLIT_REGEX).filter(Boolean).length,
        );
        const summaryFeature: Feature = {
          id: crypto.randomUUID(),
          topicId,
          topicLabel: label,
          text: summaryText,
          sourceConversationId: conversation.tabId,
          sourceConversationTitle: conversation.title,
          sourceMessageIndices: [messageIndex],
          role: 'unique',
          scores: {
            clarity: 0,
            evidence: 0,
            freshness: 0,
            antiFriction: 0,
            combined: 0,
          },
          provenance: [conversation.tabId],
          metadata: {
            wordCount,
            sentenceCount,
            containsListSyntax: true,
            containsNumbers: /\d/.test(summaryText),
            originatesFromRole: message.role,
            sourceOrder: globalOrder++,
            segmentIndex: -1,
            isSummary: true,
            summaryLevel: 'message',
            summarySourceMessageIndices: [messageIndex],
            summarySourceCount: segmentFeatures.length,
            priority: 'summary',
          },
        };
        features.push(summaryFeature);
      }
    }
  });

  const nextOrderRef = { current: globalOrder };
  const nextOrder = () => nextOrderRef.current++;
  const conversationSummary = buildConversationSummaryFeature({
    conversation,
    features,
    nextOrder,
  });
  if (conversationSummary) {
    features.push(conversationSummary);
  }

  enforceConversationFeatureCap(features);

  return {
    conversation,
    features,
  };
};

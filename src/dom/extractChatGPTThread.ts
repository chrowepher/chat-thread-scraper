import type { ConversationMessage } from '../types.js';

export interface ExtractedThread {
  title: string;
  messages: ConversationMessage[];
}

export function extractChatGPTThread(
  rootDocument?: Document,
): ExtractedThread {
  const doc = rootDocument ?? document;
  const TURN_SELECTOR =
    '[data-testid^="conversation-turn"], [data-message-author-role]';
  function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  function nodeText(node: Element): string {
    const htmlNode = node as HTMLElement;
    const inner =
      typeof htmlNode.innerText === 'string' && htmlNode.innerText.length
        ? htmlNode.innerText
        : node.textContent ?? '';
    return inner.trim();
  }

  function determineRole(testId: string, turn: Element): ConversationMessage['role'] {
    const lowered = testId.toLowerCase();
    if (lowered.includes('user')) {
      return 'user';
    }
    if (lowered.includes('assistant')) {
      return 'assistant';
    }
    if (lowered.includes('system')) {
      return 'system';
    }
    const explicitRole = turn.getAttribute('data-message-author-role');
    if (
      explicitRole === 'user' ||
      explicitRole === 'assistant' ||
      explicitRole === 'system' ||
      explicitRole === 'tool' ||
      explicitRole === 'developer'
    ) {
      return explicitRole;
    }
    if (lowered.includes('tool')) {
      return 'tool';
    }
    if (lowered.includes('developer')) {
      return 'developer';
    }
    return 'assistant';
  }

  function extractTimestamp(turn: Element): string | undefined {
    const timeNode = turn.querySelector('time');
    if (!timeNode) {
      return undefined;
    }
    return (
      timeNode.getAttribute('datetime') ?? timeNode.textContent ?? undefined
    );
  }

  function collectTextContent(turn: Element): string {
    const markdownBlocks = Array.from(
      turn.querySelectorAll<HTMLElement>('[data-testid="markdown"]'),
    ).map(nodeText);
    if (markdownBlocks.length) {
      return markdownBlocks.filter(Boolean).join('\n\n');
    }

    const codeBlocks = Array.from(
      turn.querySelectorAll<HTMLElement>('pre'),
    ).map(nodeText);
    if (codeBlocks.length) {
      return codeBlocks.filter(Boolean).join('\n\n');
    }

    return normalizeWhitespace(turn.textContent ?? '');
  }

  function serializeTurn(turn: Element): ConversationMessage | null {
    const testId = turn.getAttribute('data-testid') ?? '';
    const content = collectTextContent(turn);
    if (!content) {
      return null;
    }

    const timestamp = extractTimestamp(turn);
    const message: ConversationMessage = {
      role: determineRole(testId, turn),
      content,
    };
    if (typeof timestamp === 'string') {
      message.timestamp = timestamp;
    }
    return message;
  }

  const turns = Array.from(doc.querySelectorAll(TURN_SELECTOR));
  const messages = turns
    .map(serializeTurn)
    .filter((entry): entry is ConversationMessage => Boolean(entry));

  return {
    title: doc.title || 'Untitled ChatGPT Thread',
    messages,
  };
}

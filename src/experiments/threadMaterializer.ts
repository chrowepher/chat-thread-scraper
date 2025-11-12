import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserConversation, ConversationMessage, ThreadSnapshot } from '../types.js';

const OMITTED_SEGMENT: unique symbol = Symbol('omitted');

export interface MaterializeOptions {
  snapshotPath: string;
  runId: string;
  outputDir?: string;
  maxMessagesPerThread?: number;
  maxCharsPerMessage?: number;
}

export interface ThreadMaterializationResult {
  threadPaths: string[];
  outputDir: string;
  conversationCount: number;
}

export async function materializeExperimentThreads(
  options: MaterializeOptions,
): Promise<ThreadMaterializationResult> {
  const { snapshotPath, runId } = options;
  const conversations = await loadConversations(snapshotPath);
  if (!conversations.length) {
    throw new Error(
      `No conversations found in snapshot ${snapshotPath}. Cannot scaffold experiment threads.`,
    );
  }

  const outputDir =
    options.outputDir ?? path.resolve('runs', runId, 'threads');
  await fs.mkdir(outputDir, { recursive: true });

  const threadPaths: string[] = [];

  for (let index = 0; index < conversations.length; index += 1) {
    const conversation = conversations[index]!;
    const fileName = buildFileName(index, conversation);
    const filePath = path.join(outputDir, fileName);
    const formatOptions: { maxMessages?: number; maxCharsPerMessage?: number } = {};
    if (options.maxMessagesPerThread && options.maxMessagesPerThread > 0) {
      formatOptions.maxMessages = options.maxMessagesPerThread;
    }
    if (options.maxCharsPerMessage && options.maxCharsPerMessage > 0) {
      formatOptions.maxCharsPerMessage = options.maxCharsPerMessage;
    }
    const content = formatConversation(conversation, formatOptions);
    await fs.writeFile(filePath, content, 'utf-8');
    threadPaths.push(filePath);
  }

  return {
    threadPaths,
    outputDir,
    conversationCount: conversations.length,
  };
}

async function loadConversations(
  snapshotPath: string,
): Promise<BrowserConversation[]> {
  const resolved = path.resolve(snapshotPath);
  const raw = await fs.readFile(resolved, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return parsed as BrowserConversation[];
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as ThreadSnapshot).conversations)
  ) {
    return (parsed as ThreadSnapshot).conversations;
  }
  throw new Error(
    `Snapshot ${snapshotPath} is not an array or ThreadSnapshot object.`,
  );
}

function buildFileName(
  index: number,
  conversation: BrowserConversation,
): string {
  const base =
    conversation.title?.trim() ||
    conversation.url?.trim() ||
    conversation.tabId ||
    `conversation-${index + 1}`;
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/^-+|-+$/g, '');
  const paddedIndex = String(index + 1).padStart(3, '0');
  return `thread-${paddedIndex}-${slug || 'conversation'}.md`;
}

function formatConversation(
  conversation: BrowserConversation,
  options: { maxMessages?: number; maxCharsPerMessage?: number },
): string {
  const segments = buildSegments(conversation.messages, options.maxMessages);
  const lines: string[] = [];
  lines.push(`# ${conversation.title || 'Conversation'}`);
  lines.push(`URL: ${conversation.url}`);
  lines.push(`Tab: ${conversation.tabId}`);
  lines.push(`Total messages scraped: ${conversation.messages.length}`);
  if (options.maxMessages && conversation.messages.length > options.maxMessages) {
    lines.push(
      `Captured for experiments: ${segments.capturedCount} (trimmed ${segments.trimmedCount} middle message${segments.trimmedCount === 1 ? '' : 's'}).`,
    );
  }
  lines.push('');
  lines.push('## Condensed Messages');
  lines.push('');

  let ordinal = 1;
  for (const segment of segments.sequence) {
    if (segment === OMITTED_SEGMENT) {
      lines.push(
        `... (${segments.trimmedCount} message${segments.trimmedCount === 1 ? '' : 's'} omitted for brevity) ...`,
      );
      continue;
    }
    const message = segment as ConversationMessage;
    const snippet = formatMessage(message, options.maxCharsPerMessage);
    const timestamp = message.timestamp ? ` @ ${message.timestamp}` : '';
    const role = message.role ?? 'assistant';
    lines.push(`${ordinal}. [${role}${timestamp}] ${snippet}`.trim());
    ordinal += 1;
  }

  return lines.join('\n');
}

function buildSegments(
  messages: ConversationMessage[],
  maxMessages?: number,
): {
  sequence: Array<ConversationMessage | typeof OMITTED_SEGMENT>;
  trimmedCount: number;
  capturedCount: number;
} {
  if (!maxMessages || messages.length <= maxMessages) {
    return {
      sequence: messages,
      trimmedCount: 0,
      capturedCount: messages.length,
    };
  }

  const headCount = Math.ceil(maxMessages / 2);
  const tailCount = maxMessages - headCount;
  const trimmedCount = messages.length - maxMessages;

  const sequence: Array<ConversationMessage | typeof OMITTED_SEGMENT> = [
    ...messages.slice(0, headCount),
    OMITTED_SEGMENT,
    ...messages.slice(messages.length - tailCount),
  ];

  return {
    sequence,
    trimmedCount,
    capturedCount: maxMessages,
  };
}

function formatMessage(
  message: ConversationMessage,
  maxChars?: number,
): string {
  const content =
    typeof message?.content === 'string' ? message.content : '[no content captured]';
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!maxChars || normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}…`;
}

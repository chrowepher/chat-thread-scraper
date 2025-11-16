import crypto from 'node:crypto';
import type { BrowserConversation } from '../types.js';

export const EMPTY_CONVERSATION_HASH = crypto
  .createHash('sha1')
  .update('')
  .digest('hex');

export function computeConversationHash(
  conversation: BrowserConversation,
): string {
  const normalized = (conversation.messages ?? []).map((message) => {
    const role = message.role ?? 'assistant';
    const content =
      typeof message.content === 'string' ? message.content : '';
    return `${role}:${content.replace(/\s+/g, ' ').trim()}`;
  });
  return crypto.createHash('sha1').update(normalized.join('\n')).digest('hex');
}

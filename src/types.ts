export const MESSAGE_ROLES = [
  'system',
  'user',
  'assistant',
  'tool',
  'developer',
  'function',
] as const;

export type MessageRole = (typeof MESSAGE_ROLES)[number];

export interface ConversationMessage {
  role: MessageRole;
  content: string;
  /**
   * Optional timestamp pulled from the DOM, if available.
   */
  timestamp?: string | undefined;
}

export interface BrowserConversation {
  tabId: string;
  parentTabId?: string;
  title: string;
  url: string;
  messages: ConversationMessage[];
}

export interface MergeRequest {
  branches: BrowserConversation[];
  prompt?: string;
  model?: string;
  maxBranchHighlights?: number;
}

export interface MergeDecision {
  branchTitles: string[];
  decision: string;
  rationale?: string;
}

export interface MergeResult {
  summary: string;
  combinedPath: string[];
  mergeDecisions: MergeDecision[];
  followUpIdeas?: string[];
  rawResponse?: unknown;
}

export type ProviderPreset = 'openai' | 'openrouter' | 'custom' | string;

export interface ThreadSnapshot {
  scrapedAt: string;
  source: {
    host: string;
    port: number;
    urls: string[];
    bookmarks?: {
      path: string;
      folders: Array<{
        folderName: string;
        folderPath: string;
        entryCount: number;
      }>;
    };
  };
  conversations: BrowserConversation[];
}

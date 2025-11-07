export type MessageRole = 'system' | 'user' | 'assistant';

export interface ConversationMessage {
  role: MessageRole;
  content: string;
  /**
   * Optional timestamp pulled from the DOM, if available.
   */
  timestamp?: string;
}

export interface BrowserConversation {
  tabId: string;
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

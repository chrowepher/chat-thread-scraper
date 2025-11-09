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

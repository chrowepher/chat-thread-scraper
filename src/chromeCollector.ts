import CDP from 'chrome-remote-interface';
import { extractChatGPTThread } from './dom/extractChatGPTThread.js';
import type {
  BrowserConversation,
  ConversationMessage,
} from './types.js';

export interface ChromeCollectorOptions {
  host?: string;
  port?: number;
  includeUrlPatterns?: (string | RegExp)[];
  maxMessagesPerConversation?: number;
  verbose?: boolean;
}

export interface CollectByUrlOptions {
  host?: string;
  port?: number;
  urls: string[];
  maxMessagesPerConversation?: number;
  verbose?: boolean;
  keepOpen?: boolean;
}

const DEFAULT_INCLUDES = [/chatgpt\.com/i, /chat\.openai\.com/i];

const sanitizeFunctionSource = (fn: (...args: any[]) => unknown): string =>
  fn
    .toString()
    .replace(/__name\([^)]*\);\s*/g, '');

const EXTRACT_SCRIPT = `(${sanitizeFunctionSource(extractChatGPTThread)})()`;

type TargetDescriptor = Awaited<ReturnType<typeof CDP.List>>[number];

interface CollectorRuntimeOptions {
  host: string;
  port: number;
  maxMessagesPerConversation?: number;
  verbose?: boolean;
}

const matchesPattern = (url: string, pattern: string | RegExp): boolean => {
  if (pattern instanceof RegExp) {
    return pattern.test(url);
  }
  return url.includes(pattern);
};

const collectFromTargets = async (
  targets: TargetDescriptor[],
  runtimeOptions: CollectorRuntimeOptions,
): Promise<BrowserConversation[]> => {
  const { host, port, maxMessagesPerConversation, verbose } = runtimeOptions;
  const conversations: BrowserConversation[] = [];

  for (const target of targets) {
    let client: Awaited<ReturnType<typeof CDP>> | undefined;
    try {
      client = await CDP({ host, port, target });
      const { Runtime, Page } = client;
      await Promise.all([Runtime.enable(), Page.enable()]);

      const evaluation = await Runtime.evaluate({
        expression: EXTRACT_SCRIPT,
        returnByValue: true,
        awaitPromise: true,
      });

      const result = evaluation.result?.value;
      if (!result || typeof result !== 'object') {
        continue;
      }

      const parsed = result as {
        title?: string;
        messages?: ConversationMessage[];
      };

      const tabId =
        target.id || target.targetId || target.webSocketDebuggerUrl || 'unknown';
      const url = target.url || 'about:blank';
      const title = parsed.title?.trim() || target.title || 'ChatGPT Thread';
      let messages = Array.isArray(parsed.messages) ? parsed.messages : [];

      messages = messages.filter(
        (entry): entry is ConversationMessage =>
          Boolean(entry?.content && entry.role),
      );

      if (typeof maxMessagesPerConversation === 'number') {
        messages = messages.slice(-Math.abs(maxMessagesPerConversation));
      }

      conversations.push({
        tabId,
        title,
        url,
        messages,
      });

      if (verbose) {
        console.log(
          `Collected ${messages.length} messages from "${title}" (${url})`,
        );
      }
    } catch (error) {
      if (verbose) {
        console.warn(
          `Failed to collect conversation from tab "${target.title ?? 'Unknown'}":`,
          error,
        );
      }
    } finally {
      await client?.close();
    }
  }

  return conversations;
};

export async function collectChatGPTConversations(
  options: ChromeCollectorOptions = {},
): Promise<BrowserConversation[]> {
  const {
    host = '127.0.0.1',
    port = 9222,
    includeUrlPatterns = DEFAULT_INCLUDES,
    maxMessagesPerConversation,
    verbose,
  } = options;

  let targets: TargetDescriptor[];
  try {
    targets = await CDP.List({ host, port });
  } catch (error) {
    throw new Error(
      `Unable to connect to Chrome at ${host}:${port}. ` +
        'Make sure Chrome is launched with "--remote-debugging-port=' +
        `${port}" and that the port is accessible. Original error: ${String(error)}`,
    );
  }

  const selectedTargets = targets.filter((target) => {
    if (!target.url) {
      return false;
    }
    return includeUrlPatterns.some((pattern) =>
      matchesPattern(target.url, pattern),
    );
  });

  if (selectedTargets.length === 0) {
    if (verbose) {
      console.warn('No ChatGPT tabs were detected via the Chrome DevTools protocol.');
    }
    return [];
  }

  const runtimeOptions: CollectorRuntimeOptions = {
    host,
    port,
  };
  if (typeof maxMessagesPerConversation === 'number') {
    runtimeOptions.maxMessagesPerConversation = maxMessagesPerConversation;
  }
  if (typeof verbose === 'boolean') {
    runtimeOptions.verbose = verbose;
  }

  return collectFromTargets(selectedTargets, runtimeOptions);
}

export async function collectConversationsForUrls(
  options: CollectByUrlOptions,
): Promise<BrowserConversation[]> {
  const {
    urls,
    host = '127.0.0.1',
    port = 9222,
    maxMessagesPerConversation,
    verbose,
    keepOpen = false,
  } = options;

  if (!urls?.length) {
    return [];
  }

  const createdTargets: TargetDescriptor[] = [];

  for (const url of urls) {
    try {
      if (verbose) {
        console.log(`Opening bookmarked URL ${url}`);
      }
      const target = await CDP.New({ host, port, url });
      createdTargets.push(target);
    } catch (error) {
      console.error(`Failed to open bookmark URL ${url}:`, error);
    }
  }

  if (!createdTargets.length) {
    if (verbose) {
      console.warn('No bookmark URLs were opened successfully.');
    }
    return [];
  }

  const runtimeOptions: CollectorRuntimeOptions = {
    host,
    port,
  };
  if (typeof maxMessagesPerConversation === 'number') {
    runtimeOptions.maxMessagesPerConversation = maxMessagesPerConversation;
  }
  if (typeof verbose === 'boolean') {
    runtimeOptions.verbose = verbose;
  }

  try {
    return await collectFromTargets(createdTargets, runtimeOptions);
  } finally {
    if (!keepOpen) {
      await Promise.all(
        createdTargets.map(async (target) => {
          const targetId = target.id || target.targetId;
          if (!targetId) {
            return;
          }
          try {
            await CDP.Close({ host, port, id: targetId });
          } catch (error) {
            if (verbose) {
              console.warn(`Failed to close temporary tab (${target.url ?? targetId}):`, error);
            }
          }
        }),
      );
    }
  }
}

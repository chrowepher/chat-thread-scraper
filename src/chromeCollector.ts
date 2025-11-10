import CDP from 'chrome-remote-interface';
import { extractChatGPTThread } from './dom/extractChatGPTThread.js';
import type {
  BrowserConversation,
  ConversationMessage,
} from './types.js';

type ChromeClient = Awaited<ReturnType<typeof CDP>>;
type PageDomain = ChromeClient['Page'];
type RuntimeDomain = ChromeClient['Runtime'];

export interface ChromeCollectorOptions {
  host?: string;
  port?: number;
  includeUrlPatterns?: (string | RegExp)[];
  maxMessagesPerConversation?: number;
  verbose?: boolean;
  conversationTimeoutMs?: number;
  maxRefreshAttempts?: number;
}

export interface CollectByUrlOptions {
  host?: string;
  port?: number;
  urls: string[];
  maxMessagesPerConversation?: number;
  verbose?: boolean;
  keepOpen?: boolean;
  conversationTimeoutMs?: number;
  maxRefreshAttempts?: number;
  maxConcurrentTabs?: number;
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
  conversationTimeoutMs?: number;
  maxRefreshAttempts?: number;
  timingState?: AdaptiveTimeoutState;
}

const DEFAULT_CONVERSATION_TIMEOUT_MS = 15000;
const TIMEOUT_PADDING_FACTOR = 1.25;
const DEFAULT_MAX_CONCURRENT_TABS = 3;

interface AdaptiveTimeoutState {
  baseTimeoutMs: number;
  adaptiveTimeoutMs: number;
  durationSamples: number;
  durationTotalMs: number;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const matchesPattern = (url: string, pattern: string | RegExp): boolean => {
  if (pattern instanceof RegExp) {
    return pattern.test(url);
  }
  return url.includes(pattern);
};

const waitForPageReady = async (
  page: PageDomain,
  runtime: RuntimeDomain,
  verbose?: boolean,
  timeoutMs = 8000,
): Promise<void> => {
  if (!page || !runtime) {
    return;
  }

  try {
    const readiness = await runtime.evaluate({
      expression: 'document.readyState',
      returnByValue: true,
    });
    const state = readiness.result?.value;
    if (state === 'interactive' || state === 'complete') {
      return;
    }
  } catch {
    // Ignore errors and fall back to waiting for load events.
  }

  await new Promise<void>((resolve) => {
    let resolved = false;
    const settle = (): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(fallback);
      resolve();
    };

    const fallback = setTimeout(() => {
      if (verbose) {
        console.warn('Timed out waiting for the ChatGPT tab to finish loading.');
      }
      settle();
    }, timeoutMs);

    page.domContentEventFired?.(settle);
    page.loadEventFired(settle);
  });

  await delay(400);
};

const waitForConversationContent = async (
  runtime: RuntimeDomain,
  verbose?: boolean,
  timeoutMs = DEFAULT_CONVERSATION_TIMEOUT_MS,
): Promise<number | undefined> => {
  if (!runtime) {
    return undefined;
  }

  const expression = `(function(selector, timeout) {
    return new Promise(function(resolve) {
      var doc = document;
      if (!doc) {
        resolve(0);
        return;
      }
      var observer;
      var timer;
      var getCount = function() {
        try {
          var nodes = doc.querySelectorAll(selector);
          return nodes ? nodes.length : 0;
        } catch (_) {
          return 0;
        }
      };
      var finish = function(value) {
        if (observer) {
          observer.disconnect();
        }
        if (timer) {
          clearTimeout(timer);
        }
        resolve(value);
      };
      var existing = getCount();
      if (existing > 0) {
        finish(existing);
        return;
      }
      observer = new MutationObserver(function() {
        var count = getCount();
        if (count > 0) {
          finish(count);
        }
      });
      var root = doc.body || doc.documentElement;
      if (!root) {
        finish(0);
        return;
      }
      observer.observe(root, { childList: true, subtree: true });
      timer = setTimeout(function() {
        finish(0);
      }, timeout);
    });
  })('[data-testid^="conversation-turn"]', ${timeoutMs});`;

  try {
    const evaluation = await runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const count = Number(evaluation.result?.value) || 0;
    if (verbose) {
      if (count > 0) {
        console.log(
          `Detected ${count} conversation turn${count === 1 ? '' : 's'} before scraping.`,
        );
      } else {
        console.warn(
          'Timed out waiting for ChatGPT conversation content; attempting extraction anyway.',
        );
      }
    }
    return count;
  } catch (error) {
    if (verbose) {
      console.warn(
        'Encountered an error while waiting for ChatGPT content to load; continuing anyway.',
        error,
      );
    }
    return undefined;
  }
};

const ensureConversationContent = async (
  page: PageDomain,
  runtime: RuntimeDomain,
  verbose?: boolean,
  {
    timeoutMs = DEFAULT_CONVERSATION_TIMEOUT_MS,
    maxRefreshAttempts = 1,
  }: { timeoutMs?: number; maxRefreshAttempts?: number } = {},
): Promise<number | undefined> => {
  const safeAttempts = Math.max(0, maxRefreshAttempts);
  let attempt = 0;
  while (true) {
    const count = await waitForConversationContent(runtime, verbose, timeoutMs);
    if (typeof count === 'number' && count > 0) {
      return count;
    }
    if (attempt >= safeAttempts) {
      return count;
    }
    attempt += 1;
    if (verbose) {
      console.warn(
        `No ChatGPT conversation DOM detected after ${timeoutMs}ms; reloading tab (attempt ${attempt}/${safeAttempts}).`,
      );
    }
    try {
      await page.reload({ ignoreCache: true });
    } catch (error) {
      if (verbose) {
        console.warn('Page.reload failed while retrying conversation load:', error);
      }
      return count;
    }
    await waitForPageReady(page, runtime, verbose);
  }
};

const collectFromTargets = async (
  targets: TargetDescriptor[],
  runtimeOptions: CollectorRuntimeOptions,
): Promise<BrowserConversation[]> => {
  const { host, port, maxMessagesPerConversation, verbose } = runtimeOptions;
  const baseTimeout =
    typeof runtimeOptions.conversationTimeoutMs === 'number'
      ? Math.max(runtimeOptions.conversationTimeoutMs, DEFAULT_CONVERSATION_TIMEOUT_MS)
      : DEFAULT_CONVERSATION_TIMEOUT_MS;
  const timingState =
    runtimeOptions.timingState ??
    (runtimeOptions.timingState = {
      baseTimeoutMs: baseTimeout,
      adaptiveTimeoutMs: baseTimeout,
      durationSamples: 0,
      durationTotalMs: 0,
    });
  const maxRefreshAttempts =
    typeof runtimeOptions.maxRefreshAttempts === 'number'
      ? Math.max(0, runtimeOptions.maxRefreshAttempts)
      : 1;
  const conversations: BrowserConversation[] = [];

  for (const target of targets) {
    let client: Awaited<ReturnType<typeof CDP>> | undefined;
    try {
      client = await CDP({ host, port, target });
      const { Runtime, Page } = client;
      if (!Runtime || !Page) {
        throw new Error('Chrome protocol did not expose the Runtime/Page domains.');
      }
      await Promise.all([Runtime.enable(), Page.enable()]);
      await waitForPageReady(Page, Runtime, verbose);
      const loadStart = Date.now();
      const timeoutMs = Math.max(
        timingState.adaptiveTimeoutMs,
        timingState.baseTimeoutMs,
      );
      const detectedTurns = await ensureConversationContent(Page, Runtime, verbose, {
        timeoutMs,
        maxRefreshAttempts,
      });
      if (typeof detectedTurns === 'number' && detectedTurns > 0) {
        const elapsed = Math.max(0, Date.now() - loadStart);
        timingState.durationSamples += 1;
        timingState.durationTotalMs += elapsed;
        const average = timingState.durationTotalMs / timingState.durationSamples;
        const padded = Math.ceil(average * TIMEOUT_PADDING_FACTOR);
        const previousTimeout = timingState.adaptiveTimeoutMs;
        timingState.adaptiveTimeoutMs = Math.max(
          padded,
          timingState.baseTimeoutMs,
        );
        if (verbose) {
          console.log(
            `Conversation DOM detected in ${elapsed}ms (${detectedTurns} turns). Adaptive timeout updated from ${previousTimeout}ms to ${timingState.adaptiveTimeoutMs}ms.`,
          );
        }
      }

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

const closeTargetDescriptor = async (
  target: TargetDescriptor,
  host: string,
  port: number,
  verbose?: boolean,
): Promise<void> => {
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
    conversationTimeoutMs,
    maxRefreshAttempts,
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

  const baseTimeout =
    typeof conversationTimeoutMs === 'number'
      ? Math.max(conversationTimeoutMs, DEFAULT_CONVERSATION_TIMEOUT_MS)
      : DEFAULT_CONVERSATION_TIMEOUT_MS;

  const runtimeOptions: CollectorRuntimeOptions = {
    host,
    port,
    conversationTimeoutMs: baseTimeout,
    timingState: {
      baseTimeoutMs: baseTimeout,
      adaptiveTimeoutMs: baseTimeout,
      durationSamples: 0,
      durationTotalMs: 0,
    },
  };
  if (typeof maxMessagesPerConversation === 'number') {
    runtimeOptions.maxMessagesPerConversation = maxMessagesPerConversation;
  }
  if (typeof verbose === 'boolean') {
    runtimeOptions.verbose = verbose;
  }
  if (typeof maxRefreshAttempts === 'number') {
    runtimeOptions.maxRefreshAttempts = maxRefreshAttempts;
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
    conversationTimeoutMs,
    maxRefreshAttempts,
    maxConcurrentTabs,
  } = options;

  if (!urls?.length) {
    return [];
  }

  const concurrency =
    typeof maxConcurrentTabs === 'number' && Number.isFinite(maxConcurrentTabs)
      ? Math.max(1, Math.floor(maxConcurrentTabs))
      : DEFAULT_MAX_CONCURRENT_TABS;
  const baseTimeout =
    typeof conversationTimeoutMs === 'number'
      ? Math.max(conversationTimeoutMs, DEFAULT_CONVERSATION_TIMEOUT_MS)
      : DEFAULT_CONVERSATION_TIMEOUT_MS;

  const runtimeOptions: CollectorRuntimeOptions = {
    host,
    port,
    conversationTimeoutMs: baseTimeout,
    timingState: {
      baseTimeoutMs: baseTimeout,
      adaptiveTimeoutMs: baseTimeout,
      durationSamples: 0,
      durationTotalMs: 0,
    },
  };
  if (typeof maxMessagesPerConversation === 'number') {
    runtimeOptions.maxMessagesPerConversation = maxMessagesPerConversation;
  }
  if (typeof verbose === 'boolean') {
    runtimeOptions.verbose = verbose;
  }
  if (typeof maxRefreshAttempts === 'number') {
    runtimeOptions.maxRefreshAttempts = maxRefreshAttempts;
  }

  const pendingUrls = [...urls];
  const activeTargets: TargetDescriptor[] = [];
  const openTargets = new Set<TargetDescriptor>();
  const conversations: BrowserConversation[] = [];

  const openTargetForUrl = async (targetUrl: string): Promise<void> => {
    try {
      if (verbose) {
        console.log(`Opening bookmarked URL ${targetUrl}`);
      }
      const target = await CDP.New({ host, port, url: targetUrl });
      activeTargets.push(target);
      openTargets.add(target);
    } catch (error) {
      console.error(`Failed to open bookmark URL ${targetUrl}:`, error);
    }
  };

  const releaseTarget = async (target: TargetDescriptor): Promise<void> => {
    if (!keepOpen) {
      await closeTargetDescriptor(target, host, port, verbose);
    }
    openTargets.delete(target);
  };

  try {
    while (pendingUrls.length || activeTargets.length) {
      while (pendingUrls.length && activeTargets.length < concurrency) {
        const nextUrl = pendingUrls.shift();
        if (nextUrl) {
          await openTargetForUrl(nextUrl);
        }
      }

      if (!activeTargets.length) {
        break;
      }

      const currentTarget = activeTargets.shift();
      if (!currentTarget) {
        continue;
      }

      try {
        const result = await collectFromTargets([currentTarget], runtimeOptions);
        conversations.push(...result);
      } finally {
        await releaseTarget(currentTarget);
      }
    }
  } finally {
    if (!keepOpen && openTargets.size) {
      await Promise.all(
        Array.from(openTargets).map((target) =>
          closeTargetDescriptor(target, host, port, verbose),
        ),
      );
      openTargets.clear();
    }
  }

  if (!conversations.length && verbose) {
    console.warn('No conversations were captured from the provided URLs.');
  }

  return conversations;
}

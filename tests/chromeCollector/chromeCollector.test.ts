import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '../../src/types.js';
import {
  collectChatGPTConversations,
  collectConversationsForUrls,
} from '../../src/chromeCollector.js';

interface TargetScenario {
  url: string;
  waitFailures: number;
  waitCalls: number;
  conversationTurns: number;
  messages: ConversationMessage[];
  title: string;
  reloads: number;
}

interface TargetDescriptor {
  targetId?: string;
  id?: string;
  url?: string;
  title?: string;
}

const createDefaultMessages = (url?: string): ConversationMessage[] => [
  { role: 'user', content: `Question from ${url ?? 'unknown'}` },
  { role: 'assistant', content: 'Automated reply' },
];

const createScenario = (url?: string): TargetScenario => {
  const messages = createDefaultMessages(url);
  return {
    url: url ?? 'about:blank',
    waitFailures: 0,
    waitCalls: 0,
    conversationTurns: messages.length,
    messages,
    title: `Thread for ${url ?? 'unknown'}`,
    reloads: 0,
  };
};

const mockState = {
  scenarios: new Map<string, TargetScenario>(),
  newCalls: [] as Array<{ targetId: string; url: string }>,
  closeCalls: [] as string[],
  currentOpen: 0,
  maxOpen: 0,
  listTargets: [] as TargetDescriptor[],
  scenarioCounter: 0,
};

const resetMockState = (): void => {
  mockState.scenarios.clear();
  mockState.newCalls = [];
  mockState.closeCalls = [];
  mockState.currentOpen = 0;
  mockState.maxOpen = 0;
  mockState.listTargets = [];
  mockState.scenarioCounter = 0;
};

const registerScenarioForKey = (
  key: string,
  scenario: TargetScenario,
): TargetScenario => {
  const existing = mockState.scenarios.get(key);
  if (!existing) {
    mockState.scenarios.set(key, scenario);
    return scenario;
  }
  return existing;
};

const ensureScenarioForKey = (key: string, url?: string): TargetScenario => {
  const existing = mockState.scenarios.get(key);
  if (existing) {
    if (url && !mockState.scenarios.has(url)) {
      mockState.scenarios.set(url, existing);
    }
    return existing;
  }
  if (url) {
    const existingForUrl = mockState.scenarios.get(url);
    if (existingForUrl) {
      mockState.scenarios.set(key, existingForUrl);
      return existingForUrl;
    }
  }
  const scenario = createScenario(url ?? key);
  mockState.scenarios.set(key, scenario);
  if (url && url !== key && !mockState.scenarios.has(url)) {
    mockState.scenarios.set(url, scenario);
  }
  return scenario;
};

const getScenarioForTarget = (target: TargetDescriptor): TargetScenario => {
  const keys = [
    target.id,
    target.targetId,
    target.url,
  ].filter((value): value is string => Boolean(value));

  for (const key of keys) {
    const existing = mockState.scenarios.get(key);
    if (existing) {
      if (target.url && !mockState.scenarios.has(target.url)) {
        mockState.scenarios.set(target.url, existing);
      }
      return existing;
    }
  }

  const derivedKey =
    target.targetId ?? target.url ?? `scenario-${mockState.scenarioCounter++}`;
  return ensureScenarioForKey(derivedKey, target.url);
};

const configureScenario = (
  url: string,
  overrides: Partial<TargetScenario> = {},
): TargetScenario => {
  const scenario = ensureScenarioForKey(url, url);
  Object.assign(scenario, overrides);
  if (overrides.messages) {
    scenario.conversationTurns =
      overrides.conversationTurns ?? overrides.messages.length;
  } else if (
    typeof overrides.conversationTurns === 'number' &&
    overrides.conversationTurns > 0
  ) {
    scenario.conversationTurns = overrides.conversationTurns;
  }
  return scenario;
};

const getScenarioSnapshot = (url: string): TargetScenario | undefined => {
  const scenario = mockState.scenarios.get(url);
  return scenario ? { ...scenario } : undefined;
};

const setListTargets = (targets: TargetDescriptor[]): void => {
  mockState.listTargets = targets.map((target) => ({ ...target }));
};

vi.mock('chrome-remote-interface', () => {
  const normalizeExpressionType = (
    expression: string,
  ): 'ready' | 'wait' | 'extract' => {
    if (expression === 'document.readyState') {
      return 'ready';
    }
    if (expression.includes('MutationObserver')) {
      return 'wait';
    }
    return 'extract';
  };

  const createClient = (target: TargetDescriptor) => {
    const scenario = getScenarioForTarget(target);
    const runtimeEvaluate = vi.fn(async ({ expression }: { expression: string }) => {
      const type = normalizeExpressionType(expression);
      if (type === 'ready') {
        return { result: { value: 'complete' } };
      }
      if (type === 'wait') {
        scenario.waitCalls += 1;
        const shouldSucceed = scenario.waitCalls > scenario.waitFailures;
        return { result: { value: shouldSucceed ? scenario.conversationTurns : 0 } };
      }
      return {
        result: {
          value: {
            title: scenario.title,
            messages: scenario.messages,
          },
        },
      };
    });

    return {
      Runtime: {
        enable: vi.fn().mockResolvedValue(undefined),
        evaluate: runtimeEvaluate,
      },
      Page: {
        enable: vi.fn().mockResolvedValue(undefined),
        domContentEventFired: vi.fn((callback?: () => void) => callback?.()),
        loadEventFired: vi.fn((callback?: () => void) => callback?.()),
        reload: vi.fn().mockImplementation(async () => {
          scenario.reloads += 1;
        }),
      },
      close: vi.fn().mockResolvedValue(undefined),
    };
  };

  const CDPFn = vi.fn(async ({ target }: { target: TargetDescriptor }) =>
    createClient(target),
  );

  CDPFn.List = vi.fn(async () => mockState.listTargets.map((target) => ({ ...target })));

  CDPFn.New = vi.fn(async ({ url }: { url: string }) => {
    const targetId = `target-${mockState.newCalls.length + 1}`;
    const descriptor: TargetDescriptor = { targetId, url };
    ensureScenarioForKey(targetId, url);
    registerScenarioForKey(url, ensureScenarioForKey(targetId, url));
    mockState.newCalls.push({ targetId, url });
    mockState.currentOpen += 1;
    mockState.maxOpen = Math.max(mockState.maxOpen, mockState.currentOpen);
    return descriptor;
  });

  CDPFn.Close = vi.fn(async ({ id }: { id: string }) => {
    mockState.closeCalls.push(id);
    mockState.currentOpen = Math.max(0, mockState.currentOpen - 1);
  });

  return { default: CDPFn };
});

describe('collectConversationsForUrls concurrency and lifecycle controls', () => {
  beforeEach(() => {
    resetMockState();
    vi.clearAllMocks();
  });

  it('opens only the configured number of tabs at a time', async () => {
    const urls = [
      'https://chatgpt.com/c/a',
      'https://chatgpt.com/c/b',
      'https://chatgpt.com/c/c',
      'https://chatgpt.com/c/d',
    ];

    const conversations = await collectConversationsForUrls({
      urls,
      maxConcurrentTabs: 2,
      verbose: true,
    });

    expect(conversations).toHaveLength(urls.length);
    expect(mockState.newCalls.map((entry) => entry.url)).toEqual(urls);
    expect(mockState.maxOpen).toBeLessThanOrEqual(2);
    expect(mockState.closeCalls).toHaveLength(urls.length);
  });

  it('keeps tabs open when keepOpen is true', async () => {
    const urls = ['https://chatgpt.com/c/a', 'https://chatgpt.com/c/b'];

    const conversations = await collectConversationsForUrls({
      urls,
      maxConcurrentTabs: 1,
      keepOpen: true,
    });

    expect(conversations).toHaveLength(urls.length);
    expect(mockState.closeCalls).toHaveLength(0);
  });
});

describe('chrome collector option behaviors', () => {
  beforeEach(() => {
    resetMockState();
    vi.clearAllMocks();
  });

  it('retries loading when conversation content is initially missing', async () => {
    const url = 'https://chatgpt.com/c/retry';
    configureScenario(url, { waitFailures: 1 });

    const conversations = await collectConversationsForUrls({
      urls: [url],
      maxConcurrentTabs: 1,
      conversationTimeoutMs: 10,
      maxRefreshAttempts: 2,
    });

    const snapshot = getScenarioSnapshot(url);
    expect(conversations).toHaveLength(1);
    expect(snapshot?.reloads).toBe(1);
    expect(snapshot?.waitCalls).toBeGreaterThanOrEqual(2);
  });

  it('applies maxMessagesPerConversation when provided', async () => {
    const url = 'https://chatgpt.com/c/trim';
    configureScenario(url, {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'first reply' },
        { role: 'assistant', content: 'second reply' },
      ],
    });

    const conversations = await collectConversationsForUrls({
      urls: [url],
      maxMessagesPerConversation: 2,
    });

    expect(conversations).toHaveLength(1);
    expect(conversations[0].messages).toHaveLength(2);
    expect(conversations[0].messages.map((msg) => msg.content)).toEqual([
      'first reply',
      'second reply',
    ]);
  });

  it('filters targets via collectChatGPTConversations()', async () => {
    const allowedUrl = 'https://chatgpt.com/c/allowed';
    const ignoredUrl = 'https://example.com';
    configureScenario(allowedUrl, {
      messages: [
        { role: 'user', content: 'keep me' },
        { role: 'assistant', content: 'ok' },
      ],
    });

    setListTargets([
      { targetId: 'list-1', url: allowedUrl, title: 'ChatGPT Tab' },
      { targetId: 'list-2', url: ignoredUrl, title: 'Other Site' },
    ]);

    const conversations = await collectChatGPTConversations({
      verbose: true,
    });

    expect(conversations).toHaveLength(1);
    expect(conversations[0].url).toBe(allowedUrl);
    expect(conversations[0].messages).toHaveLength(2);
  });
});

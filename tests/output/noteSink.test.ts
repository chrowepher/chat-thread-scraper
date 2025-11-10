import path from 'node:path';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import type { BrowserConversation, MergeResult } from '../../src/types.js';

const { appendFileMock, mkdirMock } = vi.hoisted(() => ({
  appendFileMock: vi.fn(),
  mkdirMock: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    appendFile: appendFileMock,
    mkdir: mkdirMock,
  },
}));

import { appendMarkdownNote } from '../../src/output/noteSink.js';

const buildBranches = (): BrowserConversation[] => [
  {
    tabId: '1',
    title: 'Beach Retreat',
    url: 'https://example.com/beach',
    messages: [
      { role: 'user', content: 'Plan it' },
      { role: 'assistant', content: 'Sure' },
    ],
  },
  {
    tabId: '2',
    title: 'Mountain Escape',
    url: 'https://example.com/mountain',
    messages: [{ role: 'user', content: 'Need ideas' }],
  },
];

const buildResult = (): MergeResult => ({
  summary: '  Combine the strongest plans.  ',
  combinedPath: ['Pick destination', 'Book housing'],
  mergeDecisions: [
    {
      branchTitles: ['Beach Retreat', 'Mountain Escape'],
      decision: 'Merge talking points',
      rationale: 'Ensures clarity',
    },
  ],
  followUpIdeas: ['Prototype packing list'],
});

describe('appendMarkdownNote', () => {
  beforeEach(() => {
    appendFileMock.mockReset();
    mkdirMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a formatted markdown block with merge metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-04-02T05:06:07.000Z'));

    const notePath = 'notes/merge.md';
    await appendMarkdownNote({
      notePath,
      result: buildResult(),
      branches: buildBranches(),
    });

    const expectedPath = path.resolve(notePath);
    expect(mkdirMock).toHaveBeenCalledWith(path.dirname(expectedPath), {
      recursive: true,
    });
    expect(appendFileMock).toHaveBeenCalledTimes(1);
    const [, markdown] = appendFileMock.mock.calls[0];
    expect(typeof markdown).toBe('string');
    expect(markdown).toContain(
      '## Chat Thread Merge (2024-04-02T05:06:07.000Z)',
    );
    expect(markdown).toContain('### Summary');
    expect(markdown).toContain('Combine the strongest plans.');
    expect(markdown).toContain('### Recombined Path');
    expect(markdown).toContain('1. Pick destination');
    expect(markdown).toContain('2. Book housing');
    expect(markdown).toContain('### Branches');
    expect(markdown).toContain(
      '- [Beach Retreat](https://example.com/beach) - 2 messages',
    );
    expect(markdown).toContain(
      '- [Mountain Escape](https://example.com/mountain) - 1 messages',
    );
    expect(markdown).toContain('### Decisions');
    expect(markdown).toContain(
      '- Branches: Beach Retreat, Mountain Escape\n    Decision: Merge talking points\n    Rationale: Ensures clarity',
    );
    expect(markdown).toContain('### Follow-up Ideas');
    expect(markdown).toContain('- Prototype packing list');
  });

  it('falls back to placeholders when there are no decisions or follow-ups', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-07-01T00:00:00.000Z'));

    const minimalResult: MergeResult = {
      summary: 'Lean summary',
      combinedPath: ['Only step'],
      mergeDecisions: [],
    };
    const branches: BrowserConversation[] = [
      {
        tabId: 'x',
        title: '',
        url: 'https://example.com/untitled',
        messages: [],
      },
    ];

    await appendMarkdownNote({
      notePath: 'notes/untitled.md',
      result: minimalResult,
      branches,
    });

    const [, markdown] = appendFileMock.mock.calls[0];
    expect(markdown).toContain('_No explicit decisions were required._');
    expect(markdown).toContain('_No follow-up ideas were returned._');
    expect(markdown).toContain(
      '- [Untitled](https://example.com/untitled) - 0 messages',
    );
  });
});

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mkdirMock, readFileMock, writeFileMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: mkdirMock,
    readFile: readFileMock,
    writeFile: writeFileMock,
  },
}));

const { randomUUIDMock } = vi.hoisted(() => ({
  randomUUIDMock: vi.fn(),
}));

vi.mock('node:crypto', () => ({
  randomUUID: randomUUIDMock,
}));

import type { TaskEntry } from '../../src/output/taskSink.js';
import { appendTasksFromIdeas } from '../../src/output/taskSink.js';

describe('appendTasksFromIdeas', () => {
  beforeEach(() => {
    mkdirMock.mockReset();
    readFileMock.mockReset();
    writeFileMock.mockReset();
    randomUUIDMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges new ideas with existing tasks using the provided source label', async () => {
    vi.useFakeTimers();
    const now = new Date('2024-01-10T09:08:07.000Z');
    vi.setSystemTime(now);

    const existing: TaskEntry[] = [
      {
        id: 'existing',
        idea: 'Already there',
        status: 'open',
        createdAt: '2023-12-01T00:00:00.000Z',
        source: 'chat-thread-merger',
      },
    ];
    readFileMock.mockResolvedValueOnce(JSON.stringify(existing));
    randomUUIDMock.mockReturnValueOnce('uuid-A').mockReturnValueOnce('uuid-B');

    const taskPath = 'tasks/ideas.json';
    await appendTasksFromIdeas({
      taskPath,
      ideas: ['Idea A', 'Idea B'],
      source: 'merge-cli',
    });

    const expectedPath = path.resolve(taskPath);
    expect(mkdirMock).toHaveBeenCalledWith(path.dirname(expectedPath), {
      recursive: true,
    });
    expect(readFileMock).toHaveBeenCalledWith(expectedPath, 'utf-8');
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [, payload] = writeFileMock.mock.calls[0];
    const stored = JSON.parse(payload as string) as TaskEntry[];
    expect(stored).toHaveLength(3);
    expect(stored[1]).toMatchObject({
      id: 'uuid-A',
      idea: 'Idea A',
      status: 'open',
      createdAt: now.toISOString(),
      source: 'merge-cli',
    });
    expect(stored[2]).toMatchObject({
      id: 'uuid-B',
      idea: 'Idea B',
      status: 'open',
      createdAt: now.toISOString(),
      source: 'merge-cli',
    });
  });

  it('returns immediately when there are no follow-up ideas', async () => {
    await appendTasksFromIdeas({
      taskPath: 'tasks/ideas.json',
      ideas: [],
    });

    expect(mkdirMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(randomUUIDMock).not.toHaveBeenCalled();
  });

  it('creates a fresh file when the tasks JSON is missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-02-01T00:00:00.000Z'));

    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    readFileMock.mockRejectedValueOnce(enoent);
    randomUUIDMock.mockReturnValueOnce('uuid-new');

    await appendTasksFromIdeas({
      taskPath: 'tasks/missing.json',
      ideas: ['Prototype itinerary'],
    });

    const [, payload] = writeFileMock.mock.calls[0];
    const stored = JSON.parse(payload as string) as TaskEntry[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: 'uuid-new',
      idea: 'Prototype itinerary',
      source: 'chat-thread-merger',
    });
  });

  it('throws a descriptive error when the existing JSON cannot be parsed', async () => {
    readFileMock.mockResolvedValueOnce('not json');

    await expect(
      appendTasksFromIdeas({
        taskPath: 'tasks/bad.json',
        ideas: ['Still record'],
      }),
    ).rejects.toThrow(/Unable to read existing tasks/);

    expect(writeFileMock).not.toHaveBeenCalled();
  });
});

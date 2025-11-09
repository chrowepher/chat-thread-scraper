import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface TaskSinkOptions {
  taskPath: string;
  ideas: string[];
  source?: string;
}

export interface TaskEntry {
  id: string;
  idea: string;
  status: 'open' | 'done';
  createdAt: string;
  source: string;
}

const ensureDirectory = async (filePath: string): Promise<void> => {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
};

const readExistingTasks = async (filePath: string): Promise<TaskEntry[]> => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TaskEntry[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new Error(`Unable to read existing tasks at ${filePath}: ${String(error)}`);
  }
};

export async function appendTasksFromIdeas(options: TaskSinkOptions): Promise<void> {
  if (!options.ideas.length) {
    return;
  }

  const resolved = path.resolve(options.taskPath);
  await ensureDirectory(resolved);
  const existing = await readExistingTasks(resolved);

  const timestamp = new Date().toISOString();
  const source = options.source ?? 'chat-thread-merger';
  const newEntries: TaskEntry[] = options.ideas.map((idea) => ({
    id: randomUUID(),
    idea,
    status: 'open',
    createdAt: timestamp,
    source,
  }));

  const combined = [...existing, ...newEntries];
  await fs.writeFile(resolved, JSON.stringify(combined, null, 2), 'utf-8');
}

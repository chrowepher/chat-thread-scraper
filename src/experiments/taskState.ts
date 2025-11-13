import fs from 'node:fs/promises';
import path from 'node:path';

export type ExperimentTaskName = 'permutations' | 'tournaments' | 'comparisons';

interface TaskStatus {
  completed: boolean;
  updatedAt: string;
}

interface TaskStateFile {
  runId: string;
  tasks: Partial<Record<ExperimentTaskName, TaskStatus>>;
}

const FILENAME = 'task-state.json';

export class ExperimentTaskState {
  private constructor(
    private readonly filePath: string,
    private readonly runId: string,
    private data: TaskStateFile,
  ) {}

  static async load(runDir: string, runId: string): Promise<ExperimentTaskState> {
    const filePath = path.join(runDir, FILENAME);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as TaskStateFile;
      if (parsed.runId !== runId) {
        throw new Error('Task state runId mismatch.');
      }
      return new ExperimentTaskState(filePath, runId, parsed);
    } catch {
      const initial: TaskStateFile = {
        runId,
        tasks: {},
      };
      return new ExperimentTaskState(filePath, runId, initial);
    }
  }

  isCompleted(task: ExperimentTaskName): boolean {
    return Boolean(this.data.tasks[task]?.completed);
  }

  markCompleted(task: ExperimentTaskName): void {
    this.data.tasks[task] = {
      completed: true,
      updatedAt: new Date().toISOString(),
    };
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(
      this.filePath,
      JSON.stringify(this.data, null, 2),
      'utf-8',
    );
  }
}

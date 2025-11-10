export interface TodoistSyncOptions {
  token: string;
  projectId: string;
  ideas: string[];
  priority?: number;
  dueString?: string;
  sourceLabel?: string;
}

const TODOIST_ENDPOINT = 'https://api.todoist.com/rest/v2/tasks';

const clampPriority = (value?: number): number => {
  if (!value) {
    return 1;
  }
  return Math.min(4, Math.max(1, Math.round(value)));
};

export async function syncTodoistTasks(
  options: TodoistSyncOptions,
): Promise<void> {
  if (!options.ideas.length) {
    return;
  }

  if (typeof fetch !== 'function') {
    throw new Error(
      'syncTodoistTasks: global fetch is unavailable in this runtime.',
    );
  }

  const priority = clampPriority(options.priority);

  const createTask = async (idea: string): Promise<void> => {
    const payload: Record<string, unknown> = {
      content: idea,
      project_id: options.projectId,
      priority,
    };

    if (options.dueString) {
      payload.due_string = options.dueString;
    }
    if (options.sourceLabel) {
      payload.description = `Source: ${options.sourceLabel}`;
    }

    const response = await fetch(TODOIST_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `Todoist API returned ${response.status}: ${response.statusText} ${errorBody}`,
      );
    }
  };

  for (const idea of options.ideas) {
    await createTask(idea);
  }
}

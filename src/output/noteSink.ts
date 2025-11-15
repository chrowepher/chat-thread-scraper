import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserConversation, MergeDecision, MergeResult } from '../types.js';

const ensureDirectory = async (filePath: string): Promise<void> => {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
};

const formatDecisions = (decisions: MergeDecision[]): string => {
  if (!decisions.length) {
    return '_No explicit decisions were required._';
  }

  return decisions
    .map((decision) => {
      const rationale = decision.rationale
        ? `\n    Rationale: ${decision.rationale}`
        : '';
      return `- Branches: ${decision.branchTitles.join(', ')}\n    Decision: ${decision.decision}${rationale}`;
    })
    .join('\n');
};

const formatCombinedPath = (pathItems: string[]): string =>
  pathItems.map((item, index) => `${index + 1}. ${item}`).join('\n');

const pluralize = (
  count: number,
  singular: string,
  plural: string,
): string => (count === 1 ? singular : plural);

const formatBranches = (branches: BrowserConversation[]): string =>
  branches
    .map((branch) => {
      const title = branch.title || 'Untitled';
      const url = branch.url;
      const messageCount = branch.messages.length;
      const warning =
        messageCount === 0
          ? ' (scrape captured 0 messages - open this link manually to verify before re-running)'
          : '';
      return `- [${title}](${url}) - ${messageCount} ${pluralize(messageCount, 'message', 'messages')}${warning}`;
    })
    .join('\n');

export interface NoteSinkOptions {
  notePath: string;
  result: MergeResult;
  branches: BrowserConversation[];
}

export async function appendMarkdownNote(options: NoteSinkOptions): Promise<void> {
  const resolved = path.resolve(options.notePath);
  await ensureDirectory(resolved);

  const timestamp = new Date().toISOString();
  const { result, branches } = options;

  const followUps = result.followUpIdeas?.length
    ? result.followUpIdeas.map((idea) => `- ${idea}`).join('\n')
    : '_No follow-up ideas were returned._';

  const markdown = [
    `## Chat Thread Merge (${timestamp})`,
    '',
    '### Summary',
    result.summary.trim(),
    '',
    '### Recombined Path',
    formatCombinedPath(result.combinedPath),
    '',
    '### Branches',
    formatBranches(branches),
    '',
    '### Decisions',
    formatDecisions(result.mergeDecisions),
    '',
    '### Follow-up Ideas',
    followUps,
    '',
    '---',
    '',
  ].join('\n');

  await fs.appendFile(resolved, markdown, 'utf-8');
}

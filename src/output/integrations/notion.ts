import type {
  BrowserConversation,
  MergeResult,
} from '../../types.js';

export interface NotionSyncOptions {
  databaseId: string;
  token: string;
  result: MergeResult;
  branches: BrowserConversation[];
  titleProperty?: string;
  summaryProperty?: string;
}

const NOTION_API_URL = 'https://api.notion.com/v1/pages';
const NOTION_VERSION = '2022-06-28';
const MAX_TEXT = 1900;

const truncate = (value: string, max = MAX_TEXT): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}...`;

const bulletBlock = (text: string) => ({
  object: 'block',
  type: 'bulleted_list_item',
  bulleted_list_item: {
    rich_text: [
      {
        type: 'text',
        text: { content: text },
      },
    ],
  },
});

const linkBlock = (title: string, url: string) => ({
  object: 'block',
  type: 'bulleted_list_item',
  bulleted_list_item: {
    rich_text: [
      {
        type: 'text',
        text: {
          content: title,
          link: { url },
        },
      },
    ],
  },
});

export async function publishNotionSummary(
  options: NotionSyncOptions,
): Promise<void> {
  if (typeof fetch !== 'function') {
    throw new Error(
      'publishNotionSummary: global fetch is unavailable in this runtime.',
    );
  }

  const {
    databaseId,
    token,
    result,
    branches,
    titleProperty = 'Name',
    summaryProperty = 'Summary',
  } = options;

  const mergedTitle = `Chat Merge - ${new Date().toLocaleString()}`;

  const properties: Record<string, unknown> = {
    [titleProperty]: {
      title: [
        {
          text: {
            content: truncate(mergedTitle, 200),
          },
        },
      ],
    },
  };

  if (summaryProperty) {
    properties[summaryProperty] = {
      rich_text: [
        {
          text: {
            content: truncate(result.summary, 2000),
          },
        },
      ],
    };
  }

  const children = [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: {
        rich_text: [{ type: 'text', text: { content: 'Recombined Path' } }],
      },
    },
    ...result.combinedPath.map((step) => bulletBlock(step)),
    ...(result.followUpIdeas?.length
      ? [
          {
            object: 'block',
            type: 'heading_2',
            heading_2: {
              rich_text: [
                { type: 'text', text: { content: 'Follow-up Ideas' } },
              ],
            },
          },
          ...result.followUpIdeas.map((idea) => bulletBlock(idea)),
        ]
      : []),
    {
      object: 'block',
      type: 'heading_2',
      heading_2: {
        rich_text: [{ type: 'text', text: { content: 'Source Branches' } }],
      },
    },
    ...branches.map((branch) => linkBlock(branch.title, branch.url)),
  ];

  const response = await fetch(NOTION_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
      children,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `Notion API returned ${response.status}: ${response.statusText} ${errorBody}`,
    );
  }
}

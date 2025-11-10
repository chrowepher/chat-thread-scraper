import fs from 'node:fs/promises';
import path from 'node:path';

export interface BookmarkEntry {
  name: string;
  url: string;
  path: string;
  folder: string;
}

export interface BookmarkLoadResult {
  entries: BookmarkEntry[];
  folderSummaries: Array<{
    folderName: string;
    folderPath: string;
    entryCount: number;
  }>;
  resolvedPath: string;
}

export interface BookmarkLoadOptions {
  folderNames: string[];
  bookmarksPath?: string;
  profile?: string;
  caseSensitive?: boolean;
}

interface BookmarkNode {
  name?: string;
  type?: 'folder' | 'url';
  url?: string;
  children?: BookmarkNode[];
}

const DEFAULT_PROFILE = 'Default';

const PLATFORM_DIRECTORIES: Record<NodeJS.Platform, string> = {
  win32: path.join(
    process.env.LOCALAPPDATA || '',
    'Google',
    'Chrome',
    'User Data',
  ),
  darwin: path.join(
    process.env.HOME || '',
    'Library',
    'Application Support',
    'Google',
    'Chrome',
  ),
  linux: path.join(process.env.HOME || '', '.config', 'google-chrome'),
  aix: '',
  android: '',
  freebsd: path.join(process.env.HOME || '', '.config', 'google-chrome'),
  haiku: '',
  openbsd: path.join(process.env.HOME || '', '.config', 'google-chrome'),
  sunos: '',
  cygwin: path.join(
    process.env.LOCALAPPDATA || '',
    'Google',
    'Chrome',
    'User Data',
  ),
  netbsd: path.join(process.env.HOME || '', '.config', 'google-chrome'),
};

const resolveDefaultBookmarksPath = (
  profile: string = DEFAULT_PROFILE,
): string => {
  const platformKey = process.platform as NodeJS.Platform;
  const baseDir = PLATFORM_DIRECTORIES[platformKey];
  if (!baseDir) {
    throw new Error(
      `Unsupported platform "${platformKey}" for automatic bookmark discovery. Provide --bookmark-path instead.`,
    );
  }
  const resolved = path.join(baseDir, profile, 'Bookmarks');
  return resolved;
};

export const loadBookmarkFolderEntries = async (
  options: BookmarkLoadOptions,
): Promise<BookmarkLoadResult> => {
  const { folderNames, bookmarksPath, profile = DEFAULT_PROFILE, caseSensitive } =
    options;

  if (!folderNames?.length) {
    throw new Error('At least one --bookmark-folder value must be provided.');
  }

  const resolvedPath = path.resolve(
    bookmarksPath || resolveDefaultBookmarksPath(profile),
  );
  const raw = await fs.readFile(resolvedPath, 'utf-8');
  const sanitized = raw.replace(/^\uFEFF/, '');
  let parsed: {
    roots?: {
      bookmark_bar?: BookmarkNode;
      other?: BookmarkNode;
      synced?: BookmarkNode;
    };
  };
  try {
    parsed = JSON.parse(sanitized);
  } catch (error) {
    throw new Error(
      `Failed to parse Chrome bookmarks file at ${resolvedPath}: ${String(error)}`,
    );
  }

  const roots = [
    parsed.roots?.bookmark_bar,
    parsed.roots?.other,
    parsed.roots?.synced,
  ].filter(Boolean) as BookmarkNode[];

  if (!roots.length) {
    throw new Error(
      `No bookmark roots were found at ${resolvedPath}. Double-check the Chrome profile.`,
    );
  }

  const normalizedTargets = folderNames.map((folder) =>
    caseSensitive ? folder : folder.toLowerCase(),
  );

  const folderSummaries: BookmarkLoadResult['folderSummaries'] = [];
  const collected: BookmarkEntry[] = [];

  const normalize = (value: string | undefined): string =>
    caseSensitive ? value ?? '' : (value ?? '').toLowerCase();

  const gatherEntries = (
    node: BookmarkNode,
    parentPath: string,
    folderName: string,
  ): BookmarkEntry[] => {
    if (!node.children?.length) {
      return [];
    }
    const entries: BookmarkEntry[] = [];
    for (const child of node.children) {
      if (!child) {
        continue;
      }
      if (child.type === 'url' && child.url) {
        const entryPath = parentPath ? `${parentPath}/${child.name ?? ''}` : child.name ?? '';
        entries.push({
          name: child.name ?? child.url,
          url: child.url,
          path: entryPath,
          folder: folderName,
        });
      } else if (child.type === 'folder') {
        const nestedPath = parentPath
          ? `${parentPath}/${child.name ?? 'Unnamed'}`
          : child.name ?? 'Unnamed';
        entries.push(
          ...gatherEntries(child, nestedPath, folderName),
        );
      }
    }
    return entries;
  };

  const visit = (node: BookmarkNode, currentPath: string[]): void => {
    if (!node || node.type !== 'folder') {
      return;
    }
    const folderPathParts = [...currentPath, node.name ?? 'Unnamed'];
    const folderLabel = folderPathParts.filter(Boolean).join('/');
    const normalizedName = normalize(node.name);
    if (
      normalizedName &&
      normalizedTargets.includes(normalizedName)
    ) {
      const entries = gatherEntries(node, folderLabel, node.name ?? 'Unnamed');
      folderSummaries.push({
        folderName: node.name ?? 'Unnamed',
        folderPath: folderLabel,
        entryCount: entries.length,
      });
      collected.push(...entries);
    }
    if (node.children?.length) {
      for (const child of node.children) {
        if (child?.type === 'folder') {
          visit(child, folderPathParts);
        }
      }
    }
  };

  roots.forEach((root) => visit(root, []));

  if (!collected.length) {
    throw new Error(
      `No bookmarks found for folders: ${folderNames.join(', ')} (case ${caseSensitive ? 'sensitive' : 'insensitive'}).`,
    );
  }

  const dedupedMap = new Map<string, BookmarkEntry>();
  for (const entry of collected) {
    if (!entry.url) {
      continue;
    }
    if (!dedupedMap.has(entry.url)) {
      dedupedMap.set(entry.url, entry);
    }
  }

  return {
    entries: Array.from(dedupedMap.values()),
    folderSummaries,
    resolvedPath,
  };
};

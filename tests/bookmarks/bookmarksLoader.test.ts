import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadBookmarkFolderEntries } from '../../src/bookmarks.js';

const fixturePath = fileURLToPath(
  new URL('./__fixtures__/Bookmarks.json', import.meta.url),
);
const bomFixturePath = fileURLToPath(
  new URL('./__fixtures__/BookmarksWithBom.json', import.meta.url),
);

describe('bookmark folder loader', () => {
  it('extracts URLs from the requested folder name', async () => {
    const result = await loadBookmarkFolderEntries({
      folderNames: ['Digital Nomad'],
      bookmarksPath: fixturePath,
    });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.url)).toEqual([
      'https://chatgpt.com/c/primary',
      'https://chatgpt.com/c/secondary',
    ]);
    expect(result.folderSummaries[0]).toMatchObject({
      folderName: 'Digital Nomad',
    });
  });

  it('supports case-sensitive matching when requested', async () => {
    await expect(
      loadBookmarkFolderEntries({
        folderNames: ['digital nomad'],
        bookmarksPath: fixturePath,
        caseSensitive: true,
      }),
    ).rejects.toThrow(/No bookmarks found/);
  });

  it('parses bookmark files that include a UTF-8 BOM', async () => {
    const result = await loadBookmarkFolderEntries({
      folderNames: ['Digital Nomad'],
      bookmarksPath: bomFixturePath,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      url: 'https://chatgpt.com/c/primary',
      name: 'Primary Thread',
    });
  });
});

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Compute a stable hash that represents the full set of thread inputs used
 * for an experiment run. The hash incorporates both the basename (ordering)
 * and the exact contents so we can invalidate caches whenever threads change.
 */
export async function computeInputSignature(threadPaths: string[]): Promise<string> {
  const hash = crypto.createHash('sha1');
  const sorted = [...threadPaths].map((entry) => path.resolve(entry)).sort();
  for (const threadPath of sorted) {
    hash.update(path.basename(threadPath));
    const contents = await fs.readFile(threadPath);
    hash.update(contents);
  }
  return hash.digest('hex');
}

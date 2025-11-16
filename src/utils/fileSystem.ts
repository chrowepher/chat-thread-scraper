import fs from 'node:fs/promises';

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function fileExists(target: string): Promise<boolean> {
  return pathExists(target);
}

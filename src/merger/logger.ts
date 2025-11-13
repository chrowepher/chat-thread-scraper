import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  FeatureHarvestResult,
  PilotLogPayload,
  PilotLogMergeExcerpt,
} from './types.js';

const cwd = process.cwd();
const DEFAULT_LOG_ROOT = path.resolve(cwd, 'runs', 'feature-harvest');

const resolveLogRoot = (): string => {
  const envPath = process.env.FEATURE_HARVEST_LOG_DIR;
  if (envPath) {
    return path.resolve(cwd, envPath);
  }
  return DEFAULT_LOG_ROOT;
};

const getTimestamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

export const summarizeMergeResult = (
  result: FeatureHarvestResult,
): PilotLogMergeExcerpt => ({
  summary: result.synthesis.summary,
  canonicalCount: result.canonicalFeatures.length,
  uniqueCount: result.uniqueFeatures.length,
  alternateCount: result.alternateFeatures.length,
  guardrails: result.guardrails,
});

export const logPilotBatch = async (
  payload: PilotLogPayload,
): Promise<string | undefined> => {
  const root = resolveLogRoot();
  const datedDir = path.join(root, payload.timestamp.slice(0, 10));
  try {
    await fs.mkdir(datedDir, { recursive: true });
  } catch (error) {
    console.warn('Failed to ensure feature-harvest log directory:', error);
    return undefined;
  }

  const filePath = path.join(
    datedDir,
    `${payload.batchId}-${getTimestamp()}.json`,
  );
  try {
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    return filePath;
  } catch (error) {
    console.warn('Failed to write feature-harvest log file:', error);
    return undefined;
  }
};

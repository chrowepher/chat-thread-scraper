import type {
  FeatureHarvestResult,
  FeatureHarvestConfig,
} from './types.js';

export interface ScientistReviewPayload {
  batchId: string;
  mergeResults: FeatureHarvestResult[];
  configSnapshot: FeatureHarvestConfig;
  pilotMode: boolean;
  runtimeEstimateMs: number;
  runtimeActualMs: number;
}

const summarizeResult = (result: FeatureHarvestResult, index: number): string => {
  const guardrailSummary = Object.entries(result.guardrails.coverage)
    .map(
      ([conversationId, stats]) =>
        `${conversationId}: ${(
          stats.uniqueFraction * 100
        ).toFixed(1)}% uniques kept`,
    )
    .join('; ');

  const snippet = result.canonicalFeatures
    .slice(0, 2)
    .map((feature) => `• ${feature.topicLabel}: ${feature.text}`)
    .join('\n');

  return `
## Merge ${index + 1}
Summary: ${result.synthesis.summary}
Guardrails: ${guardrailSummary}
Sample:
${snippet}
`;
};

export const buildScientistPrompt = (
  payload: ScientistReviewPayload,
): string => {
  const header = `You are acting as “Scientist Reviewer” for the chat-thread feature harvesting experiment.
Use the rubric below:
- fidelity_score: 0-10 preservation of unique content
- completeness_score: 0-10 representation of all branches
- risk_score: 0-10 likelihood of hidden issues (higher = more risk)
- verdict: pass | caution | fail
- recommendations: bullet list of follow-ups

Return ONLY valid JSON.

Batch ID: ${payload.batchId}
Pilot mode: ${payload.pilotMode}
Runtime estimate: ${payload.runtimeEstimateMs} ms, actual: ${payload.runtimeActualMs} ms
Config snapshot: ${JSON.stringify(payload.configSnapshot)}
`;

  const merges = payload.mergeResults
    .map((result, index) => summarizeResult(result, index))
    .join('\n');

  const template = `
${header}

${merges}
`;
  return template.trim();
};

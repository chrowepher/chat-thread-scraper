import { describe, it, expect } from 'vitest';
import { interpretMergeSchema, parseMergeResponse, } from '../../src/openaiMerge.js';
const samplePayload = {
    summary: 'Unified summary',
    combined_path: ['Step 1', 'Step 2'],
    merge_decisions: [
        {
            branch_titles: ['Branch A', 'Branch B'],
            decision: 'Select Branch B for clarity.',
            rationale: 'It is better researched.',
        },
    ],
    follow_up_ideas: ['Validate assumptions'],
};
describe('merge parsing helpers', () => {
    it('parses valid JSON strings into the schema', () => {
        const encoded = JSON.stringify(samplePayload);
        const parsed = parseMergeResponse(encoded);
        expect(parsed).toEqual(samplePayload);
    });
    it('throws for invalid JSON', () => {
        expect(() => parseMergeResponse('{not json')).toThrowError(/invalid JSON payload/);
    });
    it('converts schema payloads into MergeResult-compatible objects', () => {
        const interpreted = interpretMergeSchema(samplePayload);
        expect(interpreted.summary).toBe('Unified summary');
        expect(interpreted.combinedPath).toEqual(['Step 1', 'Step 2']);
        expect(interpreted.mergeDecisions[0]).toMatchObject({
            branchTitles: ['Branch A', 'Branch B'],
            decision: 'Select Branch B for clarity.',
            rationale: 'It is better researched.',
        });
        expect(interpreted.followUpIdeas).toEqual(['Validate assumptions']);
    });
    it('omits optional fields when absent', () => {
        const payload = {
            summary: 'No follow ups',
            combined_path: ['Only step'],
            merge_decisions: [],
        };
        const interpreted = interpretMergeSchema(payload);
        expect(interpreted.followUpIdeas).toBeUndefined();
    });
});
//# sourceMappingURL=mergeParsing.test.js.map
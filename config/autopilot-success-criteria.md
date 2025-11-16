# Autopilot Success Criteria

These criteria drive the chatgpt-audit + chatgpt-qa pipeline. Update this
document whenever the definition of “done” for an autopilot run changes.

## Primary Outcomes

1. **Merged Narrative:** The final summary must stitch all high-signal
   conversations into a single, contradiction-free story that explains *why*
   each recommendation won. Missing evidence, hidden trade-offs, or unclear
   ownership are blockers.
2. **Decision Rationale:** Every major decision (role prioritization,
   relocation path, experiment champion, etc.) needs an explicit rationale that
   references concrete branches, experiments, or comparison scores.
3. **Actionability:** Follow-up ideas/tasks must be specific enough for a human
   to execute without re-reading the entire backlog (owner, trigger, next
   observable milestone).

## Guardrails

- Cite at least two distinct conversation branches (or experiment artifacts)
  for each major conclusion.
- Flag unresolved risks, unknowns, or data gaps with suggested resolution
  tactics.
- Note any automation limits or places where a human must intervene (e.g.,
  manual job application submission, verification codes).

## Evidence Expectations

- Summaries should quote or paraphrase the relevant branch titles/IDs so a
  reviewer can re-open the raw markdown if needed.
- Comparison winners must include the underlying criterion deltas (e.g., score
  spreads, critique snippets) instead of a generic “Plan A won.”
- Follow-up items need measurable success checks (e.g., “2 paid discovery calls
  booked,” “Visa packet notarized and submitted to VFS”).

## Fallback

If any criterion cannot be satisfied (missing data, blocking dependency,
experiment failure), the bundle must include:

1. The blocker description.
2. A proposed remediation path.
3. Whether the current run should be marked “provisional” or “failed.”

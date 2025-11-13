# Experimentation Roadmap

This document captures the design work required to add the new merge experimentation features described by the user. It maps the high-level goals onto concrete artifacts we will build inside this repository.

## Snapshot Reality Check

The current canonical dataset is `snapshots/digital-nomad.json`. Each entry in `conversations[]` already gives us everything the UI and metrics layer need:

- `tabId`, `title`, and `url` let us reference individual sources everywhere (tree outputs, metrics, UI selectors).
- `messages[]` are plain strings with `You said:` / `ChatGPT said:` prefixes, which we can split later for coverage tracking (per-source KP extraction will start here).
- `source.bookmarks` carries the folder path (`Bookmarks bar/Digital Nomad`) so the UI can offer "Load from bookmark folder" without another scrape.

These fields will seed the Thread Picker (outlined below) and keep provenance intact in the metrics lineage.

## Design Principles

1. **Control combinatorial explosion.** Provide sampling policies that deliberately limit exploration:
   - `k-random`: sample `k` permutations uniformly at random.
   - `k-diverse`: prefer permutations with high Kendall-tau distance between their source orderings (maximize dissimilarity).
   - Tree shapes to exercise associativity: `balanced`, `left-skew`, `right-skew`.
2. **Measure non-associativity and order sensitivity.** Every permutation batch writes PSI (permutation stability) and OSS (order sensitivity) to the metrics file, based on at least the three canonical tree shapes for the same set.
3. **Mitigate early-merge bias and information attenuation.**
   - Randomize seeding; run at least two tournaments with different seeds.
   - Introduce `--freshness-weight` (boost late inputs) and `--novelty-weight` (penalize dropping unique KPs).
   - Track per-source coverage so we can confirm no single early pair dominates.
4. **Compare grouped vs sequential merges.** Always run the T2 tournament and the T3 grouped route on the same pool; compute Group Interaction Gain (GIG) so we know whether triads recover lost synergy.
5. **Account for evaluator variance.** Keep critique/score temperatures at 0 and surface replicate means plus confidence intervals (`r` replicates, usually 3).
6. **Stop when stable.** If PSI for a set is above the configured threshold (default 0.92), short-circuit additional permutations and log `"status": "stable"` for that run ID.

## Metrics Contract

All metrics live in `./runs/<experimentId>/metrics.json` with this schema (minimum viable fields):

```json
{
  "runId": "exp-01",
  "permutations": [
    {
      "permId": "core6-balance-42",
      "treeShape": "balanced",
      "psi": 0.95,
      "oss": 0.08,
      "status": "stable"
    }
  ],
  "tournaments": [
    {
      "label": "T2-seed-11",
      "emb": 0.02,
      "cai": {
        "mean": 0.78,
        "median": 0.74,
        "min": 0.55
      }
    }
  ],
  "gig": [
    {
      "triple": ["A", "B", "C"],
      "t3Score": 32.5,
      "bestT2": 29.1,
      "gig": 3.4
    }
  ],
  "mers": 0.81
}
```

Specific definitions we will implement:

- **PSI** (Permutation Stability Index): average pairwise cosine similarity across the `k` sampled permutations (`k` embeddings come from the recombined.md outputs).
- **OSS** (Order Sensitivity Score): `1 - mean(sim(B, L), sim(B, R), sim(L, R))` where `B`, `L`, `R` represent balanced, left-skew, and right-skew tree outputs for the same set.
- **GIG** (Group Interaction Gain): `T3 - max(T2 pairs)` for every triple processed in parallel T3 vs T2 studies.
- **CAI** (Coverage & Attenuation Index): per-source coverage of key points (KPs). We will start by tagging KPs via sentence-level embeddings and matching to outputs. Report mean/median/min.
- **EMB** (Early-Merge Bias): delta between average contribution weight of early-round sources and late-round sources within sequential tournaments.
- **MERS** (Mutually-Exclusive Resolution Consistency): percent of exclusive decision sets that resolve to the same option across permutations of the same set.

The pure math for these lives in `src/experiments/metrics.ts` (with Vitest coverage), and `src/experiments/metricsRecorder.ts` manages `runs/<id>/metrics.json` updates so the orchestrator can append PSI/OSS/GIG/CAI/EMB/MERS entries as soon as data is available.

Acceptance thresholds so experiments can auto-gate:

- PSI >= 0.92 => mark run stable and skip more permutations.
- CAI >= 0.70 and per-source min >= 0.50 => otherwise re-run with higher novelty weighting.
- |EMB| <= 0.05 => re-seed if we exceed the bias guard.
- MERS >= 0.75 => flag rubric review when lower.

Ledger entries will summarize each experiment (`./ledger/*.md`) so operators can scan stability, coverage, and bias at a glance.

## Sampling Plans for 12 Threads

We will encode three reusable plans. Each plan becomes a first-class preset in the CLI (`--plan planA|planB|planC`) and maps to templates in automation scripts.

- **Plan A -- Tournament only (baseline):** run two independent T2 brackets with distinct seeds (balanced trees) -> ~22 merges.
- **Plan B -- Tournament + T3 groups (moderate cost):** stage 1 is four T3 groups (A-L). Stage 2 merges winners via T2, plus a full T2 tournament with another seed in parallel. ~18 merges.
- **Plan C -- Permutation probe:** pick a 6-thread subset and run `k=5` permutations x 3 shapes each for PSI/OSS (~9-15 merges).

Operators can combine A + B + C while staying under ~40 merges to collect rich evidence.

## Plan Matrix Automation

- `chat-thread-merger autopilot --plan-suite planA --plan-suite planB --plan-suite planC --plan-comparisons` now caches each plan run by the hash of its experiment threads; forcing a rerun requires `--force-plan <id>` or a changed input signature.
- Cached artifacts include recombined markdown, metrics, coverage, critiques, and lineage so Autopilot skips re-merging, re-critiquing, or replaying tournaments unless explicitly refreshed.
- Pairwise plan comparisons (PlanA/B, A/C, B/C) are written to `runs/plan-matrix-<signature>/comparisons/<pair>/` and reuse prior compare/contrast reasoning whenever the left/right champions match earlier metadata.

## CLI Surface Changes

`chat-thread-merger` will expose a superset of the current `mergeSnapshot` functionality:

- Input control: `--threads <paths>` or `--threads @listfile`, plus `--branch-count T2|T3`.
- Sampling: `--sample-policy k-random|k-diverse|bracket`, `--sample-k <int>`, `--tree-shapes balanced,left,right`, `--seed <int>`.
- Mitigations: `--freshness-weight <0..1>`, `--novelty-weight <0..1>`, `--priorities coherence,actionability,coverage`, `--tie-break actionability>coherence>coverage`.
- Metrics output: `--calc-metrics`, `--write-tree <path>` (Newick), `--write-output <path>`, `--write-metadata <path>`, `--eval-replicates <int>`.
- Provenance: every run writes `lineage.json` with `{ rpTag, newick, seed, treeShape, orderSpec, permId }`.
- Execution: `chat-thread-merger run --run-dir runs/<id> --list-tasks` loads the manifest/schedule, primes `metrics.json`, and lists permutation/tournament/comparison tasks for manual or scripted execution. Add `--execute-permutations` to run the permutation pipeline (sampler + merge executor + embeddings + coverage) and record PSI/CAI/OSS metrics automatically. Add `--execute-tournaments` to drive bracketed merges via the `MergeExecutor` (writing markdown + metadata for each match) and record champion coverage stats. Add `--execute-comparisons` to pit stored champions against each other, invoke `scripts/post_to_chatgpt.py` (via `PythonCritiqueRunner`), compute GIG, and drop critique markdown/scorecard artifacts under `./runs/<id>/comparisons/`.

Internally we will add a sampling orchestrator that:

1. Builds permutations per policy (including Kendall-tau scoring for `k-diverse`).
2. For each permutation x tree shape:
   - Runs merges in the requested tree order.
   - Saves outputs and metadata.
   - Feeds the recombined markdown into the metrics worker (PSI/OSS embeddings, coverage, etc.).
3. Determines whether the stability stop triggers.

Permutation generation (`k-random`, `k-diverse`, subset sampling, permId hashing) now lives in `src/experiments/sampler.ts`, and both permutations and tournaments call into `src/experiments/mergeExecutor.ts` so every sampled order/tree shape flows through the same merge path and emits Markdown + metadata artifacts.

Embeddings for PSI/OSS are served through `src/experiments/embeddingService.ts` (OpenAI-backed with on-disk caching), and coverage analysis for CAI/EMB hooks into `src/experiments/coverageAnalyzer.ts`, which tracks per-source key points and survival ratios before feeding values into `metricsRecorder`.

## Helper Script Changes

`scripts/post_to_chatgpt.py` now handles replicated critiques:

- Inputs: `--left <file>`, `--right <file>`, `--prompt <file>`, `--replicates <r>`, `--temperature 0`, `--out-markdown`, `--out-scorecard`, plus optional `--model`, `--api-base`, `--api-key`, and `--api-key-env`.
- Outputs: Markdown critique for humans + `scorecard.json` with per-criterion mean +/- 95% CI, raw replicate traces for audits.
- Example:

```
python scripts/post_to_chatgpt.py \
  --left ./runs/final/recombined.md \
  --right ./runs/t2_champion/recombined.md \
  --prompt ./prompts/compare_threads.md \
  --replicates 3 \
  --temperature 0 \
  --out-markdown ./runs/exp-01/critique.md \
  --out-scorecard ./runs/exp-01/scorecard.json
```

The CLI option `--eval-replicates` pipes through to this helper when we automatically critique champions (e.g., Plan B final vs the alternate tournament winner).

## Mutual-Optima Arbitration

Whenever merges encounter mutually exclusive factor sets:

```
for each exclusive_set in factor_map:
  score = w1 * coherence_gain
        + w2 * actionability_gain
        + w3 * coverage_gain
        + w4 * novelty_preservation
        + w5 * analysis_priors(option)
  choose argmax(score)
  log to notes.md and metadata.analysisRefs
```

Weights tie back to `--priorities` and `--tie-break`. Notes and metadata entries provide breadcrumbs for MERS calculations.

## Provenance & Tree Encoding

- RP tags keep their existing shape: `RP/<branchCount>-<runId>/<orderSpec>/<shortHash>`.
- Newick trees (`--write-tree`) capture merge shapes (e.g., `((A,B),(C,(D,E)));`).
- `lineage.json` aggregates `{ rpTag, newick, seed, treeShape, orderSpec, permId }` for each output so plots and diagnostics can color by property later.

## UI Blueprint

Goal: if we ever build a richer front end, default to an Angular + TypeScript dashboard (not React) that lets operators pick threads from JSON snapshots, configure experiments, run merges, and review lineage/metrics/side-by-side critiques. Realistically the CLI may remain primary, so this section is guidance, not a commitment.

### A. Thread Picker

- Reads `conversations[]` from the snapshot (local file chooser or bookmark folder quick-load).
- Displays table columns: Title, tabId, message count, "You/GPT" counts. Right panel shows the first few message excerpts for context.
- Operators can filter by tags (topic, recency) and select up to 12 threads before clicking "Create Experiment".

### B. Experiment Designer

- Form sections for Sampling & Tree Shapes, Routes to Compare (T2 vs T3), Bias Mitigation (freshness/novelty weights), Evaluation (replicates, rubric template), and Mutual-Optima priorities.
- Persists PSI threshold (default 0.92) and shows warnings when requested merges exceed ~40 budgets.
- Uses a summary card (e.g., `Experiment exp-01 * 12 threads * Plan B + C`) before launching the CLI.

### C. Run Console

- Streams CLI progress (permutation status, tournament bracket updates).
- Shows live metrics snapshots by reading `./runs/<experimentId>/metrics.json` and `lineage.json`.
- Highlights stability stop triggers, CAI/EMB alerts, and positive GIG cases.

### D. Review Workspace

- Side-by-side viewer for champions (T2 vs T3) plus critique markdown rendered inline.
- Coverage heatmap per source and per bracket.
- Tree visualization generated from Newick files.

### Data Contracts

The UI expects:

1. Snapshot JSON (as produced today).
2. `runs/<id>/` folder with `recombined.md`, `merge_tree.newick`, `metadata.json`, `metrics.json`, optional `lineage.json`, and critiques (`critique.md`, `scorecard.json`).
3. Ledger entries summarizing experiments for historical browsing.

With these contracts in place, we can implement Angular components (or any lighter UI) incrementally without blocking CLI progress, if we ever decide to go beyond the CLI.

## Next Steps

1. Scaffold the sampling orchestrator + metrics worker in TypeScript.
2. Implement PSI/OSS embedding pipeline (OpenAI text-embedding or local alternative).
3. Extend the CLI (`src/mergeSnapshot.ts`) to expose the new flags and run plans A-C.
4. Add the critique helper script plus ledger writer.
5. Build the UI shell that reads snapshots and run folders.

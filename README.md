## Chat Thread Scraper

Capture complete ChatGPT conversation threads straight from your saved bookmarks. The CLI opens every bookmarked ChatGPT URL inside a Chrome instance that exposes the DevTools protocol, scrapes the transcript, and writes a JSON snapshot you can archive or feed into downstream tooling.

### Requirements

- **Node.js 20+**
- **Google Chrome** launched with remote debugging enabled, for example:
  ```powershell
  "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
  ```
- Bookmark folders that contain ChatGPT thread URLs (or a manual list of `https://chatgpt.com/c/...` links).

### Setup

```powershell
npm install
```

### Usage

Scrape every ChatGPT thread stored inside a bookmark folder named "Research":

```powershell
npm start -- --bookmark-folder "Research" --output snapshots/research.json --pretty
```

Target multiple folders plus an explicit URL, while keeping the temporary tabs alive for further manual review:

```powershell
npm start -- ^
  --bookmark-folder "Weekly Reviews" ^
  --bookmark-folder "Ideas/AI" ^
  --url https://chatgpt.com/c/abc123 ^
  --keep-tabs ^
  --max-messages 25 ^
  --verbose
```

Key flags:

| Flag | Description |
| --- | --- |
| `--bookmark-folder <name>` | One or more bookmark folders to scan for ChatGPT URLs. Repeatable. |
| `--bookmark-profile <profile>` | Chrome profile directory to read bookmarks from (`Default`). |
| `--bookmark-path <path>` | Explicit path to Chrome's `Bookmarks` file (overrides `--bookmark-profile`). |
| `--bookmark-case-sensitive` | Match folder names case-sensitively. |
| `--url <chatgpt-url>` | Manually supply ChatGPT conversation URLs (repeatable). |
| `--host`, `--port` | Chrome DevTools host/port (`127.0.0.1:9222`). |
| `--max-messages <n>` | Limit how many messages are kept per conversation. |
| `--keep-tabs` | Leave the temporarily opened tabs alive after scraping them. |
| `--output <path>` | File path for the resulting snapshot (`snapshots/latest.json`). |
| `--pretty` | Pretty-print the JSON output. |
| `--verbose` | Extra logging about bookmark discovery and Chrome automation. |

### Snapshot format

Every run writes a `ThreadSnapshot` JSON document:

```jsonc
{
  "scrapedAt": "2025-11-09T20:48:51.660Z",
  "source": {
    "host": "127.0.0.1",
    "port": 9222,
    "urls": ["https://chatgpt.com/c/abcd"],
    "bookmarks": {
      "path": "C:/Users/me/AppData/Local/Google/Chrome/User Data/Default/Bookmarks",
      "folders": [
        { "folderName": "Research", "folderPath": "Bookmarks Bar/Research", "entryCount": 3 }
      ]
    }
  },
  "conversations": [
    {
      "tabId": "CDP/123",
      "title": "Budget Planner",
      "url": "https://chatgpt.com/c/abcd",
      "messages": [
        { "role": "user", "content": "Help plan a trip", "timestamp": "2025-05-01T12:00:00Z" },
        { "role": "assistant", "content": "Here is an itinerary..." }
      ]
    }
  ]
}
```

### Testing

```powershell
npm test
```

### Autopilot Plan Suites & Comparisons

Run the complete scrape → merge → experiment pipeline while caching plan outputs per input signature:

```powershell
chat-thread-merger autopilot --plan-suite planA --plan-suite planB --plan-suite planC --plan-comparisons
```

- `--plan-suite <plan>` adds a plan to the suite; cached runs are reused when the thread signature matches.
- `--plan-comparisons` (enabled automatically when multiple plans are listed) generates pairwise critiques (PlanA/B, A/C, B/C) and reuses them until inputs change.
- `--force-plan <plan>` reruns a specific plan even if cache hits exist; `--skip-plan-comparisons` disables the matrix run.
- Plan artifacts, metrics, and critiques are written to `runs/<planId-runId>/`, and cross-plan comparisons land in `runs/plan-matrix-<signature>/`.

### HTML Merge Reports & Preview

Capture the merged summary, recombined outline, follow-ups, and guardrail analysis as a shareable HTML report:

```powershell
chat-thread-merger autopilot --merge-html-report dist/autopilot-merge.html --open-merge-html
```

- `--merge-html-report <path>` writes the latest champion summary (plus decision notes, coverage stats, and branch catalog) to the specified HTML file.
- `--open-merge-html` launches Google Chrome with the freshly written report so you can review it immediately after the autopilot run finishes.
- When you launch autopilot via `Start-ChromeDebug.ps1`, the script now injects `--merge-html-report dist/autopilot-merge.html --open-merge-html` by default. Pass `-MergeHtmlReport <path>` to change the destination or `-DisableHtmlPreview` to opt out of the automatic Chrome preview.

### Workflow Helpers

Juggling DevTools flags, Chrome profile clean-up, and dozens of autopilot switches is now optional. Pick whichever entry point fits the moment:

- `scripts/Select-AutopilotPreset.ps1`: loads presets from `config/autopilot-presets.json`, shows an interactive picker, and launches `Start-ChromeDebug.ps1` with the matching arguments. Use `-PresetName digital-nomad-reuse-chrome` to skip the menu or `-ListOnly` to dump the catalog.
- `scripts/Ask-Autopilot.ps1`: walks you through yes/no questions (launch Chrome? keep tabs? legacy merge?) plus text prompts for bookmark folders, snapshot paths, and limits. It prints the assembled command, asks for confirmation, then executes it.
- `npm run dashboard`: starts a tiny web UI at `http://localhost:4571` with grouped form fields. Submit the form to run `Start-ChromeDebug.ps1`; the page shows the exact PowerShell invocation plus stdout/stderr so you can tweak and rerun quickly.

### Feature-Harvest Merger (Experimental)

The `src/merger` directory now contains an experimental “feature harvesting” pipeline:

- `featureExtractor` splits each conversation into atomic insights (“features”) with topic tags and provenance.
- `featureClusterer` and `featureScorer` group overlapping ideas, apply heuristics, and compute combined scores.
- `mergeSelector` enforces guardrails (coverage ratios, token budgets) while picking canonical vs. alternate features.
- `synthesizer` rebuilds a merged conversation that keeps canonical sections, unique add-ons, and clearly labeled alternates.
- `pilotRunner` plus `scientistReview` provide the pilot/batch loop with the human-in-the-loop checkpoints described in the experiment design.
- Feature harvesting now produces hierarchical summaries automatically: long messages get per-message summaries, giant threads get a conversation-level synopsis, and those summaries are treated as high-priority coverage when tokens are trimmed. Guardrail stats count summary coverage so large branches remain represented even after compression.
- The scientist reviewer now runs by default (using your `OPENAI_API_KEY` unless `FEATURE_HARVEST_SCIENTIST_API_KEY` is set) whenever you pass `--harvest`. Verdicts and prompts are recorded alongside guardrail telemetry under `runs/feature-harvest/<date>/...`.
- Large branches are chunked automatically before harvesting (80 messages ➝ 40-message segments and 100 features ➝ 60-feature segments by default). Tune this with `FEATURE_HARVEST_SPLIT_MESSAGE_THRESHOLD`/`FEATURE_HARVEST_SPLIT_MESSAGE_SIZE` and `FEATURE_HARVEST_SPLIT_FEATURE_THRESHOLD`/`FEATURE_HARVEST_SPLIT_FEATURE_SIZE`.
- Need to clamp a single noisy branch harder? Set `FEATURE_HARVEST_SPLIT_OVERRIDES` to a JSON object keyed by `tabId`, `tabId:<id>`, `title:<substring>`, or `url:<substring>` with per-branch knobs:
  ```powershell
  $env:FEATURE_HARVEST_SPLIT_OVERRIDES = '{"tabId:F4DE889B...":{"messageSize":32,"featureSize":40}}'
  ```
- Coverage remediation reruns any failing branches with splitting disabled and an expanded token cap (`FEATURE_HARVEST_REMEDIATION_MULTIPLIER`, default `3`). Each rerun now writes a Markdown dossier under `runs/feature-harvest/<date>/remediation/coverage-<tabId>.md` summarizing before/after coverage, dropped unique credits, and the unique highlights that were salvaged, so you can review gaps without digging through JSON logs.
- Coverage guardrails short-circuit once each base conversation has retained a capped number of “unique credits.” Tune this via `FEATURE_HARVEST_COVERAGE_CAP` (default `80`) if you need more or fewer per-branch credits before the 70 % threshold is evaluated.

Integrate the entry point `runFeatureHarvestMerge` (see `src/merger/featureHarvestMerge.ts`) into bespoke workflows or CLI prototypes to exercise the new pipeline before it replaces the legacy OpenAI “winner/loser” merge.

**Try it:** `npm run merge -- --input snapshots/autopilot-latest.json --harvest` will load the snapshot, run the feature-harvest merger, print the synthesized summary, display guardrail stats (token estimates + coverage ratios), and automatically render a UI-friendly report at `runs/feature-harvest/harvest-report.html` so you can review scientist findings without parsing JSON.

- Pilot batches log telemetry + scientist payloads to `runs/feature-harvest/<date>/batch-*.json` (override path via `FEATURE_HARVEST_LOG_DIR`).
- Toggle the scientist reviewer without code changes by setting `FEATURE_HARVEST_SCIENTIST=off` (or `on`) before running pilot batches.

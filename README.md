## Chat Thread Merger

Collect the content of multiple ChatGPT browser tabs and synthesize them into a single, decision-aware narrative using the OpenAI API. The tool connects to Chrome via the DevTools protocol, harvests the active ChatGPT windows you already have open, and then runs a merge pass that:

- surfaces highlights from each branch,
- resolves conflicts by picking the best idea (or explaining why),
- rewrites everything into a unified path, and
- suggests follow-up threads that would extend the work.

### Quick start

1. Launch Chrome with the remote debugging port enabled (required for reading tab content):

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

2. Install dependencies and build:

```bash
npm install
npm run build
```

3. Set your OpenAI key (or pass `OPENAI_API_KEY` inline when running):

```bash
$env:OPENAI_API_KEY = "sk-..."
```

4. Run the merger (defaults assume Chrome on `127.0.0.1:9222`):

```bash
npm start -- --verbose --save-snapshot snapshots/latest.json
```

The CLI prints a summary, the recombined path, the merge decisions, and optional follow-up ideas.

### CLI flags

| Flag | Description |
| --- | --- |
| `--host`, `--port` | Chrome DevTools host/port (`127.0.0.1:9222` by default). |
| `--include <regex>` | Limit collection to URLs matching the regex (repeatable). |
| `--from-file <path>` | Skip Chrome; load a saved JSON snapshot instead. |
| `--save-snapshot <path>` | Persist the harvested tabs for later re-runs (pairs well with `--dry-run`). |
| `--model <name>` | OpenAI model to call (`gpt-4.1-mini` default). |
| `--provider <name>` | Provider preset (`openai`, `openrouter`, or `custom`), tweaking base URLs + auth env vars. |
| `--api-base <url>` | Override the OpenAI-compatible base URL (useful for self-hosted proxies). |
| `--api-key`, `--api-key-env <VAR>` | Provide a key inline or point at the env var storing it (`OPENAI_API_KEY` default). |
| `--api-header <k=v>` | Repeatable flag for injecting custom HTTP headers to the model provider. |
| `--max-branch-highlights <n>` | Cap how many messages per branch feed into the merge (defaults to 12; set <=0 to include all). |
| `--temperature <0-1>` | Sampling temperature (default 0.2). |
| `--dry-run` | Collect tabs but skip the OpenAI call. |
| `--verbose` | Extra logging for Chrome connection + snapshots. |
| `--note-path <path>` | Append each merge result to a Markdown notebook (great for Obsidian/Notion sync). |
| `--tasks-path <path>` | Append follow-up ideas as JSON tasks; pair with `--task-source` to tag the origin. |
| `--notion-database-id`, `--notion-token-env` | Sync each merge as a Notion page (token env defaults to `NOTION_API_KEY`). |
| `--todoist-project-id`, `--todoist-token-env` | Send follow-up ideas directly into Todoist (token env defaults to `TODOIST_API_KEY`). |
| `--todoist-priority`, `--todoist-due-string` | Control priority (1-4) and natural language due date for Todoist tasks. |
| `--auto-chatgpt` | After a merge completes, paste/send the merged narrative into an open ChatGPT window automatically. |
| `--chatgpt-mode <auto|confirm>` | Choose whether the helper sends immediately (`auto`) or waits for you to press Enter before sending (`confirm`). |
| `--chatgpt-python <path>`, `--chatgpt-script <path>` | Override the Python executable or helper script (`scripts/post_to_chatgpt.py`) that drives ChatGPT automation. |
| `--bookmark-folder <name>` | Load bookmarked ChatGPT thread URLs from the named Chrome folder (repeatable). |
| `--bookmark-profile <name>` | Chrome profile directory that contains the `Bookmarks` file (`Default`). |
| `--bookmark-path <path>` | Explicit path to a `Bookmarks` JSON file (overrides `--bookmark-profile`). |
| `--bookmark-cache <path>` | Write the resolved bookmark entries to this JSON file for debugging. |
| `--bookmark-case-sensitive` | Match bookmark folder names case-sensitively. |
| `--bookmark-keep-tabs` | Keep temporary tabs opened from bookmark URLs alive after extraction. |

### Workflow tips

- **Chrome setup**: Remote debugging must stay enabled for the duration of the capture. If the command above conflicts with an existing Chrome session, close instances before relaunching with the flag.
- **Snapshots**: Use `--save-snapshot` to archive the raw conversations from a session, then iterate on prompts or models later via `--from-file`.
- **Branch focusing**: Adjust `--max-branch-highlights` to keep the merge lightweight (e.g., 6) or exhaustive (0/negative for all turns).
- **Model control**: The project defaults to an OpenAI model, but the code is structured so you can drop in alternative API calls or local model integrations inside `src/openaiMerge.ts`.
- **Notetaking + tasks**: Point `--note-path notes/threads.md` to append rich Markdown summaries after each merge. Use `--tasks-path data/tasks.json --task-source chatgpt-window` to push the follow-up ideas into any automation you can run on that JSON.
- **Remote sinks**: Set `--notion-database-id <id>` once per workspace and ensure `NOTION_API_KEY` is present to publish a structured note with highlights + links back to each branch. Likewise, pass `--todoist-project-id 123456789` (with `TODOIST_API_KEY`) to drop follow-up ideas directly into Todoist.
- **Provider presets**: Switch to OpenRouter via `--provider openrouter --model openrouter/mistral-7b-instruct` or point at a proxy you host via `--provider custom --api-base https://llm.mycompany.com/v1`.

### Remote integrations

- **Notion**: Provide `--notion-database-id` (and optional `--notion-title-prop`, `--notion-summary-prop`). The CLI pulls the token from `NOTION_API_KEY` (override with `--notion-token-env`) and appends a page per merge containing the summary, combined path, follow-up ideas, and linked source branches.
- **Todoist**: Use `--todoist-project-id`, ensure `TODOIST_API_KEY` is set (or override via `--todoist-token-env`), and optionally tweak `--todoist-priority` / `--todoist-due-string`. Every follow-up idea becomes a new Todoist task with the project, priority, due string, and a short source label.

### ChatGPT automation (optional)

Want the merged narrative to appear inside a brand-new ChatGPT conversation automatically? Install the Python helper and Playwright once per machine:

```bash
pip install playwright
playwright install chromium
```

Then launch Chrome with remote debugging enabled (same as the collector step), stay logged into ChatGPT in that session, and run:

```bash
npm start -- --auto-chatgpt --chatgpt-mode confirm
```

`--auto-chatgpt` enables the helper script (`scripts/post_to_chatgpt.py`). It attaches to the same Chrome instance via DevTools, opens a new chat, pastes the merged narrative, and either sends it immediately (`--chatgpt-mode auto`) or waits for you to press Enter in the terminal (`--chatgpt-mode confirm`). Keep usage aligned with ChatGPT’s terms of service—automation only touches your own logged-in browser profile and never transmits credentials.

### Bookmark folders (optional)

If you keep canonical ChatGPT threads in a Chrome bookmarks folder (e.g., “Digital Nomad”), point the CLI at it instead of manually opening tabs:

```bash
npm start -- --bookmark-folder "Digital Nomad" --bookmark-profile Default --save-snapshot snapshots/nomad.json
```

What happens:

1. The CLI parses Chrome’s `Bookmarks` JSON (either from the given profile or an explicit `--bookmark-path`).
2. It logs how many URLs were found and (optionally) writes them to `--bookmark-cache bookmarks.json` so you can inspect/refine the set.
3. Each bookmarked URL is opened via the DevTools protocol, scraped just like a live tab, and (unless you pass `--bookmark-keep-tabs`) the temporary tab is closed afterward.
4. The rest of the pipeline (OpenAI merge, snapshots, sinks, automation) behaves exactly the same.

Matching is case-insensitive by default; add `--bookmark-case-sensitive` if you need strict folder-name matches.


### Testing

Unit tests cover the DOM extraction helper (to guard future ChatGPT UI tweaks) and the merge-response parser. Run them with:

```bash
npm test
```

### Next steps

- Add automated tests around the DOM extraction script using fixture HTML.
- Support authentication/cookies for future services beyond ChatGPT.
- Pipe outputs into a note-taking app (e.g., Obsidian, Notion) for archival.

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

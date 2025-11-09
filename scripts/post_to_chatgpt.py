#!/usr/bin/env python3
"""
Post merged ChatGPT narratives back into an open ChatGPT tab via Playwright.

The script expects JSON payload data on stdin. It attaches to the Chrome
instance already running with the remote debugging port enabled and injects
the merged content into a new ChatGPT conversation.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass
from typing import Any, Dict, List
from pathlib import Path

try:
  from playwright.async_api import (  # type: ignore import-not-found
    Error as PlaywrightError,
    Browser,
    Page,
    async_playwright,
  )
except ImportError as exc:  # pragma: no cover - import guard
  raise SystemExit(
      "Missing dependency: playwright. Install it with 'pip install playwright' "
      "and run 'playwright install chromium'.",
  ) from exc


CHATGPT_URL = "https://chatgpt.com/"
TEXTAREA_SELECTORS = [
    "[data-testid='prompt-textarea'] textarea",
    "textarea[data-testid='prompt-textarea']",
    "textarea[placeholder*='Send a message']",
    "textarea",
]
CONTENTEDITABLE_SELECTORS = [
    "[data-testid='prompt-textarea'] div[contenteditable='true']",
    "div[contenteditable='true'][data-placeholder]",
]
SEND_BUTTON_SELECTORS = [
    "[data-testid='send-button']",
    "button:has-text('Send')",
]
NEW_CHAT_SELECTORS = [
    "[data-testid='new-chat-button']",
    "a[href='/'] >> text=New chat",
    "button:has-text('New chat')",
]


class AutomationError(Exception):
  """Raised when the ChatGPT automation flow fails."""


@dataclass
class Payload:
  message: str
  summary: str
  combinedPath: List[str]
  mergeDecisions: List[Dict[str, Any]]
  followUpIdeas: List[str]
  branches: List[Dict[str, Any]]
  generatedAt: str


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="Send merged text to ChatGPT.")
  parser.add_argument(
      "--mode",
      choices=("auto", "confirm"),
      default="auto",
      help="Automation mode.",
  )
  parser.add_argument(
      "--cdp-host",
      default="127.0.0.1",
      help="Chrome DevTools host.",
  )
  parser.add_argument(
      "--cdp-port",
      type=int,
      default=9222,
      help="Chrome DevTools port.",
  )
  parser.add_argument(
      "--payload",
      help="Path to a JSON payload file (falls back to stdin when omitted).",
  )
  return parser.parse_args()


def read_payload(path: str | None) -> Payload:
  if path:
    try:
      raw = Path(path).read_text(encoding="utf-8").strip()
    except OSError as exc:
      raise AutomationError(f"Unable to read payload file {path}: {exc}") from exc
  else:
    if sys.stdin.isatty():
      raise AutomationError("Expected JSON payload on stdin or provide --payload.")
    raw = sys.stdin.read().strip()
  if not raw:
    raise AutomationError("No payload data supplied for ChatGPT automation.")
  data = json.loads(raw)
  if "message" not in data or not isinstance(data["message"], str):
    raise AutomationError("Payload missing required 'message' field.")
  return Payload(
      message=data["message"],
      summary=data.get("summary", ""),
      combinedPath=list(data.get("combinedPath", [])),
      mergeDecisions=list(data.get("mergeDecisions", [])),
      followUpIdeas=list(data.get("followUpIdeas", [])),
      branches=list(data.get("branches", [])),
      generatedAt=data.get("generatedAt", ""),
  )


async def main() -> None:
  args = parse_args()
  payload = read_payload(args.payload)
  await run_automation(args, payload)


async def run_automation(args: argparse.Namespace, payload: Payload) -> None:
  endpoint = f"http://{args.cdp_host}:{args.cdp_port}"
  async with async_playwright() as playwright:
    browser = await playwright.chromium.connect_over_cdp(endpoint)
    try:
      page = await select_chatgpt_page(browser)
      await prepare_chat(page)
      await begin_new_chat(page)
      await inject_message(page, payload.message)
      if args.mode == "confirm":
        print(
            "Message pasted into ChatGPT. Review it, then press Enter here to send "
            "or Ctrl+C to abort.",
        )
        input()
      await send_message(page)
      print("ChatGPT automation complete.")
    finally:
      await browser.close()


async def select_chatgpt_page(browser: Browser) -> Page:
  pages: List[Page] = []
  for context in browser.contexts:
    pages.extend(context.pages)
  for page in pages:
    if "chatgpt.com" in page.url.lower():
      await page.bring_to_front()
      return page
  if pages:
    page = pages[0]
    await page.bring_to_front()
    await page.goto(CHATGPT_URL, wait_until="domcontentloaded")
    return page
  if browser.contexts:
    context = browser.contexts[0]
  else:
    context = await browser.new_context()
  page = await context.new_page()
  await page.goto(CHATGPT_URL, wait_until="domcontentloaded")
  return page


async def prepare_chat(page: Page) -> None:
  if "chatgpt.com" not in page.url.lower():
    await page.goto(CHATGPT_URL, wait_until="domcontentloaded")
  else:
    await page.wait_for_load_state("domcontentloaded")


async def begin_new_chat(page: Page) -> None:
  for selector in NEW_CHAT_SELECTORS:
    locator = page.locator(selector).first
    try:
      if await locator.count():
        await locator.click(timeout=1500)
        await page.wait_for_timeout(300)
        return
    except PlaywrightError:
      continue
  # Fallback: reload to force a clean chat session.
  await page.goto(CHATGPT_URL, wait_until="domcontentloaded")


async def inject_message(page: Page, text: str) -> None:
  selectors = TEXTAREA_SELECTORS + CONTENTEDITABLE_SELECTORS
  last_error: PlaywrightError | None = None
  for selector in selectors:
    locator = page.locator(selector).first
    try:
      if not await locator.count():
        continue
      await locator.scroll_into_view_if_needed()
      await locator.click(timeout=1500)
      await locator.fill(text)
      # Verify that the input actually contains content. Contenteditables do not
      # support input_value(), so read textContent when needed.
      has_value = await locator.evaluate(
          "(el) => ('value' in el ? el.value : (el.textContent || '')).trim().length > 0",
      )
      if has_value:
        return
    except PlaywrightError as exc:
      last_error = exc
      continue
  raise AutomationError(
      "Unable to locate or fill the ChatGPT message box."
      + (f" Last error: {last_error}" if last_error else ""),
  )


async def send_message(page: Page) -> None:
  for selector in SEND_BUTTON_SELECTORS:
    locator = page.locator(selector).first
    try:
      if await locator.count():
        await locator.click(timeout=1500)
        return
    except PlaywrightError:
      continue
  await page.keyboard.press("Enter")


if __name__ == "__main__":
  try:
    asyncio.run(main())
  except AutomationError as error:
    print(f"[chatgpt-automation] {error}", file=sys.stderr)
    sys.exit(1)
  except KeyboardInterrupt:
    sys.exit(1)

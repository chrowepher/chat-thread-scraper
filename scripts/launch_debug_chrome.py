#!/usr/bin/env python3
"""
Helper to launch Google Chrome with the DevTools remote debugging port enabled.

The script mirrors the manual instruction from the README but automates:
1. Locating the Chrome binary (or honoring --chrome-path);
2. Re-using the user's profile directory so ChatGPT stays logged in; and
3. Waiting until the DevTools websocket endpoint is reachable.
"""

from __future__ import annotations

import argparse
import os
import shlex
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterable, List

DEFAULT_PORT = 9222
DEFAULT_HOST = "127.0.0.1"


def default_chrome_candidates() -> List[str]:
  if sys.platform.startswith("win"):
    local_app = os.environ.get("LOCALAPPDATA", "")
    program_files = os.environ.get("PROGRAMFILES", r"C:\Program Files")
    program_files_x86 = os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
    return [
        rf"{program_files}\Google\Chrome\Application\chrome.exe",
        rf"{program_files_x86}\Google\Chrome\Application\chrome.exe",
        rf"{local_app}\Google\Chrome\Application\chrome.exe",
    ]
  if sys.platform == "darwin":
    return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        str(Path.home() / "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ]
  return [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
  ]


def default_user_data_dir() -> Path:
  home = Path.home()
  if sys.platform.startswith("win"):
    local_app = os.environ.get("LOCALAPPDATA")
    base = Path(local_app) if local_app else home / "AppData" / "Local"
    return base / "Google" / "Chrome" / "User Data"
  if sys.platform == "darwin":
    return home / "Library" / "Application Support" / "Google" / "Chrome"
  return home / ".config" / "google-chrome"


def resolve_chrome_path(explicit_path: str | None) -> Path:
  candidates: Iterable[str] = []
  if explicit_path:
    candidates = [explicit_path]
  else:
    candidates = default_chrome_candidates()

  for candidate in candidates:
    expanded = Path(os.path.expandvars(os.path.expanduser(candidate)))
    if expanded.is_file():
      return expanded
  message = (
      "Unable to locate the Google Chrome executable. "
      "Pass --chrome-path <path-to-chrome>."
  )
  raise SystemExit(message)


def wait_for_devtools(host: str, port: int, timeout: float) -> bool:
  """Poll the DevTools /json/version endpoint until it responds or timeout hits."""
  url = f"http://{host}:{port}/json/version"
  deadline = time.monotonic() + timeout
  while time.monotonic() < deadline:
    try:
      with urllib.request.urlopen(url, timeout=0.5) as response:
        if response.status == 200:
          return True
    except (urllib.error.URLError, TimeoutError, socket.timeout):
      time.sleep(0.25)
  return False


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(
      description="Launch Chrome with --remote-debugging-port for chat-thread-merger.",
  )
  parser.add_argument(
      "--chrome-path",
      dest="chrome_path",
      help="Path to the Chrome executable (auto-detected if omitted).",
  )
  parser.add_argument(
      "--port",
      type=int,
      default=DEFAULT_PORT,
      help=f"DevTools port to expose (default {DEFAULT_PORT}).",
  )
  parser.add_argument(
      "--host",
      default=DEFAULT_HOST,
      help=f"DevTools host to probe when waiting (default {DEFAULT_HOST}).",
  )
  parser.add_argument(
      "--user-data-dir",
      dest="user_data_dir",
      help="Directory for Chrome profile data (defaults to your standard profile).",
  )
  parser.add_argument(
      "--profile-directory",
      dest="profile_directory",
      default="Default",
      help='Profile directory name to reuse (default "Default").',
  )
  parser.add_argument(
      "--timeout",
      type=float,
      default=10.0,
      help="Seconds to wait for DevTools to become ready.",
  )
  parser.add_argument(
      "--no-wait",
      dest="no_wait",
      action="store_true",
      help="Skip waiting for DevTools readiness (fire-and-forget).",
  )
  parser.add_argument(
      "--chrome-flag",
      dest="chrome_flags",
      action="append",
      default=[],
      help="Additional flag to pass through to Chrome (repeatable).",
  )
  parser.add_argument(
      "--verbose",
      action="store_true",
      help="Print the resolved command and readiness state.",
  )
  return parser.parse_args()


def main() -> int:
  args = parse_args()
  chrome_path = resolve_chrome_path(args.chrome_path)
  user_data_dir = Path(
      args.user_data_dir,
  ) if args.user_data_dir else default_user_data_dir()
  user_data_dir.mkdir(parents=True, exist_ok=True)

  command = [
      str(chrome_path),
      f"--remote-debugging-port={args.port}",
      f"--user-data-dir={user_data_dir}",
      f"--profile-directory={args.profile_directory}",
  ]
  command.extend(args.chrome_flags or [])

  env = os.environ.copy()
  if args.verbose:
    printable = " ".join(shlex.quote(part) for part in command)
    print(f"Launching Chrome: {printable}")

  try:
    process = subprocess.Popen(command, env=env)
  except FileNotFoundError as exc:
    raise SystemExit(f"Failed to launch Chrome: {exc}") from exc

  if args.no_wait:
    print(
        f"Chrome launched (PID {process.pid}) with DevTools on {args.host}:{args.port}.",
    )
    return 0

  if wait_for_devtools(args.host, args.port, args.timeout):
    print(
        f"Chrome DevTools ready on {args.host}:{args.port} (PID {process.pid}).",
    )
    return 0

  print(
      "Chrome launched but the DevTools endpoint did not respond within "
      f"{args.timeout} seconds.",
      file=sys.stderr,
  )
  return 1


if __name__ == "__main__":
  raise SystemExit(main())

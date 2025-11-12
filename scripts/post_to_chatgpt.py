#!/usr/bin/env python3
"""
Run replicated critiques between two outputs and aggregate scorecards.

Usage example:

python scripts/post_to_chatgpt.py \
  --left runs/final/recombined.md \
  --right runs/t2_champion/recombined.md \
  --prompt prompts/compare_threads.md \
  --replicates 3 \
  --temperature 0 \
  --out-markdown runs/exp-01/critique.md \
  --out-scorecard runs/exp-01/scorecard.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
  from openai import OpenAI
except ImportError as exc:  # pragma: no cover - dependency hint
  raise SystemExit(
      'The "openai" Python package is required. Install with "pip install openai".'
  ) from exc

DEFAULT_MODEL = 'gpt-4.1-mini'


@dataclass
class CriterionSample:
  name: str
  left: Optional[float]
  right: Optional[float]
  rationale: Optional[str]


@dataclass
class ReplicateResult:
  index: int
  winner: Optional[str]
  summary_markdown: Optional[str]
  criteria: List[CriterionSample]
  raw: Dict[str, Any]
  token_usage: Dict[str, Any]


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description='Run replicated critiques via OpenAI.')
  parser.add_argument('--left', required=True, help='Path to the LEFT candidate file.')
  parser.add_argument('--right', required=True, help='Path to the RIGHT candidate file.')
  parser.add_argument('--prompt', required=True, help='System prompt file for the critique.')
  parser.add_argument(
      '--replicates',
      type=int,
      default=3,
      help='Number of replicate critiques to run (default: 3).',
  )
  parser.add_argument(
      '--temperature',
      type=float,
      default=0.0,
      help='Sampling temperature for the critique model (default: 0).',
  )
  parser.add_argument(
      '--model',
      default=DEFAULT_MODEL,
      help=f'Model to use (default: {DEFAULT_MODEL}).',
  )
  parser.add_argument(
      '--api-base',
      default=None,
      help='Optional alternative API base URL.',
  )
  parser.add_argument(
      '--api-key',
      default=None,
      help='Explicit API key (otherwise uses env var).',
  )
  parser.add_argument(
      '--api-key-env',
      default='OPENAI_API_KEY',
      help='Environment variable containing the API key (default: OPENAI_API_KEY).',
  )
  parser.add_argument(
      '--out-markdown',
      default=None,
      help='Where to write the Markdown summary.',
  )
  parser.add_argument(
      '--out-scorecard',
      default=None,
      help='Where to write the machine-readable scorecard JSON.',
  )
  return parser.parse_args()


def read_text(path: str) -> str:
  return Path(path).read_text(encoding='utf-8').strip()


def build_messages(system_prompt: str, left: str, right: str) -> List[Dict[str, str]]:
  user_payload = (
      "You will critique two candidates.\n\n"
      "=== LEFT CANDIDATE ===\n"
      f"{left}\n\n"
      "=== RIGHT CANDIDATE ===\n"
      f"{right}\n\n"
      "Return JSON with keys:\n"
      "- winner: left|right|tie\n"
      "- summary_markdown: markdown summary of contrast\n"
      "- criteria: list of {name, left, right, rationale}\n"
      "Numeric scores should be comparable (e.g., 0-1 or 0-10)."
  )
  return [
      {'role': 'system', 'content': system_prompt},
      {'role': 'user', 'content': user_payload},
  ]


def run_replicate(
    client: OpenAI,
    model: str,
    temperature: float,
    messages: List[Dict[str, str]],
) -> ReplicateResult:
  completion = client.chat.completions.create(
      model=model,
      temperature=temperature,
      response_format={'type': 'json_object'},
      messages=messages,
  )
  content = completion.choices[0].message.content
  if not content:
    raise RuntimeError('Empty response received from critique model.')
  try:
    payload = json.loads(content)
  except json.JSONDecodeError as exc:
    raise RuntimeError(f'Critique response was not valid JSON: {content[:200]}') from exc

  criteria_payload = payload.get('criteria') or []
  criteria = []
  for item in criteria_payload:
    if not isinstance(item, dict):
      continue
    criteria.append(
        CriterionSample(
            name=str(item.get('name', 'unnamed')),
            left=_to_float(item.get('left')),
            right=_to_float(item.get('right')),
            rationale=item.get('rationale') or item.get('notes'),
        ),
    )

  token_usage = {}
  if completion.usage:
    if hasattr(completion.usage, 'model_dump'):
      token_usage = completion.usage.model_dump()
    elif hasattr(completion.usage, 'to_dict'):
      token_usage = completion.usage.to_dict()
    else:
      token_usage = dict(completion.usage)  # type: ignore[arg-type]

  result = ReplicateResult(
      index=0,
      winner=payload.get('winner'),
      summary_markdown=payload.get('summary_markdown'),
      criteria=criteria,
      raw=payload,
      token_usage=token_usage,
  )
  return result


def _to_float(value: Any) -> Optional[float]:
  if isinstance(value, (int, float)):
    return float(value)
  try:
    return float(value)
  except (TypeError, ValueError):
    return None


def aggregate_criteria(
    replicates: List[ReplicateResult],
) -> Dict[str, Dict[str, Dict[str, float]]]:
  bucket: Dict[str, Dict[str, List[float]]] = {}
  for replicate in replicates:
    for crit in replicate.criteria:
      entry = bucket.setdefault(crit.name, {'left': [], 'right': [], 'delta': []})
      if crit.left is not None:
        entry['left'].append(crit.left)
      if crit.right is not None:
        entry['right'].append(crit.right)
      if crit.left is not None and crit.right is not None:
        entry['delta'].append(crit.right - crit.left)

  aggregate: Dict[str, Dict[str, Dict[str, float]]] = {}
  for name, samples in bucket.items():
    aggregate[name] = {}
    for field, values in samples.items():
      if not values:
        continue
      mean, ci = _mean_ci(values)
      aggregate[name][field] = {
          'mean': mean,
          'ci95': ci,
          'replicates': len(values),
      }
  return aggregate


def _mean_ci(values: List[float]) -> Tuple[float, float]:
  mean = statistics.fmean(values)
  if len(values) < 2:
    return mean, 0.0
  stdev = statistics.stdev(values)
  ci = 1.96 * stdev / math.sqrt(len(values))
  return mean, ci


def write_markdown(
    path: str,
    replicates: List[ReplicateResult],
    aggregate: Dict[str, Dict[str, Dict[str, float]]],
    model: str,
    temperature: float,
) -> None:
  lines = []
  lines.append(f'# Critique Summary')
  lines.append('')
  lines.append(f'- Model: `{model}`')
  lines.append(f'- Temperature: {temperature}')
  lines.append(f'- Replicates: {len(replicates)}')
  winner_counts = _winner_histogram(replicates)
  lines.append(
      '- Winners: ' + ', '.join(f'{key}={value}' for key, value in winner_counts.items()),
  )
  lines.append('')
  if aggregate:
    lines.append('## Aggregate Criteria')
    lines.append('| Criterion | Left (mean ± CI) | Right (mean ± CI) | Δ (Right-Left) |')
    lines.append('| --- | --- | --- | --- |')
    for name, stats in aggregate.items():
      left = stats.get('left')
      right = stats.get('right')
      delta = stats.get('delta')
      lines.append(
          f'| {name} | {format_stat(left)} | {format_stat(right)} | {format_stat(delta)} |',
      )
    lines.append('')

  for idx, replicate in enumerate(replicates, start=1):
    lines.append(f'## Replicate {idx}')
    lines.append(f'- Winner: **{replicate.winner or "n/a"}**')
    if replicate.summary_markdown:
      lines.append('')
      lines.append(replicate.summary_markdown.strip())
      lines.append('')
    if replicate.criteria:
      lines.append('| Criterion | Left | Right | Notes |')
      lines.append('| --- | --- | --- | --- |')
      for crit in replicate.criteria:
        rationale = crit.rationale or ''
        lines.append(
            f'| {crit.name} | {format_value(crit.left)} | {format_value(crit.right)} | {rationale} |',
        )
      lines.append('')
  Path(path).parent.mkdir(parents=True, exist_ok=True)
  Path(path).write_text('\n'.join(lines), encoding='utf-8')


def format_stat(entry: Optional[Dict[str, float]]) -> str:
  if not entry:
    return '—'
  mean = entry['mean']
  ci = entry['ci95']
  return f'{mean:.3f} ± {ci:.3f}'


def format_value(value: Optional[float]) -> str:
  if value is None:
    return '—'
  return f'{value:.3f}'


def _winner_histogram(replicates: List[ReplicateResult]) -> Dict[str, int]:
  histogram: Dict[str, int] = {'left': 0, 'right': 0, 'tie': 0, 'unknown': 0}
  for replicate in replicates:
    winner = (replicate.winner or '').lower()
    if winner in histogram:
      histogram[winner] += 1
    else:
      histogram['unknown'] += 1
  return {key: val for key, val in histogram.items() if val}


def write_scorecard(
    path: str,
    replicates: List[ReplicateResult],
    aggregate: Dict[str, Dict[str, Dict[str, float]]],
    model: str,
    temperature: float,
) -> None:
  payload = {
      'model': model,
      'temperature': temperature,
      'replicate_count': len(replicates),
      'aggregate': aggregate,
      'replicates': [
          {
              'index': idx,
              'winner': replicate.winner,
              'criteria': [
                  {
                      'name': crit.name,
                      'left': crit.left,
                      'right': crit.right,
                      'rationale': crit.rationale,
                  }
                  for crit in replicate.criteria
              ],
              'summary_markdown': replicate.summary_markdown,
              'raw': replicate.raw,
              'token_usage': replicate.token_usage,
          }
          for idx, replicate in enumerate(replicates, start=1)
      ],
  }
  Path(path).parent.mkdir(parents=True, exist_ok=True)
  Path(path).write_text(json.dumps(payload, indent=2), encoding='utf-8')


def main() -> None:
  args = parse_args()
  api_key = args.api_key or os.getenv(args.api_key_env)
  if not api_key:
    raise SystemExit(
        f'No API key provided. Use --api-key or set the {args.api_key_env} environment variable.',
    )

  client = OpenAI(api_key=api_key, base_url=args.api_base)
  left_text = read_text(args.left)
  right_text = read_text(args.right)
  system_prompt = read_text(args.prompt)
  messages = build_messages(system_prompt, left_text, right_text)

  replicates: List[ReplicateResult] = []
  for idx in range(1, args.replicates + 1):
    print(f'Running critique replicate {idx}/{args.replicates}...', file=sys.stderr)
    replicate = run_replicate(
        client=client,
        model=args.model,
        temperature=args.temperature,
        messages=messages,
    )
    replicate.index = idx
    replicates.append(replicate)

  aggregate = aggregate_criteria(replicates)
  if args.out_markdown:
    write_markdown(args.out_markdown, replicates, aggregate, args.model, args.temperature)
    print(f'Wrote Markdown summary to {args.out_markdown}', file=sys.stderr)
  if args.out_scorecard:
    write_scorecard(args.out_scorecard, replicates, aggregate, args.model, args.temperature)
    print(f'Wrote scorecard JSON to {args.out_scorecard}', file=sys.stderr)


if __name__ == '__main__':
  main()

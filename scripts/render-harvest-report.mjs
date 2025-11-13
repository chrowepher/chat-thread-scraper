#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HARVEST_ROOT = path.resolve('runs', 'feature-harvest');
const OUTPUT_PATH = path.resolve(HARVEST_ROOT, 'harvest-report.html');

const ensureDirExists = (dirPath) => {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Directory not found: ${dirPath}`);
  }
};

const pickLatestEntry = (entries) => {
  if (!entries.length) {
    throw new Error('No harvest batches found.');
  }
  return entries
    .map((entry) => ({
      name: entry,
      mtime: fs.statSync(entry).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)[0].name;
};

const formatPercent = (value) =>
  `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;

const formatCount = ( kept, total ) => `${kept}/${total}`;

const readLatestBatch = () => {
  ensureDirExists(HARVEST_ROOT);
  const dateDirs = fs
    .readdirSync(HARVEST_ROOT)
    .map((name) => path.join(HARVEST_ROOT, name))
    .filter((entry) => fs.statSync(entry).isDirectory());

  const latestDateDir = pickLatestEntry(dateDirs);
  const batchFiles = fs
    .readdirSync(latestDateDir)
    .map((name) => path.join(latestDateDir, name))
    .filter(
      (entry) =>
        fs.statSync(entry).isFile() &&
        path.basename(entry).startsWith('batch-') &&
        path.extname(entry) === '.json',
    );

  const latestBatchPath = pickLatestEntry(batchFiles);
  const raw = fs.readFileSync(latestBatchPath, 'utf-8');
  const data = JSON.parse(raw);
  return { data, batchPath: latestBatchPath };
};

const buildHtml = ({
  batchPath,
  scientist,
  merge,
  guardrails,
  lowCoverageSegments,
  aggregatedRows,
}) => {
  const compression = guardrails.compression ?? {};
  const formatRecommendations = () =>
    scientist?.recommendations
      ?.map((rec) => `<li>${rec}</li>`)
      .join('\n') || '<li>No follow-ups recorded.</li>';

  const lowCoverageTable = lowCoverageSegments.length
    ? `<table>
    <thead>
      <tr>
        <th>Segment ID</th>
        <th>Unique Coverage</th>
        <th>Kept/Total</th>
      </tr>
    </thead>
    <tbody>
      ${lowCoverageSegments
        .map(
          ({ id, stats }) => `<tr>
        <td><code>${id}</code></td>
        <td>${formatPercent(stats.uniqueFraction)}</td>
        <td>${formatCount(stats.uniqueKept, stats.uniqueTotal)}</td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>`
    : '<p class="ok">All segments meet the minimum coverage threshold.</p>';

  const aggregatedTable = `<table>
    <thead>
      <tr>
        <th>Conversation</th>
        <th>Unique Coverage</th>
        <th>Kept/Total</th>
      </tr>
    </thead>
    <tbody>
      ${aggregatedRows
        .map(
          ({ id, stats }) => `<tr>
        <td><code>${id}</code></td>
        <td>${formatPercent(stats.uniqueFraction)}</td>
        <td>${formatCount(stats.uniqueKept, stats.uniqueTotal)}</td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Feature Harvest Report</title>
  <style>
    :root {
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      color: #0f172a;
      background: #f8fafc;
    }
    body {
      margin: 0;
      padding: 2rem;
      line-height: 1.4;
    }
    h1, h2, h3 {
      margin-top: 0;
      color: #0f172a;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      padding: 1.5rem;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
      margin-bottom: 1.5rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1rem;
    }
    .metric {
      font-size: 0.9rem;
      color: #475569;
    }
    .metric strong {
      display: block;
      font-size: 1.2rem;
      color: #0f172a;
      margin-top: 0.25rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 1rem;
    }
    th, td {
      text-align: left;
      padding: 0.5rem;
      border-bottom: 1px solid #e2e8f0;
    }
    th {
      background: #f1f5f9;
      font-weight: 600;
    }
    code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      background: #e2e8f0;
      padding: 0.1rem 0.3rem;
      border-radius: 4px;
    }
    .ok {
      color: #15803d;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <h1>Feature Harvest Quality Report</h1>
  <div class="card">
    <p><strong>Batch file:</strong> <code>${path.relative(
      process.cwd(),
      batchPath,
    )}</code></p>
    <p><strong>Scientist verdict:</strong> ${
      scientist?.verdict ?? 'n/a'
    } · Fidelity ${scientist?.fidelity_score ?? 'n/a'} · Completeness ${
      scientist?.completeness_score ?? 'n/a'
    } · Risk ${scientist?.risk_score ?? 'n/a'}</p>
    <h3>Recommendations</h3>
    <ul>${formatRecommendations()}</ul>
  </div>

  <div class="card">
    <h2>Guardrail Snapshot</h2>
    <div class="grid">
      <div class="metric">
        Tokens (initial)
        <strong>${guardrails.initialTokenEstimate.toLocaleString()}</strong>
      </div>
      <div class="metric">
        Tokens (final)
        <strong>${guardrails.tokenEstimate.toLocaleString()}</strong>
      </div>
      <div class="metric">
        Canonical features
        <strong>${merge.canonicalCount}</strong>
      </div>
      <div class="metric">
        Unique features
        <strong>${merge.uniqueCount}</strong>
      </div>
      <div class="metric">
        Alternates
        <strong>${merge.alternateCount}</strong>
      </div>
    </div>
    <p>Compression: ${
      compression.applied ? 'yes' : 'no'
    } · Truncated: ${compression.truncatedFeatures ?? 0} · Uniques dropped: ${
    compression.droppedUniques ?? 0
  }</p>
  </div>

  <div class="card">
    <h2>Segments Under Threshold</h2>
    ${lowCoverageTable}
  </div>

  <div class="card">
    <h2>Aggregated Coverage</h2>
    <p>Each row shows the parent conversation after combining all split segments.</p>
    ${aggregatedTable}
  </div>
</body>
</html>`;
};

const main = () => {
  const { data, batchPath } = readLatestBatch();
  const merge = data.mergeResults?.[0];
  if (!merge) {
    throw new Error('No merge result found in the latest batch.');
  }

  const scientist =
    data.scientistVerdict && typeof data.scientistVerdict === 'string'
      ? JSON.parse(data.scientistVerdict)
      : data.scientistVerdict ?? null;

  const guardrails = merge.guardrails ?? {};
  const coverage = guardrails.coverage ?? {};
  const aggregated = guardrails.coverageAggregates ?? coverage;
  const minFraction =
    data.config?.guardrails?.minUniqueFraction ?? 0.7;

  const lowCoverageSegments = Object.entries(coverage)
    .filter(([, stats]) => stats.uniqueFraction < minFraction)
    .map(([id, stats]) => ({ id, stats }));

  const aggregatedRows = Object.entries(aggregated)
    .map(([id, stats]) => ({ id, stats }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const html = buildHtml({
    batchPath,
    scientist,
    merge,
    guardrails,
    lowCoverageSegments,
    aggregatedRows,
  });

  fs.writeFileSync(OUTPUT_PATH, html, 'utf-8');
  console.log(`Harvest report written to ${path.relative(process.cwd(), OUTPUT_PATH)}`);

  const openReport = () => {
    const fullPath = OUTPUT_PATH;
    const platform = process.platform;
    let command;
    let args;
    if (platform === 'win32') {
      command = 'powershell.exe';
      args = [
        '-NoProfile',
        '-Command',
        `Start-Process -FilePath "${fullPath.replace(/"/g, '""')}"`,
      ];
    } else if (platform === 'darwin') {
      command = 'open';
      args = [fullPath];
    } else {
      command = 'xdg-open';
      args = [fullPath];
    }
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
  };

  try {
    openReport();
  } catch (error) {
    console.warn('Failed to open harvest report in browser:', error.message);
  }
};

main();

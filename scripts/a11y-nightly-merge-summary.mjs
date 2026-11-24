#!/usr/bin/env node
/**
 * Merge the accessibility nightly's run summaries into one (AECI-1876).
 *
 * The nightly runs two Playwright lanes: the `e2e-a11y/` suite, and the e2e suite with the
 * axe sweep on, in shards. Each run writes a summary with `apps/web/e2e-a11y/summary-reporter.ts`.
 * The `report` job in `.github/workflows/a11y-nightly.yml` merges them into the one
 * `a11y-nightly-summary.json` the alert reads (`scripts/a11y-nightly-alert.mjs`), and writes the
 * axe findings to the job summary, grouped by rule.
 *
 *   node scripts/a11y-nightly-merge-summary.mjs --out=<file> [--markdown=<file>] <part.json>...
 *
 * A part that is missing or unreadable is named in `parts` and makes the merged `status`
 * `failed`, so a lane that died before its reporter ran is never read as green.
 *
 * The rule grouping matches `summarizeAxe()` in `apps/web/e2e/axe-summary.ts`. Keep the two in
 * step. No dependencies, so the job needs no `pnpm install`.
 *
 * Exit codes: 0 merged, 2 a flag is wrong or no part was given.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const IMPACTS = ['critical', 'serious', 'moderate', 'minor'];
export const PATHS_KEPT = 10;
/** Rows per table in the job summary. The JSON has them all. */
const MARKDOWN_ROWS = 40;
/** Worst first. */
const STATUS_ORDER = ['failed', 'timedout', 'interrupted', 'passed'];

function impactRank(impact) {
  const i = IMPACTS.indexOf(impact ?? '');
  return i === -1 ? IMPACTS.length : i;
}

/** Most severe first, then most tests, then rule id. Same order as `compareRules()`. */
export function compareRules(a, b) {
  return (
    impactRank(a.impact) - impactRank(b.impact) ||
    b.tests - a.tests ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Merge rule lists from several runs by rule id. */
export function mergeRules(lists) {
  const byId = new Map();
  for (const rule of lists.flat()) {
    const prev = byId.get(rule.id);
    if (!prev) {
      byId.set(rule.id, { ...rule, paths: [...new Set(rule.paths ?? [])].slice(0, PATHS_KEPT) });
      continue;
    }
    const paths = new Set(prev.paths);
    for (const p of rule.paths ?? []) if (paths.size < PATHS_KEPT) paths.add(p);
    byId.set(rule.id, {
      ...prev,
      impact: impactRank(prev.impact) <= impactRank(rule.impact) ? prev.impact : rule.impact,
      tests: prev.tests + rule.tests,
      nodes: prev.nodes + rule.nodes,
      paths: [...paths],
    });
  }
  return [...byId.values()].map((r) => ({ ...r, paths: [...r.paths].sort() })).sort(compareRules);
}

/** Merge known-failure lists by issue and rule. */
export function mergeKnown(lists) {
  const byKey = new Map();
  for (const k of lists.flat()) {
    const key = `${k.issue} ${k.rule}`;
    const prev = byKey.get(key);
    byKey.set(key, {
      issue: k.issue,
      rule: k.rule,
      tests: (prev?.tests ?? 0) + (Number(k.tests) || 0),
    });
  }
  return [...byKey.values()].sort((a, b) =>
    a.issue < b.issue ? -1 : a.issue > b.issue ? 1 : a.rule < b.rule ? -1 : 1,
  );
}

/** Merge the `axe` blocks. Always an object: all zeros when no part had one. */
export function mergeAxe(blocks) {
  const present = blocks.filter((b) => b && typeof b === 'object');
  const sum = (pick) => present.reduce((n, b) => n + (Number(pick(b)) || 0), 0);
  return {
    violationsByImpact: Object.fromEntries(
      IMPACTS.map((i) => [i, sum((b) => b.violationsByImpact?.[i])]),
    ),
    scans: {
      scanned: sum((b) => b.scans?.scanned),
      optedOut: sum((b) => b.scans?.optedOut),
      notScanned: sum((b) => b.scans?.notScanned),
    },
    optOuts: present.flatMap((b) => b.optOuts ?? []),
    gate: {
      tags: present[0]?.gate?.tags ?? [],
      rules: mergeRules(present.map((b) => b.gate?.rules ?? [])),
    },
    knownFailures: mergeKnown(present.map((b) => b.knownFailures ?? [])),
    reportOnly: {
      tags: present[0]?.reportOnly?.tags ?? [],
      rules: mergeRules(present.map((b) => b.reportOnly?.rules ?? [])),
    },
  };
}

/** Read one part. Never throws. */
export function readPart(path) {
  if (!existsSync(path)) return { path, found: false, error: 'missing' };
  try {
    const summary = JSON.parse(readFileSync(path, 'utf8'));
    if (!summary || typeof summary !== 'object' || !Array.isArray(summary.tests)) {
      throw new Error('expected an object with a tests array');
    }
    return { path, found: true, summary };
  } catch (err) {
    return { path, found: false, error: `unreadable: ${err?.message ?? err}` };
  }
}

/** Merge parts read with `readPart()`. `now` is for tests. */
export function mergeSummaries(parts, now = new Date()) {
  const found = parts.filter((p) => p.found).map((p) => p.summary);
  const first = (key) => found.map((s) => s[key]).find((v) => v !== null && v !== undefined);
  const total = (key) => found.reduce((n, s) => n + (Number(s.totals?.[key]) || 0), 0);
  let status = found
    .map((s) => s.status)
    .sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b))[0];
  if (!status || parts.some((p) => !p.found)) status = 'failed';
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    commitSha: first('commitSha') ?? null,
    trigger: first('trigger') ?? 'manual',
    runUrl: first('runUrl') ?? null,
    status,
    totals: {
      passed: total('passed'),
      failed: total('failed'),
      skipped: total('skipped'),
      expectedFailures: total('expectedFailures'),
    },
    parts: parts.map((p) => ({ file: p.path, found: p.found, error: p.error ?? null })),
    tests: found.flatMap((s) => s.tests),
    axe: mergeAxe(found.map((s) => s.axe)),
  };
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function ruleTable(rules) {
  if (rules.length === 0) return ['None.'];
  const shown = rules.slice(0, MARKDOWN_ROWS);
  const lines = [
    '| Rule | Impact | Tests | Nodes | Pages |',
    '|---|---|---|---|---|',
    ...shown.map(
      (r) =>
        `| [\`${cell(r.id)}\`](${r.helpUrl}) | ${cell(r.impact ?? '-')} | ${r.tests} | ${r.nodes} | ${cell(
          r.paths.map((p) => `\`${p}\``).join(', '),
        )} |`,
    ),
  ];
  if (rules.length > shown.length) {
    lines.push('', `${rules.length - shown.length} more rules. The summary artifact has them.`);
  }
  return lines;
}

/** The job summary. */
export function summaryMarkdown(merged) {
  const t = merged.totals;
  const lines = [
    '## Accessibility nightly',
    '',
    `${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped, ${t.expectedFailures} known failures. Status: ${merged.status}.`,
  ];
  const missing = merged.parts.filter((p) => !p.found);
  if (missing.length > 0) {
    lines.push('', `Missing summaries: ${missing.map((p) => `\`${p.file}\``).join(', ')}.`);
  }
  const axe = merged.axe;
  const reached = axe.scans.scanned + axe.scans.optedOut + axe.scans.notScanned;
  if (reached === 0) {
    lines.push('', 'No test reached the e2e axe sweep.');
    return `${lines.join('\n')}\n`;
  }
  const v = axe.violationsByImpact;
  lines.push(
    '',
    '### The e2e axe sweep',
    '',
    `${axe.scans.scanned} scanned, ${axe.scans.optedOut} opted out, ${axe.scans.notScanned} not scanned.`,
    '',
    `Gate violations (${axe.gate.tags.join(', ')}): ${v.critical} critical, ${v.serious} serious, ${v.moderate} moderate, ${v.minor} minor.`,
    '',
    ...ruleTable(axe.gate.rules),
    '',
    `Known failures: ${
      axe.knownFailures.length === 0
        ? 'none'
        : axe.knownFailures.map((k) => `${k.issue} (\`${k.rule}\`, tests: ${k.tests})`).join(', ')
    }.`,
    '',
    `### Report only (${axe.reportOnly.tags.join(', ')})`,
    '',
    'These never fail the run.',
    '',
    ...ruleTable(axe.reportOnly.rules),
  );
  return `${lines.join('\n')}\n`;
}

export function main(argv, { log = console.log, error = console.error } = {}) {
  const flags = {};
  const files = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (m) flags[m[1]] = m[2];
    else if (arg.startsWith('--')) {
      error(`unknown flag ${arg}`);
      return 2;
    } else files.push(arg);
  }
  if (!flags.out) {
    error('--out=<file> is required');
    return 2;
  }
  if (files.length === 0) {
    error('give at least one summary file');
    return 2;
  }
  const merged = mergeSummaries(files.map(readPart));
  writeFileSync(flags.out, `${JSON.stringify(merged, null, 2)}\n`);
  if (flags.markdown) appendFileSync(flags.markdown, summaryMarkdown(merged));
  const t = merged.totals;
  log(
    `Merged ${files.length} summaries into ${flags.out}: ${t.passed} passed, ${t.failed} failed, ` +
      `${t.skipped} skipped, ${t.expectedFailures} known failures. Status: ${merged.status}.`,
  );
  for (const p of merged.parts.filter((x) => !x.found)) log(`Missing: ${p.file} (${p.error}).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}

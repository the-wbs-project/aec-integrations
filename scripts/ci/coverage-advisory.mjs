#!/usr/bin/env node
/**
 * Advisory coverage check for the push-to-main unit jobs in deploy.yml.
 *
 * Coverage is a documented target, never a merge gate (docs/TESTING_STRATEGY.md §3.3).
 * The unit jobs therefore run each suite ONCE with coverage on and the vitest thresholds
 * zeroed on the command line, so the exit code reflects test failures only. This script
 * then reads each package's `coverage/coverage-summary.json` and compares it with the
 * `thresholds` block in that package's `vitest.config.ts`. A miss becomes a `::warning`
 * annotation and a row in the job summary. It never exits non-zero.
 *
 * Usage: node scripts/ci/coverage-advisory.mjs apps/api apps/web packages/shared ...
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const METRICS = ['lines', 'branches', 'functions', 'statements'];

/** Reads `thresholds: { lines: 70, ... }` from a vitest config's source. {} when absent. */
export function parseThresholds(source) {
  const block = source.match(/thresholds:\s*\{([^}]*)\}/);
  if (!block) return {};
  const out = {};
  for (const m of block[1].matchAll(/(lines|branches|functions|statements):\s*(\d+(?:\.\d+)?)/g)) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}

/** Each metric whose total pct is below its threshold. */
export function misses(total, thresholds) {
  return METRICS.filter((k) => thresholds[k] !== undefined && total[k]?.pct < thresholds[k]).map(
    (k) => ({ metric: k, pct: total[k].pct, threshold: thresholds[k] }),
  );
}

function main(dirs) {
  const rows = [];
  for (const dir of dirs) {
    const summaryPath = join(dir, 'coverage', 'coverage-summary.json');
    const configPath = join(dir, 'vitest.config.ts');
    if (!existsSync(summaryPath)) {
      console.log(`coverage-advisory: ${dir}: no coverage-summary.json, skipped`);
      continue;
    }
    const total = JSON.parse(readFileSync(summaryPath, 'utf8')).total;
    const thresholds = existsSync(configPath)
      ? parseThresholds(readFileSync(configPath, 'utf8'))
      : {};
    const missed = misses(total, thresholds);
    for (const m of missed) {
      console.log(
        `::warning title=Coverage below target (advisory)::${dir} ${m.metric} ${m.pct}% is under the ${m.threshold}% target`,
      );
    }
    const pcts = METRICS.map((k) => `${total[k]?.pct ?? '?'}%`).join(' | ');
    rows.push(`| ${dir} | ${pcts} | ${missed.length ? 'below target' : 'ok'} |`);
  }
  if (process.env.GITHUB_STEP_SUMMARY && rows.length > 0) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '### Coverage (advisory)',
        '',
        '| Package | Lines | Branches | Functions | Statements | Target |',
        '| --- | --- | --- | --- | --- | --- |',
        ...rows,
        '',
      ].join('\n'),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    // Advisory: a broken report must never fail the job.
    const message = err instanceof Error ? err.message : String(err);
    console.log(`::warning title=Coverage advisory failed::${message}`);
  }
}

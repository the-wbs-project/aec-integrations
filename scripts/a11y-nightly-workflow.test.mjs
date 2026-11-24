/**
 * `.github/workflows/a11y-nightly.yml`, the two-lane accessibility nightly (AECI-1876).
 * Runs under `node --test` from root `pnpm test:scripts`.
 *
 * What must hold, or a lane drops out of the result without anyone seeing:
 *   1. The `e2e-axe` matrix lists exactly 1..E2E_AXE_SHARDS, and its name says /N.
 *   2. Every summary `report` merges is one a job uploads, under that name and file.
 *   3. `report` decides the outcome from BOTH lanes. The step's own shell body runs here.
 *   4. The alert and confirm-alert jobs read `report`'s outcome, not one lane's result.
 *   5. The PR e2e job never turns the sweep on.
 *
 * Child processes use execFileSync with fixed argument arrays (no shell string built from input).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const ROOT = process.cwd();
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/a11y-nightly.yml'), 'utf8');
const DEPLOY = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
const AXE_CONFIG = readFileSync(join(ROOT, 'apps/web/playwright.e2e-axe.config.ts'), 'utf8');
const DEFAULT_CONFIG = readFileSync(join(ROOT, 'apps/web/playwright.config.ts'), 'utf8');

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** The text of one top-level job, from its key to the next job key. */
function job(name) {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.ok(start >= 0, `a11y-nightly.yml has a job "${name}"`);
  // The next job key, or the comment block above it.
  const end = lines.findIndex((l, i) => i > start && /^ {2}([a-z][a-z0-9-]*:$|# )/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

/** The `run: |` body of the named step, de-indented. */
function stepScript(name) {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `a11y-nightly.yml has a step named "${name}"`);
  const runAt = lines.findIndex((line, i) => i > start && line.trim() === 'run: |');
  const indent = lines[runAt].search(/\S/) + 2;
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

function shardTotal() {
  const match = WORKFLOW.match(/E2E_AXE_SHARDS: '(\d+)'/);
  assert.ok(match, 'a11y-nightly.yml sets E2E_AXE_SHARDS');
  return Number(match[1]);
}

test('the e2e-axe matrix lists exactly 1..E2E_AXE_SHARDS, and its name says so', () => {
  const total = shardTotal();
  const body = job('e2e-axe');
  const match = body.match(/shard: \[([\d,\s]+)\]/);
  assert.ok(match, 'e2e-axe has a shard matrix');
  assert.deepEqual(
    match[1].split(',').map((n) => Number(n.trim())),
    Array.from({ length: total }, (_, i) => i + 1),
  );
  assert.match(body, new RegExp(`\\(shard \\$\\{\\{ matrix\\.shard \\}\\}/${total}\\)`));
  assert.match(body, /-c playwright\.e2e-axe\.config\.ts --shard="\$SHARD\/\$E2E_AXE_SHARDS"/);
});

test('every summary report merges is one a lane uploads', () => {
  // The e2e-a11y suite writes the default name. The sweep config writes its own.
  assert.match(
    job('suite'),
    /name: a11y-nightly-summary-suite\n\s+path: apps\/web\/a11y-nightly-summary\.json/,
  );
  assert.match(AXE_CONFIG, /outputFile: 'a11y-e2e-axe-summary\.json'/);
  assert.match(
    job('e2e-axe'),
    /name: a11y-nightly-summary-e2e-axe-\$\{\{ matrix\.shard \}\}\n\s+path: apps\/web\/a11y-e2e-axe-summary\.json/,
  );
  const merge = stepScript('Merge into a11y-nightly-summary.json');
  assert.match(merge, /a11y-parts\/a11y-nightly-summary-suite\/a11y-nightly-summary\.json/);
  assert.match(merge, /a11y-parts\/a11y-nightly-summary-e2e-axe-\$n\/a11y-e2e-axe-summary\.json/);
  assert.match(merge, /seq 1 "\$E2E_AXE_SHARDS"/);
  // The alert downloads the merged file under the name it always used.
  assert.match(job('report'), /name: a11y-nightly-summary\n\s+path: a11y-nightly-summary\.json/);
  assert.match(job('alert'), /name: a11y-nightly-summary\n\s+path: a11y-results/);
});

/** Run the outcome step for one pair of lane results. */
function outcomeFor(suite, e2eAxe) {
  const dir = mkdtempSync(join(tmpdir(), 'a11y-outcome-'));
  tempDirs.push(dir);
  const out = join(dir, 'github-output');
  writeFileSync(out, '');
  execFileSync('bash', ['-c', stepScript("Decide the run's outcome")], {
    env: { ...process.env, SUITE_RESULT: suite, E2E_AXE_RESULT: e2eAxe, GITHUB_OUTPUT: out },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return readFileSync(out, 'utf8').trim();
}

test('the outcome is success only when both lanes pass, and a failure beats a cancel', () => {
  const cases = [
    ['success', 'success', 'success'],
    ['failure', 'success', 'failure'],
    ['success', 'failure', 'failure'],
    ['failure', 'failure', 'failure'],
    ['cancelled', 'success', 'cancelled'],
    ['success', 'cancelled', 'cancelled'],
    // A red lane alerts even when the other lane was cancelled.
    ['failure', 'cancelled', 'failure'],
    ['cancelled', 'failure', 'failure'],
    ['failure', 'skipped', 'failure'],
    ['success', 'skipped', 'cancelled'],
    ['skipped', 'success', 'cancelled'],
  ];
  for (const [suite, e2eAxe, want] of cases) {
    assert.equal(outcomeFor(suite, e2eAxe), `outcome=${want}`, `${suite}/${e2eAxe}`);
  }
});

test('report waits for both lanes, always runs on a measured commit, and posts the status', () => {
  const body = job('report');
  assert.match(body, /needs: \[resolve, suite, e2e-axe\]/);
  assert.match(body, /if: \$\{\{ always\(\) && needs\.resolve\.outputs\.measure == 'true' \}\}/);
  assert.match(body, /OUTCOME: \$\{\{ steps\.outcome\.outputs\.outcome \}\}/);
  assert.match(body, /statuses: write/);
  // It holds a write token, so it installs nothing.
  assert.doesNotMatch(body, /pnpm install/);
  // ...and every action it uses is pinned to a full commit SHA.
  const uses = [...body.matchAll(/^\s*-? ?uses: (\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 4, 'report uses checkout, setup-node, download and upload');
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${u} is pinned to a full SHA`);
  // The suite only posts `pending` now.
  assert.doesNotMatch(job('suite'), /Record the a11y-nightly status/);
  assert.doesNotMatch(job('e2e-axe'), /statuses: write|GH_TOKEN/);
});

test('the alert and confirm-alert jobs read the merged outcome', () => {
  for (const name of ['alert', 'confirm-alert']) {
    const body = job(name);
    assert.match(body, /needs\.report\.outputs\.outcome/, name);
    assert.doesNotMatch(body, /needs\.suite\.result/, name);
  }
});

test('the PR e2e job never turns the sweep on', () => {
  assert.doesNotMatch(DEPLOY, /AECI_E2E_AXE|e2e-axe\.config/);
  assert.doesNotMatch(DEFAULT_CONFIG, /AECI_E2E_AXE/);
  assert.match(AXE_CONFIG, /process\.env\[E2E_AXE_FLAG\] = '1'/);
  // A violation that passes on a retry would never reach the summary.
  assert.match(AXE_CONFIG, /^\s*retries: 0,/m);
});

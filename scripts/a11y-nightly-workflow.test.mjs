/**
 * `.github/workflows/a11y-nightly.yml`, the two-lane accessibility nightly (AECI-1876).
 * Runs under `node --test` from root `pnpm test:scripts`.
 *
 * What must hold, or a lane drops out of the result without anyone seeing:
 *   1. The `suite` and `e2e-axe` matrices list exactly 1..SUITE_SHARDS and
 *      1..E2E_AXE_SHARDS, and each job name says /N (AECI-1874 sharded `suite`).
 *   2. Every summary `report` merges is one a job uploads, under that name and file.
 *      The merge step's own shell body runs here, so the part list is checked as built.
 *   3. `report` decides the outcome from BOTH lanes and from which summaries arrived. Green
 *      lanes with a missing summary are a failure (review round 2). The steps' own shell
 *      bodies run here.
 *   4. The alert and confirm-alert jobs read `report`'s outcome, not one lane's result.
 *   5. The PR e2e job never turns the sweep on.
 *
 * Child processes use execFileSync with fixed argument arrays (no shell string built from input).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function shardTotal(name = 'E2E_AXE_SHARDS') {
  const match = WORKFLOW.match(new RegExp(`${name}: '(\\d+)'`));
  assert.ok(match, `a11y-nightly.yml sets ${name}`);
  return Number(match[1]);
}

const LANES = [
  { job: 'e2e-axe', total: 'E2E_AXE_SHARDS', config: 'playwright.e2e-axe.config.ts' },
  { job: 'suite', total: 'SUITE_SHARDS', config: 'playwright.a11y-nightly.config.ts' },
];

for (const lane of LANES) {
  test(`the ${lane.job} matrix lists exactly 1..${lane.total}, and its name says so`, () => {
    const total = shardTotal(lane.total);
    const body = job(lane.job);
    const match = body.match(/shard: \[([\d,\s]+)\]/);
    assert.ok(match, `${lane.job} has a shard matrix`);
    assert.deepEqual(
      match[1].split(',').map((n) => Number(n.trim())),
      Array.from({ length: total }, (_, i) => i + 1),
    );
    assert.match(body, new RegExp(`\\(shard \\$\\{\\{ matrix\\.shard \\}\\}/${total}\\)`));
    assert.match(body, /fail-fast: false/);
    const run = new RegExp(
      `-c ${lane.config.replace(/\./g, '\\.')} --shard="\\$SHARD/\\$${lane.total}"`,
    );
    assert.match(body, run);
  });
}

test('the suite posts pending once, from shard 1, and runs no unsharded copy', () => {
  const body = job('suite');
  assert.match(body, /- name: Mark the a11y-nightly status pending\n\s+if: matrix\.shard == 1\n/);
  assert.doesNotMatch(body, /pnpm test:a11y:nightly\s*$/m);
});

test('every summary report merges is one a lane uploads', () => {
  // The e2e-a11y suite writes the default name. The sweep config writes its own.
  assert.match(
    job('suite'),
    /name: a11y-nightly-summary-suite-\$\{\{ matrix\.shard \}\}\n\s+path: apps\/web\/a11y-nightly-summary\.json/,
  );
  assert.match(AXE_CONFIG, /outputFile: 'a11y-e2e-axe-summary\.json'/);
  assert.match(
    job('e2e-axe'),
    /name: a11y-nightly-summary-e2e-axe-\$\{\{ matrix\.shard \}\}\n\s+path: apps\/web\/a11y-e2e-axe-summary\.json/,
  );
  // Run the parts check and the merge step as written, with no parts downloaded.
  // The check must count every expected part as missing, and the merged file must
  // name each one: one per shard of each lane.
  const dir = mkdtempSync(join(tmpdir(), 'a11y-merge-step-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(
    join(ROOT, 'scripts/a11y-nightly-merge-summary.mjs'),
    join(dir, 'scripts/a11y-nightly-merge-summary.mjs'),
  );
  const stepSummary = join(dir, 'step-summary.md');
  const githubOutput = join(dir, 'github-output');
  writeFileSync(stepSummary, '');
  writeFileSync(githubOutput, '');
  const env = {
    ...process.env,
    SUITE_SHARDS: String(shardTotal('SUITE_SHARDS')),
    E2E_AXE_SHARDS: String(shardTotal('E2E_AXE_SHARDS')),
    GITHUB_STEP_SUMMARY: stepSummary,
    GITHUB_OUTPUT: githubOutput,
  };
  const run = (step) =>
    execFileSync('bash', ['-c', stepScript(step)], {
      cwd: dir,
      env,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  run('Check every summary arrived');
  run('Merge into a11y-nightly-summary.json');
  const expected = [
    ...Array.from(
      { length: shardTotal('SUITE_SHARDS') },
      (_, i) => `a11y-parts/a11y-nightly-summary-suite-${i + 1}/a11y-nightly-summary.json`,
    ),
    ...Array.from(
      { length: shardTotal('E2E_AXE_SHARDS') },
      (_, i) => `a11y-parts/a11y-nightly-summary-e2e-axe-${i + 1}/a11y-e2e-axe-summary.json`,
    ),
  ];
  assert.equal(readFileSync(githubOutput, 'utf8').trim(), `missing=${expected.length}`);
  assert.match(readFileSync(stepSummary, 'utf8'), /### Missing summaries/);
  for (const part of expected) assert.ok(readFileSync(stepSummary, 'utf8').includes(part), part);
  const merged = JSON.parse(readFileSync(join(dir, 'a11y-nightly-summary.json'), 'utf8'));
  assert.deepEqual(
    merged.parts.map((p) => p.file),
    expected,
  );
  assert.ok(merged.parts.every((p) => !p.found));
  assert.equal(merged.status, 'failed', 'missing parts never read as green');
  // The alert downloads the merged file under the name it always used.
  assert.match(job('report'), /name: a11y-nightly-summary\n\s+path: a11y-nightly-summary\.json/);
  assert.match(job('alert'), /name: a11y-nightly-summary\n\s+path: a11y-results/);
});

/** Run one step's shell body with `env` and return what it wrote to GITHUB_OUTPUT. */
function outputOf(step, env, cwd) {
  const dir = mkdtempSync(join(tmpdir(), 'a11y-outcome-'));
  tempDirs.push(dir);
  const out = join(dir, 'github-output');
  writeFileSync(out, '');
  execFileSync('bash', ['-c', stepScript(step)], {
    cwd: cwd ?? dir,
    env: { ...process.env, ...env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: join(dir, 'summary') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return readFileSync(out, 'utf8').trim();
}

test('the lanes are success only when both pass, and a failure beats a cancel', () => {
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
    assert.equal(
      outputOf("Decide the lanes' outcome", { SUITE_RESULT: suite, E2E_AXE_RESULT: e2eAxe }),
      `lanes=${want}`,
      `${suite}/${e2eAxe}`,
    );
  }
});

test('the parts check finds a shard that uploaded no summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a11y-parts-'));
  tempDirs.push(dir);
  const suite = shardTotal('SUITE_SHARDS');
  const axe = shardTotal('E2E_AXE_SHARDS');
  const place = (rel) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), '{}');
  };
  for (let n = 1; n <= suite; n++) {
    if (n !== 3) place(`a11y-parts/a11y-nightly-summary-suite-${n}/a11y-nightly-summary.json`);
  }
  for (let n = 1; n <= axe; n++) {
    place(`a11y-parts/a11y-nightly-summary-e2e-axe-${n}/a11y-e2e-axe-summary.json`);
  }
  const env = { SUITE_SHARDS: String(suite), E2E_AXE_SHARDS: String(axe) };
  assert.equal(outputOf('Check every summary arrived', env, dir), 'missing=1');
  place('a11y-parts/a11y-nightly-summary-suite-3/a11y-nightly-summary.json');
  assert.equal(outputOf('Check every summary arrived', env, dir), 'missing=0');
});

test('green lanes with a missing summary fail, and every other rule holds', () => {
  const cases = [
    ['success', '0', 'success'],
    ['success', '1', 'failure'],
    ['success', '12', 'failure'],
    // The check did not finish, so nothing proves the summaries arrived.
    ['success', '', 'failure'],
    ['failure', '0', 'failure'],
    ['failure', '3', 'failure'],
    // A cancelled run stays `error`: its missing parts are the cancel, not a red result.
    ['cancelled', '0', 'cancelled'],
    ['cancelled', '5', 'cancelled'],
    // The lanes step never ran.
    ['', '0', 'cancelled'],
  ];
  for (const [lanes, missing, want] of cases) {
    const out = outputOf("Decide the run's outcome", { LANES: lanes, MISSING: missing });
    assert.equal(out.split('\n')[0], `outcome=${want}`, `${lanes}/${missing}`);
  }
  for (const name of ['Check every summary arrived', "Decide the run's outcome"]) {
    const lines = WORKFLOW.split('\n');
    const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
    assert.ok(
      lines.slice(at, at + 4).some((l) => l.trim() === 'if: always()'),
      `${name} always runs`,
    );
  }
  // The status description names the missing count, and a nightly failure still
  // ends `(nightly, alert pending)` until confirm-alert rewrites it.
  const report = job('report');
  assert.match(report, /MISSING: \$\{\{ steps\.outcome\.outputs\.missing \}\}/);
  assert.match(report, /failed="\$failed, \$MISSING summaries missing"/);
  assert.match(report, /description="\$failed \(nightly, alert pending\)"/);
  assert.match(job('confirm-alert'), /description="Accessibility nightly failed \(nightly\)"/);
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

/**
 * `.github/workflows/a11y-nightly.yml`, the three-lane accessibility nightly (AECI-1876,
 * AECI-1885).
 * Runs under `node --test` from root `pnpm test:scripts`.
 *
 * What must hold, or a lane drops out of the result without anyone seeing:
 *   1. The `suite` and `e2e-axe` matrices list exactly 1..SUITE_SHARDS and 1..E2E_AXE_SHARDS,
 *      and `cross-browser` lists 1..FIREFOX_SHARDS and 1..WEBKIT_SHARDS, and each job name says /N (AECI-1874
 *      sharded `suite`). `suite` runs Chromium only. `cross-browser` runs the browsers in
 *      CROSS_BROWSERS from its own browser cache (AECI-1885).
 *   2. Every summary `report` merges is one a job uploads, under that name and file.
 *      The merge step's own shell body runs here, so the part list is checked as built.
 *   3. `report` decides the outcome from ALL THREE lanes and from which summaries arrived. Green
 *      lanes with a missing summary are a failure (review round 2). The steps' own shell
 *      bodies run here.
 *   4. The alert and confirm-alert jobs read `report`'s outcome, not one lane's result.
 *   5. The PR e2e job never turns the sweep on, and stays Chromium only.
 *   6. A snapshot-only dispatch (ADR 0060 answer 5) runs no lane and posts no status.
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

/** The browsers of the Firefox and WebKit lane (AECI-1885), from `CROSS_BROWSERS`. */
function crossBrowsers() {
  const match = WORKFLOW.match(/CROSS_BROWSERS: '([a-z ]+)'/);
  assert.ok(match, 'a11y-nightly.yml sets CROSS_BROWSERS');
  return match[1].split(' ');
}

/** A browser's shard count: FIREFOX_SHARDS, WEBKIT_SHARDS. */
function browserShards(browser) {
  return shardTotal(`${browser.toUpperCase()}_SHARDS`);
}

/** The env the parts check reads for the browser lane. */
function crossEnv() {
  return {
    CROSS_BROWSERS: crossBrowsers().join(' '),
    ...Object.fromEntries(
      crossBrowsers().map((b) => [`${b.toUpperCase()}_SHARDS`, String(browserShards(b))]),
    ),
  };
}

const LANES = [
  { job: 'e2e-axe', total: 'E2E_AXE_SHARDS', config: 'playwright.e2e-axe.config.ts', project: '' },
  {
    job: 'suite',
    total: 'SUITE_SHARDS',
    config: 'playwright.a11y-nightly.config.ts',
    // AECI-1885: the nightly config also holds firefox and webkit. The suite
    // shards run Chromium only, once (ADR 0060 decision 3).
    project: '--project=chromium ',
  },
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
      `-c ${lane.config.replace(/\./g, '\\.')} ${lane.project}--shard="\\$SHARD/\\$${lane.total}"`,
    );
    assert.match(body, run);
  });
}

test("the cross-browser matrix lists each browser's shards 1..N, and its name and run say /N", () => {
  const body = job('cross-browser');
  const entries = [...body.matchAll(/- \{ browser: ([a-z]+), shard: (\d+), of: (\d+) \}/g)].map(
    (m) => ({ browser: m[1], shard: Number(m[2]), of: Number(m[3]) }),
  );
  const want = crossBrowsers().flatMap((b) =>
    Array.from({ length: browserShards(b) }, (_, i) => ({
      browser: b,
      shard: i + 1,
      of: browserShards(b),
    })),
  );
  assert.deepEqual(entries, want);
  assert.equal(
    browserShards('webkit'),
    6,
    'WebKit runs six shards on Linux (first run, 2026-11-26)',
  );
  assert.match(
    body,
    /name: Accessibility nightly, \$\{\{ matrix\.browser \}\} \(shard \$\{\{ matrix\.shard \}\}\/\$\{\{ matrix\.of \}\}\)/,
  );
  assert.match(body, /SHARD_TOTAL: \$\{\{ matrix\.of \}\}/);
  assert.match(
    body,
    /-c playwright\.a11y-nightly\.config\.ts --project="\$BROWSER" --shard="\$SHARD\/\$SHARD_TOTAL"/,
  );
  assert.match(body, /fail-fast: false/);
});

test('the cross-browser lane runs each listed browser, from its own browser cache (AECI-1885)', () => {
  const body = job('cross-browser');
  const browsers = crossBrowsers();
  assert.deepEqual(browsers, ['firefox', 'webkit']);
  assert.match(body, /BROWSER: \$\{\{ matrix\.browser \}\}/);
  // ADR 0060: the shared `playwright-<os>-…` key holds Chromium alone. A job
  // that restored it could not launch Firefox or WebKit, so this key differs.
  assert.match(
    body,
    /key: playwright-a11y-\$\{\{ matrix\.browser \}\}-\$\{\{ runner\.os \}\}-\$\{\{ env\.ImageOS \}\}-\$\{\{ hashFiles\('pnpm-lock\.yaml'\) \}\}/,
  );
  assert.doesNotMatch(body, /key: playwright-\$\{\{ runner\.os \}\}/);
  assert.match(body, /playwright install --with-deps "\$BROWSER"/);
  assert.match(body, /playwright install-deps "\$BROWSER"/);
  assert.doesNotMatch(body, /install --with-deps chromium|statuses: write|GH_TOKEN/);
  assert.match(
    body,
    /name: a11y-nightly-summary-\$\{\{ matrix\.browser \}\}-\$\{\{ matrix\.shard \}\}\n\s+path: apps\/web\/a11y-nightly-summary\.json/,
  );
  // The other lanes keep the shared Chromium key, so the PR job's cache is untouched.
  for (const name of ['suite', 'e2e-axe']) {
    assert.match(job(name), /install --with-deps chromium/, name);
  }
});

test('nothing here runs on a PR, and the PR e2e job stays Chromium only (AECI-1885)', () => {
  assert.doesNotMatch(WORKFLOW, /^\s+pull_request/m);
  assert.doesNotMatch(DEPLOY, /firefox|webkit/i);
  assert.doesNotMatch(
    DEFAULT_CONFIG,
    /Desktop Firefox|Desktop Safari|name: 'firefox'|name: 'webkit'/,
  );
});

test('a snapshot-only dispatch runs no lane, posts no status, and names its browser (AECI-1885)', () => {
  const resolveStep = 'Resolve the SHA and check for an existing a11y-nightly status';
  const base = { EVENT_SHA: 'abc', REPO: 'o/r', GH_TOKEN: '' };
  assert.equal(
    outputOf(resolveStep, { ...base, EVENT_NAME: 'workflow_dispatch', UPDATE_SNAPSHOTS: 'webkit' }),
    'sha=abc\nmeasure=false\ntrigger=manual\nsnapshots=webkit',
  );
  assert.equal(
    outputOf(resolveStep, { ...base, EVENT_NAME: 'workflow_dispatch', UPDATE_SNAPSHOTS: 'none' }),
    'sha=abc\nmeasure=true\ntrigger=manual\nsnapshots=',
  );
  // An unlisted value is ignored, never run.
  assert.equal(
    outputOf(resolveStep, { ...base, EVENT_NAME: 'workflow_dispatch', UPDATE_SNAPSHOTS: 'x; rm' }),
    'sha=abc\nmeasure=true\ntrigger=manual\nsnapshots=',
  );
  const body = job('snapshots');
  assert.match(body, /if: needs\.resolve\.outputs\.snapshots != ''/);
  assert.match(
    body,
    /keyboard- --grep "tab walk" --project="\$BROWSER" --update-snapshots=changed/,
  );
  assert.match(
    body,
    /name: a11y-keyboard-snapshots-\$\{\{ needs\.resolve\.outputs\.snapshots \}\}/,
  );
  assert.doesNotMatch(body, /statuses: write|GH_TOKEN/);
  // The lanes and `report` all wait on `measure`, which the snapshot run sets false.
  for (const name of ['suite', 'e2e-axe', 'cross-browser']) {
    assert.match(job(name), /if: needs\.resolve\.outputs\.measure == 'true'/, name);
  }
  assert.match(WORKFLOW, /options:\n\s+- none\n\s+- firefox\n\s+- webkit\n/);
});

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
    ...crossEnv(),
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
    // AECI-1885: each browser's shards, three for Firefox and six for WebKit.
    ...crossBrowsers().flatMap((b) =>
      Array.from(
        { length: browserShards(b) },
        (_, i) => `a11y-parts/a11y-nightly-summary-${b}-${i + 1}/a11y-nightly-summary.json`,
      ),
    ),
  ];
  assert.equal(expected.length, 21, 'eight suite, four sweep and nine browser parts');
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

test('the lanes are success only when all three pass, and a failure beats a cancel', () => {
  // [suite, e2e-axe, cross-browser, want]
  const cases = [
    ['success', 'success', 'success', 'success'],
    ['failure', 'success', 'success', 'failure'],
    ['success', 'failure', 'success', 'failure'],
    ['success', 'success', 'failure', 'failure'],
    ['failure', 'failure', 'failure', 'failure'],
    ['cancelled', 'success', 'success', 'cancelled'],
    ['success', 'cancelled', 'success', 'cancelled'],
    ['success', 'success', 'cancelled', 'cancelled'],
    // A red lane alerts even when another lane was cancelled, in either order.
    ['failure', 'cancelled', 'success', 'failure'],
    ['cancelled', 'failure', 'success', 'failure'],
    ['cancelled', 'success', 'failure', 'failure'],
    ['success', 'cancelled', 'failure', 'failure'],
    ['failure', 'skipped', 'success', 'failure'],
    ['success', 'skipped', 'success', 'cancelled'],
    ['skipped', 'success', 'success', 'cancelled'],
    ['success', 'success', 'skipped', 'cancelled'],
    // A lane whose result never arrived is not a pass.
    ['success', 'success', '', 'cancelled'],
  ];
  for (const [suite, e2eAxe, crossBrowser, want] of cases) {
    assert.equal(
      outputOf("Decide the lanes' outcome", {
        SUITE_RESULT: suite,
        E2E_AXE_RESULT: e2eAxe,
        CROSS_BROWSER_RESULT: crossBrowser,
      }),
      `lanes=${want}`,
      `${suite}/${e2eAxe}/${crossBrowser}`,
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
  for (const b of crossBrowsers()) {
    for (let n = 1; n <= browserShards(b); n++) {
      if (!(b === 'webkit' && n === 2)) {
        place(`a11y-parts/a11y-nightly-summary-${b}-${n}/a11y-nightly-summary.json`);
      }
    }
  }
  const env = {
    SUITE_SHARDS: String(suite),
    E2E_AXE_SHARDS: String(axe),
    ...crossEnv(),
  };
  assert.equal(outputOf('Check every summary arrived', env, dir), 'missing=2');
  place('a11y-parts/a11y-nightly-summary-suite-3/a11y-nightly-summary.json');
  assert.equal(outputOf('Check every summary arrived', env, dir), 'missing=1');
  // A browser shard that uploaded nothing is missing too (AECI-1885).
  place('a11y-parts/a11y-nightly-summary-webkit-2/a11y-nightly-summary.json');
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

test('report waits for all three lanes, always runs on a measured commit, and posts the status', () => {
  const body = job('report');
  assert.match(body, /needs: \[resolve, suite, e2e-axe, cross-browser\]/);
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
  assert.doesNotMatch(job('cross-browser'), /statuses: write|GH_TOKEN/);
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

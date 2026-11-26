/**
 * `scripts/a11y-nightly-alert.mjs`, the nightly accessibility operator alert (AECI-1875).
 * Runs under `node --test` from root `pnpm test:scripts`. Every network call goes to a
 * mocked fetch.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  REGRESSION_LABEL,
  failingTable,
  issueDescription,
  issueTitle,
  loadSummary,
  main,
  missingPartsSection,
  singleOtherBrowser,
} from './a11y-nightly-alert.mjs';
import { ASSIGNEE_EMAIL, BUG_LABEL, LINEAR_GRAPHQL_URL } from './lighthouse-alert.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const ENV = {
  MEASURED_SHA: SHA,
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'the-wbs-project/aec-integrations',
  GITHUB_RUN_ID: '42',
};
const RUN_URL = 'https://github.com/the-wbs-project/aec-integrations/actions/runs/42';

/** The shape `apps/web/e2e-a11y/summary-reporter.ts` writes. */
const SUMMARY = {
  schemaVersion: 1,
  generatedAt: '2026-11-19T05:40:00.000Z',
  commitSha: SHA,
  trigger: 'nightly',
  runUrl: RUN_URL,
  status: 'failed',
  totals: { passed: 19, failed: 2, skipped: 1, expectedFailures: 0 },
  tests: [
    { title: 'Home (/)', surfaceId: 'home', route: '/', outcome: 'passed', knownFailure: null },
    {
      title: 'Login (/auth/login)',
      surfaceId: 'login',
      route: '/auth/login',
      outcome: 'failed',
      knownFailure: null,
    },
    {
      title: 'Vendor | index (/vendors)',
      surfaceId: 'vendor-index',
      route: '/vendors',
      outcome: 'failed',
      knownFailure: null,
    },
    {
      title: 'Account (/account)',
      surfaceId: 'account',
      route: '/account',
      outcome: 'skipped',
      knownFailure: null,
    },
  ],
  axe: { violationsByImpact: null },
};

const dir = mkdtempSync(join(tmpdir(), 'aeci-a11y-nightly-alert-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function writeSummary(name, body) {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

/** A fetch mock that answers Linear by operation name and records every call. */
function linearMock(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const op = body.query.match(/(?:query|mutation)\s+(\w+)/)[1];
    calls.push({ url, init, op, variables: body.variables });
    const answer = answers[op];
    if (!answer) throw new Error(`unexpected operation ${op}`);
    const { status = 200, body: resBody } = answer;
    return new Response(typeof resBody === 'string' ? resBody : JSON.stringify(resBody), {
      status,
    });
  };
  return { calls, fetchImpl };
}

function context({ open = null, regressionLabels = [] } = {}) {
  return {
    body: {
      data: {
        teams: { nodes: [{ id: 'team-1', key: 'AECI' }] },
        openIssues: { nodes: open ? [open] : [] },
        regressionLabels: { nodes: regressionLabels },
        bugLabels: { nodes: [{ id: 'bug-1', name: 'Bug', team: { key: 'AECI' } }] },
        users: { nodes: [{ id: 'user-1', email: ASSIGNEE_EMAIL }] },
      },
    },
  };
}

const OPEN = {
  id: 'issue-9',
  identifier: 'AECI-9',
  url: 'https://linear.app/x/issue/AECI-9',
  title: 'Accessibility nightly failed on main: login',
};
const created = {
  body: {
    data: {
      issueCreate: {
        success: true,
        issue: { id: 'issue-new', identifier: 'AECI-77', url: 'https://linear.app/x/AECI-77' },
      },
    },
  },
};
const commented = { body: { data: { commentCreate: { success: true, comment: { id: 'c1' } } } } };
const labelCreated = {
  body: { data: { issueLabelCreate: { success: true, issueLabel: { id: 'lab-new' } } } },
};

function quiet() {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
}

// --- summary --------------------------------------------------------------

test('only failed tests are listed, and the title names their surfaces', () => {
  const s = loadSummary(writeSummary('parse', SUMMARY));
  assert.equal(s.found, true);
  assert.deepEqual(
    s.failing.map((f) => f.surfaceId),
    ['login', 'vendor-index'],
  );
  assert.equal(issueTitle(s), 'Accessibility nightly failed on main: login, vendor-index');
  assert.ok(failingTable(s.failing).includes('Vendor \\| index'));
});

test('an e2e sweep test has no surface, so its spec file names it', () => {
  const s = loadSummary(
    writeSummary('sweep', {
      ...SUMMARY,
      tests: [
        {
          title: 'home > renders',
          surfaceId: null,
          route: '/',
          file: 'e2e/home.spec.ts',
          outcome: 'failed',
          knownFailure: null,
          axe: 'scanned',
        },
      ],
    }),
  );
  assert.equal(issueTitle(s), 'Accessibility nightly failed on main: e2e/home.spec.ts');
  assert.ok(failingTable(s.failing).includes('| `e2e/home.spec.ts` | `/` | home > renders |'));
});

test('each failing row names its browser, and a night red in one other browser says it may be the harness (AECI-1885)', () => {
  const row = (title, browser) => ({
    title,
    surfaceId: 'login',
    route: '/auth/login',
    file: 'e2e-a11y/support/keyboard-suite.ts',
    outcome: 'failed',
    knownFailure: null,
    browser,
  });
  const meta = { sha: SHA, runUrl: 'https://example.test/run/1' };
  const webkitOnly = loadSummary(
    writeSummary('webkit-only', { ...SUMMARY, tests: [row('a', 'webkit'), row('b', 'webkit')] }),
  );
  assert.deepEqual(
    webkitOnly.failing.map((f) => f.browser),
    ['webkit', 'webkit'],
  );
  assert.ok(failingTable(webkitOnly.failing).includes('| Browser |'));
  assert.ok(failingTable(webkitOnly.failing).includes('| a | webkit |'));
  assert.equal(singleOtherBrowser(webkitOnly.failing), 'webkit');
  assert.match(issueDescription(webkitOnly, meta), /ran in webkit only\. This may be a difference/);
  assert.match(
    issueDescription(webkitOnly, meta),
    /First run on Linux, and a red night in one browser/,
  );
  // Chromium, or two browsers, or a summary from before the lane: no such note.
  for (const tests of [
    [row('a', 'chromium')],
    [row('a', 'webkit'), row('b', 'firefox')],
    [row('a', undefined)],
  ]) {
    const s = loadSummary(writeSummary('mixed', { ...SUMMARY, tests }));
    assert.equal(singleOtherBrowser(s.failing), null);
    assert.doesNotMatch(issueDescription(s, meta), /may be a difference/);
  }
  assert.ok(
    failingTable(
      loadSummary(writeSummary('old', { ...SUMMARY, tests: [row('a', undefined)] })).failing,
    ).includes('| a | - |'),
  );
});

test('a missing or unreadable summary is still an alert, with a reason', () => {
  const missing = loadSummary(join(dir, 'nope.json'));
  assert.equal(missing.found, false);
  assert.match(missing.error, /does not exist/);
  assert.equal(issueTitle(missing), 'Accessibility nightly failed on main: no test summary');
  const bad = loadSummary(writeSummary('bad', '{not json'));
  assert.match(bad.error, /unreadable/);
});

// --- failure ----------------------------------------------------------------

test('no open issue: creates the label, then a Bug with both labels and the assignee', async () => {
  const { calls, fetchImpl } = linearMock({
    A11yNightlyAlertContext: context(),
    A11yNightlyAlertLabel: labelCreated,
    A11yNightlyAlertIssue: created,
  });
  const code = await main(
    ['linear', '--outcome=failure', `--summary=${writeSummary('create', SUMMARY)}`],
    { ...ENV, LINEAR_API_KEY: 'lin_test' },
    { fetchImpl, log: () => {} },
  );
  assert.equal(code, 0);
  assert.deepEqual(
    calls.map((c) => c.op),
    ['A11yNightlyAlertContext', 'A11yNightlyAlertLabel', 'A11yNightlyAlertIssue'],
  );
  assert.equal(calls[0].url, LINEAR_GRAPHQL_URL);
  assert.equal(calls[0].init.headers.Authorization, 'lin_test');
  assert.deepEqual(calls[0].variables, {
    teamKey: 'AECI',
    label: REGRESSION_LABEL,
    bug: BUG_LABEL,
    email: ASSIGNEE_EMAIL,
  });
  assert.equal(calls[1].variables.input.name, 'a11y-nightly-regression');
  const input = calls[2].variables.input;
  assert.deepEqual(input.labelIds, ['bug-1', 'lab-new']);
  assert.equal(input.assigneeId, 'user-1');
  assert.equal(input.title, 'Accessibility nightly failed on main: login, vendor-index');
  assert.ok(input.description.includes(SHA.slice(0, 12)));
  assert.ok(input.description.includes(RUN_URL));
  assert.ok(input.description.includes('19 passed, 2 failed, 1 skipped, 0 known failures.'));
  assert.ok(input.description.includes('| `login` | `/auth/login` | Login (/auth/login) |'));
});

test('an existing label is reused, not recreated', async () => {
  const { calls, fetchImpl } = linearMock({
    A11yNightlyAlertContext: context({
      regressionLabels: [{ id: 'lab-old', name: REGRESSION_LABEL, team: { key: 'AECI' } }],
    }),
    A11yNightlyAlertIssue: created,
  });
  const code = await main(
    ['linear', '--outcome=failure', `--summary=${writeSummary('reuse', SUMMARY)}`],
    { ...ENV, LINEAR_API_KEY: 'k' },
    { fetchImpl, log: () => {} },
  );
  assert.equal(code, 0);
  assert.deepEqual(
    calls.map((c) => c.op),
    ['A11yNightlyAlertContext', 'A11yNightlyAlertIssue'],
  );
  assert.deepEqual(calls[1].variables.input.labelIds, ['bug-1', 'lab-old']);
});

test('a missing summary files the issue with "no test summary, see the run log"', async () => {
  const { calls, fetchImpl } = linearMock({
    A11yNightlyAlertContext: context(),
    A11yNightlyAlertLabel: labelCreated,
    A11yNightlyAlertIssue: created,
  });
  const code = await main(
    ['linear', '--outcome=failure', `--summary=${join(dir, 'none.json')}`],
    { ...ENV, LINEAR_API_KEY: 'k' },
    { fetchImpl, log: () => {} },
  );
  assert.equal(code, 0);
  const input = calls[2].variables.input;
  assert.equal(input.title, 'Accessibility nightly failed on main: no test summary');
  assert.match(input.description, /No test summary, see the run log/);
});

/** A merged summary whose suite shard 3 never uploaded: every test that arrived passed. */
const MERGED_MISSING = {
  ...SUMMARY,
  totals: { passed: 2, failed: 0, skipped: 0, expectedFailures: 0 },
  tests: SUMMARY.tests.filter((t) => t.outcome === 'passed'),
  parts: [
    {
      file: 'a11y-parts/a11y-nightly-summary-suite-1/a11y-nightly-summary.json',
      found: true,
      error: null,
    },
    {
      file: 'a11y-parts/a11y-nightly-summary-suite-3/a11y-nightly-summary.json',
      found: false,
      error: 'does not exist',
    },
  ],
};

test('a merged summary with a missing part names it, even with no failing test', () => {
  const s = loadSummary(writeSummary('missing-part', MERGED_MISSING));
  assert.deepEqual(s.missingParts, [
    {
      file: 'a11y-parts/a11y-nightly-summary-suite-3/a11y-nightly-summary.json',
      error: 'does not exist',
    },
  ]);
  assert.equal(issueTitle(s), 'Accessibility nightly failed on main: 1 summary file(s) missing');
  const section = missingPartsSection(s).join('\n');
  assert.match(section, /## Missing summaries/);
  assert.match(section, /suite-3\/a11y-nightly-summary\.json`: does not exist/);
  // A single shard's summary has no parts, so nothing is missing.
  assert.deepEqual(loadSummary(writeSummary('no-parts', SUMMARY)).missingParts, []);
});

test('the filed issue lists the missing summaries before the failing tests', async () => {
  const { calls, fetchImpl } = linearMock({
    A11yNightlyAlertContext: context(),
    A11yNightlyAlertLabel: labelCreated,
    A11yNightlyAlertIssue: created,
  });
  const path = writeSummary('missing-part-main', {
    ...MERGED_MISSING,
    tests: SUMMARY.tests,
    totals: SUMMARY.totals,
  });
  const code = await main(
    ['linear', '--outcome=failure', `--summary=${path}`],
    { ...ENV, LINEAR_API_KEY: 'k' },
    { fetchImpl, log: () => {} },
  );
  assert.equal(code, 0);
  const input = calls[2].variables.input;
  assert.equal(
    input.title,
    'Accessibility nightly failed on main: 1 summary file(s) missing, login, vendor-index',
  );
  const d = input.description;
  assert.ok(d.indexOf('## Missing summaries') < d.indexOf('## Failing tests'));
  assert.match(d, /suite-3/);
});

test('an open issue gets a comment and no new issue', async () => {
  const { calls, fetchImpl } = linearMock({
    A11yNightlyAlertContext: context({ open: OPEN }),
    A11yNightlyAlertComment: commented,
  });
  const code = await main(
    ['linear', '--outcome=failure', `--summary=${writeSummary('comment', SUMMARY)}`],
    { ...ENV, LINEAR_API_KEY: 'k' },
    { fetchImpl, log: () => {} },
  );
  assert.equal(code, 0);
  assert.deepEqual(
    calls.map((c) => c.op),
    ['A11yNightlyAlertContext', 'A11yNightlyAlertComment'],
  );
  assert.equal(calls[1].variables.input.issueId, 'issue-9');
  assert.match(calls[1].variables.input.body, /^Still failing at /);
  assert.ok(calls[1].variables.input.body.includes('`vendor-index`'));
});

// --- recovery -----------------------------------------------------------------

test('a green run comments "Recovered" on the open issue and never closes it', async () => {
  const { calls, fetchImpl } = linearMock({
    A11yNightlyAlertContext: context({ open: OPEN }),
    A11yNightlyAlertComment: commented,
  });
  const code = await main(
    ['linear', '--outcome=success'],
    { ...ENV, LINEAR_API_KEY: 'k' },
    { fetchImpl, log: () => {} },
  );
  assert.equal(code, 0);
  const body = calls[1].variables.input.body;
  assert.ok(body.startsWith(`Recovered at [\`${SHA.slice(0, 12)}\`]`));
  assert.ok(body.includes(`run ${RUN_URL}`));
  assert.ok(calls.every((c) => !/issueUpdate|stateId/.test(c.init.body)));
});

test('a green run with no open issue makes no call after the lookup', async () => {
  const { calls, fetchImpl } = linearMock({ A11yNightlyAlertContext: context() });
  const out = quiet();
  const code = await main(
    ['linear', '--outcome=success'],
    { ...ENV, LINEAR_API_KEY: 'k' },
    { fetchImpl, log: out.log },
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.match(out.lines.join('\n'), /Nothing to do/);
});

// --- failures and flags -------------------------------------------------------

test('a non-2xx Linear response exits 1 with the response text', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (l) => errors.push(l));
  const { fetchImpl } = linearMock({
    A11yNightlyAlertContext: { status: 401, body: 'Authentication required' },
  });
  const code = await main(
    ['linear', '--outcome=failure'],
    { ...ENV, LINEAR_API_KEY: 'k', GITHUB_ACTIONS: 'true' },
    { fetchImpl, log: () => {} },
  );
  assert.equal(code, 1);
  assert.match(
    errors.join('\n'),
    /^::error::Accessibility nightly alert, Linear step failed: .*HTTP 401/,
  );
});

test('a missing LINEAR_API_KEY exits 2 without a request', async (t) => {
  t.mock.method(console, 'error', () => {});
  let called = false;
  const code = await main(['linear', '--outcome=failure'], ENV, {
    fetchImpl: async () => {
      called = true;
    },
  });
  assert.equal(code, 2);
  assert.equal(called, false);
});

test('a bad --outcome, command or flag exits 2', async (t) => {
  t.mock.method(console, 'error', () => {});
  assert.equal(await main(['linear', '--outcome=red'], ENV, {}), 2);
  assert.equal(await main(['email'], ENV, {}), 2);
  assert.equal(await main(['linear', 'stray'], ENV, {}), 2);
});

// --- dry run ------------------------------------------------------------------

test('--dry-run prints every payload and never calls fetch', async () => {
  const fetchImpl = async () => {
    throw new Error('dry run must not fetch');
  };
  const fresh = quiet();
  assert.equal(
    await main(['linear', '--outcome=failure', '--dry-run'], ENV, { fetchImpl, log: fresh.log }),
    0,
  );
  const printed = fresh.lines.join('\n');
  assert.match(printed, /Linear A11yNightlyAlertContext \(dry run, not sent\)/);
  assert.match(printed, /Linear A11yNightlyAlertLabel/);
  assert.match(printed, /Linear A11yNightlyAlertIssue/);
  assert.match(printed, /\[dry run\] Filed AECI-0/);

  const existing = quiet();
  await main(['linear', '--outcome=failure', '--dry-run', '--dry-run-open-issue'], ENV, {
    fetchImpl,
    log: existing.log,
  });
  assert.match(existing.lines.join('\n'), /A11yNightlyAlertComment/);
  assert.doesNotMatch(existing.lines.join('\n'), /A11yNightlyAlertIssue/);

  const green = quiet();
  await main(['linear', '--outcome=success', '--dry-run'], ENV, { fetchImpl, log: green.log });
  assert.match(green.lines.join('\n'), /\[dry run\] Green run and no open/);
});

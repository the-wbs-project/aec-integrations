/**
 * `scripts/lighthouse-alert.mjs`, the nightly Lighthouse operator alert. Runs under
 * `node --test` from root `pnpm test:scripts`. Every network call goes to a mocked fetch.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  ASSIGNEE_EMAIL,
  BUG_LABEL,
  EMAIL_FROM,
  EMAIL_TO,
  LINEAR_GRAPHQL_URL,
  REGRESSION_LABEL,
  RESEND_EMAILS_URL,
  assertionTable,
  emailPayload,
  failingAssertions,
  issueTitle,
  loadAssertionResults,
  main,
  pickLabel,
} from './lighthouse-alert.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const ENV = {
  MEASURED_SHA: SHA,
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'the-wbs-project/aec-integrations',
  GITHUB_RUN_ID: '42',
  GITHUB_RUN_ATTEMPT: '1',
};
const RUN_URL = 'https://github.com/the-wbs-project/aec-integrations/actions/runs/42';

/** The shape `lhci assert` saves: non-passing results only, warn and error mixed. */
const RESULTS = [
  {
    name: 'minScore',
    expected: 0.9,
    actual: 0.63,
    values: [0.63, 0.63, 0.63],
    operator: '>=',
    passed: false,
    auditProperty: 'seo',
    auditId: 'categories',
    level: 'error',
    url: 'http://localhost:8788/products',
  },
  {
    name: 'maxNumericValue',
    expected: 600,
    actual: 812.4,
    values: [812.4],
    operator: '<=',
    passed: false,
    auditId: 'server-response-time',
    auditTitle: 'Initial server response time was short',
    level: 'error',
    url: 'http://localhost:8788/search',
  },
  {
    name: 'maxNumericValue',
    expected: 200,
    actual: 232,
    values: [232],
    operator: '<=',
    passed: false,
    auditId: 'total-blocking-time',
    level: 'warn',
    url: 'http://localhost:8788/phases/construction',
  },
  {
    name: 'minScore',
    expected: 0.9,
    actual: 0.5,
    values: [0.5],
    operator: '>=',
    passed: false,
    auditProperty: 'seo',
    auditId: 'categories',
    level: 'error',
    url: 'http://localhost:8788/vendors',
  },
];

const dir = mkdtempSync(join(tmpdir(), 'aeci-lighthouse-alert-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Write `results` as `<dir>/<name>/assertion-results.json` and return its path. */
function writeFixture(name, results) {
  const sub = join(dir, name);
  mkdirSync(sub, { recursive: true });
  const resultsPath = join(sub, 'assertion-results.json');
  writeFileSync(resultsPath, typeof results === 'string' ? results : JSON.stringify(results));
  return resultsPath;
}

/** A fetch mock that answers Linear by operation name and records every call. */
function linearMock(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const op = body.query.match(/(?:query|mutation)\s+(\w+)/)[1];
    calls.push({ url, init, op, variables: body.variables });
    const answer = typeof answers[op] === 'function' ? answers[op](body) : answers[op];
    if (!answer) throw new Error(`unexpected operation ${op}`);
    const { status = 200, body: resBody } = answer;
    return new Response(typeof resBody === 'string' ? resBody : JSON.stringify(resBody), {
      status,
    });
  };
  return { calls, fetchImpl };
}

function context({ open = null, regressionLabels = [], bugLabels = null, users = null } = {}) {
  return {
    body: {
      data: {
        teams: { nodes: [{ id: 'team-1', key: 'AECI' }] },
        openIssues: { nodes: open ? [open] : [] },
        regressionLabels: { nodes: regressionLabels },
        bugLabels: { nodes: bugLabels ?? [{ id: 'bug-1', name: 'Bug', team: { key: 'AECI' } }] },
        users: { nodes: users ?? [{ id: 'user-1', email: ASSIGNEE_EMAIL }] },
      },
    },
  };
}

const OPEN = {
  id: 'issue-9',
  identifier: 'AECI-9',
  url: 'https://linear.app/x/issue/AECI-9',
  title: 'Lighthouse regression on main: categories:seo',
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

function quiet() {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
}

async function withOutput(fn) {
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}`);
  writeFileSync(out, '');
  const code = await fn(out);
  const outputs = Object.fromEntries(
    readFileSync(out, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { code, outputs };
}

// --- parsing --------------------------------------------------------------

test('only error-level misses count, keyed as in .lighthouserc.cjs', () => {
  const failing = failingAssertions(RESULTS);
  assert.deepEqual(
    failing.map((f) => f.key),
    ['categories:seo', 'server-response-time', 'categories:seo'],
  );
  assert.equal(
    issueTitle({ failing }),
    'Lighthouse regression on main: categories:seo, server-response-time',
  );
});

test('a missing results file is still an alert, with a reason', () => {
  const r = loadAssertionResults(join(dir, 'nope.json'));
  assert.equal(r.found, false);
  assert.match(r.error, /does not exist/);
  assert.equal(
    issueTitle(r),
    'Lighthouse regression on main: run failed before assertions finished',
  );
});

test('an unreadable results file is reported, not thrown', () => {
  const r = loadAssertionResults(writeFixture('bad', '{not json'));
  assert.equal(r.found, false);
  assert.match(r.error, /unreadable/);
});

test('the table escapes pipes, formats numbers, and links reports when known', () => {
  const failing = failingAssertions(RESULTS);
  const table = assertionTable(failing, {
    'http://localhost:8788/products': 'https://storage.example/report-1',
  });
  const lines = table.split('\n');
  assert.equal(lines[0], '| Page | Assertion | Expected | Found |');
  assert.equal(
    lines[2],
    '| [/products](https://storage.example/report-1) | `categories:seo` | >= 0.90 | 0.63 |',
  );
  assert.equal(lines[3], '| `/search` | `server-response-time` | <= 600 | 812 |');
  const piped = assertionTable([
    { url: 'x', key: 'a|b', operator: '<=', expected: 1, actual: NaN },
  ]);
  assert.ok(piped.includes('a\\|b'));
  assert.ok(piped.includes('not measured'));
});

test('pickLabel prefers the AECI team label, accepts a workspace label, rejects other teams', () => {
  assert.equal(pickLabel([{ id: 'o', team: { key: 'OTHER' } }]), null);
  assert.equal(pickLabel([{ id: 'w', team: null }]).id, 'w');
  assert.equal(
    pickLabel([
      { id: 'w', team: null },
      { id: 't', team: { key: 'AECI' } },
    ]).id,
    't',
  );
});

// --- linear: failure ------------------------------------------------------

test('no open issue: creates the label, then a Bug with both labels and the assignee', async () => {
  const resultsPath = writeFixture('create', RESULTS);
  const { calls, fetchImpl } = linearMock({
    LighthouseAlertContext: context(),
    LighthouseAlertLabel: {
      body: { data: { issueLabelCreate: { success: true, issueLabel: { id: 'lab-new' } } } },
    },
    LighthouseAlertIssue: created,
  });
  const { log } = quiet();
  const { code, outputs } = await withOutput((out) =>
    main(
      ['linear', '--outcome=failure', `--results=${resultsPath}`],
      { ...ENV, LINEAR_API_KEY: 'lin_test', GITHUB_OUTPUT: out },
      { fetchImpl, log },
    ),
  );
  assert.equal(code, 0);
  assert.deepEqual(
    calls.map((c) => c.op),
    ['LighthouseAlertContext', 'LighthouseAlertLabel', 'LighthouseAlertIssue'],
  );
  assert.equal(calls[0].url, LINEAR_GRAPHQL_URL);
  assert.equal(calls[0].init.headers.Authorization, 'lin_test');
  assert.deepEqual(calls[0].variables, {
    teamKey: 'AECI',
    label: REGRESSION_LABEL,
    bug: BUG_LABEL,
    email: ASSIGNEE_EMAIL,
  });
  assert.deepEqual(calls[1].variables.input.teamId, 'team-1');
  assert.equal(calls[1].variables.input.name, REGRESSION_LABEL);
  const input = calls[2].variables.input;
  assert.equal(input.teamId, 'team-1');
  assert.deepEqual(input.labelIds, ['bug-1', 'lab-new']);
  assert.equal(input.assigneeId, 'user-1');
  assert.equal(input.title, 'Lighthouse regression on main: categories:seo, server-response-time');
  assert.ok(input.description.includes(SHA.slice(0, 12)));
  assert.ok(input.description.includes(RUN_URL));
  assert.ok(input.description.includes('A red here means main regressed'));
  assert.ok(input.description.includes('| `/search` | `server-response-time` | <= 600 | 812 |'));
  assert.equal(outputs.issue_created, 'true');
  assert.equal(outputs.issue_url, 'https://linear.app/x/AECI-77');
  assert.equal(outputs.action, 'created');
});

test('an existing label is reused, not recreated', async () => {
  const { calls, fetchImpl } = linearMock({
    LighthouseAlertContext: context({
      regressionLabels: [{ id: 'lab-old', name: REGRESSION_LABEL, team: { key: 'AECI' } }],
    }),
    LighthouseAlertIssue: created,
  });
  const code = await main(
    ['linear', '--outcome=failure', `--results=${join(dir, 'none.json')}`],
    { ...ENV, LINEAR_API_KEY: 'k' },
    { fetchImpl, log: () => {} },
  );
  assert.equal(code, 0);
  assert.deepEqual(
    calls.map((c) => c.op),
    ['LighthouseAlertContext', 'LighthouseAlertIssue'],
  );
  assert.deepEqual(calls[1].variables.input.labelIds, ['bug-1', 'lab-old']);
  assert.match(calls[1].variables.input.description, /No assertion results/);
});

test('a missing Bug label or user files the issue anyway, with a warning', async (t) => {
  const warnings = [];
  t.mock.method(console, 'error', (l) => warnings.push(l));
  const { calls, fetchImpl } = linearMock({
    LighthouseAlertContext: context({
      regressionLabels: [{ id: 'lab-old', team: null }],
      bugLabels: [{ id: 'bug-other', team: { key: 'OTHER' } }],
      users: [],
    }),
    LighthouseAlertIssue: created,
  });
  const code = await main(
    ['linear', '--outcome=failure', `--results=${join(dir, 'none.json')}`],
    { ...ENV, LINEAR_API_KEY: 'k' },
    { fetchImpl, log: () => {} },
  );
  assert.equal(code, 0);
  const input = calls[1].variables.input;
  assert.deepEqual(input.labelIds, ['lab-old']);
  assert.equal('assigneeId' in input, false);
  assert.match(warnings.join('\n'), /no "Bug" label/);
  assert.match(warnings.join('\n'), /Filing unassigned/);
});

test('an open issue gets a comment, no new issue, and issue_created=false', async () => {
  const resultsPath = writeFixture('comment', RESULTS);
  const { calls, fetchImpl } = linearMock({
    LighthouseAlertContext: context({ open: OPEN }),
    LighthouseAlertComment: commented,
  });
  const { code, outputs } = await withOutput((out) =>
    main(
      ['linear', '--outcome=failure', `--results=${resultsPath}`],
      { ...ENV, LINEAR_API_KEY: 'k', GITHUB_OUTPUT: out },
      { fetchImpl, log: () => {} },
    ),
  );
  assert.equal(code, 0);
  assert.deepEqual(
    calls.map((c) => c.op),
    ['LighthouseAlertContext', 'LighthouseAlertComment'],
  );
  assert.equal(calls[1].variables.input.issueId, 'issue-9');
  assert.match(calls[1].variables.input.body, /^Still failing at /);
  assert.ok(calls[1].variables.input.body.includes(RUN_URL));
  assert.ok(calls[1].variables.input.body.includes('`categories:seo`'));
  assert.equal(outputs.issue_created, 'false');
  assert.equal(outputs.action, 'commented');
});

// --- linear: recovery -----------------------------------------------------

test('a green run comments "recovered" on the open issue and never closes it', async () => {
  const { calls, fetchImpl } = linearMock({
    LighthouseAlertContext: context({ open: OPEN }),
    LighthouseAlertComment: commented,
  });
  const code = await main(
    ['linear', '--outcome=success'],
    { ...ENV, LINEAR_API_KEY: 'k' },
    { fetchImpl, log: () => {} },
  );
  assert.equal(code, 0);
  assert.deepEqual(
    calls.map((c) => c.op),
    ['LighthouseAlertContext', 'LighthouseAlertComment'],
  );
  const body = calls[1].variables.input.body;
  assert.ok(body.startsWith(`Recovered at [\`${SHA.slice(0, 12)}\`]`));
  assert.ok(body.includes(`run ${RUN_URL}`));
  assert.ok(calls.every((c) => !/issueUpdate|stateId/.test(c.init.body)));
});

test('a green run with no open issue does nothing after the lookup', async () => {
  const { calls, fetchImpl } = linearMock({ LighthouseAlertContext: context() });
  const { code, outputs } = await withOutput((out) =>
    main(
      ['linear', '--outcome=success'],
      { ...ENV, LINEAR_API_KEY: 'k', GITHUB_OUTPUT: out },
      { fetchImpl, log: () => {} },
    ),
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(outputs.action, 'noop');
});

// --- linear: failures -----------------------------------------------------

test('a non-2xx Linear response exits 1 with the response text', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (l) => errors.push(l));
  const { fetchImpl } = linearMock({
    LighthouseAlertContext: { status: 401, body: 'Authentication required' },
  });
  const code = await main(
    ['linear', '--outcome=failure'],
    { ...ENV, LINEAR_API_KEY: 'k', GITHUB_ACTIONS: 'true' },
    { fetchImpl, log: () => {} },
  );
  assert.equal(code, 1);
  assert.match(
    errors.join('\n'),
    /^::error::Lighthouse alert, Linear step failed: .*HTTP 401.*Authentication required/,
  );
});

test('GraphQL errors on a 200 exit 1', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { fetchImpl } = linearMock({
    LighthouseAlertContext: context(),
    LighthouseAlertLabel: { body: { errors: [{ message: 'label name taken' }] } },
  });
  const code = await main(
    ['linear', '--outcome=failure'],
    { ...ENV, LINEAR_API_KEY: 'k' },
    { fetchImpl, log: () => {} },
  );
  assert.equal(code, 1);
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

test('a bad --outcome exits 2', async (t) => {
  t.mock.method(console, 'error', () => {});
  assert.equal(await main(['linear', '--outcome=red'], ENV, {}), 2);
  assert.equal(await main(['nope'], ENV, {}), 2);
});

// --- email ----------------------------------------------------------------

test('email goes from the verified sender to support@, with the run and the issue', async () => {
  const resultsPath = writeFixture('email', RESULTS);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'resend-1' }), { status: 200 });
  };
  const code = await main(
    ['email', `--results=${resultsPath}`, '--issue-url=https://linear.app/x/AECI-77'],
    { ...ENV, RESEND_API_KEY: 're_test' },
    { fetchImpl, log: () => {} },
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RESEND_EMAILS_URL);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'lighthouse-alert/42/1');
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.from, EMAIL_FROM);
  assert.equal(EMAIL_FROM, 'AEC Integrations <notifications@aecintegrations.com>');
  assert.deepEqual(payload.to, [EMAIL_TO]);
  assert.equal(
    payload.subject,
    'Lighthouse regression on main: categories:seo, server-response-time',
  );
  assert.ok(payload.text.includes(RUN_URL));
  assert.ok(payload.text.includes('Linear issue: https://linear.app/x/AECI-77'));
});

test('email without an issue URL says the issue could not be filed', () => {
  const p = emailPayload({ failing: [], found: false }, { sha: SHA, runUrl: RUN_URL }, '');
  assert.match(p.text, /could not be filed/);
  assert.ok(!p.text.includes('Linear issue: '));
});

test('a non-2xx Resend response exits 1 with the response text', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (l) => errors.push(l));
  const code = await main(
    ['email', `--results=${join(dir, 'none.json')}`],
    { ...ENV, RESEND_API_KEY: 're_test' },
    {
      fetchImpl: async () =>
        new Response('{"message":"The domain is not verified"}', { status: 403 }),
      log: () => {},
    },
  );
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /HTTP 403.*domain is not verified/);
});

// --- dry run --------------------------------------------------------------

test('--dry-run prints every payload and never calls fetch', async () => {
  const fetchImpl = async () => {
    throw new Error('dry run must not fetch');
  };
  const linear = quiet();
  assert.equal(
    await main(['linear', '--outcome=failure', '--dry-run'], ENV, {
      fetchImpl,
      log: linear.log,
    }),
    0,
  );
  const printed = linear.lines.join('\n');
  assert.match(printed, /Linear LighthouseAlertContext \(dry run, not sent\)/);
  assert.match(printed, /Linear LighthouseAlertLabel/);
  assert.match(printed, /Linear LighthouseAlertIssue/);

  const existing = quiet();
  await main(['linear', '--outcome=failure', '--dry-run', '--dry-run-open-issue'], ENV, {
    fetchImpl,
    log: existing.log,
  });
  assert.match(existing.lines.join('\n'), /LighthouseAlertComment/);
  assert.doesNotMatch(existing.lines.join('\n'), /LighthouseAlertIssue/);

  const email = quiet();
  assert.equal(await main(['email', '--dry-run'], ENV, { fetchImpl, log: email.log }), 0);
  assert.match(email.lines.join('\n'), /Resend POST \/emails \(dry run, not sent\)/);
});

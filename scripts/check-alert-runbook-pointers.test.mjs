import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkRunbookPointers, headingsOf } from './check-alert-runbook-pointers.mjs';

const RUNBOOK = [
  '# Runbooks',
  '## High Worker error rate',
  '### A scheduled job failed',
  '## Erasure left an `auth.users` row behind',
  '```bash',
  '# Not a heading, inside a fence',
  '```',
].join('\n');

const docs = {
  'docs/runbooks/alerts.md': RUNBOOK,
  'docs/email.md': '## Delivery webhooks (AECI-1222)',
};
const readDoc = (path) => docs[path] ?? null;
const check = (...runbooks) =>
  checkRunbookPointers(
    { alerts: runbooks.map((runbook, i) => ({ key: `a${i}`, runbook })) },
    readDoc,
  );

test('headingsOf reads every level and skips fenced code', () => {
  const h = headingsOf(RUNBOOK);
  assert.ok(h.has('High Worker error rate'));
  assert.ok(h.has('A scheduled job failed'));
  assert.ok(!h.has('Not a heading, inside a fence'));
});

test('a pointer naming a real heading passes', () => {
  assert.deepEqual(check("docs/runbooks/alerts.md — 'High Worker error rate'. More text."), []);
});

test('a pointer naming a missing heading fails', () => {
  assert.deepEqual(check("docs/runbooks/alerts.md — 'Worker error rate high'."), [
    "a0: docs/runbooks/alerts.md has no heading 'Worker error rate high'",
  ]);
});

test('a prefix of a heading is not a match', () => {
  assert.equal(check("docs/runbooks/alerts.md — 'High Worker'").length, 1);
});

test('backticks in the heading do not have to be repeated in the pointer', () => {
  assert.deepEqual(check("docs/runbooks/alerts.md — 'Erasure left an auth.users row behind'."), []);
});

test('an escaped em dash in the JSON source reads the same as a literal one', () => {
  const parsed = JSON.parse(
    String.raw`{"alerts":[{"key":"x","runbook":"docs/runbooks/alerts.md — 'A scheduled job failed'."}]}`,
  );
  assert.deepEqual(checkRunbookPointers(parsed, readDoc), []);
});

test('a missing doc, a missing pointer and a § pointer each fail', () => {
  const errors = checkRunbookPointers(
    {
      alerts: [
        { key: 'gone', runbook: 'docs/nope.md for the rules.' },
        { key: 'empty', runbook: '' },
        { key: 'none' },
        { key: 'section', runbook: 'docs/email.md §Delivery webhooks (what each event means).' },
      ],
    },
    readDoc,
  );
  assert.deepEqual(errors, [
    'gone: docs/nope.md does not exist',
    'empty: no runbook pointer',
    'none: no runbook pointer',
    `section: "docs/email.md §…" cannot be checked. Write docs/email.md — 'Heading' instead`,
  ]);
});

test('a path in backticks is checked like a bare one', () => {
  assert.deepEqual(check('`docs/gone.md` for the rules.'), ['a0: docs/gone.md does not exist']);
  assert.deepEqual(check("`docs/runbooks/alerts.md` — 'Nope'"), [
    "a0: docs/runbooks/alerts.md has no heading 'Nope'",
  ]);
  assert.deepEqual(check("`docs/runbooks/alerts.md` — 'High Worker error rate'"), []);
  assert.equal(check('`docs/email.md` §Delivery webhooks').length, 1);
});

test('a whole-doc reference with no heading passes when the doc exists', () => {
  assert.deepEqual(check('docs/email.md for the transport.'), []);
});

test('the committed alerts.json passes the gate', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'check-alert-runbook-pointers.mjs');
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

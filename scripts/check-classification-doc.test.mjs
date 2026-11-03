/**
 * `scripts/ci/check-classification-doc.mjs` and its workflow (AECI-1577). Runs under
 * `node --test` from root `pnpm test:scripts`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DOC_PATH,
  hasOptOut,
  undocumentedChanges,
  WATCHED_FILES,
} from './ci/check-classification-doc.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WATCHED = 'apps/api/src/lib/client-signals.ts';
const OPT_OUT = '**Classification doc:** no rule impact — renames a local variable only';

test('every watched file and the doc exist, so a rename cannot retire the check', () => {
  for (const path of [...WATCHED_FILES, DOC_PATH]) {
    assert.ok(existsSync(join(REPO_ROOT, path)), `${path} does not exist`);
  }
});

test('passes when no watched file changed', () => {
  assert.deepEqual(undocumentedChanges(['README.md', 'apps/api/src/lib/audit.ts'], ''), []);
});

test('a spec beside a watched file is not watched', () => {
  assert.deepEqual(undocumentedChanges(['apps/api/src/lib/client-signals.spec.ts'], ''), []);
});

test('fails when a watched file changed without the doc, and names the file', () => {
  assert.deepEqual(undocumentedChanges([WATCHED, 'README.md'], ''), [WATCHED]);
  assert.deepEqual(undocumentedChanges([WATCHED], undefined), [WATCHED]);
});

test('passes when the doc changed too', () => {
  assert.deepEqual(undocumentedChanges([WATCHED, DOC_PATH], ''), []);
});

test('passes on the opt-out line anywhere in the description', () => {
  assert.deepEqual(undocumentedChanges([WATCHED], `Closes AECI-1\r\n\r\n${OPT_OUT}\r\n`), []);
});

test('accepts the dash forms the legal line accepts', () => {
  assert.ok(hasOptOut('**Classification doc:** no rule impact - renames a local variable'));
  assert.ok(hasOptOut('**Classification doc:** No rule impact: renames a local variable'));
});

test('rejects a missing reason, a short reason, the placeholder and other wording', () => {
  for (const line of [
    '**Classification doc:** no rule impact',
    '**Classification doc:** no rule impact — ',
    '**Classification doc:** no rule impact — refactor',
    '**Classification doc:** no rule impact — <one sentence>',
    '**Classification doc:** skip — renames a local variable only',
    'Classification doc: no rule impact — renames a local variable only',
    `> ${OPT_OUT}`,
  ]) {
    assert.equal(hasOptOut(line), false, line);
  }
});

test('the PR template hint does not itself opt out', () => {
  const template = readFileSync(join(REPO_ROOT, '.github/pull_request_template.md'), 'utf8');
  assert.match(template, /Classification doc/);
  assert.equal(hasOptOut(template), false);
});

test('the workflow re-runs on an edit, reports on every PR and takes the body through env', () => {
  const yml = readFileSync(
    join(REPO_ROOT, '.github/workflows/classification-doc-check.yml'),
    'utf8',
  );
  assert.match(yml, /types: \[opened, edited, synchronize, reopened\]/);
  assert.doesNotMatch(yml, /^\s*(paths|paths-ignore|branches):/m);
  assert.match(yml, /fetch-depth: 2/);
  assert.match(yml, /PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/);
  const expressions = yml.split('\n').filter((l) => l.includes('pull_request.body'));
  assert.equal(expressions.length, 1, 'the body may only appear in env');
});

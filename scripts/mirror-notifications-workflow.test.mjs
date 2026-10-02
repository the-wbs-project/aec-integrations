/**
 * `.github/workflows/mirror-notifications-doc.yml` (AECI-1201). The job holds a
 * write-capable Linear key, so every action is pinned to a full commit SHA with its
 * version in a trailing comment, and checkout drops the GITHUB_TOKEN from
 * `.git/config`. Runs under `node --test` from root `pnpm test:scripts`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOW = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '.github',
    'workflows',
    'mirror-notifications-doc.yml',
  ),
  'utf8',
);

const usesLines = WORKFLOW.split('\n').filter((line) => /^\s*-?\s*uses:/.test(line));

test('the workflow uses at least checkout and setup-node', () => {
  const actions = usesLines.map((line) => line.match(/uses:\s*([^@\s]+)@/)?.[1]);
  assert.ok(actions.includes('actions/checkout'));
  assert.ok(actions.includes('actions/setup-node'));
});

test('every action is pinned to a full commit SHA with a # vX.Y.Z comment', () => {
  for (const line of usesLines) {
    assert.match(
      line,
      /uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/,
      `not pinned to a SHA with a version comment: ${line.trim()}`,
    );
  }
});

test('checkout does not persist the GITHUB_TOKEN', () => {
  const step = WORKFLOW.match(/uses: actions\/checkout@[^\n]*\n((?:\s{8,}[^\n]*\n)*)/);
  assert.ok(step, 'checkout step not found');
  assert.match(step[1], /^\s+with:\s*$/m);
  assert.match(step[1], /^\s+persist-credentials: false\s*$/m);
});

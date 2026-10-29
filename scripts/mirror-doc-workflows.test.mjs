/**
 * `.github/workflows/mirror-*-doc.yml` (AECI-1201, AECI-1431). Each job holds a
 * write-capable Linear key, so every action is pinned to a full commit SHA with its
 * version in a trailing comment, and checkout drops the GITHUB_TOKEN from
 * `.git/config`. Each workflow mirrors exactly the doc it triggers on, into the Linear
 * Document its own variable names. Runs under `node --test` from root `pnpm test:scripts`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MIRRORED_DOCS } from './mirror-doc-to-linear.mjs';

const WORKFLOWS = {
  'mirror-notifications-doc.yml': 'docs/NOTIFICATIONS.md',
  'mirror-pricing-rules-doc.yml': 'docs/PRICING_RULES.md',
};

test('every mirrored doc has a workflow', () => {
  assert.deepEqual(Object.values(WORKFLOWS).sort(), Object.keys(MIRRORED_DOCS).sort());
});

for (const [file, sourcePath] of Object.entries(WORKFLOWS)) {
  const WORKFLOW = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', file),
    'utf8',
  );
  const usesLines = WORKFLOW.split('\n').filter((line) => /^\s*-?\s*uses:/.test(line));
  const docIdVar = MIRRORED_DOCS[sourcePath];

  test(`${file} uses at least checkout and setup-node`, () => {
    const actions = usesLines.map((line) => line.match(/uses:\s*([^@\s]+)@/)?.[1]);
    assert.ok(actions.includes('actions/checkout'));
    assert.ok(actions.includes('actions/setup-node'));
  });

  test(`${file} pins every action to a full commit SHA with a # vX.Y.Z comment`, () => {
    for (const line of usesLines) {
      assert.match(
        line,
        /uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/,
        `not pinned to a SHA with a version comment: ${line.trim()}`,
      );
    }
  });

  test(`${file} checkout does not persist the GITHUB_TOKEN`, () => {
    const step = WORKFLOW.match(/uses: actions\/checkout@[^\n]*\n((?:\s{8,}[^\n]*\n)*)/);
    assert.ok(step, 'checkout step not found');
    assert.match(step[1], /^\s+with:\s*$/m);
    assert.match(step[1], /^\s+persist-credentials: false\s*$/m);
  });

  test(`${file} triggers on, and mirrors, only ${sourcePath}`, () => {
    assert.match(WORKFLOW, new RegExp(`paths:\\s*\\n\\s*- '${sourcePath}'\\s*\\n`));
    assert.ok(
      WORKFLOW.includes(`run: node scripts/mirror-doc-to-linear.mjs --source ${sourcePath}\n`),
    );
    assert.ok(WORKFLOW.includes(`vars.${docIdVar} != ''`));
    assert.ok(WORKFLOW.includes(`${docIdVar}: \${{ vars.${docIdVar} }}`));
  });
}

/**
 * `.github/workflows/mirror-docs-to-linear.yml` (AECI-1549). The job holds a write-capable
 * Linear key, so every action is pinned to a full commit SHA with its version in a trailing
 * comment, checkout drops the GITHUB_TOKEN from `.git/config`, and no event text reaches a
 * `run:` block. Runs under `node --test` from root `pnpm test:scripts`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = readFileSync(
  join(ROOT, '.github', 'workflows', 'mirror-docs-to-linear.yml'),
  'utf8',
);
const usesLines = WORKFLOW.split('\n').filter((line) => /^\s*-?\s*uses:/.test(line));

test('the one-workflow-per-doc mirrors are gone', () => {
  for (const file of ['mirror-notifications-doc.yml', 'mirror-pricing-rules-doc.yml']) {
    assert.ok(!existsSync(join(ROOT, '.github', 'workflows', file)), file);
  }
});

test('uses at least checkout and setup-node', () => {
  const actions = usesLines.map((line) => line.match(/uses:\s*([^@\s]+)@/)?.[1]);
  assert.ok(actions.includes('actions/checkout'));
  assert.ok(actions.includes('actions/setup-node'));
});

test('pins every action to a full commit SHA with a # vX.Y.Z comment', () => {
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
  assert.match(step[1], /^\s+persist-credentials: false\s*$/m);
});

test('triggers on Markdown and the mapping, and runs sync', () => {
  assert.match(
    WORKFLOW,
    /paths:\s*\n(?:\s*#[^\n]*\n)*\s*- '\*\*\.md'\s*\n\s*- 'docs\/linear-docs\.json'\s*\n/,
  );
  assert.match(WORKFLOW, /^\s+workflow_dispatch:/m);
  assert.ok(WORKFLOW.includes('run: node scripts/mirror-docs-to-linear.mjs sync\n'));
});

test('reads no event payload, and no expression reaches a run block', () => {
  const runLines = WORKFLOW.split('\n').filter((line) => /^\s*run:/.test(line));
  for (const line of runLines) assert.ok(!line.includes('${{'), line.trim());
  assert.ok(!/github\.event\./.test(WORKFLOW));
});

test('mirrors every doc on every run: no diff-based selection', () => {
  // A superseded pending run is cancelled, so a diff-based run would drop its doc.
  assert.ok(!WORKFLOW.includes('MIRROR_BEFORE_SHA'));
  assert.ok(!/fetch-depth/.test(WORKFLOW));
});

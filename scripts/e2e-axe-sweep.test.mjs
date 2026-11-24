/**
 * The e2e axe sweep's two rules (AECI-1876). Runs under `node --test` from root `pnpm test:scripts`.
 *
 *   1. Every e2e spec takes `test` from `apps/web/e2e/fixtures.ts`. A spec that imports `test`
 *      from `@playwright/test` would skip the sweep without anyone noticing.
 *   2. Every opt-out is listed below, with its reason. Adding or removing an `axeOptOut()` call
 *      means changing `OPT_OUTS`, so the count shows in the diff. A reason must be a literal string.
 *
 * `docs/TESTING_STRATEGY.md` §8.2 describes the sweep.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const E2E_DIR = join(ROOT, 'apps', 'web', 'e2e');

/**
 * Every `axeOptOut()` call in `apps/web/e2e/`, as `file: [reasons]`. One entry per call site.
 * A call in a `beforeEach` opts out every test of its block.
 */
const HELD_CHUNK = 'The test holds back a lazy chunk, so the app never becomes stable to scan.';
export const OPT_OUTS = {
  // Three tests, one per SEARCH_FORM_ROUTES entry.
  'forms-before-hydration.spec.ts': [
    'The test ends on a stub page it serves itself to catch the form request.',
  ],
  // A `beforeEach` (two tests), then three tests of the desktop panel.
  'nav-menu.spec.ts': [HELD_CHUNK, HELD_CHUNK, HELD_CHUNK, HELD_CHUNK],
  // A `beforeEach`: six tests, one per width.
  'products-detail.spec.ts': [
    'The test rewrites the h1 text in place, so hydration can see a DOM it did not render.',
  ],
};

/** Drop comments so a sentence about a call is not a call. Same rule as a11y-known-failures. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function specFiles() {
  return readdirSync(E2E_DIR)
    .filter((f) => f.endsWith('.spec.ts') && !f.endsWith('.unit.spec.ts'))
    .sort();
}

/** The `test` import problems in one spec. */
export function importProblems(file, source) {
  const code = stripComments(source);
  const problems = [];
  for (const m of code.matchAll(/import\s*(type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\3/g)) {
    if (m[1]) continue;
    const names = m[2].split(',').map((s) => s.trim());
    const takesTest = names.some((n) => n === 'test' || n.startsWith('test as '));
    if (takesTest && m[4] === '@playwright/test') {
      problems.push(
        `${file}: imports \`test\` from '@playwright/test'. Import it from './fixtures'.`,
      );
    }
  }
  if (/\btest(\.describe)?(\.(only|skip|fixme|serial|parallel))*\s*\(/.test(code)) {
    const fromFixtures = /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*['"]\.\/fixtures['"]/.test(code);
    if (!fromFixtures)
      problems.push(`${file}: defines tests but does not import \`test\` from './fixtures'.`);
  }
  return problems;
}

/** Every `axeOptOut(` call, with its literal reason or a problem. */
export function optOutCalls(file, source) {
  const code = stripComments(source);
  const reasons = [];
  const problems = [];
  for (const m of code.matchAll(/\baxeOptOut\s*\(/g)) {
    const rest = code.slice(m.index + m[0].length);
    const lit = rest.match(/^\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1\s*,?\s*\)/);
    if (!lit || (lit[1] === '`' && lit[2].includes('${'))) {
      problems.push(`${file}: axeOptOut( needs a literal reason string.`);
    } else {
      reasons.push(lit[2]);
    }
  }
  return { reasons, problems };
}

// --- the scanners -------------------------------------------------------------

test('a spec importing test from @playwright/test is refused', () => {
  assert.equal(
    importProblems(
      'a.spec.ts',
      "import { expect, test } from '@playwright/test';\ntest('x', () => {});",
    ).length,
    2,
  );
  assert.deepEqual(
    importProblems('a.spec.ts', "import { expect, test } from './fixtures';\ntest('x', () => {});"),
    [],
  );
  assert.deepEqual(
    importProblems(
      'a.spec.ts',
      "import type { Page } from '@playwright/test';\nimport { test } from './fixtures';\ntest.describe('x', () => {});",
    ),
    [],
  );
});

test('an opt-out needs a literal reason', () => {
  assert.deepEqual(optOutCalls('a.spec.ts', "axeOptOut('JavaScript is off');").reasons, [
    'JavaScript is off',
  ]);
  assert.equal(optOutCalls('a.spec.ts', 'axeOptOut(reason);').problems.length, 1);
  assert.equal(optOutCalls('a.spec.ts', 'axeOptOut(`x ${y}`);').problems.length, 1);
  assert.deepEqual(optOutCalls('a.spec.ts', '// axeOptOut(reason) in a comment').reasons, []);
});

// --- the real suite -----------------------------------------------------------

test('every e2e spec takes test from ./fixtures', () => {
  const files = specFiles();
  assert.ok(files.length > 50, `expected the e2e specs in ${E2E_DIR}`);
  const problems = files.flatMap((f) => importProblems(f, readFileSync(join(E2E_DIR, f), 'utf8')));
  assert.deepEqual(problems, []);
});

test('every axe opt-out is listed, with its reason', () => {
  const found = {};
  const problems = [];
  for (const f of specFiles()) {
    const { reasons, problems: p } = optOutCalls(f, readFileSync(join(E2E_DIR, f), 'utf8'));
    problems.push(...p);
    if (reasons.length > 0) found[f] = reasons;
  }
  assert.deepEqual(problems, []);
  assert.deepEqual(
    found,
    OPT_OUTS,
    'An axeOptOut() call was added, removed or reworded. Update OPT_OUTS in this file to match.',
  );
});

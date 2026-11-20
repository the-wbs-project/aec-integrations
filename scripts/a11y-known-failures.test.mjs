/**
 * AECI-1875: the known-failure rule for the accessibility nightly (`apps/web/e2e-a11y/`).
 *
 * A nightly test may be marked as failing only through `knownFailure('AECI-<n>', reason)`
 * from `apps/web/e2e-a11y/known-failure.ts`, so every known failure names its Linear issue.
 * This test fails when any other file in `e2e-a11y/` calls `.fail(` directly, or when a
 * `knownFailure(` call's first argument is not a literal `'AECI-<n>'`.
 *
 * Runs under `node --test` from root `pnpm test:scripts`. `docs/TESTING_STRATEGY.md` §8.4.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUITE_DIR = join(ROOT, 'apps', 'web', 'e2e-a11y');
/** The helper itself is the one file allowed to call `test.fail`. */
const HELPER = 'known-failure.ts';

/** Drop comments so a sentence about `test.fail()` is not a call. Good enough for specs. */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** Every rule break in one file. `file` is the path the message shows. */
export function scanSource(file, source) {
  if (file.split(/[\\/]/).pop() === HELPER) return [];
  const code = stripComments(source);
  const problems = [];
  for (const m of code.matchAll(/\.fail\s*\(/g)) {
    problems.push(
      `${file}:${lineOf(code, m.index)}: bare \`.fail(\`. Use knownFailure('AECI-<n>', reason) from ./known-failure.`,
    );
  }
  for (const m of code.matchAll(/\bknownFailure\s*\(/g)) {
    const args = code.slice(m.index + m[0].length);
    if (!/^\s*(['"`])AECI-\d+\1\s*,/.test(args)) {
      problems.push(
        `${file}:${lineOf(code, m.index)}: knownFailure( needs a literal 'AECI-<n>' as its first argument.`,
      );
    }
  }
  return problems;
}

function suiteFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return suiteFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

// --- the scanner itself -------------------------------------------------------

test('a knownFailure call with a literal AECI id passes', () => {
  const src = `test('x', () => {\n  knownFailure('AECI-1876', 'focus ring missing');\n});`;
  assert.deepEqual(scanSource('a.spec.ts', src), []);
  assert.deepEqual(scanSource('a.spec.ts', 'knownFailure("AECI-7", "why")'), []);
});

test('a knownFailure call without a literal AECI id fails', () => {
  for (const src of [
    "knownFailure('BAD', 'why')",
    "knownFailure('aeci-12', 'why')",
    "knownFailure(id, 'why')",
    'knownFailure(`AECI-${n}`, "why")',
    'knownFailure()',
  ]) {
    assert.equal(scanSource('a.spec.ts', src).length, 1, src);
  }
});

test('a bare test.fail fails, in any form', () => {
  for (const src of [
    'test.fail();',
    'test.fail(true, "x");',
    'test.describe.fail("x", () => {});',
  ]) {
    const problems = scanSource('a.spec.ts', src);
    assert.equal(problems.length, 1, src);
    assert.match(problems[0], /^a\.spec\.ts:1: bare `\.fail\(`/);
  }
});

test('comments do not count, and the helper file is exempt', () => {
  assert.deepEqual(
    scanSource('a.spec.ts', '// never call test.fail() here\n/* knownFailure(x) */'),
    [],
  );
  assert.deepEqual(scanSource('e2e-a11y/known-failure.ts', 'test.fail(true, reason);'), []);
});

test('the reported line is the line of the call', () => {
  const problems = scanSource('a.spec.ts', 'one\ntwo\n  test.fail();');
  assert.match(problems[0], /^a\.spec\.ts:3:/);
});

// --- the real suite -----------------------------------------------------------

test('apps/web/e2e-a11y has the helper and follows the known-failure rule', () => {
  const files = suiteFiles(SUITE_DIR);
  assert.ok(
    files.some((f) => f.endsWith(HELPER)),
    `${HELPER} is missing from apps/web/e2e-a11y`,
  );
  const problems = files.flatMap((f) => scanSource(relative(ROOT, f), readFileSync(f, 'utf8')));
  assert.deepEqual(problems, []);
});

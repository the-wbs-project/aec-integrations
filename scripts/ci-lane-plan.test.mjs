/**
 * `scripts/ci/lane-plan.mjs` and `scripts/ci/coverage-advisory.mjs`. Runs under
 * `node --test` from root `pnpm test:scripts`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { misses, parseThresholds } from './ci/coverage-advisory.mjs';
import {
  fullPlan,
  litePlan,
  parseNameStatus,
  plan,
  rootLevelFiles,
  withHiddenReaders,
} from './ci/lane-plan.mjs';

const BATCH_PR = { EVENT_NAME: 'pull_request', BASE_REF: 'batch/x' };

/** Fake git/pnpm for plan(). `diff` is the --name-status output. */
function fakeDeps({ diff = '', affected = [], merge = true, diffThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    git: (...args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') {
        if (!merge) throw new Error('not a merge');
        return 'abc';
      }
      if (args[0] === 'diff') {
        if (diffThrows) throw new Error('fatal: bad revision HEAD^1\nmore detail');
        return diff;
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
    affectedPackages: () => affected,
    rootName: () => 'aec-integrations',
  };
}

test('package files and Markdown keep the lite lane', () => {
  assert.deepEqual(
    rootLevelFiles([
      'apps/api/src/index.ts',
      'packages/shared/src/api/x.ts',
      'apps/web/src/content/docs/vendors/your-seat.md',
      'docs/API_CONTRACTS.md',
      'CLAUDE.md',
      '',
    ]),
    [],
  );
});

test('root-level files force the full lane', () => {
  const forcing = [
    'pnpm-lock.yaml',
    'package.json',
    'pnpm-workspace.yaml',
    'eslint.config.base.mjs',
    '.prettierrc.json',
    '.github/workflows/deploy.yml',
    'scripts/ops/backfill-page-view-bots.sql',
    'docs/trades-vocabulary.json',
    'apps/README',
  ];
  assert.deepEqual(rootLevelFiles(['apps/api/src/x.ts', ...forcing]), forcing);
});

test('non-batch events always take the full lane', () => {
  assert.deepEqual(plan({ EVENT_NAME: 'push', BASE_REF: '' }).plan, fullPlan());
  assert.deepEqual(plan({ EVENT_NAME: 'pull_request', BASE_REF: 'main' }).plan, fullPlan());
  assert.deepEqual(plan({ EVENT_NAME: 'pull_request', BASE_REF: 'stage-2' }).plan, fullPlan());
  // A push whose ref merely looks like a batch branch is still full.
  assert.deepEqual(plan({ EVENT_NAME: 'push', BASE_REF: 'batch/x' }).plan, fullPlan());
});

test('the full plan never selects the workspace root', () => {
  assert.equal(fullPlan().rest_filter, '--filter !@aeci/api --filter !{.}');
});

test('lite plan splits apps/api from the rest', () => {
  assert.deepEqual(litePlan(['@aeci/api']), {
    lane: 'lite',
    api: 'true',
    web: 'false',
    rest: 'false',
    lint_filter: '--filter @aeci/api',
    rest_filter: '',
  });
  assert.deepEqual(litePlan(['@aeci/shared', '@aeci/api', '@aeci/web']), {
    lane: 'lite',
    api: 'true',
    web: 'true',
    rest: 'true',
    lint_filter: '--filter @aeci/shared --filter @aeci/api --filter @aeci/web',
    rest_filter: '--filter @aeci/shared --filter @aeci/web',
  });
  assert.deepEqual(litePlan([]), {
    lane: 'lite',
    api: 'false',
    web: 'false',
    rest: 'false',
    lint_filter: '',
    rest_filter: '',
  });
});

test('a docs/ change brings apps/api into scope', () => {
  assert.deepEqual(withHiddenReaders([], ['docs/STAGE_2_SPEC.md']), ['@aeci/api']);
  assert.deepEqual(withHiddenReaders(['@aeci/web'], ['docs/x.md']), ['@aeci/web', '@aeci/api']);
  assert.deepEqual(withHiddenReaders(['@aeci/api'], ['docs/x.md']), ['@aeci/api']);
  assert.deepEqual(withHiddenReaders(['@aeci/web'], ['CLAUDE.md']), ['@aeci/web']);
});

test('an apps/datatool change brings apps/agent and apps/api into scope', () => {
  // apps/agent/src/access.spec.ts reads ../../datatool/src/access.ts.
  assert.deepEqual(withHiddenReaders(['@aeci/datatool'], ['apps/datatool/src/access.ts']), [
    '@aeci/datatool',
    '@aeci/agent',
    '@aeci/api',
  ]);
});

test('the other cross-package reads are mapped', () => {
  assert.deepEqual(withHiddenReaders(['@aeci/agent'], ['apps/agent/src/lib/corpus.ts']), [
    '@aeci/agent',
    '@aeci/api',
  ]);
  assert.deepEqual(withHiddenReaders(['@aeci/api'], ['apps/api/migrations/0099_x.sql']), [
    '@aeci/api',
    '@aeci/datatool',
    '@aeci/agent',
  ]);
  assert.deepEqual(withHiddenReaders(['@aeci/web'], ['apps/web/src/app/x.ts']), [
    '@aeci/web',
    '@aeci/shared',
  ]);
  assert.deepEqual(withHiddenReaders(['@aeci/api'], ['apps/api/src/index.ts']), [
    '@aeci/api',
    '@aeci/shared',
  ]);
  // apps/web's eslint-config spec resolves apps/api's ESLint config.
  assert.deepEqual(withHiddenReaders(['@aeci/api'], ['apps/api/eslint.config.mjs']), [
    '@aeci/api',
    '@aeci/web',
  ]);
  // An apps/api change outside migrations/, src/ and the ESLint config adds nothing.
  assert.deepEqual(withHiddenReaders(['@aeci/api'], ['apps/api/wrangler.jsonc']), ['@aeci/api']);
});

test('parseNameStatus splits status from path', () => {
  assert.deepEqual(parseNameStatus('M\tapps/api/a.ts\nD\tapps/web/b.ts\nA\tc d.ts\n'), [
    { status: 'M', path: 'apps/api/a.ts' },
    { status: 'D', path: 'apps/web/b.ts' },
    { status: 'A', path: 'c d.ts' },
  ]);
  assert.deepEqual(parseNameStatus(''), []);
});

test('the lite plan diffs with --name-status --no-renames', () => {
  const deps = fakeDeps({ diff: 'M\tapps/web/src/x.ts', affected: ['@aeci/web'] });
  const result = plan(BATCH_PR, deps);
  assert.equal(result.plan.lane, 'lite');
  assert.deepEqual(result.plan, litePlan(['@aeci/web', '@aeci/shared']));
  assert.ok(
    deps.calls.some((c) => c.join(' ') === 'diff --name-status --no-renames HEAD^1 HEAD'),
    'expected the --no-renames name-status diff',
  );
});

test('any deleted file forces the full lane', () => {
  const result = plan(
    BATCH_PR,
    fakeDeps({
      diff: 'M\tapps/web/src/x.ts\nD\tapps/datatool/src/gone.ts',
      affected: ['@aeci/web'],
    }),
  );
  assert.deepEqual(result.plan, fullPlan());
  assert.match(result.why, /deleted: apps\/datatool\/src\/gone\.ts/);
});

test('a rename shows its losing side as a deletion and forces the full lane', () => {
  // `--no-renames` reports a move as D old + A new.
  const result = plan(
    BATCH_PR,
    fakeDeps({ diff: 'D\tapps/api/src/old.ts\nA\tapps/web/src/new.ts', affected: ['@aeci/web'] }),
  );
  assert.deepEqual(result.plan, fullPlan());
});

test('a non-merge checkout takes the full lane', () => {
  assert.deepEqual(plan(BATCH_PR, fakeDeps({ merge: false })).plan, fullPlan());
});

test('a planning error falls back to the full lane with a warning', () => {
  const result = plan(BATCH_PR, fakeDeps({ diffThrows: true }));
  assert.deepEqual(result.plan, fullPlan());
  assert.match(result.warning, /full lane: fatal: bad revision HEAD\^1$/);

  const pnpmFails = fakeDeps({ diff: 'M\tapps/web/src/x.ts' });
  pnpmFails.affectedPackages = () => {
    throw new Error('pnpm ls exploded');
  };
  const second = plan(BATCH_PR, pnpmFails);
  assert.deepEqual(second.plan, fullPlan());
  assert.match(second.warning, /pnpm ls exploded/);
});

test('a successful plan carries no warning', () => {
  assert.equal(plan(BATCH_PR, fakeDeps({ diff: 'M\tapps/web/src/x.ts' })).warning, undefined);
  assert.equal(plan({ EVENT_NAME: 'push', BASE_REF: '' }).warning, undefined);
});

test('parseThresholds reads the vitest thresholds block', () => {
  const src = `coverage: { provider: 'v8', thresholds: {\n lines: 70,\n branches: 60,\n functions: 70,\n statements: 70.5,\n }, }`;
  assert.deepEqual(parseThresholds(src), {
    lines: 70,
    branches: 60,
    functions: 70,
    statements: 70.5,
  });
  assert.deepEqual(parseThresholds(`coverage: { provider: 'v8' }`), {});
});

test('misses reports only metrics under their threshold', () => {
  const total = {
    lines: { pct: 69.9 },
    branches: { pct: 61 },
    functions: { pct: 70 },
    statements: { pct: 50 },
  };
  assert.deepEqual(misses(total, { lines: 70, branches: 60, functions: 70 }), [
    { metric: 'lines', pct: 69.9, threshold: 70 },
  ]);
  assert.deepEqual(misses(total, {}), []);
});

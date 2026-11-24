/**
 * `scripts/a11y-nightly-merge-summary.mjs` (AECI-1876). Runs under `node --test` from root
 * `pnpm test:scripts`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  main,
  mergeAxe,
  mergeRules,
  mergeSummaries,
  readPart,
  summaryMarkdown,
} from './a11y-nightly-merge-summary.mjs';
import { loadSummary } from './a11y-nightly-alert.mjs';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'a11y-merge-'));
  dirs.push(d);
  return d;
}

const rule = (id, impact, tests, nodes, paths) => ({
  id,
  impact,
  help: `${id} help`,
  helpUrl: `https://dequeuniversity.com/rules/axe/4.11/${id}`,
  tests,
  nodes,
  paths,
});

const axeBlock = (over = {}) => ({
  violationsByImpact: { critical: 0, serious: 1, moderate: 0, minor: 0 },
  scans: { scanned: 10, optedOut: 1, notScanned: 2 },
  optOuts: [{ title: 'a > b', reason: 'why' }],
  gate: { tags: ['wcag2a'], rules: [rule('color-contrast', 'serious', 1, 2, ['/x'])] },
  reportOnly: {
    tags: ['best-practice'],
    rules: [rule('region', 'moderate', 3, 5, ['/a', '/b'])],
  },
  ...over,
});

const summary = (over = {}) => ({
  schemaVersion: 1,
  generatedAt: '2026-11-24T05:40:00.000Z',
  commitSha: 'abc',
  trigger: 'nightly',
  runUrl: 'https://example.test/run/1',
  status: 'passed',
  totals: { passed: 5, failed: 0, skipped: 1, expectedFailures: 0 },
  tests: [{ title: 't', surfaceId: null, route: null, outcome: 'passed', knownFailure: null }],
  axe: null,
  ...over,
});

const part = (s, path = 'p.json') => ({ path, found: true, summary: s });

test('rules merge by id: tests and nodes add, the worst impact wins, paths union and sort', () => {
  const merged = mergeRules([
    [rule('region', 'minor', 2, 3, ['/b']), rule('list', 'serious', 1, 1, ['/l'])],
    [rule('region', 'moderate', 1, 4, ['/a', '/b'])],
  ]);
  assert.deepEqual(
    merged.map((r) => [r.id, r.impact, r.tests, r.nodes, r.paths]),
    [
      ['list', 'serious', 1, 1, ['/l']],
      ['region', 'moderate', 3, 7, ['/a', '/b']],
    ],
  );
});

test('a rule keeps at most ten paths', () => {
  const many = Array.from({ length: 8 }, (_, i) => `/p${i}`);
  const more = Array.from({ length: 8 }, (_, i) => `/q${i}`);
  const [r] = mergeRules([[rule('x', 'minor', 1, 1, many)], [rule('x', 'minor', 1, 1, more)]]);
  assert.equal(r.paths.length, 10);
});

test('axe blocks sum, and a run with none stays null', () => {
  assert.equal(mergeAxe([null, undefined]), null);
  const m = mergeAxe([axeBlock(), null, axeBlock()]);
  assert.deepEqual(m.violationsByImpact, { critical: 0, serious: 2, moderate: 0, minor: 0 });
  assert.deepEqual(m.scans, { scanned: 20, optedOut: 2, notScanned: 4 });
  assert.equal(m.optOuts.length, 2);
  assert.deepEqual(
    m.reportOnly.rules.map((r) => [r.id, r.tests]),
    [['region', 6]],
  );
});

test('known failures merge by issue and rule, and show in the markdown', () => {
  const k = (issue, rule, tests) => ({ issue, rule, tests });
  const m = mergeAxe([
    axeBlock({ knownFailures: [k('AECI-2', 'list', 1), k('AECI-1', 'region', 2)] }),
    axeBlock({ knownFailures: [k('AECI-1', 'region', 3)] }),
  ]);
  assert.deepEqual(m.knownFailures, [k('AECI-1', 'region', 5), k('AECI-2', 'list', 1)]);
  const md = summaryMarkdown(mergeSummaries([part(summary({ axe: m }))]));
  assert.match(md, /Known failures: AECI-1 \(`region`, tests: 5\), AECI-2 \(`list`, tests: 1\)\./);
});

test('summaries merge: totals add, tests concatenate, the worst status wins', () => {
  const m = mergeSummaries(
    [
      part(summary()),
      part(
        summary({
          status: 'failed',
          totals: { passed: 1, failed: 2, skipped: 0, expectedFailures: 1 },
        }),
      ),
    ],
    new Date('2026-11-24T06:00:00.000Z'),
  );
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.status, 'failed');
  assert.deepEqual(m.totals, { passed: 6, failed: 2, skipped: 1, expectedFailures: 1 });
  assert.equal(m.tests.length, 2);
  assert.equal(m.commitSha, 'abc');
  assert.equal(m.generatedAt, '2026-11-24T06:00:00.000Z');
});

test('a missing part makes the merged status failed, and is named', () => {
  const dir = tempDir();
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify(summary()));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  const m = mergeSummaries([readPart(good), readPart(join(dir, 'gone.json')), readPart(bad)]);
  assert.equal(m.status, 'failed');
  assert.deepEqual(
    m.parts.map((p) => [p.found, p.error?.split(':')[0] ?? null]),
    [
      [true, null],
      [false, 'missing'],
      [false, 'unreadable'],
    ],
  );
  assert.match(summaryMarkdown(m), /Missing summaries: .*gone\.json/);
});

test('the markdown groups the report-only findings by rule', () => {
  const md = summaryMarkdown(mergeSummaries([part(summary({ axe: axeBlock() }))]));
  assert.match(md, /### Report only \(best-practice\)/);
  assert.match(
    md,
    /\| \[`region`\]\(https:\/\/dequeuniversity\.com\/rules\/axe\/4\.11\/region\) \| moderate \| 3 \| 5 \| `\/a`, `\/b` \|/,
  );
  assert.match(md, /10 scanned, 1 opted out, 2 not scanned\./);
  assert.match(
    summaryMarkdown(mergeSummaries([part(summary())])),
    /No test reached the e2e axe sweep/,
  );
});

test('the CLI writes a summary the alert can read', () => {
  const dir = tempDir();
  const a = join(dir, 'a.json');
  writeFileSync(
    a,
    JSON.stringify(
      summary({
        status: 'failed',
        totals: { passed: 0, failed: 1, skipped: 0, expectedFailures: 0 },
        tests: [
          { title: 'x', surfaceId: null, route: '/x', outcome: 'failed', knownFailure: null },
        ],
      }),
    ),
  );
  const out = join(dir, 'out.json');
  const md = join(dir, 'summary.md');
  const logs = [];
  assert.equal(main([`--out=${out}`, `--markdown=${md}`, a], { log: (l) => logs.push(l) }), 0);
  const loaded = loadSummary(out);
  assert.equal(loaded.found, true);
  assert.deepEqual(loaded.failing, [{ title: 'x', surfaceId: null, route: '/x', file: null }]);
  assert.match(readFileSync(md, 'utf8'), /## Accessibility nightly/);
});

test('the CLI refuses a bad call', () => {
  const quiet = { log: () => {}, error: () => {} };
  assert.equal(main(['a.json'], quiet), 2);
  assert.equal(main(['--out=o.json'], quiet), 2);
  assert.equal(main(['--out=o.json', '--bogus', 'a.json'], quiet), 2);
});

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
  mergeIbm,
  mergeRules,
  mergeSummaries,
  mergeVoice,
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

test('axe blocks sum, and a run with none is an all-zero object', () => {
  const none = mergeAxe([null, undefined]);
  assert.deepEqual(none.scans, { scanned: 0, optedOut: 0, notScanned: 0 });
  assert.deepEqual(none.reportOnly.rules, []);
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

test('sharded lanes merge: every shard of the suite and the sweep is one part (AECI-1874)', () => {
  const shard = (n, axe) =>
    part(
      summary({
        totals: { passed: n, failed: 0, skipped: 0, expectedFailures: 1 },
        tests: Array.from({ length: n }, (_, i) => ({ title: `t${i}`, outcome: 'passed' })),
        axe,
      }),
      `p${n}.json`,
    );
  const m = mergeSummaries([
    shard(1, null),
    shard(2, null),
    shard(3, null),
    shard(4, null),
    shard(5, axeBlock()),
    shard(6, axeBlock()),
  ]);
  assert.equal(m.status, 'passed');
  assert.equal(m.parts.length, 6);
  assert.deepEqual(m.totals, { passed: 21, failed: 0, skipped: 0, expectedFailures: 6 });
  assert.equal(m.tests.length, 21);
  assert.deepEqual(m.axe.scans, { scanned: 20, optedOut: 2, notScanned: 4 });
  // One suite shard that wrote nothing turns the merge red and is named.
  const gap = mergeSummaries([
    shard(1, null),
    { path: 'suite-2.json', found: false, error: 'missing' },
  ]);
  assert.equal(gap.status, 'failed');
  assert.deepEqual(
    gap.parts.filter((p) => !p.found).map((p) => p.file),
    ['suite-2.json'],
  );
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

const effortRow = (surfaceId, presses, baseline = 10) => ({
  surfaceId,
  route: `/${surfaceId}`,
  action: 'the first card',
  presses,
  baseline,
  margin: 3,
  change: presses === null ? null : presses - baseline,
  verdict: 'same',
});

const voiceBlock = (effort, bySurface) => ({
  effort,
  targetSize: {
    surfaces: bySurface.length,
    targets: bySurface.reduce((n, s) => n + s.targets.length, 0),
    bySurface,
  },
});

test('voice blocks merge across shards: rows concatenate by surface, and none is an empty block (AECI-1883)', () => {
  assert.deepEqual(mergeVoice([null, undefined]), {
    effort: [],
    targetSize: { surfaces: 0, targets: 0, bySurface: [] },
  });
  const m = mergeSummaries([
    part(
      summary({
        voice: voiceBlock(
          [effortRow('login', 9)],
          [
            {
              surfaceId: 'login',
              route: '/login',
              targets: [
                { target: 'a.x', verdict: 'fails', why: 'small' },
                { target: 'b.y', verdict: 'review', why: 'covered' },
              ],
            },
          ],
        ),
      }),
    ),
    part(summary()),
    part(
      summary({
        voice: voiceBlock(
          [effortRow('home', 12)],
          [{ surfaceId: 'home', route: '/', targets: [] }],
        ),
      }),
    ),
  ]);
  assert.equal(m.schemaVersion, 1);
  assert.deepEqual(
    m.voice.effort.map((e) => [e.surfaceId, e.change]),
    [
      ['home', 2],
      ['login', -1],
    ],
  );
  assert.equal(m.voice.targetSize.surfaces, 2);
  assert.equal(m.voice.targetSize.targets, 2);
  const md = summaryMarkdown(m);
  assert.match(md, /### Voice control and switch \(AECI-1883\)/);
  assert.match(md, /\| `home` \| the first card \| 12 \| 10 \| \+2 \| 3 \|/);
  assert.match(md, /1 targets fail and 1 need review, on 1 of 2 surfaces\./);
  assert.match(md, /\| `login` \| 1 \| 1 \| `a\.x`, `b\.y` \|/);
  // A run with no voice-control test writes no voice section.
  assert.doesNotMatch(summaryMarkdown(mergeSummaries([part(summary())])), /Voice control/);
});

// `failed` nodes axe failed, `review` nodes axe only marked for review.
const ibmRow = (ruleId, nodes, failed, review, surfaces, over = {}) => ({
  ruleId,
  message: `${ruleId} message`,
  wcag: ['1.3.1'],
  nodes,
  alsoAxe: failed + review,
  alsoFailedInAxe: failed,
  axeReviewOnly: review,
  axeRules: [...(failed > 0 ? ['region'] : []), ...(review > 0 ? ['region (review)'] : [])],
  surfaces,
  examples: surfaces.map((surfaceId) => ({ surfaceId, xpath: '/html[1]/body[1]' })),
  ...over,
});

const LISTS = {
  violation: 'violations',
  needsReview: 'needsReview',
  recommendation: 'recommendations',
};

/** A block whose counts are the sums of its rule rows, as `summarizeIbm` writes them. */
const ibmBlock = (bySurface, lists) => {
  const per = (field) =>
    Object.fromEntries(
      Object.entries(LISTS).map(([k, list]) => [
        k,
        (lists[list] ?? []).reduce((n, r) => n + r[field], 0),
      ]),
    );
  return {
    engine: { version: '4.0.35', ruleset: 'IBM_Accessibility' },
    surfaces: bySurface.length,
    counts: per('nodes'),
    alsoAxe: per('alsoAxe'),
    alsoFailedInAxe: per('alsoFailedInAxe'),
    axeReviewOnly: per('axeReviewOnly'),
    violations: lists.violations ?? [],
    needsReview: lists.needsReview ?? [],
    recommendations: lists.recommendations ?? [],
    bySurface,
  };
};

const ibmSurface = (surfaceId, violation, notInAxe, reviewOnly, needsReview = 0) => ({
  surfaceId,
  route: `/${surfaceId}`,
  violation,
  needsReview,
  recommendation: 0,
  uniqueViolations: notInAxe,
  violationsAxeReviewOnly: reviewOnly,
  violationsNotFailedInAxe: notInAxe + reviewOnly,
  scanMs: 100,
  axeMs: 200,
});

const ZERO = { violation: 0, needsReview: 0, recommendation: 0 };

test('ibm blocks merge across shards: rules merge by id, surfaces concatenate, none is an empty block (AECI-1884)', () => {
  assert.deepEqual(mergeIbm([null, undefined]), {
    engine: null,
    surfaces: 0,
    counts: ZERO,
    alsoAxe: ZERO,
    alsoFailedInAxe: ZERO,
    axeReviewOnly: ZERO,
    violations: [],
    needsReview: [],
    recommendations: [],
    bySurface: [],
  });
  const m = mergeSummaries([
    part(
      summary({
        ibm: ibmBlock([ibmSurface('login', 2, 1, 0, 4)], {
          violations: [ibmRow('aria_content_in_landmark', 2, 1, 0, ['login'])],
          needsReview: [ibmRow('text_contrast_sufficient', 4, 0, 1, ['login'])],
        }),
      }),
    ),
    part(summary()),
    part(
      summary({
        ibm: ibmBlock([ibmSurface('home', 3, 2, 1), ibmSurface('account', 1, 0, 1)], {
          violations: [
            ibmRow('aria_content_in_landmark', 1, 0, 1, ['account'], { wcag: ['1.3.1', '2.4.1'] }),
            ibmRow('input_label_visible', 3, 0, 1, ['home']),
          ],
        }),
      }),
    ),
  ]);
  assert.equal(m.schemaVersion, 1);
  assert.deepEqual(
    m.ibm.bySurface.map((s) => [s.surfaceId, s.uniqueViolations, s.violationsAxeReviewOnly]),
    [
      ['account', 0, 1],
      ['home', 2, 1],
      ['login', 1, 0],
    ],
  );
  assert.equal(m.ibm.surfaces, 3);
  assert.deepEqual(m.ibm.counts, { violation: 6, needsReview: 4, recommendation: 0 });
  // `alsoAxe` keeps its meaning: failed or marked for review. The split sits beside it.
  assert.deepEqual(m.ibm.alsoAxe, { violation: 3, needsReview: 1, recommendation: 0 });
  assert.deepEqual(m.ibm.alsoFailedInAxe, { violation: 1, needsReview: 0, recommendation: 0 });
  assert.deepEqual(m.ibm.axeReviewOnly, { violation: 2, needsReview: 1, recommendation: 0 });
  assert.deepEqual(
    m.ibm.violations.map((r) => [
      r.ruleId,
      r.nodes,
      r.alsoAxe,
      r.alsoFailedInAxe,
      r.axeReviewOnly,
      r.surfaces,
      r.wcag,
    ]),
    [
      ['aria_content_in_landmark', 3, 2, 1, 1, ['account', 'login'], ['1.3.1', '2.4.1']],
      ['input_label_visible', 3, 1, 0, 1, ['home'], ['1.3.1']],
    ],
  );
  assert.equal(m.ibm.engine.version, '4.0.35');

  const md = summaryMarkdown(m);
  assert.match(md, /### IBM Equal Access, report only \(AECI-1884\)/);
  assert.match(
    md,
    /Violations: 6 nodes\. axe also failed 1\. axe only marked 2 for review\. 3 are not in axe at all\./,
  );
  // The unique list keeps the review-only nodes, labelled, most first.
  assert.match(md, /#### Unique to IBM: 5 nodes axe did not fail/);
  assert.match(
    md,
    /\| `input_label_visible` \| 1\.3\.1 \| 3 \| 1 \| 2 \| `home` \|\n\| `aria_content_in_landmark` \| 1\.3\.1, 2\.4\.1 \| 2 \| 1 \| 1 \| `account`, `login` \|/,
  );
  assert.match(
    md,
    /\| `aria_content_in_landmark` \| 1\.3\.1, 2\.4\.1 \| 3 \| 1 \| 1 \| `region`, `region \(review\)` \| `account`, `login` \|/,
  );
  // The other two lists are collapsed, after the violations tables.
  assert.match(
    md,
    /<details>\n<summary>Needs review: 4 nodes \(0 failed in axe, 1 axe review only\)\. Recommendations: 0 nodes \(0 failed in axe, 0 axe review only\)\.<\/summary>/,
  );
  assert.ok(md.indexOf('`input_label_visible`') < md.indexOf('<details>'));
  assert.ok(md.indexOf('`text_contrast_sufficient`') > md.indexOf('<details>'));
  // A run with no IBM test writes no IBM section.
  assert.doesNotMatch(summaryMarkdown(mergeSummaries([part(summary())])), /IBM Equal Access/);
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

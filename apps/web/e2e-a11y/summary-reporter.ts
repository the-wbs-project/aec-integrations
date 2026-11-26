/**
 * AECI-1875: writes `apps/web/a11y-nightly-summary.json` at the end of a nightly run.
 *
 * The file is a run artifact. The alert (`scripts/a11y-nightly-alert.mjs`) reads it
 * to name the failing surfaces. AECI-1682 will read it for the dated record: the
 * date, the commit, the surfaces and the counts.
 *
 * AECI-1876: the `axe` block folds the `axe-scan` annotations of the e2e axe
 * sweep (`e2e/axe-sweep.ts`) with `summarizeAxe()`. It is all zeros for a run with
 * no sweep, such as the `e2e-a11y/` suite alone. Each test row also carries its
 * own `axe` status. `schemaVersion` changes only when a field changes meaning or
 * goes away.
 *
 * AECI-1883: the `voice` block folds the `voice-effort`, `voice-target-size` and
 * `voice-input-purpose` annotations of `voice-control.spec.ts` with `summarizeVoice()`. It is empty
 * lists for a run with no voice-control test. Adding it kept `schemaVersion` 1.
 *
 * AECI-1884: the `ibm` block folds the `ibm-equal-access` annotations of
 * `ibm-equal-access.spec.ts` with `summarizeIbm()`: IBM Equal Access findings,
 * report only, each marked when axe also reported it. Zero counts and empty
 * lists for a run with no IBM test. Adding it kept `schemaVersion` 1.
 *
 * AECI-1885: each test row names its `browser`, the Playwright project that ran
 * it, so the Firefox and WebKit lane's rows can be told from Chromium's. Adding
 * it kept `schemaVersion` 1.
 *
 * Options: `outputFile`, the file name next to the config (default
 * `a11y-nightly-summary.json`). The e2e sweep lane writes its own file so a local
 * run of both lanes keeps both. `scripts/a11y-nightly-merge-summary.mjs` merges them.
 *
 * Env: `A11Y_COMMIT_SHA` (falls back to `GITHUB_SHA`), `A11Y_TRIGGER` (`nightly`
 * or `manual`, default `manual`), and the Actions run variables for `runUrl`.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import {
  AXE_SCAN_ANNOTATION,
  parseScanRecord,
  summarizeAxe,
  type AxeScanStatus,
  type AxeSummary,
} from '../e2e/axe-summary';
import { KNOWN_FAILURE_ANNOTATION } from './known-failure';
import { summarizeIbm, type IbmSummary } from './support/ibm-overlap';
import { summarizeVoice, type VoiceSummary } from './support/voice-summary';

export const SUMMARY_FILE = 'a11y-nightly-summary.json';

export type TestOutcome = 'passed' | 'failed' | 'skipped' | 'expected-failure' | 'flaky';

export interface A11yNightlySummary {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly commitSha: string | null;
  readonly trigger: 'nightly' | 'manual';
  readonly runUrl: string | null;
  /** Playwright's overall status: passed, failed, timedout or interrupted. */
  readonly status: FullResult['status'];
  readonly totals: {
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly expectedFailures: number;
  };
  readonly tests: ReadonlyArray<{
    readonly title: string;
    readonly surfaceId: string | null;
    /** The `route` annotation, else the path of the page the axe sweep scanned. */
    readonly route: string | null;
    /** The spec file, relative to `apps/web`. */
    readonly file: string;
    /**
     * AECI-1885: the Playwright project that ran the test, `chromium`, `firefox`
     * or `webkit`. The same title appears once per browser. Adding it kept
     * `schemaVersion` 1.
     */
    readonly browser: string | null;
    readonly outcome: TestOutcome;
    /** The first known-failure ID the test carries, or `null`. Kept as it was. */
    readonly knownFailure: string | null;
    /**
     * AECI-1874: every known-failure ID the test carries, once each, in issue
     * number order. A test that judges several problems marks each known one.
     */
    readonly knownFailures: readonly string[];
    /** The e2e axe sweep's verdict on this test, or `null` when it never reached the sweep. */
    readonly axe: AxeScanStatus | null;
  }>;
  /** Always an object. All zeros and empty lists when no test reached the sweep. */
  readonly axe: AxeSummary;
  /**
   * AECI-1883: the voice-control checks' effort counts and target size report.
   * Always an object. Empty lists for a run with no voice-control test.
   */
  readonly voice: VoiceSummary;
  /**
   * AECI-1884: IBM Equal Access findings, report only, with their overlap with
   * axe. Always an object. Zero counts and empty lists for a run with no IBM test.
   */
  readonly ibm: IbmSummary;
}

function annotation(test: TestCase, result: TestResult | undefined, type: string): string | null {
  const found = [...(result?.annotations ?? []), ...test.annotations].find((a) => a.type === type);
  return found?.description ?? null;
}

/** Every distinct description of one annotation type on a test, in first-seen order. */
function annotationsOf(test: TestCase, result: TestResult | undefined, type: string): string[] {
  const all = [...(result?.annotations ?? []), ...test.annotations];
  return [
    ...new Set(all.filter((a) => a.type === type && a.description).map((a) => a.description!)),
  ];
}

/** `AECI-<n>` IDs by issue number, so the order does not depend on which check ran first. */
export function sortIssueIds(ids: readonly string[]): string[] {
  const n = (id: string): number => Number(id.match(/\d+$/)?.[0] ?? Number.MAX_SAFE_INTEGER);
  return [...ids].sort((a, b) => n(a) - n(b) || (a < b ? -1 : a > b ? 1 : 0));
}

function outcomeOf(test: TestCase): TestOutcome {
  switch (test.outcome()) {
    case 'skipped':
      return 'skipped';
    case 'flaky':
      return 'flaky';
    case 'unexpected':
      return 'failed';
    case 'expected':
      return test.expectedStatus === 'failed' ? 'expected-failure' : 'passed';
  }
}

function pathOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function runUrl(env: NodeJS.ProcessEnv): string | null {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

export function buildSummary(
  tests: readonly TestCase[],
  status: FullResult['status'],
  env: NodeJS.ProcessEnv,
  now: Date = new Date(),
  rootDir: string = process.cwd(),
): A11yNightlySummary {
  const scans: Array<{ title: string; scan: ReturnType<typeof parseScanRecord> }> = [];
  const rows = tests.map((test) => {
    const last = test.results.at(-1);
    const title = test.titlePath().slice(3).join(' > ');
    const scan = parseScanRecord(annotation(test, last, AXE_SCAN_ANNOTATION) ?? undefined);
    scans.push({ title, scan });
    return {
      // Drop the root, project and file. Keep the describe blocks and the test.
      title,
      surfaceId: annotation(test, last, 'surface'),
      route: annotation(test, last, 'route') ?? pathOf(scan?.url),
      file: relative(rootDir, test.location.file).split(sep).join('/'),
      // The title path is the root, the project, the file, then the describes.
      browser: test.titlePath()[1] || null,
      outcome: outcomeOf(test),
      knownFailure: annotation(test, last, KNOWN_FAILURE_ANNOTATION),
      knownFailures: sortIssueIds(annotationsOf(test, last, KNOWN_FAILURE_ANNOTATION)),
      axe: scan?.status ?? null,
    };
  });
  // Playwright may list a runtime annotation on both the result and the test,
  // so each test's annotations are de-duplicated before they are folded.
  const annotations = tests.flatMap((test) => {
    const all = [...(test.results.at(-1)?.annotations ?? []), ...test.annotations];
    const seen = new Set<string>();
    return all.filter((a) => {
      const key = `${a.type}\u0000${a.description ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
  const count = (...outcomes: TestOutcome[]): number =>
    rows.filter((r) => outcomes.includes(r.outcome)).length;
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    commitSha: env['A11Y_COMMIT_SHA'] || env['GITHUB_SHA'] || null,
    trigger: env['A11Y_TRIGGER'] === 'nightly' ? 'nightly' : 'manual',
    runUrl: runUrl(env),
    status,
    totals: {
      passed: count('passed', 'flaky'),
      failed: count('failed'),
      skipped: count('skipped'),
      expectedFailures: count('expected-failure'),
    },
    tests: rows,
    axe: summarizeAxe(scans),
    voice: summarizeVoice(annotations),
    ibm: summarizeIbm(annotations),
  };
}

export default class SummaryReporter implements Reporter {
  private readonly fileName: string;
  private outFile = SUMMARY_FILE;
  private rootDir = process.cwd();
  private root: Suite | null = null;

  constructor(options: { outputFile?: string } = {}) {
    this.fileName = options.outputFile ?? SUMMARY_FILE;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    // Every test in the run, including any an interrupted run never reached.
    this.root = suite;
    // Next to the config file, so the path is `apps/web/a11y-nightly-summary.json`
    // whatever directory the run started from.
    const configDir = config.configFile ? dirname(config.configFile) : process.cwd();
    this.outFile = join(configDir, this.fileName);
    this.rootDir = configDir;
  }

  onEnd(result: FullResult): void {
    const tests = this.root?.allTests() ?? [];
    // `--list` and a run that died before its first test reach here with no
    // results. Write nothing then: the alert treats a missing file as "no test
    // summary, see the run log", which is the truth.
    if (!tests.some((t) => t.results.length > 0)) return;
    const summary = buildSummary(tests, result.status, process.env, new Date(), this.rootDir);
    writeFileSync(this.outFile, `${JSON.stringify(summary, null, 2)}\n`);
    const t = summary.totals;
    console.log(
      `[a11y-nightly] ${this.outFile}: ${t.passed} passed, ${t.failed} failed, ` +
        `${t.skipped} skipped, ${t.expectedFailures} known failures.`,
    );
    if (summary.axe) {
      const s = summary.axe.scans;
      console.log(
        `[a11y-nightly] axe sweep: ${s.scanned} scanned, ${s.optedOut} opted out, ` +
          `${s.notScanned} not scanned. Report-only rules: ${summary.axe.reportOnly.rules.length}.`,
      );
    }
    if (summary.ibm.surfaces > 0) {
      const c = summary.ibm.counts;
      console.log(
        `[a11y-nightly] IBM Equal Access, report only: ${summary.ibm.surfaces} surfaces, ` +
          `${c.violation} violations (${summary.ibm.alsoFailedInAxe.violation} failed in axe, ` +
          `${summary.ibm.axeReviewOnly.violation} axe review only), ` +
          `${c.needsReview} need review, ${c.recommendation} recommendations.`,
      );
    }
  }

  printsToStdio(): boolean {
    return false;
  }
}

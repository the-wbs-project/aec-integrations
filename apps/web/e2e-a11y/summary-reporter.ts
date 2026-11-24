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
    readonly outcome: TestOutcome;
    readonly knownFailure: string | null;
    /** The e2e axe sweep's verdict on this test, or `null` when it never reached the sweep. */
    readonly axe: AxeScanStatus | null;
  }>;
  /** Always an object. All zeros and empty lists when no test reached the sweep. */
  readonly axe: AxeSummary;
}

function annotation(test: TestCase, result: TestResult | undefined, type: string): string | null {
  const found = [...(result?.annotations ?? []), ...test.annotations].find((a) => a.type === type);
  return found?.description ?? null;
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
      outcome: outcomeOf(test),
      knownFailure: annotation(test, last, KNOWN_FAILURE_ANNOTATION),
      axe: scan?.status ?? null,
    };
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
  }

  printsToStdio(): boolean {
    return false;
  }
}

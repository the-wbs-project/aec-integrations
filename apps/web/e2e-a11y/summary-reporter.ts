/**
 * AECI-1875: writes `apps/web/a11y-nightly-summary.json` at the end of a nightly run.
 *
 * The file is a run artifact. The alert (`scripts/a11y-nightly-alert.mjs`) reads it
 * to name the failing surfaces. AECI-1682 will read it for the dated record: the
 * date, the commit, the surfaces and the counts.
 *
 * `axe.violationsByImpact` stays `null` until AECI-1876 adds the axe sweep.
 * `schemaVersion` changes only when a field changes meaning or goes away.
 *
 * Env: `A11Y_COMMIT_SHA` (falls back to `GITHUB_SHA`), `A11Y_TRIGGER` (`nightly`
 * or `manual`, default `manual`), and the Actions run variables for `runUrl`.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
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
    readonly route: string | null;
    readonly outcome: TestOutcome;
    readonly knownFailure: string | null;
  }>;
  readonly axe: { readonly violationsByImpact: null };
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
): A11yNightlySummary {
  const rows = tests.map((test) => {
    const last = test.results.at(-1);
    return {
      // Drop the root, project and file. Keep the describe blocks and the test.
      title: test.titlePath().slice(3).join(' > '),
      surfaceId: annotation(test, last, 'surface'),
      route: annotation(test, last, 'route'),
      outcome: outcomeOf(test),
      knownFailure: annotation(test, last, KNOWN_FAILURE_ANNOTATION),
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
    axe: { violationsByImpact: null },
  };
}

export default class SummaryReporter implements Reporter {
  private outFile = SUMMARY_FILE;
  private root: Suite | null = null;

  onBegin(config: FullConfig, suite: Suite): void {
    // Every test in the run, including any an interrupted run never reached.
    this.root = suite;
    // Next to the config file, so the path is `apps/web/a11y-nightly-summary.json`
    // whatever directory the run started from.
    const configDir = config.configFile ? dirname(config.configFile) : process.cwd();
    this.outFile = join(configDir, SUMMARY_FILE);
  }

  onEnd(result: FullResult): void {
    const tests = this.root?.allTests() ?? [];
    // `--list` and a run that died before its first test reach here with no
    // results. Write nothing then: the alert treats a missing file as "no test
    // summary, see the run log", which is the truth.
    if (!tests.some((t) => t.results.length > 0)) return;
    const summary = buildSummary(tests, result.status, process.env);
    writeFileSync(this.outFile, `${JSON.stringify(summary, null, 2)}\n`);
    const t = summary.totals;
    console.log(
      `[a11y-nightly] ${this.outFile}: ${t.passed} passed, ${t.failed} failed, ` +
        `${t.skipped} skipped, ${t.expectedFailures} known failures.`,
    );
  }

  printsToStdio(): boolean {
    return false;
  }
}

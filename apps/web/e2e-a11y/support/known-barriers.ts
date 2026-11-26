/**
 * AECI-1877, shared by AECI-1879: a barrier a suite finds today, with its Linear issue.
 *
 * Each suite keeps its own list, typed by the names of its checks. `applies`
 * decides per surface, so the mark lands on its own surfaces only. `mark` calls
 * `knownFailure` with a literal issue ID, which `pnpm test:scripts` requires.
 * When the issue is fixed the test passes, `knownFailure` turns it red, and the
 * entry goes.
 */
import { expect } from '@playwright/test';
import type { A11ySurface } from '../surfaces';
import type { A11yBrowser } from './browser-expectations';

export interface KnownBarrier<Check extends string> {
  readonly check: Check;
  /**
   * AECI-1885: the browsers the barrier is found in. A barrier found in one
   * engine marks that engine's test only, so the others still fail on it.
   */
  readonly browsers: readonly A11yBrowser[];
  readonly applies: (surface: A11ySurface) => boolean;
  readonly mark: () => void;
}

/** Mark the running test for every barrier on this check, surface and browser. */
export function markKnownBarriers<Check extends string>(
  barriers: readonly KnownBarrier<Check>[],
  surface: A11ySurface,
  check: Check,
  browser: A11yBrowser,
): void {
  for (const barrier of barriers) {
    if (barrier.check === check && barrier.browsers.includes(browser) && barrier.applies(surface)) {
      barrier.mark();
    }
  }
}

/**
 * A known barrier inside a check that reports a list of problems (AECI-1879).
 * It covers only the problems it `matches`, so the rest of the check still runs.
 */
export interface KnownProblem {
  readonly issue: `AECI-${number}`;
  readonly matches: (problem: string) => boolean;
  /** Calls `knownFailure` with the same literal issue ID. */
  readonly mark: () => void;
}

/** The pure half of `expectOnlyKnownProblems`, pinned by `known-barriers.unit.spec.ts`. */
export function classifyProblems(
  problems: readonly string[],
  known: readonly Pick<KnownProblem, 'issue' | 'matches'>[],
): { unknown: string[]; fixed: string[] } {
  return {
    unknown: problems.filter((p) => !known.some((k) => k.matches(p))),
    fixed: known.filter((k) => !problems.some((p) => k.matches(p))).map((k) => k.issue),
  };
}

/**
 * Judge a check's problems against the known ones that apply here:
 *
 *   1. A problem no known issue matches fails the test, unmarked, so a new
 *      defect on a page with a known barrier is still red.
 *   2. A known issue that matches nothing fails the test, unmarked, so a fixed
 *      issue turns red until its mark is removed.
 *   3. Otherwise every known problem is still there. The test is marked with
 *      each issue's `knownFailure` and fails on those problems alone, which
 *      reads as an expected failure.
 */
export function expectOnlyKnownProblems(
  problems: readonly string[],
  known: readonly KnownProblem[],
): void {
  const { unknown, fixed } = classifyProblems(problems, known);
  expect(unknown, 'problems that no known issue covers').toEqual([]);
  expect(fixed, 'known issues that no longer reproduce here: remove their marks').toEqual([]);
  if (known.length === 0) return;
  for (const k of known) k.mark();
  expect(problems, 'the known problems, all still present').toEqual([]);
}

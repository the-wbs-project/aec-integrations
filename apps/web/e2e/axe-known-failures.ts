/**
 * AECI-1876: the e2e axe sweep's known failures. The sweep's form of
 * `knownFailure()` (`e2e-a11y/known-failure.ts`).
 *
 * A barrier we cannot fix yet is listed here, keyed by the rule and the page,
 * not marked on each test. One root cause often ends many tests on one page:
 * 20 tests end on `/_demo/spartan`.
 *
 * The rules are the same as `knownFailure()`:
 *   - Every entry names its Linear issue as a literal `'AECI-<n>'`.
 *     `scripts/a11y-known-failures.test.mjs` fails a `knownFailure(` call or an
 *     `issue:` here that does not.
 *   - A listed violation does not fail the test. The test carries the
 *     `known-failure` annotation, so the summary names the issue.
 *   - A test that ends on a listed page turns red when the rule no longer fails
 *     there, or when any one listed target no longer fails. A partial fix makes
 *     the entry shrink. A full fix makes it go, and the issue close.
 *
 * Match: the rule id, the page path exactly, and, when `targets` is set, every
 * failing node's selector. A new node of the same rule on the same page still fails.
 *
 * `targets` are axe's own generated selectors, as the failure message prints them.
 * axe picks the shortest selector that is unique on the page, so a short one such
 * as `.text-xs` is still exactly one node there.
 */

export interface AxeKnownFailure {
  readonly issue: `AECI-${number}`;
  readonly rule: string;
  /** The page path, exactly. No query or hash. */
  readonly path: string;
  /** axe's selectors for the known nodes. Unset means any node. */
  readonly targets?: readonly string[];
  readonly reason: string;
}

export const AXE_KNOWN_FAILURES: readonly AxeKnownFailure[] = [
  {
    issue: 'AECI-2059',
    rule: 'aria-prohibited-attr',
    path: '/_demo/spartan',
    targets: ['brn-dialog'],
    reason: 'The demo dialog host carries aria-labelledby with no role.',
  },
  {
    issue: 'AECI-2060',
    rule: 'color-contrast',
    path: '/preview/vendor-detail',
    targets: ['#vendor-top-ranking-label', '.text-xs'],
    reason: 'Tertiary text on the Bone band is 4.32 to 1.',
  },
];

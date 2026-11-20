/**
 * AECI-1875: the only way a nightly accessibility test may be marked as failing.
 *
 * A check that finds a real barrier we cannot fix today is marked with
 * `knownFailure('AECI-123', 'why')` inside the test body. The test still runs.
 * It stays green while it fails and turns red the day it passes, so the issue
 * gets closed and the mark comes off.
 *
 * The issue ID is required, so every known failure has an owner in Linear. A
 * bare `test.fail()` anywhere else in `e2e-a11y/` fails `pnpm test:scripts`
 * (`scripts/a11y-known-failures.test.mjs`). So does a call whose first
 * argument is not a literal `'AECI-<n>'`.
 */
import { test } from '@playwright/test';

/** The annotation type the summary reporter reads. */
export const KNOWN_FAILURE_ANNOTATION = 'known-failure';

const ISSUE_ID = /^AECI-\d+$/;

export function knownFailure(issueId: `AECI-${number}`, reason: string): void {
  if (!ISSUE_ID.test(issueId)) {
    throw new Error(`knownFailure needs a Linear issue ID like 'AECI-123', got '${issueId}'.`);
  }
  if (reason.trim() === '') {
    throw new Error(`knownFailure('${issueId}') needs a reason.`);
  }
  test.info().annotations.push({ type: KNOWN_FAILURE_ANNOTATION, description: issueId });
  test.fail(true, `${issueId}: ${reason}`);
}

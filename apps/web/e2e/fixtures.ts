/**
 * AECI-1876: the e2e suite's `test`. Every spec imports `test` from here, not
 * from `@playwright/test`. Everything else is re-exported unchanged, so a spec
 * swaps only its module path. `scripts/e2e-axe-sweep.test.mjs` enforces it.
 *
 * The one change is the `page` fixture. With `AECI_E2E_AXE=1` it watches for
 * hydration errors and, after the test, runs the axe sweep (`./axe-sweep.ts`).
 * With the flag unset, which is the PR e2e job, it hands the page straight
 * through and does nothing else.
 */
import { test as base } from '@playwright/test';

import { axeSweepEnabled, sweepAfterTest, watchHydrationErrors } from './axe-sweep';

export * from '@playwright/test';
export { axeOptOut } from './axe-sweep';

/** Extra time for the sweep: the hydration gate and one axe run. */
const SWEEP_BUDGET_MS = 30_000;

export const test = base.extend({
  page: async ({ page, javaScriptEnabled }, use, testInfo) => {
    if (!axeSweepEnabled()) {
      await use(page);
      return;
    }
    // A timeout of 0 means none. Leave it so.
    if (testInfo.timeout > 0) testInfo.setTimeout(testInfo.timeout + SWEEP_BUDGET_MS);
    const hydrationErrors = watchHydrationErrors(page);
    await use(page);
    await sweepAfterTest(page, testInfo, { javaScriptEnabled, hydrationErrors });
  },
});

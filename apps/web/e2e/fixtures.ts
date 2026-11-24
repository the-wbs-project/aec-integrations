/**
 * AECI-1876: the e2e suite's `test`. Every spec imports `test` from here, not
 * from `@playwright/test`. Everything else is re-exported unchanged, so a spec
 * swaps only its module path. `scripts/e2e-axe-sweep.test.mjs` enforces it.
 *
 * With the flag unset, which is the PR e2e job, `test` IS `@playwright/test`'s
 * `test`. Nothing is added.
 *
 * With `AECI_E2E_AXE=1` (read once per worker, at load):
 *   - `page` watches for hydration errors and, after the test, runs the axe
 *     sweep (`./axe-sweep.ts`). It has its own timeout, so a `test.setTimeout()`
 *     in a test body cannot shrink the time the sweep gets.
 *   - An auto fixture records every test the sweep never reached as not
 *     scanned, with the reason: no `page`, or its own browser context.
 */
import { test as base } from '@playwright/test';

import {
  axeSweepEnabled,
  recordUnreached,
  sweepAfterTest,
  trackOwnContexts,
  watchHydrationErrors,
} from './axe-sweep';

export * from '@playwright/test';
export { axeOptOut } from './axe-sweep';

/**
 * The `page` fixture's own budget, for its setup and its teardown. The sweep's
 * waits are bounded: load 10 s, app stability 15 s, busy regions 9 s,
 * animations 5 s, then one axe run. 60 s holds all of them.
 */
const PAGE_FIXTURE_TIMEOUT_MS = 60_000;

const withSweep = base.extend<{ axeSweepLedger: void }>({
  page: [
    async ({ page, javaScriptEnabled }, use, testInfo) => {
      const hydrationErrors = watchHydrationErrors(page);
      await use(page);
      await sweepAfterTest(page, testInfo, { javaScriptEnabled, hydrationErrors });
    },
    { scope: 'test', timeout: PAGE_FIXTURE_TIMEOUT_MS },
  ],
  // Set up first, so it is torn down last, after `page` has recorded its scan.
  axeSweepLedger: [
    async ({ browser }, use, testInfo) => {
      const contexts = trackOwnContexts(browser);
      try {
        await use();
      } finally {
        contexts.restore();
      }
      recordUnreached(testInfo, contexts.count());
    },
    { auto: true },
  ],
});

export const test: typeof base = axeSweepEnabled() ? (withSweep as unknown as typeof base) : base;

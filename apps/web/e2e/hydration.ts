/**
 * AECI-1655: the one real hydration gate the e2e suite has.
 *
 * With `withI18nSupport()` on, the SSR HTML carries Angular's event-replay
 * contract. Every element with a template or host listener gets a `jsaction`
 * attribute. Angular removes it once `ApplicationRef.whenStable()` resolves
 * after hydration, so its listener is live from that point (`withEventReplay`
 * in `@angular/core`). An element inside a not-yet-hydrated `@defer (hydrate …)`
 * block keeps the attribute until that block hydrates.
 *
 * Wait on this before clicking an SSR-rendered link the test needs handled
 * in-app. A link clicked earlier still follows its `href` as a full load,
 * because the inline contract never calls `preventDefault`. The click is also
 * queued, and replays into the handler if the app becomes stable before the
 * page unloads (TESTING_STRATEGY §14.3a). An element with no listener never
 * carries the attribute, so the wait returns at once for it.
 */
import { expect, type Locator } from '@playwright/test';

export async function untilHydrated(locator: Locator, timeout = 15_000): Promise<void> {
  await expect(locator, 'the element is hydrated (its jsaction is gone)').not.toHaveAttribute(
    'jsaction',
    { timeout },
  );
}

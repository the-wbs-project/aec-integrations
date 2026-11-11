import { expect, type Page } from '@playwright/test';

import { untilHydrated } from './hydration';

/**
 * Interact with the listing toolbar.
 *
 * `await expect(page.locator('app-root')).toBeAttached()` is satisfied by the
 * SSR HTML alone. It says nothing about whether Angular has hydrated. A click
 * before hydration is not dropped: the event-replay contract queues it and
 * replays it once the app is stable (AECI-1655). So each helper first waits for
 * the control's listener to be live (`untilHydrated`), then acts.
 *
 * The `toPass()` retry stays only as a safety net for a slow URL update. It is
 * safe because each retried step is idempotent: choosing `view=table` or
 * `sort=name` twice is the same as once, and `chooseSort` opens the popup only
 * when it is closed.
 */
export async function chooseView(page: Page, name: 'Cards' | 'Table'): Promise<void> {
  const expected = new RegExp(`[?&]view=${name.toLowerCase()}`);
  const button = page.getByRole('button', { name });
  await untilHydrated(button);
  await expect(async () => {
    await button.click();
    await expect(page).toHaveURL(expected, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** The `/products` sort labels, by `?sort=` key (`productSortOptions()`). */
const SORT_LABELS: Record<string, string> = {
  created: 'Newest',
  name: 'Name (A–Z)',
  updated: 'Recently updated',
  rating: 'Highest rated',
  reviews: 'Most reviewed',
};

/**
 * Pick a sort through the shared Aria combobox (`aec-listing-sort-select`):
 * open the trigger, choose the option by its label. The listbox renders in the
 * top layer, outside the toolbar, so the option is found page-wide.
 */
export async function chooseSort(page: Page, key: string): Promise<void> {
  const trigger = page.locator('aec-listing-toolbar button[role="combobox"]');
  const label = SORT_LABELS[key] ?? key;
  await expect(trigger).toBeVisible();
  await untilHydrated(trigger);
  await expect(async () => {
    // Open only when closed: a retry after a click that did open the popup
    // would otherwise toggle it shut, and the attempts alternate forever.
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
    await page.getByRole('option', { name: label }).click({ timeout: 2_000 });
    await expect(page).toHaveURL(new RegExp(`[?&]sort=${key}`), { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(trigger).toContainText(label);
}

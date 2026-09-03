import { expect, type Page } from '@playwright/test';

/**
 * Interact with the listing toolbar, retrying until the effect lands.
 *
 * `await expect(page.locator('app-root')).toBeAttached()` is satisfied by the
 * SSR HTML alone — it says nothing about whether Angular has hydrated and
 * attached its listeners. A click dispatched in that window is simply dropped,
 * so the URL never changes and the assertion times out. It fails
 * *intermittently*, because whether hydration wins the race depends on machine
 * load — the `/products` sort case was already an occasional red before
 * AECI-657 touched it.
 *
 * Both actions are idempotent (choosing `view=table` or `sort=name` twice is
 * the same as once), so retrying the action is safe. `expect(...).toPass()` is
 * Playwright's retry-the-block primitive and is the intended tool here.
 */
export async function chooseView(page: Page, name: 'Cards' | 'Table'): Promise<void> {
  const expected = new RegExp(`[?&]view=${name.toLowerCase()}`);
  await expect(async () => {
    await page.getByRole('button', { name }).click();
    await expect(page).toHaveURL(expected, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

export async function chooseSort(page: Page, key: string): Promise<void> {
  const select = page.locator('aec-listing-toolbar select');
  await expect(select).toBeVisible();
  await expect(async () => {
    await select.selectOption(key);
    await expect(page).toHaveURL(new RegExp(`[?&]sort=${key}`), { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(select).toHaveValue(key);
}

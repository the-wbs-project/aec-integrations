/**
 * AECI-243 / Phase 7.9 (§11.2) — waitlist welcome banner end-to-end.
 *
 * The banner is **cache-neutral** (§9.1a): it is never in the SSR HTML and only
 * reveals itself post-hydration when the URL carries `?ref=waitlist`. This spec
 * pins: the banner shows for a tagged arrival, is axe-clean, dismissal persists
 * across a reload (localStorage, not a cookie), the attribution token is POSTed
 * to `/api/page-views` once, and a plain `/` shows nothing.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { waitForHydrationSettle } from './console-capture';

const WAITLIST_URL = '/?ref=waitlist&token=test-token';

test.describe('/?ref=waitlist welcome banner — Phase 7.9 (AECI-243)', () => {
  test('is absent from the cached SSR HTML (cache-neutral)', async ({ request }) => {
    const html = await (await request.get(WAITLIST_URL)).text();
    // The reveal happens only after hydration; the server render carries no banner.
    expect(html).not.toContain('id="waitlist-dismiss"');
  });

  test('reveals after hydration, is axe-clean, and POSTs the attribution token', async ({
    page,
  }) => {
    const attribution = page.waitForRequest(
      (req) =>
        req.method() === 'POST' &&
        req.url().includes('/api/page-views') &&
        (req.postData() ?? '').includes('test-token'),
    );

    await page.goto(WAITLIST_URL);
    await expect(page.locator('app-root')).toBeAttached();

    const banner = page.getByRole('region', { name: 'Waitlist welcome' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Thanks for waiting');

    // Attribution token logged to page_views (reuses the AECI-177 capture).
    await attribution;

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('dismissal persists across a reload', async ({ page }) => {
    await page.goto(WAITLIST_URL);
    const dismiss = page.locator('#waitlist-dismiss');
    await expect(dismiss).toBeVisible();
    await dismiss.click();
    await expect(dismiss).toBeHidden();

    // Same tagged URL again — the persisted (localStorage) dismissal keeps it hidden.
    await page.reload();
    await waitForHydrationSettle(page);
    await expect(page.locator('#waitlist-dismiss')).toHaveCount(0);
  });

  test('plain "/" shows no banner', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();
    await waitForHydrationSettle(page);
    await expect(page.locator('#waitlist-dismiss')).toHaveCount(0);
  });
});

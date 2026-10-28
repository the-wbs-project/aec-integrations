import { expect, test, type Page } from '@playwright/test';

// AECI-1493 — a tab left open across a deploy must not get stuck.
//
// A deploy deletes the previous build's hashed chunks. These specs fake that
// from the browser side: `/_version` is routed to report a different build, and
// lazy chunk requests are routed to 404. Nothing here needs a second deploy.

const NEXT_BUILD = { sha: 'e2e-next-build', deployedAt: '2026-10-28T00:00:00.000Z' };

/** Marks the document so a full reload is detectable (it clears the marker). */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => ((window as unknown as Record<string, unknown>).__aeciDoc = true));
}

async function documentMarked(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as Record<string, unknown>).__aeciDoc === true);
}

/** The local stack runs without a stamp when `COMMIT_SHA` was not injected. */
async function skipWithoutStamp(page: Page): Promise<void> {
  const stamp = await page.locator('meta[name="aeci-build"]').count();
  test.skip(stamp === 0, 'SSR Worker has no COMMIT_SHA, so the update check is off');
}

test.describe('stale tab after a deploy (AECI-1493)', () => {
  test('SSR stamps the page with its build', async ({ page }) => {
    await page.goto('/about');
    await skipWithoutStamp(page);
    const stamp = await page.locator('meta[name="aeci-build"]').getAttribute('content');
    const version = await (await page.request.get('/_version')).json();
    expect(stamp).toBe(version.sha);
  });

  test('shows the update banner when /_version reports a newer build', async ({ page }) => {
    await page.route('**/_version', (route) => route.fulfill({ json: NEXT_BUILD }));
    await page.goto('/about');
    await skipWithoutStamp(page);

    const banner = page.locator('aec-update-banner');
    // `app-root` attached is not a hydration gate, so retry the trigger until the
    // service's listener is in place.
    await expect(async () => {
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(banner.getByText('A new version of AEC Integrations is available')).toBeVisible({
        timeout: 1000,
      });
    }).toPass({ timeout: 15_000 });

    await expect(banner.locator('[role="status"]')).toHaveAttribute('aria-live', 'polite');

    if (process.env['APP_UPDATE_SCREENSHOT']) {
      await page.screenshot({ path: process.env['APP_UPDATE_SCREENSHOT'] });
    }

    await markDocument(page);
    await banner.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => documentMarked(page).catch(() => false)).toBe(false);
  });

  test('dismissing the banner hides it', async ({ page }) => {
    await page.route('**/_version', (route) => route.fulfill({ json: NEXT_BUILD }));
    await page.goto('/about');
    await skipWithoutStamp(page);

    const refresh = page.locator('#app-update-refresh');
    await expect(async () => {
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(refresh).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });

    await page.locator('#app-update-dismiss').click();
    await expect(refresh).toHaveCount(0);
  });

  test('a navigation whose chunk 404s becomes a full page load', async ({ page }) => {
    await page.goto('/about');
    await skipWithoutStamp(page);
    await page.waitForLoadState('networkidle');
    // The deploy that deleted the chunk is what `/_version` now reports.
    await page.route('**/_version', (route) => route.fulfill({ json: NEXT_BUILD }));

    // From here on, any chunk this document has not loaded yet is "deleted".
    let blocked = true;
    let refused = 0;
    await page.route('**/chunk-*.js', (route) => {
      if (!blocked) return route.continue();
      refused += 1;
      return route.fulfill({ status: 404, body: 'Not found' });
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) blocked = false;
    });

    await markDocument(page);
    await page.locator('footer a[href="/methodology"]').first().click();

    await expect(page).toHaveURL(/\/methodology$/);
    expect(refused, 'the SPA navigation must have asked for a missing chunk').toBeGreaterThan(0);
    await expect.poll(() => documentMarked(page).catch(() => false)).toBe(false);
    await expect(page.locator('h1')).toBeVisible();
  });
});

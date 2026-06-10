import { expect, test } from '@playwright/test';

// AECI-151 — an in-app (client-side) navigation to a detail page must render
// the entity, not the global not-found shell. Before the fix the resolver's
// client branch only read TransferState (empty for a route SSR never rendered)
// and returned null, so every routerLink click rendered <aec-not-found>. A full
// load / refresh always worked because it went through the SSR server branch —
// which is exactly why no existing spec caught this (they all `goto` the URL).
//
// These specs click through from an index (a real SPA navigation), assert the
// detail content renders, the not-found shell does NOT, the navigation was
// client-side (no full reload), and the <title> was refreshed on the client.
// Skipped when the environment has no seeded data (mirrors the index specs).

test.describe('client-side navigation to detail pages (AECI-151)', () => {
  test('clicking through product → vendor renders the vendor, not the 404 shell', async ({
    page,
  }) => {
    // AECI-165 removed the /vendors index, so a vendor detail is now reached via a
    // product detail's vendor link. Exercise that client-side path end to end —
    // every hop is a SPA navigation off the single initial /products load.
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const firstProductLink = page.locator('#main a[href^="/products/"]').first();
    test.skip((await firstProductLink.count()) === 0, 'no products seeded in this environment');

    // Marker to prove every hop below is client-side (a full reload would clear it).
    await page.evaluate(() => ((window as unknown as Record<string, unknown>).__aeciSpa = true));

    await firstProductLink.click();
    await expect(page).toHaveURL(/\/products\/[^/]+$/);

    // The product detail links its owning vendor (nullable per AECI-115); skip if
    // this product has none seeded.
    const vendorLink = page.locator('aec-product-detail a[href^="/vendors/"]').first();
    test.skip(
      (await vendorLink.count()) === 0,
      'first product has no vendor link in this environment',
    );

    await vendorLink.click();
    await expect(page).toHaveURL(/\/vendors\/[^/]+$/);

    const spaPreserved = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__aeciSpa === true,
    );
    expect(spaPreserved, 'navigation must be client-side (no full document reload)').toBe(true);

    // The bug rendered <aec-not-found>; the fix renders the real detail page.
    await expect(page.locator('aec-not-found')).toHaveCount(0);
    await expect(page.locator('aec-vendor-detail')).toBeVisible();

    // Meta restored on the client branch: title is the vendor's, not the 404's.
    await expect(page).toHaveTitle(/· AEC Integrations/);
    await expect(page).not.toHaveTitle(/Not found/i);
  });

  test('clicking a product card renders the product, not the 404 shell', async ({ page }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const firstProductLink = page.locator('#main a[href^="/products/"]').first();
    test.skip((await firstProductLink.count()) === 0, 'no products seeded in this environment');

    await page.evaluate(() => ((window as unknown as Record<string, unknown>).__aeciSpa = true));

    await firstProductLink.click();
    await expect(page).toHaveURL(/\/products\/[^/]+$/);

    const spaPreserved = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__aeciSpa === true,
    );
    expect(spaPreserved, 'navigation must be client-side (no full document reload)').toBe(true);

    await expect(page.locator('aec-not-found')).toHaveCount(0);
    await expect(page.locator('aec-product-detail')).toBeVisible();
    await expect(page).not.toHaveTitle(/Not found/i);
  });

  test('clicking a category card renders the browse page, not the 404 shell', async ({ page }) => {
    await page.goto('/categories');
    await expect(page.locator('app-root')).toBeAttached();

    // Scope to the <main id="main"> content region: the shared header taxonomy
    // flyout (AECI-155) renders hidden `/categories/:slug` links in the global
    // <header> (outside #main). An unscoped `.first()` resolves to one of those
    // hidden flyout links and `.click()` times out (AECI-164).
    const firstCategoryLink = page.locator('#main a[href^="/categories/"]').first();
    test.skip((await firstCategoryLink.count()) === 0, 'no categories seeded in this environment');

    await page.evaluate(() => ((window as unknown as Record<string, unknown>).__aeciSpa = true));

    await firstCategoryLink.click();
    await expect(page).toHaveURL(/\/categories\/[^/]+$/);

    const spaPreserved = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__aeciSpa === true,
    );
    expect(spaPreserved, 'navigation must be client-side (no full document reload)').toBe(true);

    await expect(page.locator('aec-not-found')).toHaveCount(0);
    await expect(page).not.toHaveTitle(/Not found/i);
  });
});

import { expect, test } from '@playwright/test';

// AECI-94 (originally the monogram swap). The header renders the brand wordmark
// as an `<img>` of /branding/wordmark.svg with alt "AEC Integrations", so a
// crawler (Google's OAuth branding check) sees a logo image and the brand name
// on the page. See apps/web/src/app/layout/brand-logo.ts.
//
// Target a static preview shell (no API resolver). The global header/footer
// (and therefore the wordmark) render around every route via the app.ts shell.

const ROUTE = '/preview/layouts/detail';
const headerLogo = 'aec-site-header aec-brand-logo';

test.describe('brand wordmark', () => {
  test('the header home link shows the wordmark image with the brand alt', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(page.locator('app-root')).toBeAttached();

    const brandLink = page.locator(`${headerLogo} a[aria-label="AEC Integrations home"]`);
    await expect(brandLink).toHaveCount(1);

    const img = brandLink.locator('img');
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute('src', '/branding/wordmark.svg');
    await expect(img).toHaveAttribute('alt', 'AEC Integrations');
    // The SVG actually loaded (a broken src leaves naturalWidth at 0).
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  });
});

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * AECI-2083: the listing-hidden banner (AECI-1238, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11d.6) on the ungated vendor preview, through its `listing-hidden` preset. AECi hid
 * the company and its products, so the overview carries the company banner and a
 * product tab the product banner. It runs on the preview for the reason
 * `preview-vendor-portal-nav.spec.ts` gives: no vendor session, no `/vendor/` path.
 *
 * Every request off the local stack is answered here: PostHog with an empty 200, the
 * rest aborted. Nothing is submitted.
 */
const PATH = '/preview/vendor-dashboard';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return route.continue();
    if (/posthog/.test(host)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
});

async function axeSerious(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
}

test.describe('Listing hidden by AECi (preview)', () => {
  test('the overview heads with the company banner', async ({ page }) => {
    const res = await page.goto(`${PATH}/overview?fixture=listing-hidden`);
    expect(res?.status()).toBe(200);
    const banner = page.getByTestId('listing-hidden-banner');
    await expect(banner).toHaveCount(1);
    await expect(banner).toContainText('Hidden from the public site by AEC Integrations on');
    await expect(banner.getByTestId('listing-hidden-reason')).toContainText('A rights holder');
    expect(await axeSerious(page), 'listing-hidden overview must be axe clean').toEqual([]);
  });

  test('a product tab carries the product banner', async ({ page }) => {
    await page.goto(`${PATH}/products/summit-model-coordination/overview?fixture=listing-hidden`);
    await expect(page.getByTestId('listing-hidden-banner')).toHaveCount(1);
  });

  test('no other preset shows the banner', async ({ page }) => {
    await page.goto(`${PATH}/overview?fixture=verified`);
    await expect(page.locator('aec-vendor-overview-section')).toBeVisible();
    await expect(page.getByTestId('listing-hidden-banner')).toHaveCount(0);
  });
});

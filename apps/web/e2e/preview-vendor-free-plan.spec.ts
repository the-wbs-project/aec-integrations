import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * The Free plan portal (AECI-1218, `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18),
 * driven on the ungated dev preview with its three presets: Free (never had a
 * plan), Pilot ended (a revoked row with `ended_at`) and Mixed (12 products, 5
 * Managed and 7 Free).
 *
 * Runs here, not in `vendor-dashboard.spec.ts`, for the reason
 * `preview-vendor-portal-nav.spec.ts` gives: the preview needs no vendor session
 * and its path has no `/vendor/` segment for the zone WAF to refuse.
 */
const PATH = '/preview/vendor-dashboard';

async function axeSerious(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
}

test.describe('Free plan portal (preview)', () => {
  test('Free: the overview has the checklist and no plan card, and no banner', async ({ page }) => {
    const res = await page.goto(`${PATH}/overview?fixture=free`);
    expect(res?.status()).toBe(200);

    await expect(page.getByTestId('plan-summary-line')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible();
    await expect(page.getByTestId('plan-ended-banner')).toHaveCount(0);
    expect(await axeSerious(page), 'Free overview must be axe clean').toEqual([]);
  });

  test('Free: a product reads 3 of 3 and data flows are optional', async ({ page }) => {
    await page.goto(`${PATH}/products/summit-model-coordination/overview?fixture=free`);

    const checklist = page.locator('aec-vendor-checklist');
    await expect(checklist.getByTestId('checklist-score')).toHaveText('0 of 3 done');
    await expect(checklist.locator('[data-step="confirm_data_flows"]')).toContainText(
      'Available on Managed',
    );
    await expect(page.locator('aec-vendor-plan-panel')).toContainText(
      'Managed is $25 a month per product.',
    );
    expect(await axeSerious(page), 'Free product overview must be axe clean').toEqual([]);
  });

  test('Free: Looks right ticks the product details step', async ({ page }) => {
    await page.goto(`${PATH}/products/summit-model-coordination/overview?fixture=free`);
    const step = page.locator('[data-step="product_details"]');
    // Hydration has no clean DOM signal, so retry the click until it takes.
    await expect(async () => {
      await step.getByRole('button', { name: 'Looks right' }).click();
      await expect(page.getByTestId('checklist-score')).toHaveText('1 of 3 done', {
        timeout: 1_000,
      });
    }).toPass({ timeout: 15_000 });
  });

  test('Free: locked Managed fields are readonly with a described reason', async ({ page }) => {
    await page.goto(`${PATH}/products/summit-model-coordination/profile?fixture=free`);
    const apiDocs = page.getByLabel('API documentation URL');
    await expect(apiDocs).toHaveAttribute('readonly', '');
    await expect(apiDocs).toHaveAccessibleDescription(/Part of Managed for this product/);
    expect(await axeSerious(page), 'Free product profile must be axe clean').toEqual([]);
  });

  test('Pilot ended: the banner heads the page and is not dismissible', async ({ page }) => {
    await page.goto(`${PATH}/overview?fixture=pilot-ended`);
    const banner = page.getByTestId('plan-ended-banner');
    await expect(banner).toContainText('Your Managed plan has ended');
    await expect(banner).toContainText('Nothing you entered was removed.');
    await expect(banner.getByRole('button')).toHaveCount(0);
    expect(await axeSerious(page), 'Pilot ended overview must be axe clean').toEqual([]);
  });

  test('Mixed: 12 products, each with its plan and checklist score', async ({ page }) => {
    await page.goto(`${PATH}/products?fixture=mixed`);
    await expect(page.locator('aec-vendor-product-list-page li')).toHaveCount(12);
    await expect(page.getByTestId('product-checklist-score')).toHaveCount(12);
    expect(await axeSerious(page), 'Mixed product list must be axe clean').toEqual([]);
  });
});

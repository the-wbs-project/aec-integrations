import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * The vendor portal's header, breadcrumb and single tab row, driven on the
 * ungated dev preview.
 *
 * ── WHY HERE AND NOT IN `vendor-dashboard.spec.ts` ──────────────────────────
 * That spec covers the real `/vendor/:vendorSlug` surface and skips entirely
 * without `SUPABASE_VENDOR_TEST_USER_*`, which CI does not set — so it is
 * executable documentation, not a gate. `/preview/vendor-dashboard` mounts the
 * SAME shell and the SAME section routes with a fixture-backed API and no
 * session, so this file actually runs. It also sidesteps the zone WAF, which
 * 403s any path containing `/vendor/`; this path has no such segment.
 *
 * §6.11: opening a product swaps the whole header to that product. The vendor
 * row and the product row are never on the page together.
 */
const PATH = '/preview/vendor-dashboard';

const nav = (page: import('@playwright/test').Page) =>
  page.getByRole('navigation', { name: 'Portal sections' });

const productNav = (page: import('@playwright/test').Page, productName: string) =>
  page.getByRole('navigation', { name: `${productName} sections` });

const breadcrumb = (page: import('@playwright/test').Page) =>
  page.getByRole('navigation', { name: 'Breadcrumb' });

/**
 * Click something, and keep clicking until it took.
 *
 * Angular hydration has no clean DOM signal, and a click fired between "the SSR
 * markup is visible" and "the listener is attached" is silently dropped — so a
 * single `.click()` here is a coin flip that comes up tails often enough to look
 * like a real failure. Retrying the click until the state it should have
 * produced is observable is the only reliable shape.
 */
async function clickUntil(
  target: import('@playwright/test').Locator,
  settled: () => Promise<unknown>,
): Promise<void> {
  await expect(async () => {
    await target.click();
    await settled();
  }).toPass({ timeout: 15_000 });
}

async function axeSerious(page: import('@playwright/test').Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
}

test.describe('vendor portal nav (preview)', () => {
  test('is one horizontal row of five section links under a vendor breadcrumb', async ({
    page,
  }) => {
    const res = await page.goto(`${PATH}/overview`);
    expect(res?.status(), `GET ${PATH}/overview must return 200`).toBe(200);

    // Exactly one row: a `md:hidden` mobile duplicate would double every item
    // in a screen reader's link list.
    await expect(nav(page)).toHaveCount(1);
    await expect(nav(page).getByRole('link')).toHaveCount(5);
    await expect(nav(page).getByRole('link', { name: 'Vendor Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Vendor › Company. The separators are aria-hidden, so they are not list items.
    await expect(breadcrumb(page).getByRole('listitem')).toHaveCount(2);
  });

  test('navigating a section keeps one live region and moves aria-current', async ({ page }) => {
    await page.goto(`${PATH}/overview`);

    await clickUntil(nav(page).getByRole('link', { name: 'Profile', exact: true }), () =>
      expect(page).toHaveURL(new RegExp(`${PATH}/profile$`), { timeout: 1_000 }),
    );
    await expect(nav(page).getByRole('link', { name: 'Profile', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.locator('[role="status"].sr-only')).toHaveCount(1);
  });

  test('Products opens the product list, and a product takes over the header', async ({ page }) => {
    await page.goto(`${PATH}/overview`);
    await clickUntil(nav(page).getByRole('link', { name: 'Products', exact: true }), () =>
      expect(page).toHaveURL(new RegExp(`${PATH}/products$`), { timeout: 1_000 }),
    );

    const productName = 'Summit Field Issues';
    await clickUntil(page.getByRole('link', { name: productName }), () =>
      expect(page).toHaveURL(new RegExp(`${PATH}/products/summit-field-issues/profile$`), {
        timeout: 1_000,
      }),
    );

    await expect(page.locator('h1')).toHaveText(productName);
    await expect(nav(page)).toHaveCount(0);
    await expect(productNav(page, productName)).toHaveCount(1);
    await expect(breadcrumb(page).getByRole('link', { name: 'Products' })).toHaveCount(1);
    expect(await axeSerious(page), 'product context must be axe clean').toEqual([]);
  });

  test('the product row navigates and the vendor crumb returns to the vendor', async ({ page }) => {
    const productName = 'Summit Field Issues';
    await page.goto(`${PATH}/products/summit-field-issues/profile`);

    await clickUntil(
      productNav(page, productName).getByRole('link', { name: 'Integrations', exact: true }),
      () =>
        expect(page).toHaveURL(new RegExp(`${PATH}/products/summit-field-issues/integrations$`), {
          timeout: 1_000,
        }),
    );
    await expect(
      productNav(page, productName).getByRole('link', { name: 'Integrations', exact: true }),
    ).toHaveAttribute('aria-current', 'page');

    await clickUntil(breadcrumb(page).getByRole('link', { name: 'Vendor', exact: true }), () =>
      expect(page).toHaveURL(new RegExp(`${PATH}/overview$`), { timeout: 1_000 }),
    );
    await expect(nav(page)).toHaveCount(1);
    await expect(productNav(page, productName)).toHaveCount(0);
    expect(await axeSerious(page), 'vendor context must be axe clean').toEqual([]);
  });
  // AECI-1102: the "product not found" line's link sat in running text told
  // apart by colour alone (axe `link-in-text-block`, serious). The "No access ·
  // new" preset swaps to a vendor that owns no products, so the product route
  // renders that state.
  test('the product-not-found state is axe clean', async ({ page }) => {
    await page.goto(`${PATH}/products/summit-model-coordination/integrations`);
    const notFound = page.getByText("That product isn't linked to your vendor.");
    await clickUntil(page.getByRole('button', { name: 'No access · new' }), () =>
      expect(notFound).toBeVisible({ timeout: 1_000 }),
    );
    await expect(page.getByRole('link', { name: 'See your products' })).toHaveCSS(
      'text-decoration-line',
      'underline',
    );
    expect(await axeSerious(page), 'product-not-found state must be axe clean').toEqual([]);
  });
});

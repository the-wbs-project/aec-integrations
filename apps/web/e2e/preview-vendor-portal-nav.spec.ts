import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * The vendor portal's horizontal nav and its filterable Products menu, driven on
 * the ungated dev preview.
 *
 * ── WHY HERE AND NOT IN `vendor-dashboard.spec.ts` ──────────────────────────
 * That spec covers the real `/vendor/:vendorSlug` surface and skips entirely
 * without `SUPABASE_VENDOR_TEST_USER_*`, which CI does not set — so it is
 * executable documentation, not a gate. `/preview/vendor-dashboard` mounts the
 * SAME shell and the SAME section routes with a fixture-backed API and no
 * session, so this file actually runs. It also sidesteps the zone WAF, which
 * 403s any path containing `/vendor/`; this path has no such segment.
 *
 * What this covers that the component specs cannot: Aria's real
 * ArrowDown → `aria-activedescendant` → Enter commit, a real outside click, real
 * focus order out of the browser's top layer, and an axe pass with the panel
 * OPEN — which is the only automated check that would catch an empty
 * `role="listbox"` or a menu illegally owning a textbox.
 */
const PATH = '/preview/vendor-dashboard';

/** The 20-product fixture. Two products cannot exercise a search box. */
const LARGE_CATALOG = 'Active · 20 products';

const nav = (page: import('@playwright/test').Page) =>
  page.getByRole('navigation', { name: 'Portal sections' });

const productsTrigger = (page: import('@playwright/test').Page) =>
  nav(page).getByRole('button', { name: 'Products', exact: true });

const searchBox = (page: import('@playwright/test').Page) =>
  page.getByRole('combobox', { name: 'Filter products' });

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

async function openLargeCatalog(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${PATH}/overview`);
  const fixtureButton = page.getByRole('button', { name: LARGE_CATALOG });
  await clickUntil(fixtureButton, () =>
    expect(fixtureButton).toHaveAttribute('aria-pressed', 'true', { timeout: 1_000 }),
  );
  await expect(productsTrigger(page)).toBeVisible();
}

async function openMenu(page: import('@playwright/test').Page): Promise<void> {
  // The post-condition has to be one that STICKS. A click that lands mid-
  // hydration can flip `aria-expanded` to true and then have the subtree
  // re-created under it, so asserting the attribute alone can pass on a state
  // that is gone a frame later. Requiring the search box to still be focused
  // after a beat is the condition that only a real open satisfies.
  await clickUntil(productsTrigger(page), async () => {
    await expect(searchBox(page)).toBeFocused({ timeout: 1_000 });
    await page.waitForTimeout(250);
    await expect(productsTrigger(page)).toHaveAttribute('aria-expanded', 'true', {
      timeout: 1_000,
    });
  });
}

test.describe('vendor portal nav (preview)', () => {
  test('is one horizontal row of five sections, four of them links', async ({ page }) => {
    const res = await page.goto(`${PATH}/overview`);
    expect(res?.status(), `GET ${PATH}/overview must return 200`).toBe(200);

    // Exactly one row: a `md:hidden` mobile duplicate would double every item
    // in a screen reader's link list.
    await expect(nav(page)).toHaveCount(1);
    await expect(nav(page).getByRole('link')).toHaveCount(4);
    await expect(productsTrigger(page)).toHaveCount(1);
    await expect(nav(page).getByRole('link', { name: 'Vendor Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
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
});

test.describe('vendor portal products menu (preview)', () => {
  test('opens on the trigger, focuses the search box, and lists the catalog', async ({ page }) => {
    await openLargeCatalog(page);
    await openMenu(page);

    await expect(productsTrigger(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(searchBox(page)).toBeFocused();
    await expect(page.getByRole('option')).toHaveCount(20);
    // Alphabetical: the menu is a lookup, not a ranking.
    await expect(page.getByRole('option').first()).toHaveText(/Summit Asset Register/);
  });

  test('filters, then commits with the keyboard, and the URL names the product', async ({
    page,
  }) => {
    // The path the component spec deliberately does not fake: Aria's own
    // ArrowDown → aria-activedescendant → Enter commit.
    await openLargeCatalog(page);
    await openMenu(page);
    await searchBox(page).fill('warranty');

    await expect(page.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(searchBox(page)).toHaveAttribute('aria-activedescendant', /.+/);
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(new RegExp(`${PATH}/products/summit-warranty-tracker$`));
    await expect(productsTrigger(page)).toHaveAttribute('aria-current', 'true');
    await expect(searchBox(page)).toHaveCount(0);
  });

  test('a query that matches nothing renders no listbox at all', async ({ page }) => {
    // An empty `role="listbox"` is an aria-required-children violation, and Aria
    // expands on every keystroke, so this is the state that has to be checked
    // rather than assumed.
    await openLargeCatalog(page);
    await openMenu(page);
    await searchBox(page).fill('zzzzzz');

    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(page.getByText('No products match that name')).toBeVisible();
  });

  test('Escape closes and returns focus to the trigger', async ({ page }) => {
    await openLargeCatalog(page);
    await openMenu(page);
    await expect(searchBox(page)).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(productsTrigger(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(productsTrigger(page)).toBeFocused();
  });

  test('a click outside closes it without stealing focus back', async ({ page }) => {
    await openLargeCatalog(page);
    await openMenu(page);
    await expect(searchBox(page)).toBeVisible();

    await page.locator('h1').click();
    await expect(productsTrigger(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(searchBox(page)).toHaveCount(0);
  });

  test('stays a single live region with the panel open, and is axe clean', async ({ page }) => {
    await openLargeCatalog(page);
    await openMenu(page);
    await expect(searchBox(page)).toBeFocused();

    // A "20 products match" status on the panel would be the forbidden second
    // region (STAGE_2_REALTIME_SPEC.md §6.3).
    await expect(page.locator('[role="status"].sr-only')).toHaveCount(1);

    const open = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(
      open.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious'),
      'open products menu must be axe clean',
    ).toEqual([]);

    await page.keyboard.press('Escape');
    const closed = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(
      closed.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious'),
      'closed portal nav must be axe clean',
    ).toEqual([]);
  });

  test('a vendor with nothing to choose between gets a link instead of a menu', async ({
    page,
  }) => {
    // The never-verified fixture owns no products at all. A dropdown over one
    // option (or none) is noise, and a link keeps the section reachable.
    await page.goto(`${PATH}/overview`);
    const fixtureButton = page.getByRole('button', { name: 'Never verified · new' });
    await clickUntil(fixtureButton, () =>
      expect(fixtureButton).toHaveAttribute('aria-pressed', 'true', { timeout: 1_000 }),
    );

    await expect(nav(page).getByRole('button', { name: 'Products', exact: true })).toHaveCount(0);
    await expect(nav(page).getByRole('link', { name: 'Products', exact: true })).toHaveCount(1);
  });
});

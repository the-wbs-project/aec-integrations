import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// AECI-96 / AECI-158 / AECI-159. The primary navigation (DESIGN.md §5) is
// responsive AND taxonomy-driven. Below `md` it is a labelled hamburger to the
// left of the wordmark that opens a CDK-overlay dropdown holding all site chrome
// — Home + Products links, the Categories / Audiences / Phases facets as
// tap-to-expand disclosure sections, search, and Sign-in. At `md+` the hamburger
// drops out and the same set renders inline: Home + Products links and three
// facet flyout triggers (label links to the index, an adjacent disclosure button
// reveals the top values). Vendors / Integrations no longer live in the nav
// (they moved to the footer).
//
// Unlike layouts.spec.ts (which EXCLUDES the header from axe), this spec is
// specifically about the header/menu, so axe INCLUDES `aec-site-header` and the
// open overlay panel.

// Any route renders the global header; browse is a known-200 preview route.
const ROUTE = '/preview/layouts/browse';
const MOBILE = { width: 375, height: 667 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// Top-level links (not the taxonomy facets, which are flyouts/disclosures).
const TOP_LINKS = ['Home', 'Products'] as const;
const FACETS = ['Categories', 'Audiences', 'Phases'] as const;
// Pulled out of the nav by AECI-159 — must NOT appear in either arrangement.
const REMOVED = ['Vendors', 'Integrations'] as const;

// CSS locator, not getByRole: while the menu is open the popover marks the
// background (including the trigger) aria-hidden for the focus trap, so a
// role/name query can't find the toggle mid-open. A CSS locator still resolves
// it. The accessible NAME is asserted separately in the closed state below.
function toggle(page: Page) {
  return page.locator('aec-nav-menu button[aria-haspopup="dialog"]');
}

function overlay(page: Page) {
  return page.locator('.cdk-overlay-container');
}

test.describe('primary navigation menu (375px)', () => {
  test.use({ viewport: MOBILE });

  test('the labelled menu toggle is reachable and the header does not overflow', async ({
    page,
  }) => {
    await page.goto(ROUTE);
    await expect(page.locator('app-root')).toBeAttached();

    const named = page.getByRole('button', { name: 'Open menu' });
    await expect(named).toBeVisible();
    await expect(named).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(named).toHaveAttribute('aria-expanded', 'false');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'document must not overflow horizontally on mobile').toBeLessThanOrEqual(1);
  });

  test('opening the menu exposes links, facet sections, search, and sign-in', async ({ page }) => {
    await page.goto(ROUTE);
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');

    for (const name of TOP_LINKS) {
      await expect(overlay(page).getByRole('link', { name })).toBeVisible();
    }
    // The three facets are tap-to-expand disclosure buttons (collapsed initially).
    for (const name of FACETS) {
      const section = overlay(page).getByRole('button', { name });
      await expect(section).toBeVisible();
      await expect(section).toHaveAttribute('aria-expanded', 'false');
    }
    // Vendors / Integrations are gone from the nav.
    for (const name of REMOVED) {
      await expect(overlay(page).getByRole('link', { name })).toHaveCount(0);
    }

    // The search box is the `aec-search-autocomplete` combobox (AECI-144); Angular
    // Aria sets role="combobox" on the input (was a plain searchbox placeholder).
    await expect(overlay(page).getByRole('combobox', { name: 'Search' })).toBeVisible();
    await expect(overlay(page).getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('expanding a facet section reveals its value list and the View-all link', async ({
    page,
  }) => {
    await page.goto(ROUTE);
    await toggle(page).click();

    const categories = overlay(page).getByRole('button', { name: 'Categories' });
    await categories.click();
    await expect(categories).toHaveAttribute('aria-expanded', 'true');

    // "View all categories" always renders (independent of seeded values) and
    // points at the index.
    const viewAll = overlay(page).getByRole('link', { name: 'View all categories' });
    await expect(viewAll).toBeVisible();
    await expect(viewAll).toHaveAttribute('href', '/categories');

    // Collapsing hides it again.
    await categories.click();
    await expect(categories).toHaveAttribute('aria-expanded', 'false');
    await expect(viewAll).toBeHidden();
  });

  test('Escape closes the menu and returns focus to the toggle', async ({ page }) => {
    await page.goto(ROUTE);
    await toggle(page).click();
    await expect(overlay(page).getByRole('link', { name: 'Products' })).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(overlay(page).getByRole('link', { name: 'Products' })).toBeHidden();
    await expect(toggle(page)).toBeFocused();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('clicking outside closes the menu', async ({ page }) => {
    await page.goto(ROUTE);
    await toggle(page).click();
    await expect(overlay(page).getByRole('link', { name: 'Products' })).toBeVisible();

    await page.mouse.click(5, 400);

    await expect(overlay(page).getByRole('link', { name: 'Products' })).toBeHidden();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('selecting a top-level link navigates and closes the menu', async ({ page }) => {
    await page.goto(ROUTE);
    await toggle(page).click();
    const link = overlay(page).getByRole('link', { name: 'Products' });
    await expect(link).toBeVisible();

    await link.click();

    await page.waitForURL(/\/products$/);
    await expect(overlay(page).getByRole('link', { name: 'Products' })).toBeHidden();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('a facet "View all" link navigates to the index and closes the menu', async ({ page }) => {
    await page.goto(ROUTE);
    await toggle(page).click();
    await overlay(page).getByRole('button', { name: 'Phases' }).click();
    const viewAll = overlay(page).getByRole('link', { name: 'View all phases' });
    await expect(viewAll).toBeVisible();

    await viewAll.click();

    await page.waitForURL(/\/phases$/);
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('header + menu are axe-clean (closed and open)', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(toggle(page)).toBeVisible();
    expect(await analyzeHeader(page), 'closed state').toEqual([]);

    await toggle(page).click();
    await overlay(page).getByRole('button', { name: 'Categories' }).click();
    await expect(overlay(page).getByRole('link', { name: 'View all categories' })).toBeVisible();
    expect(await analyzeHeaderAndOverlay(page), 'open state').toEqual([]);
  });
});

test.describe('primary navigation menu (1280px)', () => {
  test.use({ viewport: DESKTOP });

  function primaryNav(page: Page) {
    return page.locator('aec-site-header').getByRole('navigation', { name: 'Primary' });
  }

  test('inline nav replaces the hamburger at desktop width', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(page.locator('app-root')).toBeAttached();

    await expect(toggle(page)).toBeHidden();

    const nav = primaryNav(page);
    for (const name of TOP_LINKS) {
      await expect(nav.getByRole('link', { name })).toBeVisible();
    }
    // Each facet renders an index link plus a disclosure button.
    for (const name of FACETS) {
      await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
      await expect(nav.getByRole('button', { name: `${name} menu` })).toBeVisible();
    }
    for (const name of REMOVED) {
      await expect(nav.getByRole('link', { name })).toHaveCount(0);
    }

    const header = page.locator('aec-site-header');
    await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('hovering a facet opens its flyout with the top values + View all', async ({ page }) => {
    await page.goto(ROUTE);
    await primaryNav(page).getByRole('link', { name: 'Categories', exact: true }).hover();

    const panel = page.locator('#nav-flyout-category');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('link', { name: 'View all categories' })).toHaveAttribute(
      'href',
      '/categories',
    );
  });

  test('the flyout opens on keyboard and Escape closes it, returning focus', async ({ page }) => {
    await page.goto(ROUTE);
    const button = primaryNav(page).getByRole('button', { name: 'Audiences menu' });
    await button.focus();
    await page.keyboard.press('Enter');

    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#nav-flyout-audience')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).toBeFocused();
  });

  test('desktop header is axe-clean (closed and with a flyout open)', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(primaryNav(page).getByRole('link', { name: 'Products' })).toBeVisible();
    expect(await analyzeHeader(page), 'closed').toEqual([]);

    // Pointer affordance is hover-to-open (see the "hovering a facet" test
    // above): the host opens on `mouseenter`, while the trigger button's click
    // *toggles*. A literal `.click()` therefore lands as mouseenter(open) →
    // click(toggle→close), netting closed — so drive the open state the way a
    // mouse user actually does, by hovering the trigger.
    await primaryNav(page).getByRole('button', { name: 'Categories menu' }).hover();
    await expect(page.locator('#nav-flyout-category')).toBeVisible();
    expect(await analyzeHeader(page), 'flyout open').toEqual([]);
  });
});

async function analyzeHeader(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(AXE_TAGS)
    .include('aec-site-header')
    .analyze();
  return results.violations.map(formatViolation);
}

async function analyzeHeaderAndOverlay(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(AXE_TAGS)
    .include('aec-site-header')
    .include('.cdk-overlay-container')
    .analyze();
  return results.violations.map(formatViolation);
}

function formatViolation(v: {
  impact?: string | null;
  id: string;
  help: string;
  nodes: { target: unknown[] }[];
}): string {
  const targets = v.nodes.map((n) => `\n    ${n.target.join(' ')}`).join('');
  return `[${v.impact ?? '?'}] ${v.id}: ${v.help} (${v.nodes.length} node(s))${targets}`;
}

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// AECI-96 / AECI-158 / AECI-159. The primary navigation (DESIGN.md §5) is
// responsive AND taxonomy-driven. Below `lg` it is a labelled hamburger to the
// left of the wordmark that opens a CDK-overlay dropdown holding site navigation:
// Home + Products links, the four facets as tap-to-expand disclosure sections,
// search, and the account block / Sign-in. At `lg+` the hamburger drops out and
// the same set renders inline: Home + Products links plus four facet flyout
// triggers (one text link that navigates to the index and also discloses the top
// values on hover / ArrowDown — there is no separate arrow button).
// Vendors / Integrations no longer live in the nav (AECI-159).
//
// The "More" overflow menu is gone. The row is public-directory-only and closed,
// so its secondary destinations (Updates, Roadmap, About, Contact) and Legal
// group live in the footer, covered by `site-footer.component.spec.ts` and the
// footer navigation in `updates.spec.ts`. The `/admin` IA it duplicated is now a
// single role-gated "Admin portal" door in the account menu, which needs a real
// session to drive (see the authed-console spec); the door's visibility rules are
// covered by `user-menu.component.spec.ts`. So this spec asserts the row is
// exactly the six public destinations and that nothing role-gated leaks into it.
//
// Unlike layouts.spec.ts (which EXCLUDES the header from axe), this spec is
// specifically about the header/menu, so axe INCLUDES `aec-site-header` and the
// open overlay panel.

// Any route renders the global header; browse is a known-200 preview route.
const ROUTE = '/preview/layouts/browse';
const MOBILE = { width: 375, height: 667 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;
// The `lg`-`xl` band. Neither the hamburger nor the inline search box renders
// here, so it is the width the compact `aec-search-trigger` exists to cover.
// 1100 rather than 1024 so the assertions aren't sitting on the exact edge; the
// row's fit at 1024 is pinned by measurement in `site-header.ts`, not here.
const NARROW_DESKTOP = { width: 1100, height: 800 } as const;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// Top-level links (not the taxonomy facets, which are flyouts/disclosures).
const TOP_LINKS = ['Home', 'Products'] as const;
const FACETS = ['Categories', 'Trades', 'Audiences', 'Phases'] as const;
// The secondary destinations that used to hang off the header's "More" menu.
// They are footer-only now, and must NOT reappear in the primary row at either
// width — the row is width-budgeted and reserved for directory surfaces.
const SECONDARY = ['Updates', 'Roadmap', 'About', 'Contact', 'Terms'] as const;
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

  test('carries no "More" disclosure and no secondary destinations', async ({ page }) => {
    await page.goto(ROUTE);
    await toggle(page).click();

    // The overflow disclosure was retired with the desktop menu. On a phone the
    // secondary links are a scroll to the footer rather than two taps here —
    // the one deliberate reach regression of that change.
    await expect(overlay(page).getByRole('button', { name: 'More' })).toHaveCount(0);
    for (const name of SECONDARY) {
      await expect(overlay(page).getByRole('link', { name, exact: true })).toHaveCount(0);
    }
    // Signed out, so no portal door is rendered at all.
    await expect(overlay(page).locator('a[href^="/admin"]')).toHaveCount(0);
    await expect(overlay(page).locator('a[href^="/vendor"]')).toHaveCount(0);
  });

  test('the footer still carries every secondary destination', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(page.locator('app-root')).toBeAttached();

    // The footer is server-rendered on every page, which is what makes it a
    // sound home for the links the header stopped carrying.
    const company = page.getByRole('navigation', { name: 'Company' });
    await expect(company.getByRole('link', { name: 'Updates', exact: true })).toHaveAttribute(
      'href',
      '/updates',
    );
    await expect(company.getByRole('link', { name: 'Roadmap', exact: true })).toHaveAttribute(
      'href',
      '/roadmap',
    );
    await expect(
      page.getByRole('navigation', { name: 'Legal' }).getByRole('link', { name: 'Terms' }),
    ).toHaveAttribute('href', '/legal/terms');
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
    // Each facet is ONE control: an index link that is also the disclosure
    // trigger (no separate arrow button), so the disclosure attributes have to
    // sit on the link itself.
    for (const name of FACETS) {
      const facet = nav.getByRole('link', { name, exact: true });
      await expect(facet).toBeVisible();
      await expect(facet).toHaveAttribute('aria-haspopup', 'true');
      await expect(facet).toHaveAttribute('aria-expanded', 'false');
    }
    // Six items, full stop: no overflow trigger, no secondary destination, and
    // nothing role-gated (the header is cached URL-keyed HTML, so an /admin href
    // here would leak to the next visitor of this URL).
    await expect(nav.getByRole('button', { name: 'More menu' })).toHaveCount(0);
    for (const name of SECONDARY) {
      await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
    }
    await expect(nav.locator('a[href^="/admin"]')).toHaveCount(0);
    for (const name of REMOVED) {
      await expect(nav.getByRole('link', { name })).toHaveCount(0);
    }

    const header = page.locator('aec-site-header');
    await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('the overflow panel is gone, and its links stayed crawlable in the footer', async ({
    page,
  }) => {
    await page.goto(ROUTE);

    // The old panel was `[hidden]`, not unmounted, so its links shipped in SSR
    // HTML. The footer is equally server-rendered, so retiring the panel cost
    // crawlers nothing — that equivalence is the point of this assertion.
    await expect(page.locator('#nav-more-panel')).toHaveCount(0);

    const footer = page.locator('aec-site-footer');
    for (const href of ['/updates', '/roadmap', '/about', '/contact', '/legal/terms']) {
      await expect(footer.locator(`a[href="${href}"]`), href).toHaveCount(1);
    }
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
    const trigger = primaryNav(page).getByRole('link', { name: 'Audiences', exact: true });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');

    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator('#nav-flyout-audience');
    await expect(panel).toBeVisible();
    // The focus move has to survive a REAL render: the panel is `[hidden]` until
    // change detection runs, and a focus attempt scheduled before that lands on a
    // `display: none` element and is silently dropped.
    await expect(panel.getByRole('link').first()).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
  });

  test('desktop header is axe-clean (closed and with a flyout open)', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(primaryNav(page).getByRole('link', { name: 'Products' })).toBeVisible();
    expect(await analyzeHeader(page), 'closed').toEqual([]);

    await primaryNav(page).getByRole('link', { name: 'Categories', exact: true }).hover();
    await expect(page.locator('#nav-flyout-category')).toBeVisible();
    expect(await analyzeHeader(page), 'flyout open').toEqual([]);

    // A second facet, since the four flyouts are the only dropdowns left in the
    // row and they share one behaviour base (`layout/nav-disclosure.ts`).
    await primaryNav(page).getByRole('link', { name: 'Phases', exact: true }).hover();
    await expect(page.locator('#nav-flyout-phase')).toBeVisible();
    expect(await analyzeHeader(page), 'second flyout open').toEqual([]);
  });
});

// The 1024-1279 band used to render NO search affordance at all: the hamburger
// (which carries a search box) is `lg:hidden`, and the inline header box is
// `hidden xl:block`, so the two breakpoints never met. The inline box genuinely
// does not fit at 1024 - the row has ~1px of slack - so the fix is the compact
// icon trigger rather than widening the box. These tests are the regression
// guard: the failure mode is silent (nothing throws, search just disappears at
// some widths), so both "exactly one affordance" and "it actually works" are
// pinned here.
test.describe('header search in the lg-xl band (1100px)', () => {
  test.use({ viewport: NARROW_DESKTOP });

  function searchTrigger(page: Page) {
    return page.locator('aec-search-trigger button');
  }

  test('the compact trigger is the only search affordance at this width', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(page.locator('app-root')).toBeAttached();

    // The hamburger (and its search box) is gone above `lg`...
    await expect(toggle(page)).toBeHidden();
    // ...and the inline box has not arrived yet below `xl`.
    await expect(page.locator('aec-site-header aec-search-autocomplete')).toBeHidden();
    // ...so this is what carries search here.
    await expect(searchTrigger(page)).toBeVisible();
    await expect(searchTrigger(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('the trigger opens a focused search box and Escape returns focus', async ({ page }) => {
    await page.goto(ROUTE);
    await searchTrigger(page).click();

    const input = overlay(page).getByRole('combobox', { name: 'Search' });
    await expect(input).toBeVisible();
    // Opening a search affordance that does not take focus is a dead control.
    await expect(input).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(input).toHaveCount(0);
    await expect(searchTrigger(page)).toBeFocused();
  });

  test('submitting a query from the panel reaches /search', async ({ page }) => {
    await page.goto(ROUTE);
    await searchTrigger(page).click();

    await overlay(page).getByRole('combobox', { name: 'Search' }).fill('revit');
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/search\?q=revit/);
  });

  test('the header and the open search panel are axe-clean', async ({ page }) => {
    await page.goto(ROUTE);
    expect(await analyzeHeader(page), 'closed').toEqual([]);

    await searchTrigger(page).click();
    await expect(overlay(page).getByRole('combobox', { name: 'Search' })).toBeVisible();
    expect(await analyzeHeaderAndOverlay(page), 'search panel open').toEqual([]);
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

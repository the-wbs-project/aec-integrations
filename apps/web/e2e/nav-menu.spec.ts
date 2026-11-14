import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { untilHydrated } from './hydration';

// AECI-96 / AECI-159 / AECI-1774. The primary navigation (DESIGN.md §5) is
// responsive. Below `lg` it is a labelled hamburger that opens a CDK-overlay
// dropdown: "All products", the four facets as tap-to-expand sections, How we
// rank, For vendors, search, and the account block or Sign in. At `lg+` the
// row is Browse, How we rank and For vendors. "Browse" is a link to /products
// that also discloses the Browse menu: one white panel of five columns. It is
// disclosure navigation, not an ARIA menu, so it has no aria-haspopup.
//
// The "More" overflow menu is gone. The row is public-only and closed, so its
// secondary destinations (Updates, Roadmap, About, Contact) and Legal group
// live in the footer, covered by `site-footer.component.spec.ts` and the
// footer navigation in `updates.spec.ts`. The `/admin` IA is a single
// role-gated "Admin portal" door in the account menu, which needs a real
// session to drive (see the authed-console spec); the door's visibility rules
// are covered by `site-header.component.spec.ts`. So this spec asserts the row
// is exactly the three public destinations and that nothing role-gated leaks.
//
// Unlike layouts.spec.ts (which EXCLUDES the header from axe), this spec is
// specifically about the header/menu, so axe INCLUDES `aec-site-header` and the
// open overlay panel.

// Any route renders the global header; browse is a known-200 preview route.
const ROUTE = '/preview/layouts/browse';
const MOBILE = { width: 375, height: 667 } as const;
// iPhone SE (1st gen). Short enough that the open menu outgrows the viewport.
const SHORT_MOBILE = { width: 375, height: 568 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// The mobile menu's plain links (the facets are disclosures), and the desktop row.
const TOP_LINKS = ['All products', 'How we rank', 'For vendors'] as const;
const ROW = [
  ['Browse', '/products'],
  ['How we rank', '/docs/trust/how-ranking-works'],
  ['For vendors', '/vendor-program'],
] as const;
// The Browse menu's column order, shared by the mobile sections.
const FACETS = ['Categories', 'Phases', 'Audiences', 'Trades'] as const;
// Every index the old row and its four flyouts reached.
const INDEXES = [
  ['See all categories', '/categories'],
  ['See all phases', '/phases'],
  ['See all audiences', '/audiences'],
  ['See all trades', '/trades'],
] as const;
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

// Open the menu on a hydrated toggle (AECI-1655). A click before hydration is
// queued and replayed at app stability, so without the wait the open lands at a
// load-dependent moment rather than on the click.
//
// Then wait until the popover is listening (AECI-1672). A visible panel is not
// yet a listening panel. Spartan's popover renders the panel inside the click
// handler, but it subscribes to the overlay's outside-click and Escape streams
// in a root effect, which runs on the NEXT app tick. CDK drops an outside click
// or Escape that arrives before then, because the stream has no subscriber yet.
// The trigger's `aria-expanded` is a host binding, so it flips to "true" in the
// same tick that attaches the listeners. Focus on the first link (the popover's
// focus trap) lands after that render, so it confirms the panel is ready too.
async function openMenu(page: Page) {
  await untilHydrated(toggle(page));
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(overlay(page).getByRole('link', { name: 'All products' })).toBeFocused();
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
    await openMenu(page);

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
      await expect(overlay(page).getByRole('link', { name, exact: true })).toHaveCount(0);
    }

    // The search box is the `aec-search-autocomplete` combobox (AECI-144); Angular
    // Aria sets role="combobox" on the input (was a plain searchbox placeholder).
    const search = overlay(page).getByRole('combobox', { name: 'Search' });
    await expect(search).toBeVisible();
    // The results are products and vendors, so the box names the directory (AECI-985).
    await expect(search).toHaveAttribute('placeholder', 'Search directory');
    await expect(overlay(page).getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('expanding a facet section reveals its value list and the See-all link', async ({
    page,
  }) => {
    await page.goto(ROUTE);
    await openMenu(page);

    const categories = overlay(page).getByRole('button', { name: 'Categories' });
    await categories.click();
    await expect(categories).toHaveAttribute('aria-expanded', 'true');

    // "See all categories" always renders (independent of seeded values) and
    // points at the index.
    const viewAll = overlay(page).getByRole('link', { name: 'See all categories' });
    await expect(viewAll).toBeVisible();
    await expect(viewAll).toHaveAttribute('href', '/categories');

    // Collapsing hides it again.
    await categories.click();
    await expect(categories).toHaveAttribute('aria-expanded', 'false');
    await expect(viewAll).toBeHidden();
  });

  test('Escape closes the menu and returns focus to the toggle', async ({ page }) => {
    await page.goto(ROUTE);
    await openMenu(page);
    await expect(overlay(page).getByRole('link', { name: 'All products' })).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(overlay(page).getByRole('link', { name: 'All products' })).toBeHidden();
    await expect(toggle(page)).toBeFocused();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('clicking outside closes the menu', async ({ page }) => {
    await page.goto(ROUTE);
    await openMenu(page);
    await expect(overlay(page).getByRole('link', { name: 'All products' })).toBeVisible();

    await page.mouse.click(5, 400);

    await expect(overlay(page).getByRole('link', { name: 'All products' })).toBeHidden();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('selecting a top-level link navigates and closes the menu', async ({ page }) => {
    await page.goto(ROUTE);
    await openMenu(page);
    const link = overlay(page).getByRole('link', { name: 'All products' });
    await expect(link).toBeVisible();

    await link.click();

    await page.waitForURL(/\/products$/);
    await expect(overlay(page).getByRole('link', { name: 'All products' })).toBeHidden();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('carries no "More" disclosure and no secondary destinations', async ({ page }) => {
    await page.goto(ROUTE);
    await openMenu(page);

    // The overflow disclosure was retired with the desktop menu. On a phone the
    // secondary links are a scroll to the footer rather than two taps here —
    // the one deliberate reach regression of that change.
    await expect(overlay(page).getByRole('button', { name: 'More' })).toHaveCount(0);
    for (const name of SECONDARY) {
      await expect(overlay(page).getByRole('link', { name, exact: true })).toHaveCount(0);
    }
    // Signed out, so no portal door is rendered at all.
    await expect(overlay(page).locator('a[href^="/admin"]')).toHaveCount(0);
    await expect(overlay(page).locator('a[href="/vendor"], a[href^="/vendor/"]')).toHaveCount(0);
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
      page
        .getByRole('navigation', { name: 'Legal' })
        .getByRole('link', { name: 'Terms', exact: true }),
    ).toHaveAttribute('href', '/legal/terms');
  });

  test('a facet "See all" link navigates to the index and closes the menu', async ({ page }) => {
    await page.goto(ROUTE);
    await openMenu(page);
    await overlay(page).getByRole('button', { name: 'Phases' }).click();
    const viewAll = overlay(page).getByRole('link', { name: 'See all phases' });
    await expect(viewAll).toBeVisible();

    await viewAll.click();

    await page.waitForURL(/\/phases$/);
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('with every facet open on a short screen, the panel scrolls and its last rows still work', async ({
    page,
  }) => {
    // AECI-1487. The overlay pane is fixed, so a panel taller than the viewport
    // left its lower rows unreachable: Playwright reported the Audiences row
    // "outside of the viewport" once Categories and Trades were open. The panel
    // is now capped at the viewport and scrolls inside.
    await page.setViewportSize(SHORT_MOBILE);
    await page.goto(ROUTE);
    await openMenu(page);
    for (const name of FACETS) {
      await overlay(page).getByRole('button', { name }).click();
    }

    const panel = overlay(page).getByRole('navigation', { name: 'Primary' });
    const box = await panel.boundingBox();
    expect(box, 'the open panel has a box').not.toBeNull();
    expect(box!.y + box!.height, 'the panel ends inside the viewport').toBeLessThanOrEqual(
      SHORT_MOBILE.height,
    );
    expect(
      await panel.evaluate((el) => el.scrollHeight > el.clientHeight),
      'the panel scrolls',
    ).toBe(true);

    // The bottom row is reachable by scrolling the panel itself.
    const signIn = overlay(page).getByRole('link', { name: 'Sign in' });
    await signIn.scrollIntoViewIfNeeded();
    await expect(signIn).toBeInViewport();

    await overlay(page).getByRole('link', { name: 'See all phases' }).click();

    await page.waitForURL(/\/phases$/);
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('header + menu are axe-clean (closed and open)', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(toggle(page)).toBeVisible();
    expect(await analyzeHeader(page), 'closed state').toEqual([]);

    await openMenu(page);
    await overlay(page).getByRole('button', { name: 'Categories' }).click();
    await expect(overlay(page).getByRole('link', { name: 'See all categories' })).toBeVisible();
    expect(await analyzeHeaderAndOverlay(page), 'open state').toEqual([]);
  });
});

test.describe('primary navigation menu (1280px)', () => {
  test.use({ viewport: DESKTOP });

  function primaryNav(page: Page) {
    return page.locator('aec-site-header').getByRole('navigation', { name: 'Primary' });
  }

  function browse(page: Page) {
    return primaryNav(page).getByRole('link', { name: 'Browse', exact: true });
  }

  function panel(page: Page) {
    return page.locator('#browse-menu-panel');
  }

  // Open by keyboard on a hydrated trigger, and wait for the focus move, which
  // lands only after the render that clears `[hidden]`.
  async function openByKeyboard(page: Page) {
    await untilHydrated(browse(page));
    await browse(page).focus();
    await page.keyboard.press('ArrowDown');
    await expect(browse(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(panel(page).getByRole('link', { name: /^All products/ })).toBeFocused();
  }

  test('the row is Browse, How we rank and For vendors, and nothing else', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(page.locator('app-root')).toBeAttached();

    await expect(toggle(page)).toBeHidden();

    const nav = primaryNav(page);
    for (const [name, href] of ROW) {
      await expect(nav.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
    }
    // Disclosure navigation: aria-expanded and aria-controls, no aria-haspopup.
    await expect(browse(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(browse(page)).toHaveAttribute('aria-controls', 'browse-menu-panel');
    await expect(browse(page)).not.toHaveAttribute('aria-haspopup');
    await expect(panel(page)).toBeHidden();

    // Home and the four facet flyouts left the row. Nothing secondary or role-gated
    // (the header is cached URL-keyed HTML, so an /admin href here would leak).
    for (const name of ['Home', 'Products', ...FACETS, 'More menu']) {
      await expect(
        nav.getByRole('link', { name, exact: true }),
        `${name} is not in the row`,
      ).toHaveCount(0);
    }
    for (const name of SECONDARY) {
      await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
    }
    await expect(nav.locator('a[href^="/admin"]')).toHaveCount(0);
    for (const name of REMOVED) {
      await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
    }

    const header = page.locator('aec-site-header');
    await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible();

    // The inline search box shares the mobile copy: one i18n source (AECI-985).
    const search = header.getByRole('combobox', { name: 'Search' });
    await expect(search).toBeVisible();
    await expect(search).toHaveAttribute('placeholder', 'Search directory');
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

  test('hovering Browse opens the panel with five columns, and leaving closes it', async ({
    page,
  }) => {
    await page.goto(ROUTE);
    await untilHydrated(browse(page));
    await browse(page).hover();

    await expect(panel(page)).toBeVisible();
    await expect(browse(page)).toHaveAttribute('aria-expanded', 'true');
    for (const label of ['Explore', 'Key categories', ...FACETS]) {
      await expect(panel(page).getByText(label, { exact: true })).toBeVisible();
    }
    await expect(
      panel(page).getByText('Key categories are chosen by AEC Integrations.', { exact: false }),
    ).toBeVisible();
    // Terms and counts arrive after hydration, from /api/taxonomy.
    await expect(
      panel(page)
        .getByRole('link', { name: /\d+ products?$/ })
        .first(),
    ).toBeVisible();

    // The pointer crosses into the panel without closing it (the close grace).
    const box = (await panel(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 40, { steps: 8 });
    await page.waitForTimeout(400);
    await expect(panel(page)).toBeVisible();

    // Leaving for the page below closes it after the grace.
    await page.mouse.move(5, 790);
    await expect(panel(page)).toBeHidden();
    await expect(browse(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('the keyboard walk: ArrowDown opens, Tab walks the panel in order, Escape returns to Browse', async ({
    page,
  }) => {
    await page.goto(ROUTE);
    await openByKeyboard(page);

    // Tab order follows the columns: Explore first, then each facet column, each
    // ending with its "See all".
    const order: string[] = [];
    for (let i = 0; i < 60; i++) {
      const href = await page.evaluate(() => document.activeElement?.getAttribute('href') ?? '');
      order.push(href);
      if (href === '/trades') break;
      await page.keyboard.press('Tab');
    }
    expect(order[0]).toBe('/products');
    const seeAll = INDEXES.map(([, href]) => order.indexOf(href));
    expect(
      seeAll.every((i) => i > 0),
      order.join(' '),
    ).toBe(true);
    expect([...seeAll].sort((a, b) => a - b)).toEqual(seeAll);

    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(browse(page)).toBeFocused();
    await expect(browse(page)).toHaveAttribute('aria-expanded', 'false');

    // Closed, Tab skips the panel: Browse, then How we rank, then For vendors.
    await page.keyboard.press('Tab');
    await expect(primaryNav(page).getByRole('link', { name: 'How we rank' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(primaryNav(page).getByRole('link', { name: 'For vendors' })).toBeFocused();
  });

  test('Tab past the last panel link closes it', async ({ page }) => {
    await page.goto(ROUTE);
    await openByKeyboard(page);
    await panel(page).getByRole('link', { name: 'See all trades' }).focus();
    await page.keyboard.press('Tab');
    await expect(panel(page)).toBeHidden();
    await expect(primaryNav(page).getByRole('link', { name: 'How we rank' })).toBeFocused();
  });

  test('a click outside, on the dimmed page, closes the panel', async ({ page }) => {
    await page.goto(ROUTE);
    await openByKeyboard(page);
    const dimmer = page.locator('[data-browse-dimmer]');
    await expect(dimmer).toBeVisible();
    await expect(dimmer).toHaveAttribute('aria-hidden', 'true');

    await page.mouse.click(5, 790);
    await expect(panel(page)).toBeHidden();
    await expect(dimmer).toHaveCount(0);
  });

  test('a click on a panel link lands, and closes the panel', async ({ page }) => {
    await page.goto(ROUTE);
    await untilHydrated(browse(page));
    await browse(page).hover();
    await expect(panel(page)).toBeVisible();
    await panel(page).getByRole('link', { name: 'See all phases' }).click();
    await page.waitForURL(/\/phases$/);
    await expect(panel(page)).toBeHidden();
    // Browse is the current section on a facet index.
    await expect(browse(page)).toHaveAttribute('aria-current', 'true');
  });

  // Every destination the old row and flyouts reached stays one hover or one
  // ArrowDown away, and each index is a real page.
  for (const [name, href] of INDEXES) {
    test(`reaches ${href} from the header`, async ({ page }) => {
      await page.goto(ROUTE);
      await openByKeyboard(page);
      const link = panel(page).getByRole('link', { name, exact: true });
      await expect(link).toHaveAttribute('href', href);
      await link.click();
      await page.waitForURL(new RegExp(`${href}$`));
      await expect(page.locator('h1').first()).toBeVisible();
    });
  }

  // The panel body is a lazy `@defer (on idle; hydrate on idle)` block. A reader
  // can act before its chunk lands, or after it failed (a tab open across a
  // deploy). Its links are plain hrefs with no listener, and the eager panel box
  // routes them, so neither case may lose the click. The chunk is found by a
  // string only the panel carries: its footer line.
  //
  // App stability waits for the held chunk, so `untilHydrated` (which waits for
  // stability) cannot gate these tests. The gate is the chunk request itself:
  // `hydrate on idle` asks for it only once the eager app has hydrated.
  async function holdPanelChunk(page: Page, mode: 'slow' | 'abort') {
    const seen = { panelChunk: false };
    await page.route(/\/chunk-[^/]+\.js$/, async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      if (!body.includes('Key categories are chosen by AEC Integrations')) {
        await route.fulfill({ response, body });
        return;
      }
      seen.panelChunk = true;
      if (mode === 'abort') {
        await route.abort('failed');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      await route.fulfill({ response, body }).catch(() => {});
    });
    return seen;
  }

  async function openWhileHeld(page: Page, seen: { panelChunk: boolean }) {
    await expect
      .poll(() => seen.panelChunk, { message: 'the panel chunk was requested' })
      .toBe(true);
    await expect(async () => {
      await page.mouse.move(5, 790);
      await browse(page).hover();
      await expect(panel(page)).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  }

  test('with the panel chunk slowed, the first click on a panel link navigates', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const seen = await holdPanelChunk(page, 'slow');
    await page.goto(ROUTE);
    await openWhileHeld(page, seen);
    // Still the server's links: the panel body has not hydrated.
    await expect(panel(page).getByRole('link', { name: /\d+ products?$/ })).toHaveCount(0);

    await panel(page).getByRole('link', { name: 'See all trades' }).click();
    await page.waitForURL(/\/trades$/, { timeout: 5_000 });
    await expect(page.locator('h1').first()).toBeVisible();
  });

  test('with the panel chunk slowed, Enter on a panel link navigates', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await holdPanelChunk(page, 'slow');
    await page.goto(ROUTE);
    await openWhileHeld(page, seen);
    await panel(page).getByRole('link', { name: 'See all phases' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/phases$/, { timeout: 5_000 });
  });

  test('with the panel chunk blocked, the server-rendered links still navigate', async ({
    page,
  }) => {
    const seen = await holdPanelChunk(page, 'abort');
    await page.goto(ROUTE);
    await openWhileHeld(page, seen);
    await panel(page).getByRole('link', { name: 'See all phases' }).click();
    await page.waitForURL(/\/phases$/);
    await expect(page.locator('h1').first()).toBeVisible();

    // The header keeps working on the next page.
    await openWhileHeld(page, seen);
    await panel(page)
      .getByRole('link', { name: /^All products/ })
      .click();
    await page.waitForURL(/\/products$/);
  });

  test('Escape closes a hover-opened panel while focus is elsewhere', async ({ page }) => {
    await page.goto(ROUTE);
    await untilHydrated(browse(page));
    await browse(page).hover();
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
  });

  test('desktop header is axe-clean (closed and with the panel open)', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(browse(page)).toBeVisible();
    expect(await analyzeHeader(page), 'closed').toEqual([]);

    await openByKeyboard(page);
    await expect(
      panel(page)
        .getByRole('link', { name: /\d+ products?$/ })
        .first(),
    ).toBeVisible();
    expect(await analyzeHeader(page), 'panel open').toEqual([]);
  });
});

// No JavaScript-only dead end. With scripts off, "Browse" still goes to
// /products, the server-rendered (hidden) panel carries every index link for
// crawlers, and the footer's Directory column carries them visibly.
test.describe('header with JavaScript off (1280px)', () => {
  test.use({ viewport: DESKTOP, javaScriptEnabled: false });

  test('every index the old row reached is in the server HTML', async ({ page }) => {
    await page.goto(ROUTE);
    const nav = page.locator('aec-site-header nav[aria-label="Primary"]');
    await expect(nav.locator('a[href="/products"]').first()).toHaveText(/Browse/);

    const panelLinks = page.locator('#browse-menu-panel a');
    await expect(panelLinks.first()).toBeAttached();
    const hrefs = await panelLinks.evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs).toEqual(['/products', '/categories', '/phases', '/audiences', '/trades']);

    const footer = page.locator('aec-site-footer');
    for (const href of ['/products', '/categories', '/audiences', '/trades', '/phases']) {
      await expect(footer.locator(`a[href="${href}"]`), href).toBeVisible();
    }
  });
});

// The header search is a 44px pill on Forest from `lg` (AECI-1772). Below `lg` the
// mobile menu carries search. The failure mode of a bad handover is silent
// (search just disappears at some width, or two inputs mount), so both "exactly
// one affordance" and "it actually works" are pinned here.
const PILL_WIDTHS = [
  { width: 1024, height: 800 },
  { width: 1100, height: 800 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
] as const;

function pill(page: Page) {
  return page.locator('#header-search');
}

for (const viewport of PILL_WIDTHS) {
  test.describe(`header search pill (${viewport.width}px)`, () => {
    test.use({ viewport });

    test('is the only search affordance, fits the row, and nothing overflows', async ({ page }) => {
      await page.goto(ROUTE);
      await untilHydrated(pill(page));
      await expect(toggle(page)).toBeHidden();
      await expect(page.locator('aec-search-trigger')).toHaveCount(0);
      await expect(pill(page)).toBeVisible();
      await expect(pill(page)).toHaveAttribute('placeholder', 'Search directory');

      const box = await pill(page).boundingBox();
      expect(box!.height).toBe(44);
      expect(box!.width).toBeGreaterThanOrEqual(240);
      expect(box!.width).toBeLessThanOrEqual(460);

      // The row does not wrap or overflow: every part sits on one line.
      const row = await page.evaluate(() => {
        const header = document.querySelector('aec-site-header header > div') as HTMLElement;
        return {
          overflow: header.scrollWidth - header.clientWidth,
          doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          height: header.getBoundingClientRect().height,
        };
      });
      expect(row.overflow).toBeLessThanOrEqual(0);
      expect(row.doc).toBeLessThanOrEqual(0);
      // One row: 76px at `md` and up. A wrap would add a whole row.
      expect(row.height).toBeLessThanOrEqual(76);
    });

    test('the pill edge and ring compute to the Bone tokens, and the header is axe-clean', async ({
      page,
    }) => {
      await page.goto(ROUTE);
      await untilHydrated(pill(page));
      expect(await computed(pill(page), 'border-top-color')).toBe(
        await tokenColor(page, '--border-on-brand-strong', 'border-top-color'),
      );
      expect(await computed(pill(page), 'border-top-width')).toBe('1px');
      // The placeholder is secondary Bone ink (6.00:1), not the global tertiary grey
      // that an unlayered `::placeholder` rule would give it.
      const placeholder = await pill(page).evaluate(
        (el) => getComputedStyle(el, '::placeholder').color,
      );
      expect(placeholder).toBe(await tokenColor(page, '--text-on-brand-secondary', 'color'));
      expect(await computed(page.locator('aec-site-header kbd'), 'border-top-color')).toBe(
        await tokenColor(page, '--border-on-brand', 'border-top-color'),
      );
      expect(await computed(pill(page), 'border-top-left-radius')).not.toBe('12px');
      expect(parseFloat(await computed(pill(page), 'border-top-left-radius'))).toBeGreaterThan(100);

      await page.keyboard.press('Tab');
      await pill(page).focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(pill(page)).toBeFocused();
      await expect
        .poll(async () => computed(pill(page), 'outline-color'))
        .toBe(await tokenColor(page, '--focus-ring-on-brand', 'color'));
      expect(await computed(pill(page), 'outline-width')).toBe('3px');
      expect(await computed(pill(page), 'outline-offset')).toBe('3px');

      expect(await analyzeHeader(page), 'axe').toEqual([]);
    });
  });
}

test.describe('header search shortcut (Ctrl+/ or Cmd+/)', () => {
  test.use({ viewport: DESKTOP });

  const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

  test('focuses the search from the page body and the key is not typed', async ({ page }) => {
    await page.goto('/products');
    await untilHydrated(pill(page));
    await expect(pill(page)).toHaveAttribute('aria-keyshortcuts', 'Control+/ Meta+/');
    await page.locator('body').click({ position: { x: 5, y: 400 } });
    await page.keyboard.press(`${MOD}+/`);
    await expect(pill(page)).toBeFocused();
    await expect(pill(page)).toHaveValue('');
  });

  test('a bare "/" does nothing (WCAG 2.1.4)', async ({ page }) => {
    await page.goto('/products');
    await untilHydrated(pill(page));
    await page.locator('body').click({ position: { x: 5, y: 400 } });
    await page.keyboard.press('/');
    await expect(pill(page)).not.toBeFocused();
  });

  test('does not fire while typing in another field', async ({ page }) => {
    await page.goto('/products');
    await untilHydrated(pill(page));
    const other = page.locator('main input, main textarea, main select').first();
    test.skip((await other.count()) === 0, 'no other field on this page');
    await other.focus();
    await page.keyboard.press(`${MOD}+/`);
    await expect(other).toBeFocused();
  });

  test('does not fire with a dialog open, and the key is not cancelled', async ({ page }) => {
    await page.goto(ROUTE);
    await untilHydrated(pill(page));
    // A dialog at the width where the pill is visible. The account menu needs a
    // session, so an element with the same role stands in for any open BrnDialog.
    await page.evaluate(() => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      document.body.appendChild(dialog);
      (window as unknown as { __cancelled: boolean[] }).__cancelled = [];
      window.addEventListener('keydown', (e) =>
        (window as unknown as { __cancelled: boolean[] }).__cancelled.push(e.defaultPrevented),
      );
    });
    await page.keyboard.press(`${MOD}+/`);
    await expect(pill(page)).not.toBeFocused();
    const cancelled = await page.evaluate(
      () => (window as unknown as { __cancelled: boolean[] }).__cancelled,
    );
    expect(cancelled.length).toBeGreaterThan(0);
    expect(cancelled.every((c) => !c)).toBe(true);
    // And the same key works once the dialog is gone.
    await page.evaluate(() => document.querySelector('body > [role="dialog"]')?.remove());
    await page.keyboard.press(`${MOD}+/`);
    await expect(pill(page)).toBeFocused();
  });

  test('typing and submitting from the pill reaches /search', async ({ page }) => {
    await page.goto('/products');
    await untilHydrated(pill(page));
    await page.keyboard.press(`${MOD}+/`);
    await pill(page).fill('revit');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=revit/);
  });
});

// AECI-1771: the header sits on Forest. These checks read COMPUTED styles, because
// a class that names the right token can still lose in the cascade (a
// `border-(--x)` utility loses to the global `*` border-color rule, and a layered
// outline utility used to lose to the global `:focus-visible` colour).
//
// The expected colours are resolved from the tokens in the page, so a token
// change moves both sides. The signed-in account trigger needs a session this
// spec cannot mint. It takes the same `aec-on-brand-edge` class, pinned in
// `site-header.component.spec.ts`.
async function tokenColor(page: Page, token: string, property: 'color' | 'border-top-color') {
  return page.evaluate(
    ([t, prop]) => {
      const probe = document.createElement('div');
      probe.style.cssText = `position:absolute;visibility:hidden;color:var(${t});border:1px solid var(${t})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).getPropertyValue(prop);
      probe.remove();
      return value;
    },
    [token, property],
  );
}

async function computed(locator: ReturnType<Page['locator']>, property: string) {
  return locator.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);
}

test.describe('header on Forest (computed styles)', () => {
  test('the menu toggle edge computes to the strong Bone edge', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto(ROUTE);
    await untilHydrated(toggle(page));
    expect(await computed(toggle(page), 'border-top-color')).toBe(
      await tokenColor(page, '--border-on-brand-strong', 'border-top-color'),
    );
    expect(await computed(toggle(page), 'border-top-width')).toBe('1px');
  });

  test('a focused header link has a Bone 3px ring, and a panel link a Forest ring', async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(ROUTE);
    const nav = page.locator('aec-site-header').getByRole('navigation', { name: 'Primary' });
    const rank = nav.getByRole('link', { name: 'How we rank', exact: true });
    await untilHydrated(rank);
    // A keyboard focus, so `:focus-visible` applies.
    await rank.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(rank).toBeFocused();
    await expect
      .poll(async () => computed(rank, 'outline-color'))
      .toBe(await tokenColor(page, '--focus-ring-on-brand', 'color'));
    expect(await computed(rank, 'outline-width')).toBe('3px');
    expect(await computed(rank, 'outline-offset')).toBe('3px');

    // The header search field carries the same single Bone ring set.
    const search = page.locator('#header-search');
    await search.focus();
    await expect(search).toBeFocused();
    await expect
      .poll(async () => computed(search, 'outline-color'))
      .toBe(await tokenColor(page, '--focus-ring-on-brand', 'color'));
    expect(await computed(search, 'outline-width')).toBe('3px');
    expect(await computed(search, 'outline-offset')).toBe('3px');

    // "Browse" on Forest: the Bone ring.
    const trigger = nav.getByRole('link', { name: 'Browse', exact: true });
    await trigger.focus();
    await expect
      .poll(async () => computed(trigger, 'outline-color'))
      .toBe(await tokenColor(page, '--focus-ring-on-brand', 'color'));

    // Inside the open white panel the ring is Forest, 3px.
    await page.keyboard.press('ArrowDown');
    const first = page.locator('#browse-menu-panel').getByRole('link').first();
    await expect(first).toBeFocused();
    await expect
      .poll(async () => computed(first, 'outline-color'))
      .toBe(await tokenColor(page, '--accent-primary', 'color'));
    expect(await computed(first, 'outline-width')).toBe('3px');

    // The Clay cue under "Browse" shows only while the panel is open.
    const cue = trigger.locator('[data-browse-cue]');
    expect(await computed(cue, 'background-color')).toBe(
      await tokenColor(page, '--accent-secondary', 'color'),
    );
    // Tailwind's `scale-x-0` sets the `scale` property, not `transform`.
    await expect.poll(async () => computed(cue, 'scale')).toBe('none');
    // On the header's bottom edge: the cue's bottom meets the header's.
    const headerBottom = await page
      .locator('aec-site-header header')
      .evaluate((el) => el.getBoundingClientRect().bottom);
    const cueBottom = await cue.evaluate((el) => el.getBoundingClientRect().bottom);
    expect(Math.abs(cueBottom - headerBottom)).toBeLessThanOrEqual(1);

    // Panel destinations are weight 400.
    const allProducts = page.locator('#browse-menu-panel a[href="/products"] span').first();
    expect(await computed(allProducts, 'font-weight')).toBe('400');

    await page.keyboard.press('Escape');
    await expect.poll(async () => computed(cue, 'scale')).toBe('0 1');
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

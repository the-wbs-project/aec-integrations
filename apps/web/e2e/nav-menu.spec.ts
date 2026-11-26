import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { untilHydrated } from './hydration';
import { expectNoSidewaysScroll } from './no-sideways-scroll';

// AECI-96 / AECI-159 / AECI-1774 / AECI-1775. The primary navigation (DESIGN.md
// §5) is responsive. Below `lg` a toggle named "Menu" opens the mobile menu, a
// dialog under the header: "All products" and the key categories, the four
// facets as tap-to-expand sections, How we rank, For vendors, search, and the
// account block or Sign in. At `lg+` the
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
// specifically about the header/menu, so axe INCLUDES `aec-site-header` (the
// mobile menu's panel is inside it) and the search trigger's overlay.

// Any route renders the global header; browse is a known-200 preview route.
const ROUTE = '/preview/layouts/browse';
const DESKTOP = { width: 1280, height: 800 } as const;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// The desktop row.
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

// The mobile menu (AECI-1775). The toggle is found by its data hook, not by
// role: while the menu is open everything outside the menu is inert, and the
// name is asserted on its own below.
function toggle(page: Page) {
  return page.locator('aec-nav-menu [data-nav-menu-toggle]');
}

function menuPanel(page: Page) {
  return page.locator('#nav-menu-panel');
}

// Open the menu on a hydrated toggle (AECI-1655). A click before hydration is
// queued and replayed at app stability, so without the wait the open lands at a
// load-dependent moment rather than on the click. Focus moves to "All products"
// after the render that clears `[hidden]`, so that confirms the menu is ready.
async function openMenu(page: Page) {
  await untilHydrated(toggle(page));
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(menuPanel(page).getByRole('link', { name: /^All products/ })).toBeFocused();
}

/** Every Tab stop in the open menu, in order, from the toggle round to the toggle. */
async function tabCycle(page: Page, shift = false): Promise<string[]> {
  await toggle(page).focus();
  const seen: string[] = [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return 'none';
      if (el.hasAttribute('data-nav-menu-toggle')) return 'toggle';
      if (!el.closest('aec-nav-menu')) return `OUTSIDE:${el.tagName}`;
      return el.getAttribute('href') ?? el.id ?? el.textContent?.trim() ?? el.tagName;
    });
    seen.push(stop);
    if (stop === 'toggle' || stop.startsWith('OUTSIDE')) break;
  }
  return seen;
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
] as const) {
  test.describe(`mobile menu (${viewport.width}px)`, () => {
    test.use({ viewport });

    test('the toggle is named "Menu", sits at the end edge, and the header does not overflow', async ({
      page,
    }) => {
      await page.goto(ROUTE);
      await expect(page.locator('app-root')).toBeAttached();

      const named = page.getByRole('button', { name: 'Menu', exact: true });
      await expect(named).toBeVisible();
      await expect(named).toHaveAttribute('aria-expanded', 'false');
      await expect(named).toHaveAttribute('aria-controls', 'nav-menu-panel');
      await expect(menuPanel(page)).toBeHidden();

      // End edge: the toggle is the last thing in the header row, after the wordmark.
      const header = (await page.locator('aec-site-header header').boundingBox())!;
      const box = (await toggle(page).boundingBox())!;
      const logo = (await page.locator('aec-site-header aec-brand-logo a').first().boundingBox())!;
      expect(box.x).toBeGreaterThan(logo.x + logo.width);
      expect(header.x + header.width - (box.x + box.width)).toBeLessThanOrEqual(33);
      expect(box.width).toBe(44);
      expect(box.height).toBe(44);

      await expectNoSidewaysScroll(page, 'document must not overflow horizontally', {
        tolerance: 1,
      });

      // AECI-1771, folded in here (AECI-2027). The edge does not depend on width. It
      // reads computed styles, see "header on Forest" below.
      await test.step('the menu toggle edge computes to the strong Bone edge', async () => {
        await untilHydrated(toggle(page));
        expect(await computed(toggle(page), 'border-top-color')).toBe(
          await tokenColor(page, '--border-on-brand-strong', 'border-top-color'),
        );
        expect(await computed(toggle(page), 'border-top-width')).toBe('1px');
      });
    });

    test('open: a named dialog, a white panel under the header, the page inert and not scrolling', async ({
      page,
    }) => {
      await page.goto(ROUTE);
      await page.evaluate(() => window.scrollTo(0, 0));
      await openMenu(page);

      const dialog = page.getByRole('dialog', { name: 'Menu' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      // The name stays "Menu" while open; the glyph is a close mark.
      await expect(toggle(page)).toHaveAttribute('aria-label', 'Menu');

      // The panel hangs from the header's bottom edge and stops at the viewport.
      const header = (await page.locator('aec-site-header header').boundingBox())!;
      const panel = (await menuPanel(page).boundingBox())!;
      expect(Math.abs(panel.y - (header.y + header.height))).toBeLessThanOrEqual(1);
      expect(panel.y + panel.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(panel.width).toBeCloseTo(header.width, 0);
      expect(await computed(menuPanel(page), 'background-color')).toBe(
        await tokenColor(page, '--surface-base', 'color'),
      );

      // The page behind is inert and the root does not scroll.
      expect(await page.locator('main').evaluate((el) => (el as HTMLElement).inert)).toBe(true);
      expect(
        await page.locator('aec-site-footer').evaluate((el) => el.closest('[inert]') !== null),
      ).toBe(true);
      expect(await computed(page.locator('html'), 'overflow-y')).toBe('hidden');
      await page.mouse.wheel(0, 600);
      // A fixed wait on purpose. The test proves that the wheel does not scroll the
      // page, and no condition marks the end of "nothing happened".
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);

      // The dimmer covers the page under the header. The open menu is modal, so
      // the header and dimmer lift above the consent (z-50) and update (z-60) banners.
      await expect(page.locator('[data-nav-scrim]')).toBeVisible();
      expect(await computed(page.locator('aec-site-header header'), 'z-index')).toBe('70');
      expect(await computed(page.locator('[data-nav-scrim]'), 'z-index')).toBe('65');
    });

    // The behaviour tests run at 320 only (AECI-2027). 390 and 320 are both below
    // `md`, so no breakpoint changes the menu between them. 320 is the stricter
    // case: its short panel makes the `scrollIntoViewIfNeeded` paths really scroll.
    // The layout tests above and the axe test below run at both widths.
    if (viewport.width === 320) {
      test('Tab and Shift+Tab cycle inside the open menu and never reach the page', async ({
        page,
      }) => {
        await page.goto(ROUTE);
        await openMenu(page);

        const forward = await tabCycle(page);
        expect(forward.at(-1), forward.join(' ')).toBe('toggle');
        expect(forward[0]).toBe('/products');
        expect(forward).toContain('/docs/trust/how-ranking-works');
        expect(forward).toContain('/vendor-program');
        expect(forward).toContain('mobile-search');
        expect(forward.some((stop) => stop.startsWith('/auth/login'))).toBe(true);

        const backward = await tabCycle(page, true);
        expect(backward.at(-1), backward.join(' ')).toBe('toggle');
        expect(backward[0]?.startsWith('/auth/login')).toBe(true);
        // The same stops, in reverse.
        expect(backward.slice(0, -1)).toEqual(forward.slice(0, -1).reverse());
      });

      test('Escape closes, returns focus to the toggle, and releases the page', async ({
        page,
      }) => {
        await page.goto(ROUTE);
        await openMenu(page);
        await page.keyboard.press('Tab');
        await page.keyboard.press('Escape');

        await expect(menuPanel(page)).toBeHidden();
        await expect(toggle(page)).toBeFocused();
        await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
        expect(await page.locator('main').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
        expect(await computed(page.locator('html'), 'overflow-y')).not.toBe('hidden');
        await expect(page.getByRole('dialog')).toHaveCount(0);
      });

      test('a tap on the dimmer closes the menu', async ({ page }) => {
        await page.goto(ROUTE);
        await openMenu(page);
        // The panel can fill a phone screen, leaving no dimmer to hit, so the
        // click goes to the dimmer itself. It is outside the inert walk.
        await page.locator('[data-nav-scrim]').dispatchEvent('click');
        await expect(menuPanel(page)).toBeHidden();
        await expect(toggle(page)).toBeFocused();
      });

      test('each section expands with aria-expanded and reaches its terms and "See all"', async ({
        page,
      }) => {
        await page.goto(ROUTE);
        await openMenu(page);
        for (const [index, name] of FACETS.entries()) {
          const section = menuPanel(page).getByRole('button', { name, exact: true });
          await expect(section).toHaveAttribute('aria-expanded', 'false');
          await section.click();
          await expect(section).toHaveAttribute('aria-expanded', 'true');
          const [label, href] = INDEXES[index]!;
          await expect(menuPanel(page).getByRole('link', { name: label })).toHaveAttribute(
            'href',
            href,
          );
          await section.click();
          await expect(section).toHaveAttribute('aria-expanded', 'false');
          await expect(menuPanel(page).getByRole('link', { name: label })).toBeHidden();
        }
        // Terms and counts arrive in the browser, from /api/taxonomy.
        await menuPanel(page).getByRole('button', { name: 'Categories' }).click();
        await expect(
          menuPanel(page)
            .locator('#nav-menu-sec-category')
            .getByRole('link', { name: /\d+ products?$/ })
            .first(),
        ).toBeVisible();
      });

      // A tap on a menu link lands on a real page and closes the menu. Two cases
      // (AECI-2027): a top-level row link, and a link inside an expanded section.
      // How we rank and For vendors are plain top-level links like All products.
      // Both are Tab stops in the cycle test, For vendors is tapped in the AECI-1855
      // focus test, and How we rank in the chunk-held test.
      const DESTINATIONS = [
        [/^All products/, '/products'],
        ['See all phases', '/phases'],
      ] as const;
      for (const [name, href] of DESTINATIONS) {
        test(`reaches ${href}, and the route change closes the menu`, async ({ page }) => {
          await page.goto(ROUTE);
          await openMenu(page);
          if (href === '/phases')
            await menuPanel(page).getByRole('button', { name: 'Phases' }).click();
          const link = menuPanel(page).getByRole('link', { name });
          await link.scrollIntoViewIfNeeded();
          await link.click();
          await page.waitForURL(new RegExp(`${href}$`));
          await expect(page.locator('h1').first()).toBeVisible();
          await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
          await expect(menuPanel(page)).toBeHidden();
          expect(await page.locator('main').evaluate((el) => (el as HTMLElement).inert)).toBe(
            false,
          );
        });
      }

      test('a key category and a term navigate', async ({ page }) => {
        await page.goto(ROUTE);
        await openMenu(page);
        const key = menuPanel(page)
          .locator('ul[aria-labelledby="nav-menu-key"]')
          .getByRole('link')
          .first();
        await expect(key).toBeVisible();
        const href = (await key.getAttribute('href'))!;
        expect(href).toMatch(/^\/categories\/[\w-]+$/);
        await key.click();
        await page.waitForURL(new RegExp(`${href}$`));
      });

      test('search and Sign in are in the menu', async ({ page }) => {
        await page.goto(ROUTE);
        await openMenu(page);
        const search = menuPanel(page).getByRole('combobox', { name: 'Search' });
        await expect(search).toBeAttached();
        await expect(search).toHaveAttribute('placeholder', 'Search directory');
        const signIn = menuPanel(page).getByRole('link', { name: 'Sign in' });
        await signIn.scrollIntoViewIfNeeded();
        await expect(signIn).toBeVisible();
        // Primary, full width: Forest fill across the panel's content box.
        expect(await computed(signIn, 'background-color')).toBe(
          await tokenColor(page, '--accent-primary', 'color'),
        );
        const content = (await menuPanel(page).locator('nav').boundingBox())!;
        const button = (await signIn.boundingBox())!;
        expect(Math.abs(button.width - content.width)).toBeLessThanOrEqual(1);
        expect(button.height).toBeGreaterThanOrEqual(44);
        // No "More" disclosure and no secondary or retired destinations.
        await expect(menuPanel(page).getByRole('button', { name: 'More' })).toHaveCount(0);
        for (const name of [...SECONDARY, ...REMOVED]) {
          await expect(menuPanel(page).getByRole('link', { name, exact: true })).toHaveCount(0);
        }
        // Signed out, so no portal door at all.
        await expect(menuPanel(page).locator('a[href^="/admin"]')).toHaveCount(0);
        await expect(menuPanel(page).locator('a[href="/vendor"]')).toHaveCount(0);
      });

      test('submitting a search from the menu reaches /search and closes it', async ({ page }) => {
        await page.goto(ROUTE);
        await openMenu(page);
        await menuPanel(page).getByRole('combobox', { name: 'Search' }).fill('revit');
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/search\?q=revit/);
        await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
      });
    }

    test('axe: the header and the open menu, with a section expanded', async ({ page }) => {
      await page.goto(ROUTE);
      await expect(toggle(page)).toBeVisible();
      expect(await analyzeHeader(page), 'closed state').toEqual([]);

      await openMenu(page);
      await menuPanel(page).getByRole('button', { name: 'Categories' }).click();
      await expect(menuPanel(page).getByRole('link', { name: 'See all categories' })).toBeVisible();
      expect(await analyzeHeader(page), 'open state').toEqual([]);
    });
  });
}

// Search inside the mobile menu (AECI-1775). Local dev has no Algolia keys, so
// the config is injected and the query endpoint answered with ten hits: five
// products and five vendors, the most the box shows.
async function mockMenuSearch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __AECI_ALGOLIA__: unknown }).__AECI_ALGOLIA__ = {
      appId: 'E2ETEST',
      searchKey: 'e2e',
      indexes: { products: 'products', vendors: 'vendors', integrations: 'integrations' },
    };
  });
  await page.route('**/1/indexes/*/queries**', async (route) => {
    const body = route.request().postDataJSON() as { requests: { query?: string }[] };
    const query = body.requests[0]?.query ?? '';
    const products = Array.from({ length: 5 }, (_, i) => ({
      objectID: `p${i}`,
      name: `Fixture product ${i + 1}`,
      slug: `fixture-product-${i + 1}`,
      vendor_name: 'Fixture Vendor',
    }));
    const vendors = Array.from({ length: 5 }, (_, i) => ({
      objectID: `v${i}`,
      company_name: `Fixture vendor ${i + 1}`,
      slug: `fixture-vendor-${i + 1}`,
    }));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          { hits: products, nbHits: 5, query, params: '', index: 'products' },
          { hits: vendors, nbHits: 5, query, params: '', index: 'vendors' },
        ],
      }),
    });
  });
}

type Box = { top: number; bottom: number; left: number; right: number };

async function rect(locator: ReturnType<Page['locator']>): Promise<Box> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
}

/** True when the list hangs from the field: just below it, or just above it. */
function attached(list: Box, field: Box): boolean {
  return Math.abs(list.top - field.bottom - 4) <= 2 || Math.abs(field.top - list.bottom - 4) <= 2;
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
] as const) {
  test.describe(`mobile menu search (${viewport.width} by ${viewport.height})`, () => {
    test.use({ viewport });

    test('every suggestion can be reached, the list follows the field, and Escape closes the list first', async ({
      page,
    }) => {
      await mockMenuSearch(page);
      await page.goto(ROUTE);
      await openMenu(page);

      const field = menuPanel(page).getByRole('combobox', { name: 'Search' });
      await field.scrollIntoViewIfNeeded();
      // 44px, as the header pill is.
      expect((await field.boundingBox())!.height).toBe(44);
      await field.fill('fixture');

      const list = page.getByRole('listbox', { name: 'Search suggestions' });
      await expect(list).toBeVisible();
      await expect(list.getByRole('option')).toHaveCount(10);

      // The list sits on the screen, on one side of the field.
      const listBox = await rect(list);
      const fieldBox = await rect(field);
      console.log(
        `[AECI-1775] ${viewport.width}x${viewport.height} field ${JSON.stringify(fieldBox)} list ${JSON.stringify(listBox)}`,
      );
      expect(listBox.top).toBeGreaterThanOrEqual(0);
      expect(listBox.bottom).toBeLessThanOrEqual(viewport.height);
      expect(listBox.right).toBeLessThanOrEqual(viewport.width);
      expect(attached(listBox, fieldBox), 'the list hangs from the field').toBe(true);

      // Every suggestion can be scrolled into view inside the list.
      const options = list.getByRole('option');
      for (let i = 0; i < 10; i++) {
        await options.nth(i).scrollIntoViewIfNeeded();
        await expect(options.nth(i)).toBeInViewport();
      }

      // The panel scrolls while the list is open: the list stays on the field.
      await menuPanel(page).evaluate((el) => el.scrollBy(0, -60));
      await expect
        .poll(async () => attached(await rect(list), await rect(field)), {
          message: 'the list is attached to the field after the panel scrolls',
        })
        .toBe(true);
      await menuPanel(page).evaluate((el) => el.scrollBy(0, 60));
      await expect.poll(async () => attached(await rect(list), await rect(field))).toBe(true);

      // Escape: the first closes the list, the second the menu.
      await field.focus();
      await page.keyboard.press('Escape');
      await expect(list).toBeHidden();
      await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(menuPanel(page)).toBeHidden();
      await expect(toggle(page)).toBeFocused();
    });
  });
}

// Decision C (AECI-1775): between md and lg the header shows its own Sign in.
// While the menu is open it is inert, so it is hidden, keeping its space.
test.describe('header right-hand group while the menu is open (900px)', () => {
  test.use({ viewport: { width: 900, height: 800 } });

  test('the inert Sign in is invisible while open, nothing shifts, and it returns on close', async ({
    page,
  }) => {
    await page.goto(ROUTE);
    // The header's own Sign in comes before the menu's in the DOM. A role query
    // would skip it once it is invisible and find the menu's instead.
    const headerSignIn = page.locator('aec-site-header a[href^="/auth/login"]').first();
    await expect(headerSignIn).toBeVisible();
    const before = (await toggle(page).boundingBox())!;

    await openMenu(page);
    expect(await computed(headerSignIn, 'visibility')).toBe('hidden');
    const during = (await toggle(page).boundingBox())!;
    expect(during.x).toBe(before.x);
    // Only the menu's own Sign in is visible.
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(headerSignIn).toBeVisible();
    expect((await toggle(page).boundingBox())!.x).toBe(before.x);
  });
});

test.describe('mobile menu on short and zoomed screens', () => {
  // A landscape phone: below `lg`, so the menu carries navigation, but only
  // 390px tall. The panel stops at the viewport and scrolls inside.
  test('landscape phone (844 by 390): the panel scrolls and its last control works', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto(ROUTE);
    await openMenu(page);
    for (const name of FACETS) {
      await menuPanel(page).getByRole('button', { name }).click();
    }
    const box = (await menuPanel(page).boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(390 + 1);
    expect(await menuPanel(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    const signIn = menuPanel(page).getByRole('link', { name: 'Sign in' });
    await signIn.scrollIntoViewIfNeeded();
    await expect(signIn).toBeInViewport();
    // The page behind did not scroll while the panel did.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await menuPanel(page).getByRole('link', { name: 'See all trades' }).click();
    await page.waitForURL(/\/trades$/);
  });

  // 320px at 200% zoom lays out like a 160px viewport. Nothing in the panel
  // may be cut off sideways; it scrolls down instead.
  test('320px at 200% zoom: nothing in the panel is cut off', async ({ page }) => {
    // At this size the consent banner fills the screen before the menu can be
    // reached. That is the banner's own reflow, not the menu's, so answer it.
    await page.addInitScript(() => {
      globalThis.localStorage.setItem('aeci_analytics_consent', 'denied');
    });
    await page.setViewportSize({ width: 160, height: 284 });
    await page.goto(ROUTE);
    await openMenu(page);
    await menuPanel(page).getByRole('button', { name: 'Audiences' }).click();
    const sideways = await menuPanel(page).evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(sideways, 'the panel does not scroll sideways').toBeLessThanOrEqual(1);
    const clipped = await menuPanel(page).evaluate((panel) => {
      const edge = panel.getBoundingClientRect();
      return Array.from(panel.querySelectorAll('a, button, input'))
        .filter((el) => el.getClientRects().length > 0)
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left < edge.left - 1 || r.right > edge.right + 1;
        })
        .map((el) => el.textContent?.trim() || el.tagName);
    });
    expect(clipped).toEqual([]);
    const signIn = menuPanel(page).getByRole('link', { name: 'Sign in' });
    await signIn.scrollIntoViewIfNeeded();
    await expect(signIn).toBeInViewport();
  });

  test('growing the viewport to lg closes the menu and releases the page', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(ROUTE);
    await openMenu(page);
    await page.setViewportSize({ width: 1100, height: 844 });
    await expect(toggle(page)).toBeHidden();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    expect(await page.locator('main').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
    expect(await computed(page.locator('html'), 'overflow-y')).not.toBe('hidden');
  });

  test('reduced motion: the section chevron turns without a transition', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(ROUTE);
    await openMenu(page);
    const chevron = menuPanel(page)
      .getByRole('button', { name: 'Categories' })
      .locator('[data-chevron]');
    // The global reduced-motion rule sets 0.01ms, which reads as 1e-05s.
    expect(parseFloat(await computed(chevron, 'transition-duration'))).toBeLessThan(0.001);
  });

  test('forced colours: the panel keeps a visible edge and the focus ring', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(ROUTE);
    await openMenu(page);
    // A shadow is not drawn in forced colours, so the panel needs a real border.
    expect(await computed(menuPanel(page), 'border-bottom-width')).toBe('1px');
    expect(await computed(menuPanel(page), 'border-bottom-style')).toBe('solid');
    const first = menuPanel(page).getByRole('link', { name: /^All products/ });
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    expect(await computed(first, 'outline-style')).toBe('solid');
    expect(await computed(first, 'outline-width')).toBe('3px');
  });
});

// The panel body is a lazy `@defer (on idle; hydrate on idle)` block, server
// rendered. Its links are plain hrefs with no listener, and the eager host routes
// them. So a tap lands while the chunk is slow, and when it never arrives. The
// chunk is found by a string only the mobile body carries.
test.describe('mobile menu with its body chunk held (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function holdMobileChunk(page: Page, mode: 'slow' | 'abort') {
    const seen = { chunk: false };
    await page.route(/\/chunk-[^/]+\.js$/, async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      if (!body.includes('nav-menu-sec-')) {
        await route.fulfill({ response, body });
        return;
      }
      seen.chunk = true;
      if (mode === 'abort') {
        await route.abort('failed');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      await route.fulfill({ response, body }).catch(() => {});
    });
    return seen;
  }

  async function openWhileHeld(page: Page, seen: { chunk: boolean }) {
    await expect.poll(() => seen.chunk, { message: 'the body chunk was requested' }).toBe(true);
    await expect(async () => {
      if ((await toggle(page).getAttribute('aria-expanded')) !== 'true') {
        await toggle(page).click();
      }
      await expect(menuPanel(page)).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  }

  test('with the body chunk slowed, the first tap on a menu link navigates', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await holdMobileChunk(page, 'slow');
    await page.goto(ROUTE);
    await openWhileHeld(page, seen);
    // Still the server's links: no terms have arrived.
    await expect(menuPanel(page).getByRole('link', { name: /\d+ products?$/ })).toHaveCount(0);

    await menuPanel(page).getByRole('link', { name: 'How we rank' }).click();
    await page.waitForURL(/\/docs\/trust\/how-ranking-works$/, { timeout: 5_000 });
  });

  test('with the body chunk blocked, the server-rendered links still navigate', async ({
    page,
  }) => {
    const seen = await holdMobileChunk(page, 'abort');
    await page.goto(ROUTE);
    await openWhileHeld(page, seen);
    await menuPanel(page)
      .getByRole('link', { name: /^All products/ })
      .click();
    await page.waitForURL(/\/products$/);
    await expect(page.locator('h1').first()).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  });
});

// Focus after a navigation (AECI-1855). Shared by the desktop panel test and the
// focus describe below.

/** What holds focus, as a short label. */
async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    if (el.matches('main#main')) return 'main';
    if (el.matches('main#main h1')) return 'h1';
    return `${el.tagName.toLowerCase()}:${el.textContent?.trim().slice(0, 30) ?? ''}`;
  });
}

async function expectPageHeadingFocused(page: Page) {
  await expect.poll(() => focused(page)).toBe('h1');
  // No ring on a heading that only holds focus for this.
  const outline = await page
    .locator('main#main h1')
    .first()
    .evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe('none');
}

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
    // A fixed wait on purpose. It outlasts the 260ms close grace, so a panel that
    // was going to close has closed. The test proves it stays open, which no
    // condition can mark as done.
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

  // One page load for both ways to close a keyboard-opened panel (AECI-2027).
  // The panel is reopened by keyboard between them, which refocuses Browse.
  test('Tab past the last panel link closes it, and so does a click on the dimmed page', async ({
    page,
  }) => {
    await page.goto(ROUTE);

    await test.step('Tab past the last panel link closes it', async () => {
      await openByKeyboard(page);
      await panel(page).getByRole('link', { name: 'See all trades' }).focus();
      await page.keyboard.press('Tab');
      await expect(panel(page)).toBeHidden();
      await expect(primaryNav(page).getByRole('link', { name: 'How we rank' })).toBeFocused();
    });

    await test.step('a click outside, on the dimmed page, closes the panel', async () => {
      await openByKeyboard(page);
      const dimmer = page.locator('[data-browse-dimmer]');
      await expect(dimmer).toBeVisible();
      await expect(dimmer).toHaveAttribute('aria-hidden', 'true');

      await page.mouse.click(5, 790);
      await expect(panel(page)).toBeHidden();
      await expect(dimmer).toHaveCount(0);
    });
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

    // AECI-1855, folded in here (AECI-2027): the click moves focus to the new page h1.
    await test.step('a mouse click on a panel link puts focus on the new page h1', async () => {
      await expectPageHeadingFocused(page);
    });
  });

  // Every destination the old row and flyouts reached stays one hover or one
  // ArrowDown away, and each index is a real page. One case runs (AECI-2027):
  // /categories, which no other test clicks from the desktop panel. One handler
  // routes every panel link. The keyboard walk asserts all four See-all hrefs,
  // the JavaScript-off test pins them in the server HTML, and other tests click
  // through to /phases and /trades.
  for (const [name, href] of INDEXES.filter(([, h]) => h === '/categories')) {
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

// AECI-1852. The Clay cue under "Browse" shows only while the panel is open. It
// used to run a scale transition from full width to 0 on every load, because the
// Tailwind `scale-x-0` rule was invalid until the full stylesheet arrived. Sample
// the header's last pixel row, with the panel closed, right after load and after
// 50, 100, 200 and 400ms. The full stylesheet is held back 600ms so the window in
// which the bug showed is always hit. A flat row means no Clay pixel.
test.describe('the Browse Clay cue (AECI-1852)', () => {
  // Sample the header's own width, not the viewport's. `html` reserves a stable
  // scrollbar gutter, so with classic scrollbars the last ~15px are the white page
  // ground, which read as a 225 delta (AECI-1854).
  async function lastRow(page: Page): Promise<number[][]> {
    const { bottom, right } = await page
      .locator('header')
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { bottom: Math.round(r.bottom), right: Math.floor(r.right) };
      });
    const png = await page.screenshot({ clip: { x: 0, y: bottom - 1, width: right, height: 1 } });
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, 1).data;
      const out: number[][] = [];
      for (let x = 0; x < img.width; x++) out.push([data[x * 4], data[x * 4 + 1], data[x * 4 + 2]]);
      return out;
    }, png.toString('base64'));
  }

  for (const width of [1024, 1440]) {
    test(`no Clay pixel on the header's last row during load, panel closed (${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.route(/styles-[^/]+\.css/, async (route) => {
        await new Promise((r) => setTimeout(r, 600));
        await route.continue();
      });
      await page.goto(ROUTE, { waitUntil: 'domcontentloaded' });
      const started = Date.now();
      for (const at of [0, 50, 100, 200, 400]) {
        const wait = at - (Date.now() - started);
        // A fixed wait on purpose. The test samples the header at set times while
        // the stylesheet is held back, so the samples are tied to the clock.
        if (wait > 0) await page.waitForTimeout(wait);
        const row = await lastRow(page);
        const ground = row[0];
        const worst = Math.max(
          ...row.map((px) => Math.max(...px.map((c, i) => Math.abs(c - ground[i])))),
        );
        console.log(`cue ${width}px at ${at}ms: worst channel delta ${worst}`);
        expect(worst, `${width}px at ${at}ms`).toBeLessThanOrEqual(1);
      }
    });
  }

  test('the cue still draws and animates when the panel opens', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(ROUTE);
    const link = page
      .locator('aec-site-header')
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Browse', exact: true });
    await untilHydrated(link);
    const cue = link.locator('[data-browse-cue]');
    expect((await cue.boundingBox())?.width ?? 0).toBeLessThan(1);
    await link.hover();
    await expect(link).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => (await cue.boundingBox())?.width ?? 0).toBeGreaterThan(20);
    expect((await cue.boundingBox())?.height).toBe(3);
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

    // The fit check runs at 1024 and 1280 only (AECI-2027). The row is
    // `lg:gap-4 xl:gap-8`, so the tight point of each band is its first width.
    // 1100 and 1440 sit inside those bands with more room. The axe test below
    // keeps all four widths.
    if (viewport.width === 1024 || viewport.width === 1280) {
      test('is the only search affordance, fits the row, and nothing overflows', async ({
        page,
      }) => {
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
            height: header.getBoundingClientRect().height,
          };
        });
        expect(row.overflow).toBeLessThanOrEqual(0);
        await expectNoSidewaysScroll(page);
        // One row: 76px at `md` and up. A wrap would add a whole row.
        expect(row.height).toBeLessThanOrEqual(76);
      });
    }

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
// `border-(--x)` utility lost to the global `*` border-color rule until AECI-2088,
// and a layered outline utility used to lose to the global `:focus-visible` colour).
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

function formatViolation(v: {
  impact?: string | null;
  id: string;
  help: string;
  nodes: { target: unknown[] }[];
}): string {
  const targets = v.nodes.map((n) => `\n    ${n.target.join(' ')}`).join('');
  return `[${v.impact ?? '?'}] ${v.id}: ${v.help} (${v.nodes.length} node(s))${targets}`;
}

// AECI-1855: after a navigation to another page, focus moves to the new page's h1
// (or `<main>` when it has none), never to `<body>`, and the focus does not scroll
// (`core/route-focus.ts`, ANGULAR_STYLE_GUIDE.md §18). Escape with no navigation
// still returns focus to the trigger. That is pinned by the keyboard walk in the
// 1280px describe and by the mobile Escape test. The mouse-click case on a panel
// link is the last step of "a click on a panel link lands" (AECI-2027).
test.describe('focus after a navigation (AECI-1855)', () => {
  test.describe('desktop Browse menu (1280px)', () => {
    test.use({ viewport: DESKTOP });
    const browse = (page: Page) =>
      page
        .locator('aec-site-header')
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link', { name: 'Browse', exact: true });
    const panel = (page: Page) => page.locator('#browse-menu-panel');

    test('Enter on a panel link puts focus on the new page h1', async ({ page }) => {
      await page.goto(ROUTE);
      await untilHydrated(browse(page));
      await browse(page).focus();
      await page.keyboard.press('ArrowDown');
      const first = panel(page).getByRole('link', { name: /^All products/ });
      await expect(first).toBeFocused();
      await page.keyboard.press('Enter');
      await page.waitForURL(/\/products$/);
      await expectPageHeadingFocused(page);
      // The next Tab starts from the content, not from the top of the document.
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('main#main, aside'))).toBe(
        true,
      );
    });
  });

  test.describe('mobile menu (390px)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('a tap on a menu link puts focus on the new page h1', async ({ page }) => {
      await page.goto(ROUTE);
      await openMenu(page);
      await menuPanel(page)
        .getByRole('link', { name: /^For vendors$/ })
        .click();
      await page.waitForURL(/\/vendor-program$/);
      await expect(menuPanel(page)).toBeHidden();
      // The page behind is released after the route change (AECI-2027).
      expect(await page.locator('main').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
      await expectPageHeadingFocused(page);
    });

    test('Enter on a menu link puts focus on the new page h1', async ({ page }) => {
      await page.goto(ROUTE);
      await openMenu(page);
      // Focus starts on "All products".
      await page.keyboard.press('Enter');
      await page.waitForURL(/\/products$/);
      await expectPageHeadingFocused(page);
    });

    test('a link to the page already showing still lands focus on its h1', async ({ page }) => {
      await page.goto('/products');
      await openMenu(page);
      await page.keyboard.press('Enter'); // "All products", the page already showing
      await expect(menuPanel(page)).toBeHidden();
      await expect.poll(() => focused(page)).toBe('h1');
    });

    test('growing the window to lg puts focus that was in the menu on the page h1', async ({
      page,
    }) => {
      await page.goto('/products');
      await openMenu(page);
      await page.setViewportSize({ width: 1100, height: 844 });
      await expect(toggle(page)).toBeHidden();
      await expect.poll(() => focused(page)).toBe('h1');
    });
  });

  // Chris's ruling on AECI-1855 (option A): a persistent section row keeps focus on
  // the pressed link. The vendor portal row is driven on the session-free preview,
  // which mounts the real portal shell and nav. The admin row needs a session, so
  // `route-focus.component.spec.ts` covers the attribute's behaviour for it.
  test.describe('a persistent section row keeps focus (1280px)', () => {
    test.use({ viewport: DESKTOP });
    const row = (page: Page) => page.getByRole('navigation', { name: 'Portal sections' });

    for (const how of ['Enter', 'click'] as const) {
      test(`the vendor portal row keeps focus on the link pressed by ${how}`, async ({ page }) => {
        await page.goto('/preview/vendor-dashboard/overview');
        const link = row(page).getByRole('link').nth(2);
        await untilHydrated(link);
        const href = (await link.getAttribute('href'))!;
        if (how === 'Enter') {
          await link.focus();
          await page.keyboard.press('Enter');
        } else {
          await link.click();
        }
        await page.waitForURL((url) => url.pathname === href);
        await expect(link).toHaveAttribute('aria-current', 'page');
        // A fixed wait on purpose. The test proves that route focus does not move
        // focus off the link after the render. Focus is on the link already, so a
        // web-first check would pass before the move it guards against.
        await page.waitForTimeout(300);
        await expect(link).toBeFocused();
      });
    }
  });

  test.describe('links on the page (1280px)', () => {
    test.use({ viewport: DESKTOP });

    test('a product card puts focus on the product page h1', async ({ page }) => {
      await page.goto('/products');
      const card = page.locator('main a[href^="/products/"]').first();
      await untilHydrated(card);
      await card.click();
      await page.waitForURL(/\/products\/[^/]+$/);
      await expectPageHeadingFocused(page);
    });

    test('a breadcrumb puts focus on the index h1', async ({ page }) => {
      await page.goto('/products');
      const href = (await page.locator('main a[href^="/products/"]').first().getAttribute('href'))!;
      await page.goto(href);
      const crumb = page
        .getByRole('navigation', { name: 'Breadcrumb' })
        .getByRole('link', { name: 'Products' });
      await untilHydrated(crumb);
      await crumb.click();
      await page.waitForURL(/\/products$/);
      await expectPageHeadingFocused(page);
    });

    // Back restores `/products` far down the page, with its h1 above the viewport. The
    // h1 takes focus and the restored position holds. This guards the restore. It does
    // not pin `preventScroll`: the router re-applies the saved position after the
    // render, so it would pass without it. No navigation in the app today leaves the
    // focus as the last scroll write, so `route-focus.component.spec.ts` pins the
    // focus options instead.
    test('Back focuses the h1 above the viewport and keeps the restored position', async ({
      page,
    }) => {
      await page.goto('/products');
      const cards = page.locator('main a[href^="/products/"]');
      await untilHydrated(cards.first());
      const card = cards.nth(Math.min(11, (await cards.count()) - 1));
      await card.scrollIntoViewIfNeeded();
      const left = await page.evaluate(() => window.scrollY);
      expect(left, 'the listing is tall enough to leave far down').toBeGreaterThan(600);
      await card.click();
      await page.waitForURL(/\/products\/[^/]+$/);
      await page.goBack();
      await page.waitForURL(/\/products$/);
      await expect.poll(() => focused(page)).toBe('h1');
      const headingBottom = await page
        .locator('main#main h1')
        .first()
        .evaluate((el) => el.getBoundingClientRect().bottom);
      expect(headingBottom, 'the h1 is above the viewport').toBeLessThan(0);
      // A fixed wait on purpose. The test proves that the restored position holds,
      // and no condition marks the end of "it did not move".
      await page.waitForTimeout(300);
      expect(Math.abs((await page.evaluate(() => window.scrollY)) - left)).toBeLessThan(80);
    });
  });
});

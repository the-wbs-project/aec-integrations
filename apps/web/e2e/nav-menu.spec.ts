import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { untilHydrated } from './hydration';

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
const MOBILE = { width: 375, height: 667 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;
// The `lg`-`xl` band. Neither the hamburger nor the inline search box renders
// here, so it is the width the compact `aec-search-trigger` exists to cover.
// 1100 rather than 1024 so the assertions aren't sitting on the exact edge; the
// row's fit at 1024 is pinned by measurement in `site-header.ts`, not here.
const NARROW_DESKTOP = { width: 1100, height: 800 } as const;
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

/** The search trigger's popover (lg to xl) still renders in the CDK overlay. */
function overlay(page: Page) {
  return page.locator('.cdk-overlay-container');
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

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'document must not overflow horizontally').toBeLessThanOrEqual(1);
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
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);

      // The dimmer covers the page under the header.
      await expect(page.locator('[data-nav-scrim]')).toBeVisible();
    });

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

    test('Escape closes, returns focus to the toggle, and releases the page', async ({ page }) => {
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

    // Every destination is one tap from the open menu, and each lands on a real page.
    const DESTINATIONS = [
      [/^All products/, '/products'],
      [/^How we rank$/, '/docs/trust/how-ranking-works'],
      [/^For vendors$/, '/vendor-program'],
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
        expect(await page.locator('main').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
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
    // Same popover, same one-tick gap before Escape is heard (see `openMenu`).
    await expect(searchTrigger(page)).toHaveAttribute('aria-expanded', 'true');

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

  test('the compact search icon edge computes to the strong Bone edge', async ({ page }) => {
    await page.setViewportSize(NARROW_DESKTOP);
    await page.goto(ROUTE);
    const trigger = page.locator('aec-search-trigger button');
    await untilHydrated(trigger);
    expect(await computed(trigger, 'border-top-color')).toBe(
      await tokenColor(page, '--border-on-brand-strong', 'border-top-color'),
    );
    expect(await computed(trigger, 'border-top-width')).toBe('1px');
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

import { expect, test, type Page } from '@playwright/test';

import { waitForHydrationSettle } from './console-capture';
import { untilHydrated } from './hydration';

// Scroll restoration on navigation. A client-side (SPA) navigation is a
// same-document navigation, so without router scroll restoration the browser
// carries the previous page's scroll offset into the new route — landing the
// visitor deep in the new page (often the footer) instead of at the header.
//
// `provideRouter(..., withInMemoryScrolling({ scrollPositionRestoration:
// 'enabled', anchorScrolling: 'enabled' }))` (app.config.ts) fixes it: a forward
// navigation opens at the top; Back/Forward restores the prior position.
// `ScrollBehaviorManager` (app.ts) keeps that reset instant even while smooth
// scrolling is on for an in-page jump (AECI-1752, the last describe below).
//
// Mirrors client-nav-detail.spec.ts: click through a real /products index row (a
// SPA navigation off the single initial load). Skipped when no data is seeded.
//
// AECI-1630. A click on an SSR-rendered row link before hydration is not dropped:
// the browser follows the `href` as a full document load. That load opens at the
// top on its own, and Back then loads a fresh /products at the top too. So the
// "opens at the top" test passed without testing anything, and the Back test
// failed with scrollY 0. `scrollListingThenClickThrough` waits for a quiet network
// before the click, then checks a window marker survived it. Retrying from `goto`
// without the wait does not converge under load (TESTING_STRATEGY §14.3 (a)).

const DOC_MARKER = '__aeciDoc';

async function markDocument(page: Page): Promise<void> {
  await page.evaluate(
    (key) => ((window as unknown as Record<string, unknown>)[key] = true),
    DOC_MARKER,
  );
}

async function documentMarked(page: Page): Promise<boolean> {
  return page.evaluate(
    (key) => (window as unknown as Record<string, unknown>)[key] === true,
    DOC_MARKER,
  );
}

/**
 * Loads /products, scrolls it to the bottom, and clicks the first row through to
 * its detail page as a client navigation. A click that still lands before
 * hydration is a full document load; the marker catches it, the attempt is
 * annotated, and the setup runs again. Fails, rather than skips, when every
 * attempt loads a new document, so a broken hydration stays red.
 */
async function scrollListingThenClickThrough(page: Page, maxAttempts = 4): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const firstProductLink = page.locator('#main a[href^="/products/"]').first();
    // SSR renders the rows, so `attached` proves only that the data exists. It is
    // not a hydration gate.
    await firstProductLink.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    test.skip((await firstProductLink.count()) === 0, 'no products seeded in this environment');

    // There is no DOM hydration signal (TESTING_STRATEGY §14.3 (a)). A quiet network
    // means the main bundle, the lazy route chunk and the listing's requests have
    // all landed, which is when Angular hydrates the row links.
    await page.waitForLoadState('networkidle');
    // AECI-1752: also wait for the row link's own listener (its jsaction clears on
    // hydration). A quiet network alone still let a click land on a dead row.
    await untilHydrated(firstProductLink);

    // Scroll the listing to the bottom so a naive SPA navigation would carry the
    // offset over. Forced instant, so the setup never animates even if smooth
    // scrolling is switched back on globally (AECI-1752).
    await page.evaluate(() =>
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior }),
    );
    const listingScrollY = await page.evaluate(() => Math.round(window.scrollY));
    test.skip(
      listingScrollY === 0,
      'products listing is not tall enough to scroll in this environment',
    );

    await markDocument(page);
    await firstProductLink.click();
    await expect(page).toHaveURL(/\/products\/[^/]+$/);
    await expect(page.locator('aec-product-detail')).toBeVisible();
    if (await documentMarked(page)) return;
    test.info().annotations.push({
      type: 'pre-hydration click',
      description: `attempt ${attempt} loaded a new document; retrying`,
    });
  }
  throw new Error(
    `every forward click loaded a new document (${maxAttempts} attempts): the listing never hydrated in time`,
  );
}

test.describe('scroll restoration on navigation', () => {
  test('a client-side navigation to a detail page opens at the top', async ({ page }) => {
    await scrollListingThenClickThrough(page);

    // The fix: the new route opens scrolled to the top, not at the carried offset.
    await expect
      .poll(() => page.evaluate(() => Math.round(window.scrollY)), {
        message: 'detail page must open scrolled to the top',
      })
      .toBe(0);
  });

  // AECI-1629. Angular's `RouterScroller` skips its scroll reset for every
  // navigation that ends before the app is first stable (its `isHydrating` flag
  // clears on `ApplicationRef.whenStable()`), and any in-flight `httpResource` keeps
  // the app unstable. In CI the facets request was still loading when the row was
  // clicked, so the detail page kept the listing's offset: 143, where Playwright
  // had scrolled to bring the first row into view.
  // Holding that request open makes the window deterministic. `PreStableScrollReset`
  // (core/pre-stable-scroll-reset.ts) closes it.
  test('a click before the listing settles still opens the detail page at the top', async ({
    page,
  }) => {
    let releaseFacets: () => void = () => {};
    const facetsReleased = new Promise<void>((resolve) => (releaseFacets = resolve));
    let markFacetsHeld: () => void = () => {};
    const facetsHeld = new Promise<void>((resolve) => (markFacetsHeld = resolve));
    await page.route('**/api/products/facets*', async (route) => {
      markFacetsHeld();
      await facetsReleased;
      await route.continue().catch(() => {});
    });

    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const firstProductLink = page.locator('#main a[href^="/products/"]').first();
    await firstProductLink.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    test.skip((await firstProductLink.count()) === 0, 'no products seeded in this environment');
    // The facets fetch can start a moment after the rows render.
    const held = await Promise.race([
      facetsHeld.then(() => true),
      page.waitForTimeout(5000).then(() => false),
    ]);
    test.skip(!held, 'the listing did not fetch facets from the browser');

    await page.evaluate(() =>
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior }),
    );
    const listingScrollY = await page.evaluate(() => Math.round(window.scrollY));
    test.skip(
      listingScrollY === 0,
      'products listing is not tall enough to scroll in this environment',
    );

    // A click that lands before hydration is a full page load, which opens at the
    // top on its own and would pass without exercising the client navigation.
    await page.evaluate(() => ((window as { __aeci1629?: boolean }).__aeci1629 = true));
    await firstProductLink.click();
    await expect(page).toHaveURL(/\/products\/[^/]+$/);
    await expect(page.locator('aec-product-detail')).toBeVisible();
    const sameDocument = await page.evaluate(
      () => (window as { __aeci1629?: boolean }).__aeci1629 === true,
    );
    test.skip(!sameDocument, 'the click landed before hydration and loaded a new document');

    try {
      await expect
        .poll(() => page.evaluate(() => Math.round(window.scrollY)), {
          message: 'a navigation before the app is stable must still open at the top',
        })
        .toBe(0);
    } finally {
      releaseFacets();
    }
  });

  test('Back restores the previous page scroll position', async ({ page }) => {
    await scrollListingThenClickThrough(page);
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);

    await page.goBack();
    await expect(page).toHaveURL(/\/products$/, { timeout: 15_000 });
    // A Back that reloaded the document would open at the top for its own reasons.
    expect(await documentMarked(page), 'Back must stay in the same document').toBe(true);

    // Back navigation restores (roughly) the offset we left the listing at, not 0.
    await expect
      .poll(() => page.evaluate(() => Math.round(window.scrollY)), {
        message: 'Back must restore the previous scroll position, not reset to top',
      })
      .toBeGreaterThan(0);
  });
});

// Initial-load fragment scrolling. `withInMemoryScrolling` sets
// `history.scrollRestoration = 'manual'` (disabling the browser's native fragment
// scroll) and the router's anchor scrolling does NOT fire on the initial hydration
// navigation — so a reload or externally-shared deep link to `…#integrations` would
// land at the top of the page. `InitialFragmentScroller` (app.ts) fixes it by
// scrolling to the fragment on the first NavigationEnd, honoring the section's
// `scroll-mt-20` (via `scrollIntoView`).
test.describe('initial-load fragment scrolling', () => {
  test('a deep link to #integrations opens scrolled to that section', async ({ page }) => {
    // Find a real product slug (env-independent — skip if nothing is seeded).
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();
    const firstProductLink = page.locator('#main a[href^="/products/"]').first();
    await firstProductLink.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    test.skip((await firstProductLink.count()) === 0, 'no products seeded in this environment');
    const href = await firstProductLink.getAttribute('href');
    test.skip(!href, 'product link has no href');

    // Full-document load of the hashed URL — the reload / external-deep-link case.
    await page.goto(`${href}#integrations`);
    await expect(page.locator('aec-product-detail')).toBeVisible();

    const section = page.locator('#integrations');
    await expect(section).toBeAttached();

    // Only meaningful when the section starts below the fold; a short product
    // (empty integrations, no description) can render it above the fold already.
    const absTop = await section.evaluate((el) =>
      Math.round(el.getBoundingClientRect().top + window.scrollY),
    );
    const viewportHeight = page.viewportSize()?.height ?? 0;
    test.skip(
      absTop <= viewportHeight,
      'integrations section is above the fold on this product; deep-link scroll is not observable',
    );

    // The fix: the page opens scrolled so the section is in view near the top,
    // its `scroll-mt-20` (5rem/80px) clearing the sticky section-nav.
    await expect(section).toBeInViewport();
    await expect
      .poll(() => page.evaluate(() => Math.round(window.scrollY)), {
        message: 'deep link to #integrations must scroll down to the section, not stay at the top',
      })
      .toBeGreaterThan(0);
    const sectionViewportTop = await section.evaluate((el) =>
      Math.round(el.getBoundingClientRect().top),
    );
    expect(sectionViewportTop).toBeGreaterThanOrEqual(0);
    expect(sectionViewportTop).toBeLessThan(160);
  });
});

// In-page section-nav jumps. `SectionNav` renders plain `<a href="{path}#id">`
// anchors so the browser scrolls natively, honoring each section's `scroll-mt-20`
// — but a same-document fragment navigation fires `popstate`, Angular reads that
// as a browser-driven navigation, and `RouterScroller` asks to re-scroll to the
// same fragment right after. Angular's stock `ViewportScroller.scrollToAnchor()`
// ignores `scroll-margin-top`, so that second scroll overshot by 80px and parked
// the section's <h2> underneath the sticky nav. `ScrollMarginViewportScroller`
// (app.config.ts) now skips it; this asserts the heading stays visible.
//
// The candidate walk matters: the thin local seed puts short products (no
// description, no integrations) at the head of the index, and a page that cannot
// scroll cannot show this defect. Taking `.first()` like the tests above would
// silently skip on every local run.
/**
 * Walks the first few seeded products until one renders a section-nav with an
 * Integrations entry on a page tall enough to scroll, and leaves the page open.
 * Skips the test when none does.
 */
async function openProductWithIntegrationsJump(page: Page): Promise<string> {
  await page.goto('/products');
  await expect(page.locator('app-root')).toBeAttached();
  const productLinks = page.locator('#main a[href^="/products/"]');
  await productLinks
    .first()
    .waitFor({ state: 'attached', timeout: 15000 })
    .catch(() => {});
  test.skip((await productLinks.count()) === 0, 'no products seeded in this environment');

  const hrefs = (
    await productLinks.evaluateAll((els) =>
      els.map((el) => el.getAttribute('href')).filter((h): h is string => !!h && !h.includes('#')),
    )
  ).slice(0, 8);

  let usable: string | null = null;
  for (const href of hrefs) {
    await page.goto(href);
    await expect(page.locator('aec-product-detail')).toBeVisible();
    const hasJump = await page.locator('aec-section-nav a[href$="#integrations"]').count();
    if (hasJump === 0) continue;
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollHeight > window.innerHeight + 120,
    );
    if (scrollable) {
      usable = href;
      break;
    }
  }
  test.skip(!usable, 'no seeded product is tall enough to jump to #integrations');
  return usable!;
}

test.describe('section-nav jumps clear the sticky nav', () => {
  test('clicking "Integrations" leaves the section heading below the nav', async ({ page }) => {
    await openProductWithIntegrationsJump(page);

    const nav = page.locator('aec-section-nav');
    await nav.locator('a[href$="#integrations"]').click();
    await expect(page).toHaveURL(/#integrations$/);

    const heading = page.locator('#integrations-title');
    await expect(heading).toBeAttached();

    // The regression: the heading must land BELOW the sticky nav's bottom edge,
    // not flush with the viewport top where the nav covers it. Angular's stock
    // scroller overshot by the section's `scroll-mt-20`, putting this at -50.
    await expect
      .poll(
        async () => {
          const navBottom = await nav.evaluate((el) =>
            Math.round(el.getBoundingClientRect().bottom),
          );
          const headingTop = await heading.evaluate((el) =>
            Math.round(el.getBoundingClientRect().top),
          );
          return headingTop - navBottom;
        },
        { message: 'the Integrations heading must not sit underneath the sticky section-nav' },
      )
      .toBeGreaterThanOrEqual(0);
  });
});

// AECI-1752. Smooth scrolling is scoped to in-page section links (clash 38 of
// ADR 0056): `html { scroll-behavior: smooth }` is gone, and `InPageSmoothScroll`
// (core/in-page-smooth-scroll.ts) puts `html.aeci-smooth-scroll` on for the span
// of a jump from an `<a data-smooth-scroll>` link. These tests sample `scrollY`
// on every animation frame. A smooth scroll passes through intermediate
// offsets. An instant one goes straight from the start to the end, so it shows
// exactly two. "Animates" therefore means at least one offset in between, plus
// a computed `smooth` on <html> at the click. Asking for several in-between
// offsets failed on a loaded machine, where the main thread misses frames while
// the compositor finishes the scroll (seen 2026-11-14: 0, 2, 601).

const SAMPLES = '__aeciScrollSamples';

interface ScrollSample {
  y: number;
  path: string;
}

interface ScrollSampler {
  samples: ScrollSample[];
  stopped: boolean;
  /** `<html>`'s computed `scroll-behavior` when the next click reached `window`. */
  behaviorAtClick: string | null;
}

/**
 * Records `scrollY` and the path on every frame from now until it is stopped.
 * Not time-boxed: under parallel load the click can come seconds later.
 */
async function startScrollSampler(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const sample = () => ({ y: Math.round(window.scrollY), path: location.pathname });
    const sampler: ScrollSampler = { samples: [sample()], stopped: false, behaviorAtClick: null };
    (window as unknown as Record<string, ScrollSampler>)[key] = sampler;
    // A `window` listener runs after `InPageSmoothScroll`'s `document` one and
    // before the link's default action, so this is what the browser scrolls with.
    window.addEventListener(
      'click',
      () => (sampler.behaviorAtClick = getComputedStyle(document.documentElement).scrollBehavior),
      { once: true },
    );
    const tick = () => {
      sampler.samples.push(sample());
      if (!sampler.stopped) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, SAMPLES);
}

/**
 * The computed `scroll-behavior` on `<html>` at the moment of the click: the
 * deterministic half of "this jump animates". Sampling offsets per frame is the
 * observable half, and it can miss frames on a heavily loaded machine.
 */
async function behaviorAtClick(page: Page): Promise<string | null> {
  return page.evaluate(
    (key) =>
      (window as unknown as Record<string, ScrollSampler | undefined>)[key]?.behaviorAtClick ??
      null,
    SAMPLES,
  );
}

/** Stops the sampler and returns every sample it took. */
async function stopScrollSampler(page: Page): Promise<ScrollSample[]> {
  return page.evaluate((key) => {
    const sampler = (window as unknown as Record<string, ScrollSampler | undefined>)[key];
    if (!sampler) return [];
    sampler.stopped = true;
    return sampler.samples;
  }, SAMPLES);
}

/** Stops the sampler and returns the distinct offsets it saw, in first-seen order. */
async function distinctOffsets(page: Page): Promise<number[]> {
  return [...new Set((await stopScrollSampler(page)).map((s) => s.y))];
}

/**
 * Stops the sampler and returns the distinct offsets seen while the URL path was
 * `path`, in first-seen order, without the final one. A router scroll that is
 * instant leaves at most the carried offset here. A glide leaves many.
 */
async function offsetsBeforeRestingOn(page: Page, path: string): Promise<number[]> {
  const onPath = (await stopScrollSampler(page)).filter((s) => s.path === path).map((s) => s.y);
  const final = onPath.at(-1);
  return [...new Set(onPath)].filter((y) => y !== final);
}

/**
 * Serves every page with `class="aeci-smooth-scroll"` on <html>, exactly as the
 * switch back to the old global behaviour would (a class in `src/index.html`).
 */
async function flipTheSwitch(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    const response = await route.fetch();
    const body = (await response.text()).replace(/<html\b/, '<html class="aeci-smooth-scroll"');
    await route.fulfill({ response, body });
  });
}

/**
 * Clicks an in-page section link and, `gapMs` later, does `then` in the page:
 * the race where a router scroll starts while the smooth-scroll class is on.
 * Both happen inside the page so the gap does not depend on the test's round
 * trip.
 */
async function sectionClickThen(
  page: Page,
  sectionLink: string,
  then: 'click-products' | 'back-two',
  gapMs = 50,
): Promise<void> {
  await page.evaluate(
    ({ sectionLink, then, gapMs }) => {
      document.querySelector<HTMLAnchorElement>(sectionLink)!.click();
      setTimeout(() => {
        if (then === 'back-two') history.go(-2);
        else document.querySelector<HTMLAnchorElement>('header a[href="/products"]')!.click();
      }, gapMs);
    },
    { sectionLink, then, gapMs },
  );
}

/**
 * Waits in the page until `scrollY` holds still for five frames, and returns it.
 * Counting frames in the page, not polling from the test, keeps it independent
 * of how slow the round trip is under parallel load.
 */
function scrollSettled(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let last = Math.round(window.scrollY);
        let still = 0;
        const tick = () => {
          const now = Math.round(window.scrollY);
          still = now === last ? still + 1 : 0;
          last = now;
          if (still >= 5) resolve(now);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/**
 * From 600px down, activates the skip link from the keyboard and asserts the
 * jump to `<main>` is instant, stays in the same document, and lands above 600.
 * The skip link never opts in to the smooth jump.
 */
async function expectSkipLinkJumpsInstantly(page: Page): Promise<void> {
  const scrollable = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight + 600,
  );
  test.skip(!scrollable, 'the page is not tall enough to scroll');

  await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' }));
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await skip.focus();
  await expect(skip).toBeFocused();
  const path = new URL(page.url()).pathname;
  await markDocument(page);
  await startScrollSampler(page);
  // Press on the focused element, the way a keyboard user activates it.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/' : path}#main$`));
  expect(await documentMarked(page), 'the skip link must stay on the page').toBe(true);
  const end = await scrollSettled(page);
  expect(end).toBeLessThan(600);

  expect(await behaviorAtClick(page), 'the skip link never arms').toBe('auto');
  const offsets = await distinctOffsets(page);
  expect(offsets, 'the skip link must not animate').toEqual([600, end]);
}

const htmlScrollBehavior = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior);

test.describe('smooth scrolling is scoped to in-page section links', () => {
  test('a section-nav click animates and lands the section below the nav', async ({ page }) => {
    await openProductWithIntegrationsJump(page);
    const nav = page.locator('aec-section-nav');
    // The nav host owns a click listener, so its jsaction clears on hydration.
    // `InPageSmoothScroll` starts in `App`'s constructor, before that.
    await untilHydrated(nav);

    // Not a global setting: nothing on <html> asks for smooth scrolling at rest.
    expect(await htmlScrollBehavior(page)).toBe('auto');

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await startScrollSampler(page);
    await nav.locator('a[href$="#integrations"]').click();
    await expect(page).toHaveURL(/#integrations$/);

    const end = await scrollSettled(page);
    expect(end).toBeGreaterThan(0);
    await expect(page.locator('#integrations-title')).toBeInViewport();
    const gap = await page.evaluate(() => {
      const navBottom = document.querySelector('aec-section-nav')!.getBoundingClientRect().bottom;
      const headingTop = document.getElementById('integrations-title')!.getBoundingClientRect().top;
      return Math.round(headingTop - navBottom);
    });
    expect(gap, 'scroll-margin keeps the heading clear of the sticky nav').toBeGreaterThanOrEqual(
      0,
    );

    expect(await behaviorAtClick(page), 'the click armed smooth scrolling').toBe('smooth');
    const offsets = await distinctOffsets(page);
    expect(
      offsets.length,
      `a smooth jump passes through intermediate offsets, saw ${offsets.join(', ')}`,
    ).toBeGreaterThan(2);

    // The class comes off once the jump ends, so the next scroll is instant again.
    await expect.poll(() => htmlScrollBehavior(page)).toBe('auto');
  });

  test('under reduced motion a section-nav click jumps instantly', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openProductWithIntegrationsJump(page);
    const nav = page.locator('aec-section-nav');
    await untilHydrated(nav);

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await startScrollSampler(page);
    await nav.locator('a[href$="#integrations"]').click();
    await expect(page).toHaveURL(/#integrations$/);
    const end = await scrollSettled(page);
    expect(end).toBeGreaterThan(0);
    await expect(page.locator('#integrations-title')).toBeInViewport();

    expect(await behaviorAtClick(page), 'reduced motion never arms').toBe('auto');
    const offsets = await distinctOffsets(page);
    expect(offsets, 'an instant jump goes straight from the top to the section').toEqual([0, end]);
    expect(await htmlScrollBehavior(page)).toBe('auto');
  });

  // The acceptance test for "the skip link never animates", for this issue and
  // AECI-1839. The link is found by its name, not its href: AECI-1839 changes the
  // href from a bare `#main` to a path-preserving `{path}#main`.
  test('the skip link jumps without animation on the home page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#main')).toBeAttached();
    await page.waitForLoadState('networkidle');
    await expectSkipLinkJumpsInstantly(page);
  });

  test('the skip link jumps without animation on a page other than home', async ({ page }) => {
    await openProductWithIntegrationsJump(page);
    await page.waitForLoadState('networkidle');
    const href = await page
      .getByRole('link', { name: 'Skip to main content' })
      .getAttribute('href');
    // Until AECI-1839 is merged into this branch, the bare `#main` resolves
    // against `<base href>` and loads `/`, so there is no same-page jump to time.
    test.skip(
      href === '#main',
      'the skip link is still a bare #main that loads the home page (AECI-1839 not merged yet)',
    );
    await expectSkipLinkJumpsInstantly(page);
  });

  test('Back after a route change restores the position without animation', async ({ page }) => {
    await scrollListingThenClickThrough(page);
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);

    await startScrollSampler(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/products$/, { timeout: 15_000 });
    expect(await documentMarked(page), 'Back must stay in the same document').toBe(true);
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(0);
    const end = await scrollSettled(page);

    // The restore may land in one or two steps (the page can grow while the
    // listing renders), but an animated glide passes through many offsets.
    const offsets = await distinctOffsets(page);
    expect(
      offsets.length,
      `Back must restore instantly, saw ${offsets.join(', ')} ending at ${end}`,
    ).toBeLessThanOrEqual(3);
  });
});

// AECI-1752 review. The "On this page" rail on a docs article is an in-page
// section link too (clash 38, the Same-Behavior Rule), so it animates like the
// product section nav. Nothing above a docs article is sticky, so "below the
// header" means the heading lands at its own `scroll-margin-top` (1.5rem).
test.describe('the docs "On this page" rail', () => {
  test('a rail click animates and lands the heading at its scroll margin', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/docs/vendors/plans');
    await waitForHydrationSettle(page);
    const rail = page.getByRole('navigation', { name: 'On this page' });
    await expect(rail.locator('.aec-docs-toc-dash').first()).toBeVisible();
    // The rail host owns the click listener, so its jsaction clears on hydration.
    await untilHydrated(page.locator('app-docs-toc').first());

    const link = rail.getByRole('link').last();
    const href = (await link.getAttribute('href'))!;
    expect(href).toMatch(/^\/docs\/vendors\/plans#[a-z0-9-]+$/);
    const id = href.split('#')[1]!;
    expect(await link.getAttribute('data-smooth-scroll')).toBe('');

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    const historyBefore = await page.evaluate(() => history.length);
    await link.focus();
    await startScrollSampler(page);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/docs/vendors/plans#${id}$`));
    const end = await scrollSettled(page);
    expect(end).toBeGreaterThan(0);

    const top = await page.evaluate(
      (id) => Math.round(document.getElementById(id)!.getBoundingClientRect().top),
      id,
    );
    expect(top, 'the heading sits at its 1.5rem scroll margin').toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(48);
    await expect(link).toHaveAttribute('aria-current', 'location');

    expect(await behaviorAtClick(page), 'the click armed smooth scrolling').toBe('smooth');
    const offsets = await distinctOffsets(page);
    expect(
      offsets.length,
      `a rail jump passes through intermediate offsets, saw ${offsets.join(', ')}`,
    ).toBeGreaterThan(2);
    await expect.poll(() => htmlScrollBehavior(page)).toBe('auto');

    // Same history as the product section nav: one entry per jump, and Back
    // returns to the bare article URL in the same document.
    expect(await page.evaluate(() => history.length)).toBe(historyBefore + 1);
    await markDocument(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/docs\/vendors\/plans$/);
    expect(await documentMarked(page)).toBe(true);
  });
});

// AECI-1752 review, the real race. A router scroll that starts while the
// smooth-scroll class is still on must stay instant.
// - A forward navigation with no fragment resets to the top through
//   `scrollToPosition([0, 0])` with no `behavior`, which honours the CSS.
//   `ScrollBehaviorManager`'s inline `scroll-behavior: auto` is the only thing
//   that keeps it instant. With `ScrollBehaviorManager.start()` removed, the
//   first test fails (measured 2026-11-14: the reset glided 29, 24, 8, 3, 1, 0).
// - Back/Forward restores pass `behavior: 'instant'` inside Angular 22's
//   `RouterScroller` itself, so the second test passes with or without the
//   guard. It pins the outcome, not the guard.
test.describe('a router scroll during a smooth in-page jump stays instant', () => {
  test('a route change clicked mid-jump opens the new page at the top', async ({ page }) => {
    await openProductWithIntegrationsJump(page);
    await untilHydrated(page.locator('aec-section-nav'));
    const productsLink = page.locator('header a[href="/products"]').first();
    await untilHydrated(productsLink);

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await startScrollSampler(page);
    await sectionClickThen(page, 'aec-section-nav a[href$="#integrations"]', 'click-products');
    await expect(page).toHaveURL(/\/products$/, { timeout: 15_000 });
    expect(await scrollSettled(page)).toBe(0);

    const before = await offsetsBeforeRestingOn(page, '/products');
    expect(before.length, `the reset must not glide, saw ${before.join(', ')}`).toBeLessThanOrEqual(
      2,
    );
  });

  test('Back pressed mid-jump restores the previous page without a glide', async ({ page }) => {
    const product = await openProductWithIntegrationsJump(page);

    // Listing, scrolled to the bottom, then a client navigation to that product.
    await page.goto('/products');
    const row = page.locator(`#main a[href="${product}"]`).first();
    await row.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForLoadState('networkidle');
    await untilHydrated(row);
    await page.evaluate(() =>
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }),
    );
    test.skip(
      (await page.evaluate(() => window.scrollY)) === 0,
      'products listing is not tall enough to scroll in this environment',
    );
    await markDocument(page);
    // A DOM click, so Playwright does not scroll the row into view first.
    await row.evaluate((a) => (a as HTMLAnchorElement).click());
    await expect(page).toHaveURL(new RegExp(`${product}$`));
    expect(await documentMarked(page), 'the row click must be a client navigation').toBe(true);
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);
    await untilHydrated(page.locator('aec-section-nav'));

    await startScrollSampler(page);
    await sectionClickThen(page, 'aec-section-nav a[href$="#integrations"]', 'back-two');
    await expect(page).toHaveURL(/\/products$/, { timeout: 15_000 });
    expect(await documentMarked(page), 'Back must stay in the same document').toBe(true);
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(0);
    const end = await scrollSettled(page);

    const before = await offsetsBeforeRestingOn(page, '/products');
    expect(
      before.length,
      `the restore must not glide, saw ${before.join(', ')} before ${end}`,
    ).toBeLessThanOrEqual(2);
  });
});

// AECI-1752 review. The switch back to the old global smooth scroll is a class on
// <html> in `src/index.html`. This serves that HTML and checks the three things
// the switch must keep: section jumps animate, router scrolls stay instant, and
// reduced motion stays instant.
test.describe('the switch: with the class on <html>, smooth scrolling is global again', () => {
  test('a section jump animates and a route change stays instant', async ({ page }) => {
    await flipTheSwitch(page);
    await openProductWithIntegrationsJump(page);
    const nav = page.locator('aec-section-nav');
    await untilHydrated(nav);
    expect(await htmlScrollBehavior(page), 'smooth at rest, as before AECI-1752').toBe('smooth');

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await startScrollSampler(page);
    await nav.locator('a[href$="#integrations"]').click();
    await expect(page).toHaveURL(/#integrations$/);
    expect(await scrollSettled(page)).toBeGreaterThan(0);
    expect(await behaviorAtClick(page)).toBe('smooth');
    const offsets = await distinctOffsets(page);
    expect(offsets.length, `the jump animates, saw ${offsets.join(', ')}`).toBeGreaterThan(2);
    // The service stood down and left the class on.
    expect(await htmlScrollBehavior(page)).toBe('smooth');

    const productsLink = page.locator('header a[href="/products"]').first();
    await untilHydrated(productsLink);
    await startScrollSampler(page);
    await page.evaluate(() =>
      document.querySelector<HTMLAnchorElement>('header a[href="/products"]')!.click(),
    );
    await expect(page).toHaveURL(/\/products$/, { timeout: 15_000 });
    expect(await scrollSettled(page)).toBe(0);
    const before = await offsetsBeforeRestingOn(page, '/products');
    expect(before.length, `the reset must not glide, saw ${before.join(', ')}`).toBeLessThanOrEqual(
      2,
    );
  });

  test('reduced motion still jumps instantly', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await flipTheSwitch(page);
    await openProductWithIntegrationsJump(page);
    const nav = page.locator('aec-section-nav');
    await untilHydrated(nav);
    expect(await htmlScrollBehavior(page)).toBe('auto');

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await startScrollSampler(page);
    await nav.locator('a[href$="#integrations"]').click();
    await expect(page).toHaveURL(/#integrations$/);
    const end = await scrollSettled(page);
    expect(end).toBeGreaterThan(0);
    expect(await behaviorAtClick(page)).toBe('auto');
    expect(await distinctOffsets(page)).toEqual([0, end]);
  });
});

import { expect, test, type Page } from '@playwright/test';

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

    // Scroll the listing to the bottom (forced instant so the smooth CSS doesn't
    // animate the setup) so a naive SPA navigation would carry the offset over.
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
    await expect(page).toHaveURL(/\/products$/);
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
async function openProductWithIntegrationsJump(page: Page): Promise<void> {
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
// on every animation frame. A smooth scroll passes through many intermediate
// offsets. An instant one goes straight from the start to the end.

const SAMPLES = '__aeciScrollSamples';

interface ScrollSampler {
  samples: number[];
  stopped: boolean;
}

/**
 * Records `scrollY` on every frame from now until {@link distinctOffsets} stops
 * it. Not time-boxed: under parallel load the click can come seconds later.
 */
async function startScrollSampler(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const sampler: ScrollSampler = { samples: [Math.round(window.scrollY)], stopped: false };
    (window as unknown as Record<string, ScrollSampler>)[key] = sampler;
    const tick = () => {
      sampler.samples.push(Math.round(window.scrollY));
      if (!sampler.stopped) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, SAMPLES);
}

/** Stops the sampler and returns the distinct offsets it saw, in first-seen order. */
async function distinctOffsets(page: Page): Promise<number[]> {
  const samples = await page.evaluate((key) => {
    const sampler = (window as unknown as Record<string, ScrollSampler | undefined>)[key];
    if (!sampler) return [];
    sampler.stopped = true;
    return sampler.samples;
  }, SAMPLES);
  return [...new Set(samples)];
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

    const offsets = await distinctOffsets(page);
    expect(
      offsets.length,
      `a smooth jump passes through intermediate offsets, saw ${offsets.join(', ')}`,
    ).toBeGreaterThan(3);

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

    const offsets = await distinctOffsets(page);
    expect(offsets, 'an instant jump goes straight from the top to the section').toEqual([0, end]);
    expect(await htmlScrollBehavior(page)).toBe('auto');
  });

  test('the skip link jumps without animation', async ({ page }) => {
    // On `/` the skip link's `#main` is a same-document jump. On other pages
    // `<base href>` resolves it to `/#main`, which loads the home page.
    await page.goto('/');
    await expect(page.locator('#main')).toBeAttached();
    await page.waitForLoadState('networkidle');
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollHeight > window.innerHeight + 600,
    );
    test.skip(!scrollable, 'the home page is not tall enough to scroll');

    await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' }));
    const skip = page.locator('a[href="#main"]');
    await skip.focus();
    await expect(skip).toBeFocused();
    await startScrollSampler(page);
    // Press on the focused element, the way a keyboard user activates it.
    await page.keyboard.press('Enter');
    const end = await scrollSettled(page);
    expect(end).toBeLessThan(600);

    const offsets = await distinctOffsets(page);
    expect(offsets, 'the skip link must not animate').toEqual([600, end]);
  });

  test('Back after a route change restores the position without animation', async ({ page }) => {
    await scrollListingThenClickThrough(page);
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);

    await startScrollSampler(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/products$/);
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

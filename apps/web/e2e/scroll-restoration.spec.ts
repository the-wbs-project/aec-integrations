import { expect, test } from '@playwright/test';

// Scroll restoration on navigation. A client-side (SPA) navigation is a
// same-document navigation, so without router scroll restoration the browser
// carries the previous page's scroll offset into the new route — landing the
// visitor deep in the new page (often the footer) instead of at the header.
//
// `provideRouter(..., withInMemoryScrolling({ scrollPositionRestoration:
// 'enabled', anchorScrolling: 'enabled' }))` (app.config.ts) fixes it: a forward
// navigation opens at the top; Back/Forward restores the prior position.
// `ScrollBehaviorManager` (app.ts) keeps that reset instant despite the global
// `scroll-behavior: smooth`.
//
// Mirrors client-nav-detail.spec.ts: click through a real /products index row (a
// SPA navigation off the single initial load). Skipped when no data is seeded.

test.describe('scroll restoration on navigation', () => {
  test('a client-side navigation to a detail page opens at the top', async ({ page }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const firstProductLink = page.locator('#main a[href^="/products/"]').first();
    // The index fetches its rows client-side (httpResource), so the links appear
    // a tick after hydration — wait for them before deciding the env has no data.
    await firstProductLink.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    test.skip((await firstProductLink.count()) === 0, 'no products seeded in this environment');

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

    await firstProductLink.click();
    await expect(page).toHaveURL(/\/products\/[^/]+$/);
    await expect(page.locator('aec-product-detail')).toBeVisible();

    // The fix: the new route opens scrolled to the top, not at the carried offset.
    await expect
      .poll(() => page.evaluate(() => Math.round(window.scrollY)), {
        message: 'detail page must open scrolled to the top',
      })
      .toBe(0);
  });

  test('Back restores the previous page scroll position', async ({ page }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const firstProductLink = page.locator('#main a[href^="/products/"]').first();
    // The index fetches its rows client-side (httpResource), so the links appear
    // a tick after hydration — wait for them before deciding the env has no data.
    await firstProductLink.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    test.skip((await firstProductLink.count()) === 0, 'no products seeded in this environment');

    await page.evaluate(() =>
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior }),
    );
    const listingScrollY = await page.evaluate(() => Math.round(window.scrollY));
    test.skip(
      listingScrollY === 0,
      'products listing is not tall enough to scroll in this environment',
    );

    await firstProductLink.click();
    await expect(page).toHaveURL(/\/products\/[^/]+$/);
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);

    await page.goBack();
    await expect(page).toHaveURL(/\/products$/);

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
// as a browser-driven navigation, and `RouterScroller` re-scrolls to the same
// fragment right after. Angular's stock `ViewportScroller.scrollToAnchor()`
// ignores `scroll-margin-top`, so that second scroll overshot by 80px and parked
// the section's <h2> underneath the sticky nav. `ScrollMarginViewportScroller`
// (app.config.ts) is the fix; this asserts the heading stays visible.
//
// The candidate walk matters: the thin local seed puts short products (no
// description, no integrations) at the head of the index, and a page that cannot
// scroll cannot show this defect. Taking `.first()` like the tests above would
// silently skip on every local run.
test.describe('section-nav jumps clear the sticky nav', () => {
  test('clicking "Integrations" leaves the section heading below the nav', async ({ page }) => {
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
        els
          .map((el) => el.getAttribute('href'))
          .filter((h): h is string => !!h && !h.includes('#')),
      )
    ).slice(0, 8);

    // Walk candidates until one renders a section-nav with an Integrations entry
    // on a page tall enough to scroll.
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

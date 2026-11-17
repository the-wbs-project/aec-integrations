import { expect, test, type Page, type Response } from '@playwright/test';

import { waitForHydrationSettle } from './console-capture';
import { FAKE_PRODUCTS, FAKE_VENDORS, routeFakeAlgolia } from './fake-algolia';
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

/** Product cards rendered in the listing grid. */
const LISTING_CARDS = '#main aec-product-card-grid li';
const LISTING_CARD_LINKS = '#main aec-product-card-grid a[href^="/products/"]';

/** How far a restored position may sit from the one the reader left (AECI-1900). */
const RESTORE_TOLERANCE_PX = 50;

/**
 * Waits in the page until `scrollY` and the document height both hold still for
 * ten frames, and returns `scrollY`. A restore that lands before the rows render
 * and then drifts as they arrive does not count as settled until the drift ends.
 *
 * Nor does a page the footer is loading (AECI-1909). A scroll can bring the
 * footer's sentinel within its 600px margin, and the footer then loads the next
 * page by itself. The page holds still while that runs, and on `/search` the
 * fake Algolia answers 300ms later, so ten still frames passed first. The test
 * recorded the rows without the new page, left, and on Back the store rightly
 * restored the page the reader really left with. The footer's control carries
 * `aria-busy` while it loads, so a settle also waits for that to clear.
 */
function layoutSettled(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const busy = () =>
          document.querySelectorAll('aec-pagination-footer [aria-busy="true"]').length;
        const read = () =>
          `${Math.round(window.scrollY)}:${document.documentElement.scrollHeight}:${busy()}`;
        let last = read();
        let still = 0;
        const tick = () => {
          const now = read();
          still = now === last ? still + 1 : 0;
          last = now;
          if (still >= 10 && busy() === 0) resolve(Math.round(window.scrollY));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/**
 * Clicks the first product card link that sits wholly in the viewport, with a
 * DOM click so Playwright does not scroll anything into view first. Returns the
 * `scrollY` at the click: the position the router saves for Back.
 */
async function clickVisibleCard(page: Page): Promise<{ y: number; href: string }> {
  const hit = await page.evaluate((selector) => {
    const link = [...document.querySelectorAll<HTMLAnchorElement>(selector)].find((a) => {
      const r = a.getBoundingClientRect();
      return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
    });
    if (!link) return null;
    const y = Math.round(window.scrollY);
    link.click();
    return { y, href: link.getAttribute('href')! };
  }, LISTING_CARD_LINKS);
  expect(hit, 'a product card is on screen to click').not.toBeNull();
  return hit!;
}

/**
 * Loads /products, scrolls to the end of the loaded rows, and clicks a card on
 * screen through to its detail page as a client navigation. Returns the
 * position it left the listing at. A click that still lands before hydration is
 * a full document load; the marker catches it, the attempt is annotated, and the
 * setup runs again. Fails, rather than skips, when every attempt loads a new
 * document, so a broken hydration stays red.
 */
async function scrollListingThenClickThrough(page: Page, maxAttempts = 4): Promise<number> {
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

    // Scroll so the last loaded card sits at the bottom of the viewport, far
    // enough down that a naive SPA navigation would carry the offset over.
    // Forced instant, so the setup never animates even if smooth scrolling is
    // switched back on globally (AECI-1752). The footer's sentinel may load the
    // next page from here; the settle waits that out.
    await page.evaluate((selector) => {
      const cards = document.querySelectorAll(selector);
      const last = cards[cards.length - 1]!.getBoundingClientRect();
      window.scrollTo({
        top: last.bottom + window.scrollY - window.innerHeight,
        behavior: 'instant' as ScrollBehavior,
      });
    }, LISTING_CARDS);
    const listingScrollY = await layoutSettled(page);
    test.skip(
      listingScrollY === 0,
      'products listing is not tall enough to scroll in this environment',
    );

    await markDocument(page);
    // A DOM click on a card already on screen. Playwright's own click would first
    // scroll the first row into view and so change the position under test.
    const { y } = await clickVisibleCard(page);
    await expect(page).toHaveURL(/\/products\/[^/]+$/);
    await expect(page.locator('aec-product-detail')).toBeVisible();
    if (await documentMarked(page)) return y;
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
    const saved = await scrollListingThenClickThrough(page);
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);

    await page.goBack();
    await expect(page).toHaveURL(/\/products$/, { timeout: 15_000 });
    // A Back that reloaded the document would open at the top for its own reasons.
    expect(await documentMarked(page), 'Back must stay in the same document').toBe(true);

    // AECI-1900: the offset the reader left, not just "somewhere below the top".
    // Before the fix the listing had no rows when the router restored, so the
    // page was too short and the reader landed elsewhere.
    const restored = await layoutSettled(page);
    expect(
      Math.abs(restored - saved),
      `Back must restore ${saved}, landed at ${restored}`,
    ).toBeLessThanOrEqual(RESTORE_TOLERANCE_PX);
  });
});

// AECI-1900. On Back, the router restores the saved position one frame after the
// listing renders. The listing used to fetch its rows again, so in that frame it
// had none (and every "Load more" page was gone): the page was too short to
// reach the position, and scroll anchoring then carried the reader somewhere
// else as the rows arrived. Measured on the base: left at 1200, landed at 3503.
// The listing now renders the pages it had from an in-memory store on Back and
// Forward (`shared/paginated-index/listing-history-store.ts`), and the router's
// own restoration lands. Nothing here or in the fix scrolls by hand.
//
// Each case opens the listing by a client navigation from `/categories`, so
// Back from the listing has somewhere to go and Forward returns to it.
//
// The term page. The local seed has no term with more than one page, so the
// term cases drop the term filter from the grid's browser request: the term
// page then lists the whole catalogue and shows "Load more". The page itself,
// its controller and its store key are the term page's own. The SSR fetch is not
// touched, which is why the term page is opened by a client navigation.
type ListingCase = {
  name: string;
  /** Opens the listing from `/categories` by a client navigation. */
  open: (page: Page) => Promise<void>;
  /** The listing URL path, to wait on after Back and Forward. */
  path: RegExp;
};

const TERM_PAGE = /\/categories\/[^/?#]+$/;

const LISTINGS: ListingCase[] = [
  {
    name: '/products',
    path: /\/products$/,
    open: async (page) => {
      const link = page.locator('header a[href="/products"]').first();
      await untilHydrated(link);
      await link.click();
      await expect(page).toHaveURL(/\/products$/);
    },
  },
  {
    name: 'a term page',
    path: TERM_PAGE,
    open: async (page) => {
      await page.route(
        (url) => url.pathname === '/api/products' && url.searchParams.has('category_slug'),
        (route) => {
          const url = new URL(route.request().url());
          url.searchParams.delete('category_slug');
          return route.continue({ url: url.toString() });
        },
      );
      // A term with products: an empty term renders its empty state, not the grid.
      const taxonomy = (await (await page.request.get('/api/taxonomy')).json()) as {
        categories: { slug: string; product_count: number }[];
      };
      const term = taxonomy.categories
        .filter((c) => c.product_count > 0)
        .sort((a, b) => b.product_count - a.product_count || (a.slug < b.slug ? -1 : 1))[0];
      test.skip(!term, 'no category has products in this environment');
      const link = page.locator(`#main a[href="/categories/${term!.slug}"]`).first();
      await untilHydrated(link);
      await link.click();
      await expect(page).toHaveURL(TERM_PAGE);
    },
  },
];

/** Opens the listing, loads `pages` pages, and scrolls card `cardIndex` near the top. */
async function browseListing(
  page: Page,
  listing: ListingCase,
  pages: 1 | 2,
  cardIndex: number,
): Promise<number> {
  await page.goto('/categories');
  await page.waitForLoadState('networkidle');
  await listing.open(page);
  await markDocument(page);

  const cards = page.locator(LISTING_CARDS);
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });
  test.skip((await cards.count()) < 24, 'the catalogue has no second page in this environment');
  if (pages === 2) {
    const loadMore = page.locator('aec-pagination-footer a').first();
    test.skip((await loadMore.count()) === 0, 'the listing has no "Load more" here');
    await loadMore.click();
    await expect.poll(() => cards.count()).toBeGreaterThan(cardIndex);
  }
  expect(await cards.count(), `card ${cardIndex} exists`).toBeGreaterThan(cardIndex);

  await page.evaluate(
    ({ selector, i }) => {
      const r = document.querySelectorAll(selector)[i]!.getBoundingClientRect();
      window.scrollTo({ top: r.top + window.scrollY - 120, behavior: 'instant' as ScrollBehavior });
    },
    { selector: LISTING_CARDS, i: cardIndex },
  );
  return layoutSettled(page);
}

async function expectRestored(page: Page, saved: number, when: string): Promise<void> {
  expect(await documentMarked(page), `${when} must stay in the same document`).toBe(true);
  const restored = await layoutSettled(page);
  expect(
    Math.abs(restored - saved),
    `${when} must restore ${saved}, landed at ${restored}`,
  ).toBeLessThanOrEqual(RESTORE_TOLERANCE_PX);
}

test.describe('Back and Forward return the reader to their place in a listing (AECI-1900)', () => {
  for (const listing of LISTINGS) {
    for (const where of [
      { label: 'a position on page 1', pages: 1 as const, card: 9 },
      { label: 'a position inside a page added by "Load more"', pages: 2 as const, card: 30 },
    ]) {
      test(`${listing.name}: Back and Forward restore ${where.label}`, async ({ page }) => {
        await browseListing(page, listing, where.pages, where.card);
        const count = await page.locator(LISTING_CARDS).count();

        const { y: saved, href } = await clickVisibleCard(page);
        await expect(page).toHaveURL(new RegExp(`${href}$`));
        await expect(page.locator('aec-product-detail')).toBeVisible();
        await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);

        await page.goBack();
        await expect(page).toHaveURL(listing.path, { timeout: 15_000 });
        await expectRestored(page, saved, 'Back');
        // The pages added by "Load more" come back too.
        expect(await page.locator(LISTING_CARDS).count()).toBe(count);

        // Back once more to /categories, then Forward onto the listing.
        await page.goBack();
        await expect(page).toHaveURL(/\/categories$/, { timeout: 15_000 });
        await page.goForward();
        await expect(page).toHaveURL(listing.path, { timeout: 15_000 });
        await expectRestored(page, saved, 'Forward');
        expect(await page.locator(LISTING_CARDS).count()).toBe(count);
      });
    }
  }
});

// AECI-1900, one URL visited twice in one tab. The store keeps one entry per
// history entry (the router's `navigationId` in `history.state`), not per URL.
// Keyed by URL alone, leaving the second visit overwrote the first, and Back to
// the first visit restored the second visit's pages.
test('two visits to /products keep their own pages and positions on Back', async ({ page }) => {
  const listing = LISTINGS[0]!;
  await page.goto('/categories');
  await page.waitForLoadState('networkidle');
  await listing.open(page);
  await markDocument(page);
  const cards = page.locator(LISTING_CARDS);
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });
  test.skip((await cards.count()) < 24, 'the catalogue has no second page in this environment');

  // First visit: page 1 only, a card high enough that the footer's auto-load
  // sentinel (600px margin) stays out of reach.
  await page.evaluate((selector) => {
    const r = document.querySelectorAll(selector)[3]!.getBoundingClientRect();
    window.scrollTo({ top: r.top + window.scrollY - 120, behavior: 'instant' as ScrollBehavior });
  }, LISTING_CARDS);
  await layoutSettled(page);
  const firstCount = await cards.count();
  const first = await clickVisibleCard(page);
  await expect(page.locator('aec-product-detail')).toBeVisible();

  // Second visit, a fresh navigation: "Load more", a card on page 2.
  const productsLink = page.locator('header a[href="/products"]').first();
  await untilHydrated(productsLink);
  await productsLink.click();
  await expect(page).toHaveURL(/\/products$/);
  await expect(cards.first()).toBeVisible();
  await page.locator('aec-pagination-footer a').first().click();
  await expect.poll(() => cards.count()).toBeGreaterThan(firstCount);
  const secondCount = await cards.count();
  await page.evaluate((selector) => {
    const r = document.querySelectorAll(selector)[30]!.getBoundingClientRect();
    window.scrollTo({ top: r.top + window.scrollY - 120, behavior: 'instant' as ScrollBehavior });
  }, LISTING_CARDS);
  await layoutSettled(page);
  const second = await clickVisibleCard(page);
  await expect(page.locator('aec-product-detail')).toBeVisible();

  await page.goBack(); // to the second visit
  await expect(page).toHaveURL(/\/products$/);
  await expectRestored(page, second.y, 'Back to the second visit');
  expect(await cards.count()).toBe(secondCount);

  await page.goBack(); // to the first product
  await expect(page).toHaveURL(urlEndingWith(first.href));
  // A Back changes the URL before the router has rendered the page. Pressing
  // Back again before that supersedes the navigation, which is the router's
  // own business and not what this test is about.
  await expect(page.locator('aec-product-detail')).toBeVisible();
  await layoutSettled(page);
  await page.goBack(); // to the first visit
  await expect(page).toHaveURL(/\/products$/);
  await expectRestored(page, first.y, 'Back to the first visit');
  expect(await cards.count(), 'the first visit had page 1 only').toBe(firstCount);
});

// AECI-1900, filtered listings. With a filter on, the rows are few and the
// filter panel sets the page height. On Back the panel fetched its counts again,
// so in the frame the router restored the position it was about 127px tall,
// not about 1,000: the page was too short, the position was clamped, and scroll
// anchoring moved the reader when the counts arrived. Measured on the base: left
// at 1,576, landed at 1,925. The panel now keeps its last counts in an
// in-memory store for Back and Forward (`FacetHistoryStore`).
//
// The reader stops a little above the bottom of the page, deep in the panel,
// and leaves through the site header. The filters are picked from the live
// counts so the cases do not depend on seeded ids.
type FacetTerm = { id: string; slug: string; name: string; product_count: number };
type FacetCounts = Record<'categories' | 'audiences' | 'phases' | 'trades', FacetTerm[]>;

async function facetCounts(page: Page, query = ''): Promise<FacetCounts> {
  return (await (await page.request.get(`/api/products/facets${query}`)).json()) as FacetCounts;
}

/** The terms of one dimension with products, most products first, slug as the tie-break. */
function busiest(terms: FacetTerm[]): FacetTerm[] {
  return terms
    .filter((t) => t.product_count > 0)
    .sort((a, b) => b.product_count - a.product_count || (a.slug < b.slug ? -1 : 1));
}

type FilteredCase = { name: string; url: (page: Page) => Promise<string | null> };

const FILTERED: FilteredCase[] = [
  {
    name: '/products with one filter',
    url: async (page) => {
      const [phase] = busiest((await facetCounts(page)).phases);
      return phase ? `/products?phase_id=${phase.id}` : null;
    },
  },
  {
    name: '/products with two filters',
    url: async (page) => {
      const [first, second] = busiest((await facetCounts(page)).phases);
      return first && second
        ? `/products?phase_id=${[first.id, second.id].sort().join(',')}`
        : null;
    },
  },
  {
    name: 'a term page with a filter',
    url: async (page) => {
      const [phase] = busiest((await facetCounts(page)).phases);
      if (!phase) return null;
      const [audience] = busiest((await facetCounts(page, `?phase_id=${phase.id}`)).audiences);
      return audience ? `/phases/${phase.slug}?audience_id=${audience.id}` : null;
    },
  },
];

/** Loads a filtered listing and stops 200px above the bottom of the page. */
async function openFilteredListing(page: Page, listing: FilteredCase): Promise<string> {
  const url = await listing.url(page);
  test.skip(url === null, 'no filter with products in this environment');
  await page.goto(url!);
  await page.waitForLoadState('networkidle');
  await expect(page.locator(LISTING_CARDS).first()).toBeVisible({ timeout: 15_000 });
  const panelSetsHeight = await page.evaluate((selector) => {
    const panel = document.querySelector('aec-facet-sidebar')!.getBoundingClientRect();
    const cards = [...document.querySelectorAll(selector)].map((c) => c.getBoundingClientRect());
    return panel.bottom > Math.max(...cards.map((c) => c.bottom));
  }, LISTING_CARDS);
  test.skip(!panelSetsHeight, 'the rows, not the filter panel, set the page height here');
  return url!;
}

/** A matcher for a URL that ends with this path and query, taken literally. */
function urlEndingWith(pathAndQuery: string): RegExp {
  return new RegExp(`${pathAndQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/** Stops `up` px above the bottom, leaves through the site header, and returns the position. */
async function stopNearBottomThenLeave(page: Page, up = 200): Promise<number> {
  await page.evaluate(
    (up) =>
      window.scrollTo({
        top: document.documentElement.scrollHeight - window.innerHeight - up,
        behavior: 'instant' as ScrollBehavior,
      }),
    up,
  );
  const saved = await layoutSettled(page);
  const link = page.locator('header a[href="/docs/trust/how-ranking-works"]').first();
  await untilHydrated(link);
  await markDocument(page);
  // A DOM click, so Playwright does not scroll the header link into view.
  await link.evaluate((a) => (a as HTMLAnchorElement).click());
  await expect(page).toHaveURL(/\/docs\/trust\/how-ranking-works$/);
  return saved;
}

test.describe('Back returns the reader to their place in a filtered listing (AECI-1900)', () => {
  for (const listing of FILTERED) {
    test(`${listing.name}: Back restores a position deep in the filter panel`, async ({ page }) => {
      const url = await openFilteredListing(page, listing);
      const saved = await stopNearBottomThenLeave(page);

      await page.goBack();
      await expect(page).toHaveURL(urlEndingWith(url), { timeout: 15_000 });
      await expectRestored(page, saved, 'Back');
    });
  }
});

// AECI-1900, Back and Forward between filter states on one page. A filter click
// pushes a history entry and keeps the listing and its panel, so a Back or
// Forward between two filter states rebuilds nothing. Both now save as the
// reader leaves each entry and look the entry up again on the way back, so
// the rows (with every "Load more" page) and the counts are there at once.
//
// Here the reader applies the filters by clicking the panel, so every filter
// state is its own history entry, then leaves through the site header.
type FilterClick = { group: string; name: string };
type FilterPlan = { start: string; clicks: FilterClick[]; end: string };

const FILTER_PLANS: { name: string; plan: (page: Page) => Promise<FilterPlan | null> }[] = [
  {
    name: '/products with one filter',
    plan: async (page) => {
      const [phase] = busiest((await facetCounts(page)).phases);
      return phase
        ? {
            start: '/products',
            clicks: [{ group: 'Phases', name: phase.name }],
            end: `/products?phase_id=${phase.id}`,
          }
        : null;
    },
  },
  {
    name: '/products with two filters',
    plan: async (page) => {
      const [first, second] = busiest((await facetCounts(page)).phases);
      return first && second
        ? {
            start: '/products',
            clicks: [
              { group: 'Phases', name: first.name },
              { group: 'Phases', name: second.name },
            ],
            end: `/products?phase_id=${[first.id, second.id].sort().join(',')}`,
          }
        : null;
    },
  },
  {
    name: 'a term page with a filter',
    plan: async (page) => {
      const [phase] = busiest((await facetCounts(page)).phases);
      if (!phase) return null;
      const [audience] = busiest((await facetCounts(page, `?phase_id=${phase.id}`)).audiences);
      return audience
        ? {
            start: `/phases/${phase.slug}`,
            clicks: [{ group: 'Audiences', name: audience.name }],
            end: `/phases/${phase.slug}?audience_id=${audience.id}`,
          }
        : null;
    },
  },
];

/** The listing's own requests: its rows and its filter panel's counts. */
const LISTING_REQUESTS = ['/api/products', '/api/products/facets'];

/** Whether a response URL answers the filter state in `pageUrl` (every `*_id` param matches). */
function answersFilterState(responseUrl: string, path: string, pageUrl: string): boolean {
  const response = new URL(responseUrl);
  if (response.pathname !== path) return false;
  const filters = [...new URL(pageUrl).searchParams].filter(([key]) => key.endsWith('_id'));
  return filters.every(([key, value]) => response.searchParams.get(key) === value);
}

/**
 * Brings one filter checkbox to the middle of the viewport and clicks it with a
 * DOM click, as a reader ticking a filter. Returns the position at the click:
 * what the router saves for a later Back to the state being left.
 *
 * Then waits until the new filter state's rows and counts have both arrived
 * (AECI-1909). A filter click is a client navigation, so `waitForLoadState`
 * returns at once: the document reached `networkidle` long before. And the
 * page holds still while the request runs, because the previous state's rows
 * stay on screen, dimmed. So a settle alone let the test count, scroll and
 * leave a state whose rows had not arrived. The listing stores nothing for
 * such a state, on purpose, so the Back that followed fetched and landed short.
 * Measured: the rows took 190 to 560ms on the local stack.
 */
async function clickFilter(page: Page, click: FilterClick): Promise<number> {
  const group = page.locator('aec-facet-sidebar fieldset', {
    has: page.locator('legend', { hasText: click.group }),
  });
  const box = group.getByRole('checkbox', {
    name: new RegExp(`^${click.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`),
  });
  if ((await box.count()) === 0) await group.getByRole('button').first().click();
  await untilHydrated(page.locator('aec-facet-sidebar'));

  const answered: string[] = [];
  const onResponse = (response: Response) => {
    if (response.ok()) answered.push(response.url());
  };
  page.on('response', onResponse);
  try {
    const before = page.url();
    const y = await box.evaluate((input) => {
      input.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      const y = Math.round(window.scrollY);
      (input as HTMLInputElement).click();
      return y;
    });
    await expect.poll(() => page.url()).not.toBe(before);
    const after = page.url();
    await expect
      .poll(
        () =>
          LISTING_REQUESTS.every((path) =>
            answered.some((url) => answersFilterState(url, path, after)),
          ),
        { message: `the rows and counts for ${after} arrive`, timeout: 15_000 },
      )
      .toBe(true);
    return y;
  } finally {
    page.off('response', onResponse);
  }
}

test.describe('Back and Forward between filter states on one page (AECI-1900)', () => {
  for (const { name, plan } of FILTER_PLANS) {
    test(`${name}: Back and Forward restore the filtered listing`, async ({ page }) => {
      const steps = await plan(page);
      test.skip(steps === null, 'no filter with products in this environment');
      await page.goto(steps!.start);
      await page.waitForLoadState('networkidle');
      await expect(page.locator(LISTING_CARDS).first()).toBeVisible({ timeout: 15_000 });

      let clickedAt = 0;
      for (const click of steps!.clicks) {
        clickedAt = await clickFilter(page, click);
        await expect(page).toHaveURL(new RegExp(click.group === 'Phases' ? 'phase_id=' : '_id='));
        await layoutSettled(page);
      }
      await expect(page).toHaveURL(urlEndingWith(steps!.end));
      const cards = await page.locator(LISTING_CARDS).count();
      const saved = await stopNearBottomThenLeave(page);

      // Back from another page: the listing is rebuilt from the store.
      await page.goBack();
      await expect(page).toHaveURL(urlEndingWith(steps!.end), { timeout: 15_000 });
      await expectRestored(page, saved, 'Back');

      // Back to the state before the last filter click: same listing, new query.
      await page.goBack();
      await expect(page).not.toHaveURL(urlEndingWith(steps!.end));
      await expectRestored(page, clickedAt, 'Back to the previous filter state');

      // Forward to the filtered state: same listing again.
      await page.goForward();
      await expect(page).toHaveURL(urlEndingWith(steps!.end), { timeout: 15_000 });
      await expectRestored(page, saved, 'Forward');
      expect(await page.locator(LISTING_CARDS).count()).toBe(cards);
    });
  }

  test('/products: Back across a filter click keeps the "Load more" pages', async ({ page }) => {
    const [phase] = busiest((await facetCounts(page)).phases);
    test.skip(!phase, 'no filter with products in this environment');
    await page.goto('/products');
    await page.waitForLoadState('networkidle');
    const cards = page.locator(LISTING_CARDS);
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    const loadMore = page.locator('aec-pagination-footer a').first();
    test.skip((await loadMore.count()) === 0, 'the listing has no "Load more" here');
    await untilHydrated(loadMore);
    const firstPage = await cards.count();
    await loadMore.click();
    await expect.poll(() => cards.count()).toBeGreaterThan(firstPage);
    const loaded = await cards.count();
    await markDocument(page);

    const clickedAt = await clickFilter(page, { group: 'Phases', name: phase!.name });
    await expect(page).toHaveURL(/phase_id=/);
    const filteredAt = await layoutSettled(page);
    const filteredCards = await cards.count();

    await page.goBack();
    await expect(page).toHaveURL(/\/products$/);
    await expectRestored(page, clickedAt, 'Back across the filter click');
    expect(await cards.count(), 'the "Load more" page is still there').toBe(loaded);

    await page.goForward();
    await expect(page).toHaveURL(/phase_id=/);
    await expectRestored(page, filteredAt, 'Forward across the filter click');
    expect(await cards.count()).toBe(filteredCards);
  });

  // AECI-1902. The listing read `?page=` only when it was built, so this Back
  // restarted at page 1, missed the stored pages and fetched the wrong rows.
  test('/products?page=2: Back across a filter click returns to page 2 and its place', async ({
    page,
  }) => {
    const [phase] = busiest((await facetCounts(page)).phases);
    test.skip(!phase, 'no filter with products in this environment');
    await page.goto('/products?page=2');
    await page.waitForLoadState('networkidle');
    const cards = page.locator(LISTING_CARDS);
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    const hrefs = () =>
      page
        .locator(LISTING_CARD_LINKS)
        .evaluateAll((links) => links.map((a) => a.getAttribute('href')));
    const pageTwo = await hrefs();
    await markDocument(page);

    const clickedAt = await clickFilter(page, { group: 'Phases', name: phase!.name });
    await expect(page).toHaveURL(/phase_id=/);
    // The filter starts at its own page 1: the panel drops `?page=`.
    await expect(page).not.toHaveURL(/[?&]page=/);
    await layoutSettled(page);

    await page.goBack();
    await expect(page).toHaveURL(/\/products\?page=2$/);
    await expectRestored(page, clickedAt, 'Back across the filter click');
    // Bringing the filter into view can let the footer load page 3 first, and
    // the store keeps it. The list must still start at page 2.
    const restored = await hrefs();
    expect(restored.slice(0, pageTwo.length), 'the page 2 rows are back, first').toEqual(pageTwo);
  });
});

// /search gets its rows from Algolia only after the search code loads, after the
// first render. So a Back used to render no rows in the frame the router restored
// the position: left at 3,200, clamped to 1,341, landed at 3,457. The page now
// renders what the reader left from a per-tab store on Back and Forward.
//
// Every answer comes from the fixed Algolia in `fake-algolia.ts`, held back by
// 300ms, so the rows, counts and order cannot move and a restore that waits for
// Algolia is caught. The only client-side way into /search from another page is
// the header search box, which carries `?q=` alone. So a Forward lands on that
// entry, and the tab and filter cases are checked on Back.

/** Result cards on the active /search tab. */
const SEARCH_CARDS = '#main aec-search-product-card, #main aec-search-vendor-card';

/** Opens /search from /categories through the header search box. */
async function openSearchFromHeader(page: Page): Promise<void> {
  await page.goto('/categories');
  await page.waitForLoadState('networkidle');
  const box = page.locator('header form[role="search"] input[name="q"]').first();
  test.skip((await box.count()) === 0, 'no header search box at this viewport');
  await untilHydrated(box);
  await box.fill('zz fake');
  await box.press('Enter');
  await expect(page).toHaveURL(/\/search\?q=zz(\+|%20)fake$/, { timeout: 15_000 });
  await expect(page.locator(SEARCH_CARDS).first()).toBeVisible({ timeout: 15_000 });
  await markDocument(page);
}

/** Loads `pages` pages and puts card `cardIndex` near the top. Returns `scrollY`. */
async function placeReader(page: Page, pages: 1 | 2, cardIndex: number): Promise<number> {
  const cards = page.locator(SEARCH_CARDS);
  await page.waitForLoadState('networkidle');
  await expect(cards).toHaveCount(24, { timeout: 15_000 });
  if (pages === 2) {
    await page.locator('aec-pagination-footer a, aec-pagination-footer button').first().click();
    await expect.poll(() => cards.count()).toBeGreaterThan(cardIndex);
    await page.waitForLoadState('networkidle');
  }
  await page.evaluate(
    ({ selector, i }) => {
      const r = document.querySelectorAll(selector)[i]!.getBoundingClientRect();
      window.scrollTo({ top: r.top + window.scrollY - 120, behavior: 'instant' as ScrollBehavior });
    },
    { selector: SEARCH_CARDS, i: cardIndex },
  );
  // The footer may load the next page from here on its own; let it land, so
  // the rows counted are the rows the reader leaves.
  await page.waitForLoadState('networkidle');
  return layoutSettled(page);
}

/** Leaves /search for /products through the header link, as a client navigation. */
async function leaveForProducts(page: Page): Promise<number> {
  const y = await page.evaluate(() => {
    const link = document.querySelector<HTMLAnchorElement>('header a[href="/products"]');
    const at = Math.round(window.scrollY);
    link!.click();
    return at;
  });
  await expect(page).toHaveURL(/\/products$/);
  await expect(page.locator(LISTING_CARDS).first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);
  return y;
}

/** The slug of every result card on screen, in order. */
function searchRows(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    return [...document.querySelectorAll(selector)].map((card) => {
      const prefix = card.tagName === 'AEC-SEARCH-VENDOR-CARD' ? '/vendors/' : '/products/';
      const link = card.querySelector<HTMLAnchorElement>(`a[href^="${prefix}"]`);
      return link?.getAttribute('href')?.slice(prefix.length) ?? '';
    });
  }, SEARCH_CARDS);
}

/**
 * The reader is back where they left, with exactly the rows they had, in the
 * frame the router restored. Then Algolia's answer lands and must not move
 * them. The footer may load the next page by itself from there, as it does on
 * any visit, so later rows may follow: they must continue the fixed order with
 * no row twice and none missing.
 */
async function expectSearchRestored(
  page: Page,
  saved: number,
  rows: string[],
  order: string[],
  when: string,
): Promise<string[]> {
  await expectRestored(page, saved, when);
  expect(await searchRows(page), `${when}: the rows the reader left`).toEqual(rows);
  await page.waitForLoadState('networkidle');
  await expectRestored(page, saved, `${when}, after Algolia answered,`);
  const after = await searchRows(page);
  expect(after.slice(0, rows.length), `${when}: the rows stay`).toEqual(rows);
  expect(after, `${when}: no row twice, none missing`).toEqual(order.slice(0, after.length));
  // The rows the reader leaves with next time.
  return after;
}

const SEARCH_DEPTHS = [
  { label: 'a position on page 1', pages: 1 as const, card: 9 },
  { label: 'a position inside a page added by "Load more"', pages: 2 as const, card: 30 },
];

test.describe('Back and Forward return the reader to their place on /search', () => {
  for (const where of SEARCH_DEPTHS) {
    test(`/search?q=: Back and Forward restore ${where.label}`, async ({ page }) => {
      await routeFakeAlgolia(page, { delayMs: 300 });
      await openSearchFromHeader(page);
      await placeReader(page, where.pages, where.card);
      const rows = await searchRows(page);
      const order = FAKE_PRODUCTS.map((p) => p.slug);
      const saved = await leaveForProducts(page);

      await page.goBack();
      await expect(page).toHaveURL(/\/search\?q=/, { timeout: 15_000 });
      const left = await expectSearchRestored(page, saved, rows, order, 'Back');

      // Back once more to /categories, then Forward onto /search.
      await page.goBack();
      await expect(page).toHaveURL(/\/categories$/, { timeout: 15_000 });
      await page.goForward();
      await expect(page).toHaveURL(/\/search\?q=/, { timeout: 15_000 });
      await expectSearchRestored(page, saved, left, order, 'Forward');
    });
  }

  for (const tab of [
    {
      name: 'Products',
      order: FAKE_PRODUCTS.filter((p) => p.categories.includes('Field Management')).map(
        (p) => p.slug,
      ),
      filter: async (page: Page) => {
        const box = page
          .locator('aec-search-refinement-list fieldset')
          .filter({ has: page.locator('legend', { hasText: 'Categories' }) })
          .getByRole('checkbox', { name: 'Field Management' });
        await untilHydrated(box);
        await box.check();
        await expect(page).toHaveURL(/categories=Field/);
        // The filtered answer is on screen. "Load more" pressed while a filter
        // search is in flight loses that answer's first page (seen here, not fixed).
        await expect(page.locator('aec-pagination-footer')).toContainText('of 70');
      },
    },
    {
      name: 'Vendors',
      order: FAKE_VENDORS.filter((v) => v.integration_count >= 1 && v.integration_count <= 10).map(
        (v) => v.slug,
      ),
      filter: async (page: Page) => {
        await page.getByRole('tab', { name: /Vendors/ }).click();
        await expect(page).toHaveURL(/tab=vendors/);
        await expect(page.locator('#main aec-search-vendor-card').first()).toBeVisible();
        await page
          .locator('aec-search-numeric-menu fieldset')
          .filter({ has: page.locator('legend', { hasText: 'Integrations' }) })
          .getByRole('radio', { name: '1–10' })
          .check();
        await expect(page).toHaveURL(/v_integration_count=1/);
        await expect(page.locator('aec-pagination-footer')).toContainText('of 53');
      },
    },
  ]) {
    for (const where of SEARCH_DEPTHS) {
      test(`${tab.name} tab with a filter: Back restores ${where.label}`, async ({ page }) => {
        await routeFakeAlgolia(page, { delayMs: 300 });
        await openSearchFromHeader(page);
        await tab.filter(page);
        await placeReader(page, where.pages, where.card);
        const rows = await searchRows(page);
        const url = page.url();
        const saved = await leaveForProducts(page);

        await page.goBack();
        await expect(page).toHaveURL(url, { timeout: 15_000 });
        const left = await expectSearchRestored(page, saved, rows, tab.order, 'Back');

        // Forward to /products and Back again: the entry is restored a second
        // time, under the id the first Back gave it.
        await page.goForward();
        await expect(page).toHaveURL(/\/products$/, { timeout: 15_000 });
        await page.goBack();
        await expect(page).toHaveURL(url, { timeout: 15_000 });
        await expectSearchRestored(page, saved, left, tab.order, 'Back again');
      });
    }
  }
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
// ADR 0058): `html { scroll-behavior: smooth }` is gone, and `InPageSmoothScroll`
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
 * Clicks an in-page section link and, `gapMs` later, the header's Products link,
 * both inside the page so the gap does not depend on the test's round trip. Used
 * under reduced motion, where there is no glide to wait for (see `glideThen`).
 */
async function sectionClickThenProducts(
  page: Page,
  sectionLink: string,
  gapMs = 50,
): Promise<void> {
  await page.evaluate(
    ({ sectionLink, gapMs }) => {
      document.querySelector<HTMLAnchorElement>(sectionLink)!.click();
      setTimeout(
        () => document.querySelector<HTMLAnchorElement>('header a[href="/products"]')!.click(),
        gapMs,
      );
    },
    { sectionLink, gapMs },
  );
}

/**
 * AECI-1907: starts a section jump, waits in the page until the glide is in flight
 * (`scrollY` strictly between 1 and the target), then does `then`: clicks the link
 * that selector names, presses Enter in the field it names, or goes back two entries. Returns where the glide was when
 * `then` ran, or `at: -1` when no glide started within three seconds. Waiting on the
 * glide, not on a fixed gap, makes the race happen on every run.
 */
async function glideThen(
  page: Page,
  sectionLink: string,
  then: { click: string } | { enterIn: string } | 'back-two',
): Promise<{ at: number; goal: number }> {
  // A request still loading can hold the page's height, and the glide's target with it.
  await page.waitForLoadState('networkidle');
  return page.evaluate(
    ({ sectionLink, then }) =>
      new Promise<{ at: number; goal: number }>((resolve) => {
        const link = document.querySelector<HTMLAnchorElement>(sectionLink)!;
        const target = document.getElementById(decodeURIComponent(link.hash.slice(1)))!;
        const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const goal = Math.round(
          Math.min(max, target.getBoundingClientRect().top + window.scrollY - margin),
        );
        const act = () => {
          if (then === 'back-two') history.go(-2);
          else if ('click' in then) document.querySelector<HTMLAnchorElement>(then.click)!.click();
          else
            document
              .querySelector(then.enterIn)!
              .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        };
        const started = performance.now();
        const wait = () => {
          const y = window.scrollY;
          if (y > 1 && y < goal - 1) {
            act();
            resolve({ at: Math.round(y), goal });
          } else if (performance.now() - started > 3000) {
            resolve({ at: -1 - Math.round(y), goal });
          } else {
            requestAnimationFrame(wait);
          }
        };
        // Two frames first, so the test's own instant scroll to the top has landed.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            link.click();
            requestAnimationFrame(wait);
          }),
        );
      }),
    { sectionLink, then },
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
    const saved = await scrollListingThenClickThrough(page);
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);

    await startScrollSampler(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/products$/, { timeout: 15_000 });
    expect(await documentMarked(page), 'Back must stay in the same document').toBe(true);
    const end = await layoutSettled(page);
    expect(
      Math.abs(end - saved),
      `Back must restore ${saved}, landed at ${end}`,
    ).toBeLessThanOrEqual(RESTORE_TOLERANCE_PX);

    // The restore lands in one step now that the rows render with it (AECI-1900),
    // but an animated glide passes through many offsets.
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
  // AECI-1907: the click lands while the glide is in flight, on every run. Before the
  // fix the glide ran on into /products and the page ended partway down (seen: 24,
  // 39, 153) or the reset itself glided to the top.
  test('a route change clicked mid-jump opens the new page at the top', async ({ page }) => {
    await openProductWithIntegrationsJump(page);
    await untilHydrated(page.locator('aec-section-nav'));
    const productsLink = page.locator('header a[href="/products"]').first();
    await untilHydrated(productsLink);

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await startScrollSampler(page);
    const { at, goal } = await glideThen(page, 'aec-section-nav a[href$="#integrations"]', {
      click: 'header a[href="/products"]',
    });
    expect(at, `the click must land mid-glide (target ${goal})`).toBeGreaterThan(1);
    await expect(page).toHaveURL(/\/products$/, { timeout: 15_000 });
    expect(await scrollSettled(page)).toBe(0);

    const before = await offsetsBeforeRestingOn(page, '/products');
    expect(before.length, `the reset must not glide, saw ${before.join(', ')}`).toBeLessThanOrEqual(
      2,
    );
  });

  test('a second section link clicked mid-glide lands on the second section', async ({ page }) => {
    await openProductWithIntegrationsJump(page);
    const nav = page.locator('aec-section-nav');
    await untilHydrated(nav);
    test.skip(
      (await nav.locator('a[href$="#reviews"]').count()) === 0,
      'no Reviews link in this section nav',
    );
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await markDocument(page);

    const { at, goal } = await glideThen(page, 'aec-section-nav a[href$="#integrations"]', {
      click: 'aec-section-nav a[href$="#reviews"]',
    });
    expect(at, `the second click must land mid-glide (target ${goal})`).toBeGreaterThan(1);
    await expect(page).toHaveURL(/#reviews$/);
    await scrollSettled(page);
    expect(await documentMarked(page), 'a section jump stays in the document').toBe(true);
    await expect(page.locator('#reviews-title')).toBeInViewport();
    const gap = await page.evaluate(
      () =>
        document.getElementById('reviews-title')!.getBoundingClientRect().top -
        document.querySelector('aec-section-nav')!.getBoundingClientRect().bottom,
    );
    expect(gap, 'the second section lands below the bar').toBeGreaterThanOrEqual(0);
  });

  test('under reduced motion a route change right after a section click opens at the top', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openProductWithIntegrationsJump(page);
    await untilHydrated(page.locator('aec-section-nav'));
    await untilHydrated(page.locator('header a[href="/products"]').first());

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await startScrollSampler(page);
    await sectionClickThenProducts(page, 'aec-section-nav a[href$="#integrations"]');
    await expect(page).toHaveURL(/\/products$/, { timeout: 15_000 });
    expect(await scrollSettled(page)).toBe(0);
    const before = await offsetsBeforeRestingOn(page, '/products');
    expect(before.length, `the reset must not glide, saw ${before.join(', ')}`).toBeLessThanOrEqual(
      2,
    );
  });

  // The docs search routes with `router.navigate([path], { fragment })`, a client
  // navigation to another page with a fragment. Enter in the field picks the first hit.
  test('a route to another page with a fragment, taken mid-glide, lands on that fragment', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/docs/vendors/plans');
    await waitForHydrationSettle(page);
    await untilHydrated(page.locator('app-docs-toc').first());
    const search = page.locator('aec-docs-search input[type="search"]').first();
    test.skip((await search.count()) === 0, 'docs search is not available in this environment');
    await search.fill('paying by card');
    await expect(page.getByRole('option').first()).toContainText('Paying by card');
    const railHref = (await page
      .getByRole('navigation', { name: 'On this page' })
      .getByRole('link')
      .last()
      .getAttribute('href'))!;
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await markDocument(page);

    const { at, goal } = await glideThen(page, `a[href="${railHref}"][data-smooth-scroll]`, {
      enterIn: 'aec-docs-search input[type="search"]',
    });
    expect(at, `Enter must land mid-glide (target ${goal})`).toBeGreaterThan(1);
    await expect(page).toHaveURL(/\/docs\/vendors\/billing#paying-by-card$/, { timeout: 15_000 });
    expect(await documentMarked(page), 'the search must route in the same document').toBe(true);
    await scrollSettled(page);
    const top = await page.evaluate(() =>
      Math.round(document.getElementById('paying-by-card')!.getBoundingClientRect().top),
    );
    expect(top, 'the heading sits at its scroll margin').toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(48);
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
    // AECI-1907: Back is pressed while the glide is in flight, on every run.
    const { at } = await glideThen(page, 'aec-section-nav a[href$="#integrations"]', 'back-two');
    expect(at, 'Back must land mid-glide').toBeGreaterThan(1);
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

/**
 * AECI-1902: the listing's first page follows `?page=` on every navigation.
 *
 * `/products?page=2` is the URL crawlers follow from "Load more", so readers
 * land on it from search. The listing read `?page=` once, when it was built.
 * The header "Browse" link to `/products` keeps the same component, so the
 * address bar said `/products` while the list still showed page 2's rows and
 * no "Load more". The same held for a term page.
 *
 * Each case compares the rendered rows with the API's own pages in the default
 * order, so it holds on any seeded catalogue. A case self-skips when the
 * catalogue has too few pages.
 */
import { expect, test, type Page } from '@playwright/test';

import { untilHydrated } from './hydration';

const CARD_LINKS = '#main aec-product-card-grid a[href^="/products/"]';
const PER_PAGE = 24;
/** The listings' default order (`PRODUCT_DEFAULT_SORT`), which the URLs below leave implicit. */
const DEFAULT_SORT = 'created';
const DOC_MARKER = '__aeci1902';

/** The product slugs of one API page in the default order, and the total. */
async function apiPage(
  page: Page,
  n: number,
  query = '',
): Promise<{ slugs: string[]; total: number }> {
  const res = await page.request.get(
    `/api/products?page=${n}&perPage=${PER_PAGE}&sort=${DEFAULT_SORT}${query}`,
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: { slug: string }[]; total: number };
  return { slugs: body.data.map((p) => p.slug), total: body.total };
}

/** The product slugs on screen, in order, one per card. */
function renderedSlugs(page: Page): Promise<string[]> {
  return page
    .locator(CARD_LINKS)
    .evaluateAll((links) => [
      ...new Set(links.map((a) => a.getAttribute('href')!.replace('/products/', ''))),
    ]);
}

/** Waits until the rendered rows are exactly `slugs`. */
async function expectRows(page: Page, slugs: string[], when: string): Promise<void> {
  await expect.poll(() => renderedSlugs(page), { message: when, timeout: 15_000 }).toEqual(slugs);
}

const loadMore = (page: Page) => page.locator('aec-pagination-footer a', { hasText: 'Load more' });

/** Opens a listing URL as a full load, waits until it is hydrated, and marks the document. */
async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  await untilHydrated(page.locator('aec-listing-toolbar button[role="combobox"]'));
  await page.evaluate(
    (key) => ((window as unknown as Record<string, unknown>)[key] = true),
    DOC_MARKER,
  );
}

/** True while the page is still the document `open` marked: every step was a client navigation. */
function sameDocument(page: Page): Promise<boolean> {
  return page.evaluate(
    (key) => (window as unknown as Record<string, unknown>)[key] === true,
    DOC_MARKER,
  );
}

/** Clicks the header "Browse" link to `/products` as a reader would. */
async function clickHeaderBrowse(page: Page): Promise<void> {
  const link = page.locator('header a[href="/products"]').first();
  await untilHydrated(link);
  await link.click();
  await expect(page).toHaveURL(/\/products$/);
}

/**
 * A client navigation to `url` that keeps the listing component. No in-app
 * link goes to `?page=N` without "Load more" intercepting it, so this pushes
 * the URL and lets the app's router handle the `popstate`, as it does for Back.
 */
async function clientNavigate(page: Page, url: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(null, '', to);
    dispatchEvent(new PopStateEvent('popstate', { state: null }));
  }, url);
}

test.describe('the listing follows ?page= on every navigation (AECI-1902)', () => {
  test('/products?page=2, then the header "Browse" link: page 1, "Load more", at the top', async ({
    page,
  }) => {
    const one = await apiPage(page, 1);
    test.skip(one.total <= PER_PAGE, 'the catalogue has no second page in this environment');
    const two = await apiPage(page, 2);

    await open(page, '/products?page=2');
    await expectRows(page, two.slugs, 'the server renders page 2');
    // Scroll down first, so landing at the top is the navigation's doing.
    await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' as ScrollBehavior }));

    await clickHeaderBrowse(page);
    await expectRows(page, one.slugs, 'page 1 after the header link');
    await expect(loadMore(page)).toHaveCount(1);
    await expect(loadMore(page)).toHaveAttribute('href', /[?&]page=2(?:&|$)/);
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(0);
    expect(await sameDocument(page), 'the header link is a client navigation').toBe(true);
  });

  test('/products, then a client navigation to ?page=2: page 2 rows', async ({ page }) => {
    const one = await apiPage(page, 1);
    test.skip(one.total <= PER_PAGE, 'the catalogue has no second page in this environment');
    const two = await apiPage(page, 2);

    await open(page, '/products');
    await expectRows(page, one.slugs, 'page 1');
    await clientNavigate(page, '/products?page=2');
    await expectRows(page, two.slugs, 'page 2 after the client navigation');
    expect(await sameDocument(page)).toBe(true);
  });

  test('/products?page=2, "Load more" to page 3, then the header link: page 1 only', async ({
    page,
  }) => {
    const one = await apiPage(page, 1);
    test.skip(one.total <= 2 * PER_PAGE, 'the catalogue has no third page in this environment');
    const two = await apiPage(page, 2);
    const three = await apiPage(page, 3);

    await open(page, '/products?page=2');
    await expectRows(page, two.slugs, 'page 2');
    await untilHydrated(loadMore(page));
    await loadMore(page).click();
    await expectRows(page, [...two.slugs, ...three.slugs], 'pages 2 and 3');

    await clickHeaderBrowse(page);
    await expectRows(page, one.slugs, 'page 1 only after the header link');
    await expect(loadMore(page)).toHaveCount(1);
    expect(await sameDocument(page)).toBe(true);
  });

  test('a term page at ?page=2, then the bare term: page 1; Back: page 2', async ({ page }) => {
    const taxonomy = (await (await page.request.get('/api/taxonomy')).json()) as {
      categories: { slug: string; product_count: number }[];
    };
    const term = taxonomy.categories
      .filter((c) => c.product_count > PER_PAGE)
      .sort((a, b) => b.product_count - a.product_count || (a.slug < b.slug ? -1 : 1))[0];
    test.skip(!term, 'no category has a second page in this environment');
    const query = `&category_slug=${term!.slug}`;
    const one = await apiPage(page, 1, query);
    const two = await apiPage(page, 2, query);

    await open(page, `/categories/${term!.slug}?page=2`);
    await expectRows(page, two.slugs, 'the server renders the term page 2');
    await clientNavigate(page, `/categories/${term!.slug}`);
    await expectRows(page, one.slugs, 'term page 1 after dropping ?page=');
    await expect(loadMore(page)).toHaveCount(1);

    await page.goBack();
    await expect(page).toHaveURL(/[?&]page=2(?:&|$)/);
    await expectRows(page, two.slugs, 'Back to term page 2');
    expect(await sameDocument(page)).toBe(true);
  });

  test('Back and Forward between ?page=2 and /products restore the right rows', async ({
    page,
  }) => {
    const one = await apiPage(page, 1);
    test.skip(one.total <= PER_PAGE, 'the catalogue has no second page in this environment');
    const two = await apiPage(page, 2);

    await open(page, '/products?page=2');
    await expectRows(page, two.slugs, 'page 2');
    await clickHeaderBrowse(page);
    await expectRows(page, one.slugs, 'page 1');

    await page.goBack();
    await expect(page).toHaveURL(/\/products\?page=2$/);
    await expectRows(page, two.slugs, 'Back to page 2');
    await page.goForward();
    await expect(page).toHaveURL(/\/products$/);
    await expectRows(page, one.slugs, 'Forward to page 1');
    expect(await sameDocument(page)).toBe(true);
  });
});

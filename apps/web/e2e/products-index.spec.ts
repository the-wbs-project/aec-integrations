import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';

import { chooseSort, chooseView } from './listing-toolbar';

// AECI-58 / Phase 2.12 — paginated product index at /products. Redesigned in
// AECI-190: a buyer-facing card grid (default) + a table view, switched by a
// toolbar toggle, with a sort dropdown. Verifies the page renders SSR-side with
// the right title, breadcrumbs, and toolbar, and that the sort, view, and
// pagination controls update the URL. The cache headers live in facets.spec.ts
// and the product click-through in client-nav-detail.spec.ts.
//
// The spec is resilient to a populated or empty local DB. Sort/view URL behavior
// is exercised even when no products are seeded; the table render is only
// asserted when at least one product is present.

test.describe('/products — product index (AECI-58)', () => {
  test('renders SSR HTML with title, breadcrumbs, and the view toolbar', async ({ request }) => {
    const res = await request.get('/products');
    expect(res.status(), 'GET /products must return 200').toBe(200);
    const html = await res.text();

    // Title carries the i18n "Products · AEC Integrations" form.
    expect(html, '<title> must include "Products · AEC Integrations"').toMatch(
      /<title[^>]*>[^<]*Products[^<]*· AEC Integrations[^<]*<\/title>/i,
    );

    // Canonical is self-referential — the serving origin, not a hardcoded apex (ADR 0011).
    // Bare /products URL, no query params.
    const origin = new URL(res.url()).origin;
    const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/)?.[1];
    expect(canonical, 'canonical <link> must point at /products on the serving origin').toBe(
      `${origin}/products`,
    );

    // og:type for an index page must be "website", not "article".
    expect(html, 'og:type must be "website" for an index page').toMatch(
      /<meta[^>]+property="og:type"[^>]+content="website"/,
    );

    // Page chrome: breadcrumb + heading rendered SSR-side.
    expect(html).toMatch(/<h1[^>]*>[^<]*Products[^<]*<\/h1>/i);
    expect(html, 'breadcrumb nav must mention Home and Products').toMatch(/Home/);

    // The toolbar renders regardless of data: the sort combobox + the view toggle.
    expect(html, 'sort dropdown must render').toMatch(/<button[^>]+id="aec-listing-sort-0"/);
    expect(html, 'view toggle buttons must render (aria-pressed)').toMatch(/aria-pressed/);
  });

  // AECI-803 — page 2+ self-canonicalises rather than pointing back at page 1.
  // Data-independent: the canonical is composed from the URL, so this holds on an
  // empty local DB as well as a seeded one.
  test('page 2 self-canonicalises; a facet filter still canonicalises to /products', async ({
    request,
  }) => {
    const paged = await request.get('/products?page=2');
    expect(paged.status()).toBe(200);
    const pagedOrigin = new URL(paged.url()).origin;
    const pagedHtml = await paged.text();
    expect(
      pagedHtml.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/)?.[1],
      'canonical on ?page=2 must self-reference, not point at page 1',
    ).toBe(`${pagedOrigin}/products?page=2`);

    // Facets stay stripped: their controls emit no `href`, so those URLs are not
    // crawlable and must not become canonical targets.
    const faceted = await request.get('/products?category_id=00000000-0000-4000-8000-000000030001');
    expect(faceted.status()).toBe(200);
    const facetedOrigin = new URL(faceted.url()).origin;
    const facetedHtml = await faceted.text();
    expect(facetedHtml.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/)?.[1]).toBe(
      `${facetedOrigin}/products`,
    );
  });

  // The §8.3 cache headers on bare /products are asserted by facets.spec.ts
  // "distinct facet URLs are independently cacheable with an identical Cache-Tag"
  // (AECI-2027 removed the copy that lived here).

  test('has zero axe AA violations', async ({ page }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });

  // AECI-2027 merged the sort and view tests. Both loaded /products and only
  // drove the toolbar. The sort runs first, then the view toggle.
  test('the sort dropdown updates ?sort= in the URL and reflects the choice', async ({ page }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    await chooseSort(page, 'name');

    await test.step('the view toggle switches between cards and table and reflects ?view=', async () => {
      await chooseView(page, 'Table');
      // The table only renders when products are present; assert it when there is data.
      const hasProducts = (await page.locator('#main a[href^="/products/"]').count()) > 0;
      if (hasProducts) {
        await expect(page.locator('table[aria-label="Products"]')).toBeVisible();
      }

      await chooseView(page, 'Cards');
      await expect(page.locator('table[aria-label="Products"]')).toHaveCount(0);
    });
  });

  test("Pagination footer 'Load more' is the no-JS page-2 floor and appends in place (AECI-328)", async ({
    page,
  }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    // AECI-328 replaced the prev/next Paginator with an append-mode footer: a
    // real `?page=N+1` anchor (the no-JS / crawler floor) that JS intercepts to
    // append the next page in place. The link only renders when a second page
    // exists — self-skip otherwise (no data, or a single page in this DB).
    const loadMore = page.getByRole('link', { name: 'Load more' });
    test.skip(
      (await loadMore.count()) === 0,
      'fewer than two pages of products in this environment',
    );

    // The link is the de-emphasised a11y/SEO floor: a genuine ?page=2 href.
    await expect(loadMore).toHaveAttribute('href', /[?&]page=2(?:&|$)/);

    // Clicking appends in place — the page count stays OUT of the URL (append
    // mode), unlike the removed Paginator which advanced `?page=`.
    const before = await page.locator('#main a[href^="/products/"]').count();
    await loadMore.click();
    await expect(page).not.toHaveURL(/[?&]page=/);
    await expect
      .poll(() => page.locator('#main a[href^="/products/"]').count())
      .toBeGreaterThan(before);
  });

  // The product-card click-through to /products/:slug is asserted by
  // client-nav-detail.spec.ts "clicking through product → vendor renders the vendor,
  // not the 404 shell" (AECI-2027 removed the copy that lived here).
});

function formatViolations(
  violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations'],
): string {
  if (violations.length === 0) return '';
  return violations
    .map(
      (v) =>
        `[${v.impact ?? '?'}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n` +
        v.nodes.map((n) => `  - ${n.target.join(', ')}\n    ${n.failureSummary ?? ''}`).join('\n'),
    )
    .join('\n\n');
}

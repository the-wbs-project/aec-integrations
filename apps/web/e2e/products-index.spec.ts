import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// AECI-58 / Phase 2.12 — paginated product index at /products. Redesigned in
// AECI-190: a buyer-facing card grid (default) + a table view, switched by a
// toolbar toggle, with a sort dropdown. Verifies the page renders SSR-side with
// the right title, breadcrumbs, cache headers, and toolbar; that the sort, view,
// and pagination controls update the URL; and that a product link resolves to a
// /products/:slug URL.
//
// The spec is resilient to a populated or empty local DB. Sort/view URL behavior
// is exercised even when no products are seeded; link navigation and the table
// render are only asserted when at least one product is present.

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

    // The toolbar renders regardless of data: a sort <select> + the view toggle.
    expect(html, 'sort dropdown must render').toMatch(/<select[^>]+id="aec-products-sort"/);
    expect(html, 'view toggle buttons must render (aria-pressed)').toMatch(/aria-pressed/);
  });

  test('emits §8.3 cache headers — s-maxage=300, max-age=0, Cache-Tag for /products', async ({
    request,
  }) => {
    const res = await request.get('/products');
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `Cache-Control must include s-maxage=300; got: ${cacheControl}`).toContain(
      's-maxage=300',
    );
    expect(cacheControl, `Cache-Control must include max-age=0; got: ${cacheControl}`).toContain(
      'max-age=0',
    );

    const cacheTag = res.headers()['cache-tag'] ?? '';
    expect(cacheTag, `Cache-Tag must include route:index; got: ${cacheTag}`).toContain(
      'route:index',
    );
    expect(cacheTag, `Cache-Tag must include index:products; got: ${cacheTag}`).toContain(
      'index:products',
    );
  });

  test('has zero axe AA violations', async ({ page }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });

  test('the sort dropdown updates ?sort= in the URL and reflects the choice', async ({ page }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const sort = page.locator('#aec-products-sort');
    await expect(sort).toBeVisible();
    await sort.selectOption('name');

    await expect(page).toHaveURL(/\?.*sort=name/);
    await expect(sort).toHaveValue('name');
  });

  test('the view toggle switches between cards and table and reflects ?view=', async ({ page }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    await page.getByRole('button', { name: 'Table' }).click();
    await expect(page).toHaveURL(/\?.*view=table/);
    // The table only renders when products are present; assert it when there is data.
    const hasProducts = (await page.locator('#main a[href^="/products/"]').count()) > 0;
    if (hasProducts) {
      await expect(page.locator('table[aria-label="Products"]')).toBeVisible();
    }

    await page.getByRole('button', { name: 'Cards' }).click();
    await expect(page).toHaveURL(/\?.*view=cards/);
    await expect(page.locator('table[aria-label="Products"]')).toHaveCount(0);
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

  test('clicking a product card navigates to /products/:slug', async ({ page }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const firstProductLink = page.locator('#main a[href^="/products/"]').first();
    const exists = (await firstProductLink.count()) > 0;
    test.skip(!exists, 'no products seeded in this environment');

    const href = await firstProductLink.getAttribute('href');
    expect(href, 'product link must point at /products/:slug').toMatch(/^\/products\/[^/]+$/);
    await firstProductLink.click();
    await expect(page).toHaveURL(/\/products\/[^/]+$/);
  });
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

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// AECI-58 / Phase 2.12 — paginated product index at /products.
// Verifies the page renders SSR-side with the right title, breadcrumbs,
// cache headers, and an accessible table; that the sort and pagination
// controls update the URL; and that the product-card click target resolves
// to a /products/:slug URL.
//
// The spec is resilient to a populated or empty local DB. Sort and
// pagination URL behavior is exercised even when no products are seeded
// (clicking the Name header still produces ?sort=name). Card-link
// navigation is only asserted when at least one product row is rendered.

test.describe('/products — product index (AECI-58)', () => {
  test('renders SSR HTML with title, breadcrumbs, and the products table', async ({ request }) => {
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

    // The products table is present (IndexLayout shell).
    expect(html, '<table> with the index aria-label must render').toMatch(
      /<table[^>]+aria-label[^>]*>/,
    );
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

  test('sorting by Name updates ?sort=name in the URL', async ({ page }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    // Find the sortable header button labeled "Name".
    const nameHeader = page.locator('aec-sortable-column-header button', { hasText: 'Name' });
    await expect(nameHeader).toBeVisible();
    await nameHeader.click();

    await expect(page).toHaveURL(/\?.*sort=name/);

    // The column's `<th>` should reflect the active state via aria-sort.
    // Per Phase 2 Spec §7.4 / `apps/api/src/lib/sort.ts:resolveProductSort`,
    // the `name` sort key is fixed to ascending direction — the column header
    // for Name renders with `direction="ascending"` (see `products-index.ts`).
    await expect(page.locator('th[aria-sort="ascending"]')).toBeVisible();
  });

  test('Pagination Next button advances ?page= when more than one page exists', async ({
    page,
  }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const nextButton = page.getByRole('button', { name: 'Next page' });
    const rendered = (await nextButton.count()) > 0;
    test.skip(!rendered, 'paginator not rendered (no data or local DB unconfigured)');

    const enabled = await nextButton.isEnabled();
    test.skip(!enabled, 'fewer than two pages of products in this environment');

    await nextButton.click();
    await expect(page).toHaveURL(/\?.*page=2/);
  });

  test('clicking a product card navigates to /products/:slug', async ({ page }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const firstProductLink = page.locator('tr[aec-product-card] a[href^="/products/"]').first();
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

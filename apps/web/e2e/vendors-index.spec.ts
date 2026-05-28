import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// AECI-59 / Phase 2.13 — paginated vendor index at /vendors.
// Verifies the page renders SSR-side with the right title, breadcrumbs,
// cache headers, and an accessible table; that the sort and pagination
// controls update the URL; and that the vendor-card click target resolves
// to a /vendors/:slug URL.
//
// The spec is resilient to a populated or empty local DB. Sort and
// pagination URL behavior is exercised even when no vendors are seeded
// (clicking the Name header still produces ?sort=name). Card-link
// navigation is only asserted when at least one vendor row is rendered.

test.describe('/vendors — vendor index (AECI-59)', () => {
  test('renders SSR HTML with title, breadcrumbs, and the vendors table', async ({ request }) => {
    const res = await request.get('/vendors');
    expect(res.status(), 'GET /vendors must return 200').toBe(200);
    const html = await res.text();

    // Title carries the i18n "Vendors — AEC Integrations" form.
    expect(html, '<title> must include "Vendors — AEC Integrations"').toMatch(
      /<title[^>]*>[^<]*Vendors[^<]*— AEC Integrations[^<]*<\/title>/i,
    );

    // Canonical link is set to the bare /vendors URL (no query params).
    expect(html, 'canonical <link> must point at /vendors').toMatch(
      /<link[^>]+rel="canonical"[^>]+href="https:\/\/aecintegrations\.com\/vendors"/,
    );

    // og:type for an index page must be "website", not "article".
    expect(html, 'og:type must be "website" for an index page').toMatch(
      /<meta[^>]+property="og:type"[^>]+content="website"/,
    );

    // Page chrome: breadcrumb + heading rendered SSR-side.
    expect(html).toMatch(/<h1[^>]*>[^<]*Vendors[^<]*<\/h1>/i);
    expect(html, 'breadcrumb nav must mention Home and Vendors').toMatch(/Home/);

    // The vendors table is present (IndexLayout shell).
    expect(html, '<table> with the index aria-label must render').toMatch(
      /<table[^>]+aria-label[^>]*>/,
    );
  });

  test('emits §8.3 cache headers — s-maxage=300, max-age=0, Cache-Tag for /vendors', async ({
    request,
  }) => {
    const res = await request.get('/vendors');
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
    expect(cacheTag, `Cache-Tag must include index:vendors; got: ${cacheTag}`).toContain(
      'index:vendors',
    );
  });

  test('has zero axe AA violations', async ({ page }) => {
    await page.goto('/vendors');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });

  test('sorting by Name updates ?sort=name in the URL', async ({ page }) => {
    await page.goto('/vendors');
    await expect(page.locator('app-root')).toBeAttached();

    const nameHeader = page.locator('aec-sortable-column-header button', { hasText: 'Name' });
    await expect(nameHeader).toBeVisible();
    await nameHeader.click();

    await expect(page).toHaveURL(/\?.*sort=name/);

    // Per Phase 2 Spec §7.4 / `apps/api/src/lib/sort.ts:resolveVendorSort`,
    // the `name` sort key is fixed to ascending direction.
    await expect(page.locator('th[aria-sort="ascending"]')).toBeVisible();
  });

  test('Pagination Next button advances ?page= when more than one page exists', async ({
    page,
  }) => {
    await page.goto('/vendors');
    await expect(page.locator('app-root')).toBeAttached();

    const nextButton = page.getByRole('button', { name: 'Next page' });
    const rendered = (await nextButton.count()) > 0;
    test.skip(!rendered, 'paginator not rendered (no data or local DB unconfigured)');

    const enabled = await nextButton.isEnabled();
    test.skip(!enabled, 'fewer than two pages of vendors in this environment');

    await nextButton.click();
    await expect(page).toHaveURL(/\?.*page=2/);
  });

  test('clicking a vendor card navigates to /vendors/:slug', async ({ page }) => {
    await page.goto('/vendors');
    await expect(page.locator('app-root')).toBeAttached();

    const firstVendorLink = page.locator('tr[aec-vendor-card] a[href^="/vendors/"]').first();
    const exists = (await firstVendorLink.count()) > 0;
    test.skip(!exists, 'no vendors seeded in this environment');

    const href = await firstVendorLink.getAttribute('href');
    expect(href, 'vendor link must point at /vendors/:slug').toMatch(/^\/vendors\/[^/]+$/);
    await firstVendorLink.click();
    await expect(page).toHaveURL(/\/vendors\/[^/]+$/);
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

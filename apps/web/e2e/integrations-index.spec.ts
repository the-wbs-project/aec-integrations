import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// AECI-60 / Phase 2.14 — integration index at /integrations.
// Verifies SSR render (title, breadcrumbs, sortable table), §8.3 cache
// headers, sort + filter URL behavior, and axe AA. Resilient to a populated
// or empty local DB: the sort/filter URL assertions don't depend on seeded
// rows (a raw UUID typed into the filter resolves without a product lookup),
// and card-link navigation is only asserted when a row is present.

test.describe('/integrations — integration index (AECI-60)', () => {
  test('renders SSR HTML with title, breadcrumbs, and the integrations table', async ({
    request,
  }) => {
    const res = await request.get('/integrations');
    expect(res.status(), 'GET /integrations must return 200').toBe(200);
    const html = await res.text();

    expect(html, '<title> must include "Integrations — AEC Integrations"').toMatch(
      /<title[^>]*>[^<]*Integrations[^<]*— AEC Integrations[^<]*<\/title>/i,
    );
    expect(html, 'canonical <link> must point at /integrations').toMatch(
      /<link[^>]+rel="canonical"[^>]+href="https:\/\/aecintegrations\.com\/integrations"/,
    );
    expect(html, 'og:type must be "website" for an index page').toMatch(
      /<meta[^>]+property="og:type"[^>]+content="website"/,
    );
    expect(html).toMatch(/<h1[^>]*>[^<]*Integrations[^<]*<\/h1>/i);
    expect(html, 'breadcrumb nav must mention Home').toMatch(/Home/);
    expect(html, '<table> with the index aria-label must render').toMatch(
      /<table[^>]+aria-label[^>]*>/,
    );
  });

  test('emits §8.3 cache headers — s-maxage=300, max-age=0, Cache-Tag for /integrations', async ({
    request,
  }) => {
    const res = await request.get('/integrations');
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl).toContain('s-maxage=300');
    expect(cacheControl).toContain('max-age=0');

    const cacheTag = res.headers()['cache-tag'] ?? '';
    expect(cacheTag).toContain('route:index');
    expect(cacheTag).toContain('index:integrations');
  });

  test('has zero axe AA violations', async ({ page }) => {
    await page.goto('/integrations');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });

  test('sorting by Integration updates ?sort=name in the URL', async ({ page }) => {
    await page.goto('/integrations');
    await expect(page.locator('app-root')).toBeAttached();

    const nameHeader = page.locator('aec-sortable-column-header button', {
      hasText: 'Integration',
    });
    await expect(nameHeader).toBeVisible();
    await nameHeader.click();

    await expect(page).toHaveURL(/\?.*sort=name/);
    await expect(page.locator('th[aria-sort="ascending"]')).toBeVisible();
  });

  test('applying a product UUID in the source filter updates ?sourceProductId in the URL', async ({
    page,
  }) => {
    await page.goto('/integrations');
    await expect(page.locator('app-root')).toBeAttached();

    // A raw UUID is used directly (no slug→ID lookup needed), so this assertion
    // is independent of whether the product exists in the local DB.
    const uuid = '00000000-0000-4000-8000-000000020001';
    await page.locator('#filter-source').fill(uuid);
    await page.getByRole('button', { name: 'Apply' }).click();

    await expect(page).toHaveURL(new RegExp(`sourceProductId=${uuid}`));
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

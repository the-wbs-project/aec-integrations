import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// AECI-61 / Phase 2.15 — `/categories` flat list (every category with product
// counts, rendered as an editorial card grid). Verifies SSR render (title,
// canonical, breadcrumb), the §4 cache headers/tags, accessibility, and that a
// category card navigates to its `/categories/:slug` browse page.
//
// Resilient to a populated or empty local DB: card-navigation and count
// assertions only run when at least one category is seeded.

test.describe('/categories — category index (AECI-61)', () => {
  test('renders SSR HTML with title, canonical, breadcrumb, and the heading', async ({
    request,
  }) => {
    const res = await request.get('/categories');
    expect(res.status(), 'GET /categories must return 200').toBe(200);
    const html = await res.text();

    expect(html, '<title> must include "Categories · AEC Integrations"').toMatch(
      /<title[^>]*>[^<]*Categories[^<]*· AEC Integrations[^<]*<\/title>/i,
    );
    // Canonical is self-referential — the serving origin, not a hardcoded apex (ADR 0011).
    const origin = new URL(res.url()).origin;
    const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/)?.[1];
    expect(canonical, 'canonical <link> must point at /categories on the serving origin').toBe(
      `${origin}/categories`,
    );
    // Index page → og:type "website", not "article".
    expect(html, 'og:type must be "website" for an index page').toMatch(
      /<meta[^>]+property="og:type"[^>]+content="website"/,
    );
    expect(html).toMatch(/<h1[^>]*>[^<]*Categories[^<]*<\/h1>/i);
    expect(html, 'breadcrumb must mention Home').toMatch(/Home/);
  });

  test('emits §4 cache headers — s-maxage=300, max-age=0, Cache-Tag route:index,index:categories,taxonomy', async ({
    request,
  }) => {
    const res = await request.get('/categories');
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=300');
    expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=0');

    const cacheTag = res.headers()['cache-tag'] ?? '';
    expect(cacheTag, `got: ${cacheTag}`).toContain('route:index');
    expect(cacheTag, `got: ${cacheTag}`).toContain('index:categories');
    expect(cacheTag, `got: ${cacheTag}`).toContain('taxonomy');
  });

  test('lists every category with a product count', async ({ page, request }) => {
    const taxonomy = (await (await request.get('/api/taxonomy')).json()) as {
      categories: Array<{ slug: string }>;
    };
    test.skip(taxonomy.categories.length === 0, 'no categories seeded in this environment');

    await page.goto('/categories');
    await expect(page.locator('app-root')).toBeAttached();

    const cards = page.locator('a[href^="/categories/"]');
    await expect(cards).toHaveCount(taxonomy.categories.length);
    // Each card shows its product count (the i18n "N products" label).
    await expect(cards.first()).toContainText(/\bproducts\b/);
  });

  test('clicking a category card navigates to /categories/:slug', async ({ page }) => {
    await page.goto('/categories');
    await expect(page.locator('app-root')).toBeAttached();

    const firstCard = page.locator('a[href^="/categories/"]').first();
    test.skip((await firstCard.count()) === 0, 'no categories seeded in this environment');

    const href = await firstCard.getAttribute('href');
    expect(href, 'card link must point at /categories/:slug').toMatch(/^\/categories\/[^/]+$/);
    await firstCard.click();
    await expect(page).toHaveURL(/\/categories\/[^/]+$/);
  });

  test('has zero axe AA violations', async ({ page }) => {
    await page.goto('/categories');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toEqual([]);
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

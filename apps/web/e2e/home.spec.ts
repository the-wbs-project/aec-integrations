import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// AECI-184 — Phase 4.9 home "Browse by" grids. Three count-chip subsections
// (category / audience / project phase) reading the LIVE aggregate taxonomy
// (`GET /api/taxonomy`, resolved SSR-side), each chip linking to its
// `/{segment}/:slug` browse page, plus a "View all" link to the facet index.
// Verifies SSR render, the §4 home cache headers/tags (s-maxage=900,
// route:index + taxonomy), live counts, navigation, and accessibility.
//
// Resilient to a populated or empty local DB: count/navigation assertions only
// run when at least one term is seeded for that facet.

interface Facet {
  segment: 'categories' | 'audiences' | 'phases';
  /** Key into `GET /api/taxonomy`. */
  apiKey: 'categories' | 'audiences' | 'phases';
  heading: string;
  /** Top-N cap the home applies (categories/audiences), or null for "show all". */
  cap: number | null;
}

const FACETS: Facet[] = [
  { segment: 'categories', apiKey: 'categories', heading: 'Browse by category', cap: 10 },
  { segment: 'audiences', apiKey: 'audiences', heading: 'Browse by audience', cap: 10 },
  { segment: 'phases', apiKey: 'phases', heading: 'Browse by project phase', cap: null },
];

test.describe('/ — home "Browse by" grids (AECI-184)', () => {
  test('SSR-renders the three browse headings', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status(), 'GET / must return 200').toBe(200);
    const html = await res.text();
    for (const facet of FACETS) {
      expect(html, `SSR HTML must include "${facet.heading}"`).toContain(facet.heading);
    }
  });

  test('emits §4 home cache headers — public, max-age=300, s-maxage=900, Cache-Tag route:index,taxonomy', async ({
    request,
  }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=900');
    expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=300');

    const cacheTag = res.headers()['cache-tag'] ?? '';
    expect(cacheTag, `got: ${cacheTag}`).toContain('route:index');
    expect(cacheTag, `got: ${cacheTag}`).toContain('taxonomy');
  });

  for (const facet of FACETS) {
    test(`${facet.segment}: renders top chips with live counts linking to browse pages`, async ({
      page,
      request,
    }) => {
      const taxonomy = (await (await request.get('/api/taxonomy')).json()) as Record<
        string,
        Array<{ slug: string }>
      >;
      const terms = taxonomy[facet.apiKey] ?? [];
      test.skip(terms.length === 0, `no ${facet.segment} seeded in this environment`);

      const expected = facet.cap === null ? terms.length : Math.min(terms.length, facet.cap);

      await page.goto('/');
      await expect(page.locator('app-root')).toBeAttached();

      // Scope to the browse-grid `<ul>` inside <main id="main">: the chips are
      // `ul li a`, whereas the same `/{segment}/:slug` links also appear in the
      // global header flyout (AECI-155, outside #main) and the hero "Popular:"
      // row (AECI-182, a `<p>` that hydrates in post-SSR) — both are excluded by
      // the `ul` scope. The "View all" link is `/{segment}` (no slug) so it too
      // is excluded.
      const chips = page.locator(`#main ul a[href^="/${facet.segment}/"]`);
      await expect(chips).toHaveCount(expected);
      // Each chip shows a numeric product count ("{name} {count}").
      await expect(chips.first()).toContainText(/\d/);
    });

    test(`${facet.segment}: "View all" links to the facet index`, async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('app-root')).toBeAttached();

      const viewAll = page.locator(`#main a[href="/${facet.segment}"]`);
      await expect(viewAll).toHaveCount(1);
      await viewAll.click();
      await expect(page).toHaveURL(new RegExp(`/${facet.segment}$`));
    });
  }

  test('clicking a chip navigates to its browse page', async ({ page, request }) => {
    const taxonomy = (await (await request.get('/api/taxonomy')).json()) as Record<
      string,
      Array<{ slug: string }>
    >;
    test.skip(
      (taxonomy['categories'] ?? []).length === 0,
      'no categories seeded in this environment',
    );

    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();

    // `ul` scope so we click a browse-grid chip, not a hero "Popular:" link.
    const firstChip = page.locator('#main ul a[href^="/categories/"]').first();
    const href = await firstChip.getAttribute('href');
    expect(href, 'chip must link to /categories/:slug').toMatch(/^\/categories\/[^/]+$/);
    await firstChip.click();
    await expect(page).toHaveURL(/\/categories\/[^/]+$/);
  });

  test('has zero axe AA violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });
});

// AECI-186 — Phase 4.11 home assembly. The six section components (hero / stats
// cards / browse grids / recently-added / trending) are stacked in §4.1 order and
// the home SEO (meta + OG/Twitter + WebSite/Organization JSON-LD + canonical) is
// emitted. The axe coverage above runs against `/`, so it now also validates
// these added sections — no duplicate axe pass is needed here.
//
// Resilient to a populated or empty stats_cache: assertions key off the labels /
// headings that render in BOTH the data and empty states, never the data itself.
test.describe('/ — home assembly (AECI-186)', () => {
  test('SSR-renders the stats / recently-added / trending sections', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status(), 'GET / must return 200').toBe(200);
    const html = await res.text();

    // Stats card label + recent-integrations heading render in every data state.
    expect(html, 'stats cards must render').toContain('Total integrations indexed');
    expect(html, 'recently-added section must render').toContain('Recently added integrations');
    // Trending heading is one of: trending / recently-added fallback / empty note.
    const trendingRendered =
      html.includes('Trending products this week') ||
      html.includes('Recently added products') ||
      html.includes('Trending lands once we have product view data');
    expect(trendingRendered, 'trending section must render in some state').toBe(true);
  });

  test('stacks the sections in §4.1 order', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const order = [
      'aec-home-hero',
      'aec-home-credibility-strip',
      'aec-home-stats-cards',
      'app-browse-grid',
      'aec-recent-integrations-section',
      'aec-trending-products-section',
    ].map((tag) => html.indexOf(tag));

    for (const [i, pos] of order.entries()) {
      expect(pos, `section ${i} must be present in SSR HTML`).toBeGreaterThan(-1);
      if (i > 0) {
        expect(pos, `section ${i} must follow section ${i - 1} in §4.1 order`).toBeGreaterThan(
          order[i - 1],
        );
      }
    }
  });

  test('emits home SEO — title, description, canonical, website OG type', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/AEC Integrations/);

    await expect(page.locator('head meta[name="description"]')).toHaveAttribute(
      'content',
      /independent directory/,
    );

    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveCount(1);
    await expect(canonical).toHaveAttribute('href', /\/$/);

    await expect(page.locator('head meta[property="og:type"]')).toHaveAttribute(
      'content',
      'website',
    );
  });

  test('emits WebSite (with SearchAction) and publisher Organization JSON-LD', async ({ page }) => {
    await page.goto('/');

    const website = page.locator('script[data-aeci-jsonld="website"]');
    await expect(website).toHaveCount(1);
    const websiteLd = JSON.parse((await website.textContent()) ?? '{}');
    expect(websiteLd['@type']).toBe('WebSite');
    expect(websiteLd.potentialAction['@type']).toBe('SearchAction');
    expect(websiteLd.potentialAction.target).toContain('/search?q={search_term_string}');

    const org = page.locator('script[data-aeci-jsonld="organization"]');
    await expect(org).toHaveCount(1);
    const orgLd = JSON.parse((await org.textContent()) ?? '{}');
    expect(orgLd['@type']).toBe('Organization');
    expect(orgLd.name).toBe('AEC Integrations');
  });

  test('fires POST /api/page-views with route "/" on in-app navigation home', async ({ page }) => {
    // The SSR Worker counts the initial landing server-side (not browser-visible);
    // the client PageViewTracker counts subsequent in-app navigations. Land on
    // /products, then navigate home via the Primary-nav link and observe the POST.
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const homeLink = page.locator('nav[aria-label="Primary"] a[href="/"]').first();
    await expect(homeLink).toBeVisible();

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/api/page-views') && r.method() === 'POST'),
      homeLink.click(),
    ]);

    expect((req.postDataJSON() as { route?: string }).route).toBe('/');
    await expect(page).toHaveURL(/\/$/);
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

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// The home browse block (`home-browse-block.ts`): one "Browse the directory"
// section with four labelled count-chip rows (category, trade, project phase,
// audience) reading the LIVE aggregate taxonomy (`GET /api/taxonomy`, resolved
// SSR-side). Each chip links to its `/{segment}/:slug` browse page, and each row
// has a "View all" link to the facet index. Verifies SSR render, the §4 home
// cache headers/tags (s-maxage=900, route:index + taxonomy), live counts,
// navigation, and accessibility. The audience row is a curated role list,
// covered by its own describe block below.
//
// Resilient to a populated or empty local DB: count/navigation assertions only
// run when at least one term is seeded for that facet.

interface Facet {
  segment: 'categories' | 'trades' | 'phases';
  /** Key into `GET /api/taxonomy`. */
  apiKey: 'categories' | 'trades' | 'phases';
  viewAll: string;
  /** Top-N cap the home applies (categories, trades), or null for "show all". */
  cap: number | null;
  /** Trades only: the home drops terms below the publication floor (1 product). */
  publishedOnly?: boolean;
}

const FACETS: Facet[] = [
  { segment: 'categories', apiKey: 'categories', viewAll: 'View all categories', cap: 10 },
  {
    segment: 'trades',
    apiKey: 'trades',
    viewAll: 'View all trades',
    cap: 10,
    publishedOnly: true,
  },
  { segment: 'phases', apiKey: 'phases', viewAll: 'View all phases', cap: null },
];

test.describe('/ — home browse block', () => {
  test('SSR-renders one browse block with its four rows', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status(), 'GET / must return 200').toBe(200);
    const html = await res.text();
    expect(html, 'browse block heading').toContain('Browse the directory');
    for (const facet of FACETS) {
      expect(html, `SSR HTML must include "${facet.viewAll}"`).toContain(facet.viewAll);
    }
    expect(html, 'audience row').toContain('View all audiences');
    // One browse block: the retired per-facet headings and audience band are gone.
    expect(html).not.toContain('Browse by category');
    expect(html).not.toContain('Built for the people who choose and use AEC software');
  });

  test('emits §4 home cache headers — public, max-age=300, s-maxage=900, Cache-Tag route:index,index:home,taxonomy', async ({
    request,
  }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=900');
    expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=300');

    const cacheTag = res.headers()['cache-tag'] ?? '';
    expect(cacheTag, `got: ${cacheTag}`).toContain('route:index');
    // AECI-305 — the home page's per-promote purge handle for the stats refresh.
    expect(cacheTag, `got: ${cacheTag}`).toContain('index:home');
    expect(cacheTag, `got: ${cacheTag}`).toContain('taxonomy');
  });

  for (const facet of FACETS) {
    test(`${facet.segment}: renders top chips with live counts linking to browse pages`, async ({
      page,
      request,
    }) => {
      const taxonomy = (await (await request.get('/api/taxonomy')).json()) as Record<
        string,
        Array<{ slug: string; product_count: number }>
      >;
      const all = taxonomy[facet.apiKey] ?? [];
      const terms = facet.publishedOnly ? all.filter((t) => t.product_count >= 1) : all;
      test.skip(terms.length === 0, `no ${facet.segment} seeded in this environment`);

      const expected = facet.cap === null ? terms.length : Math.min(terms.length, facet.cap);

      await page.goto('/');
      await expect(page.locator('app-root')).toBeAttached();

      // Scope to the browse-grid `<ul>` inside <main id="main">: the chips are
      // `ul li a`, whereas the same `/{segment}/:slug` links also appear in the
      // global header flyout (AECI-155, outside #main), which the `#main ul`
      // scope excludes. The hero "Popular:" row links to products, not facets.
      // The "View all" link is `/{segment}` (no slug) so it too is excluded.
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

    // `ul` scope so we click a browse-grid chip, not a header flyout link.
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

// The audience row of the browse block: a curated list of nine roles, each
// mapped to an audience term and linking to `/audiences/:slug`. A role with no
// taxonomy term is not listed. Static + cache-neutral (no client state).
test.describe('/ — home browse block, audience row', () => {
  test('SSR-renders the audience lede', async ({ request }) => {
    const html = await (await request.get('/')).text();
    expect(html).toContain('justifying a decision to a steering committee');
  });

  test('links the nine mapped roles to their /audiences/:slug browse pages', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();
    // Scoped to `#main ul`: the same exclusion as the browse-grid chips (the
    // header flyout is outside this scope).
    const chips = page.locator('#main ul a[href^="/audiences/"]');
    await expect(chips).toHaveCount(9);
  });

  test('does not list a role that has no taxonomy term (Technology directors)', async ({
    request,
  }) => {
    const html = await (await request.get('/')).text();
    expect(html).not.toContain('Technology directors');
  });

  test('"View all audiences" links to the audience index', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();
    const viewAll = page.locator('#main a[href="/audiences"]');
    await expect(viewAll).toHaveCount(1);
    await viewAll.click();
    await expect(page).toHaveURL(/\/audiences$/);
  });
});

// Home assembly. Four bands, directory first: hero + credibility row, browse
// block, the argument (one evidence band, `aec-home-why`), then the closing CTA. The home SEO (meta + OG/Twitter +
// WebSite/Organization JSON-LD + canonical) is emitted. The axe coverage above
// runs against `/`, so it also validates every section; no duplicate axe pass is
// needed here.
//
// Resilient to a populated or empty stats_cache: assertions key off the labels /
// headings that render in BOTH the data and empty states, never the data itself.
test.describe('/ — home assembly', () => {
  test('SSR-renders the argument band and none of the retired bands', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status(), 'GET / must return 200').toBe(200);
    const html = await res.text();

    // The argument is one evidence band (AECI-1558), with the ideas row inside it.
    expect(html, 'argument band must render').toContain(
      'The way AEC firms find software is broken',
    );
    expect(html, 'ideas row must render').toContain('What we do instead');
    expect(html, 'merged bands are gone').not.toContain('aec-home-differentiation');
    expect(html, 'merged bands are gone').not.toContain('aec-home-how-it-works');
    // The stats cards are gone; the credibility row is the only figure row.
    expect(html, 'no stats cards').not.toContain('aec-home-stats-cards');
    // AECI-1573: the recent and trending card bands are gone in every data state.
    expect(html, 'no recent band').not.toContain('aec-recent-integrations-section');
    expect(html, 'no trending band').not.toContain('aec-trending-products-section');
    expect(html, 'no recent heading').not.toContain('Recently added integrations');
    expect(html, 'no trending heading').not.toContain('Trending products this week');
    expect(html, 'no recently-added heading').not.toContain('Recently added products');
  });

  test('stacks the sections directory first, argument after', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const order = [
      'aec-home-hero',
      'aec-home-credibility-strip',
      'aec-home-browse-block',
      'aec-home-why',
      'aec-home-closing-cta',
    ].map((tag) => html.indexOf(tag));

    for (const [i, pos] of order.entries()) {
      expect(pos, `section ${i} must be present in SSR HTML`).toBeGreaterThan(-1);
      if (i > 0) {
        expect(pos, `section ${i} must follow section ${i - 1}`).toBeGreaterThan(order[i - 1]);
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

    // The dedicated 1200×630 home share card (AECI-276), not the monogram
    // fallback. Match by path so the assertion is origin-agnostic across envs.
    await expect(page.locator('head meta[property="og:image"]')).toHaveAttribute(
      'content',
      /\/branding\/home-og\.png$/,
    );
    await expect(page.locator('head meta[name="twitter:image"]')).toHaveAttribute(
      'content',
      /\/branding\/home-og\.png$/,
    );
    await expect(page.locator('head meta[property="og:image:alt"]')).toHaveAttribute(
      'content',
      /.+/,
    );
  });

  test('serves the home OG share card asset (1200×630 PNG)', async ({ request }) => {
    const res = await request.get('/branding/home-og.png');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
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

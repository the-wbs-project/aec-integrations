import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { untilHydrated } from './hydration';
import { expectNoSidewaysScroll } from './no-sideways-scroll';

// The home browse block (`home-browse-block.ts`): one "Browse the directory"
// section with four labelled count-chip rows (category, trade, project phase,
// audience) reading the LIVE aggregate taxonomy (`GET /api/taxonomy`, resolved
// SSR-side). Each chip links to its `/{segment}/:slug` browse page, and each row
// has a "View all" link to the facet index. Verifies SSR render, the §4 home
// cache headers/tags (s-maxage=900, route:index + taxonomy), live counts,
// navigation, and accessibility. The audience row is a curated role list of nine
// roles linking to `/audiences/:slug`. A role with no taxonomy term is not listed.
// Its checks are steps in the merged tests below (AECI-2027).
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
  // AECI-2027: one request for the raw server HTML, one step per check. The steps
  // cover the browse block, the audience row and the home assembly.
  test('the server HTML of / carries the browse block, the audience row and the assembly', async ({
    request,
  }) => {
    const res = await request.get('/');
    const html = await res.text();

    await test.step('SSR-renders one browse block with its four rows', () => {
      expect(res.status(), 'GET / must return 200').toBe(200);
      expect(html, 'browse block heading').toContain('Browse the directory');
      for (const facet of FACETS) {
        expect(html, `SSR HTML must include "${facet.viewAll}"`).toContain(facet.viewAll);
      }
      expect(html, 'audience row').toContain('View all audiences');
      // One browse block: the retired per-facet headings and audience band are gone.
      expect(html).not.toContain('Browse by category');
      expect(html).not.toContain('Built for the people who choose and use AEC software');
    });

    await test.step('SSR-renders the audience lede', () => {
      expect(html).toContain('justifying a decision to a steering committee');
    });

    await test.step('does not list a role that has no taxonomy term (Technology directors)', () => {
      expect(html).not.toContain('Technology directors');
    });

    await test.step('SSR-renders the argument band and none of the retired bands', () => {
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

    await test.step('stacks the sections directory first, argument after', () => {
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

  // AECI-2027: one load of `/` at the default viewport, one step per read-only
  // check. A facet with no seeded terms skips its own step, and the skip shows as
  // an annotation in the report.
  test('the hydrated home page carries the browse chips, the audience row, the SEO and the JSON-LD', async ({
    page,
    request,
  }) => {
    const taxonomy = (await (await request.get('/api/taxonomy')).json()) as Record<
      string,
      Array<{ slug: string; product_count: number }>
    >;

    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();

    for (const facet of FACETS) {
      await test.step(`${facet.segment}: renders top chips with live counts linking to browse pages`, async (step) => {
        const all = taxonomy[facet.apiKey] ?? [];
        const terms = facet.publishedOnly ? all.filter((t) => t.product_count >= 1) : all;
        if (terms.length === 0) {
          test.info().annotations.push({
            type: 'skipped step',
            description: `no ${facet.segment} seeded in this environment`,
          });
        }
        step.skip(terms.length === 0, `no ${facet.segment} seeded in this environment`);

        const expected = facet.cap === null ? terms.length : Math.min(terms.length, facet.cap);

        // Scope to the browse-grid `<ul>` inside <main id="main">: the chips are
        // `ul li a`, whereas the same `/{segment}/:slug` links also appear in the
        // global header flyout (AECI-155, outside #main), which the `#main ul`
        // scope excludes. The hero "Largest categories" fallback links to
        // `/categories/:slug` too, but it is a `<p>`, not a `ul`, so it is excluded.
        // The "View all" link is `/{segment}` (no slug) so it too is excluded.
        const chips = page.locator(`#main ul a[href^="/${facet.segment}/"]`);
        await expect(chips).toHaveCount(expected);
        // A chip prints its count only above zero (§4.1 thin-corpus rule), and phases
        // keep lifecycle order, so the first chip can be a zero-count term. Check the
        // largest term: every facet's cap keeps it, and it prints whenever any count does.
        const largest = terms.reduce((a, b) => (b.product_count > a.product_count ? b : a));
        if (largest.product_count > 0) {
          await expect(
            page.locator(`#main ul a[href="/${facet.segment}/${largest.slug}"]`),
          ).toContainText(String(largest.product_count));
        }
      });
    }

    await test.step('links the nine mapped roles to their /audiences/:slug browse pages', async () => {
      // Scoped to `#main ul`: the same exclusion as the browse-grid chips (the
      // header flyout is outside this scope).
      const chips = page.locator('#main ul a[href^="/audiences/"]');
      await expect(chips).toHaveCount(9);
    });

    // AECI-2027: the four "View all" links are checked by href, not clicked. The test
    // "clicking a chip navigates to its browse page" proves a link in this block
    // navigates.
    for (const segment of [...FACETS.map((f) => f.segment), 'audiences']) {
      await test.step(`${segment}: "View all" links to the facet index`, async () => {
        await expect(page.locator(`#main a[href="/${segment}"]`)).toHaveCount(1);
      });
    }

    await test.step('emits home SEO — title, description, canonical, website OG type', async () => {
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

    await test.step('emits WebSite (with SearchAction) and publisher Organization JSON-LD', async () => {
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
  });

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

// Home assembly. Four bands, directory first: hero + credibility row, browse
// block, the argument (one evidence band, `aec-home-why`), then the closing CTA.
// The band order, the retired bands, the home SEO (meta + OG/Twitter + canonical)
// and the WebSite/Organization JSON-LD are steps in the merged tests at the top
// of this file (AECI-2027). The axe coverage above runs against `/`, so it also
// validates every section; no duplicate axe pass is needed here.
//
// Resilient to a populated or empty stats_cache: assertions key off the labels /
// headings that render in BOTH the data and empty states, never the data itself.
test.describe('/ — home assembly', () => {
  test('serves the home OG share card asset (1200×630 PNG)', async ({ request }) => {
    const res = await request.get('/branding/home-og.png');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
  });

  test('fires POST /api/page-views with route "/" on in-app navigation home', async ({ page }) => {
    // The SSR Worker counts the initial landing server-side (not browser-visible);
    // the client PageViewTracker counts subsequent in-app navigations. Land on
    // /products, then navigate home via the header wordmark (the row has no Home
    // link since AECI-1774) and observe the POST.
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const homeLink = page.locator('aec-site-header aec-brand-logo a[href="/"]').first();
    await expect(homeLink).toBeVisible();
    await untilHydrated(homeLink);

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/api/page-views') && r.method() === 'POST'),
      homeLink.click(),
    ]);

    expect((req.postDataJSON() as { route?: string }).route).toBe('/');
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe('/ — printed citations (AECI-1846, AECI-1792)', () => {
  // Measure settled geometry: focus navigation otherwise starts the home's smooth scroll.
  test.use({ reducedMotion: 'reduce' });

  for (const width of [320, 639, 640, 768, 1024]) {
    test(`prints every citation inside ${width}px with no sideways scroll`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const figures = page.getByTestId('home-why-figures');
      const citations = figures.getByTestId('home-why-citation');
      const links = figures.locator('a[target="_blank"]');
      await expect(citations).toHaveCount(3);
      await expect(links).toHaveCount(3);
      await page.evaluate(() => document.fonts.ready);
      // Mock-up 9 prints the citation: no tooltip, nothing to hover.
      await expect(figures.locator('[role="tooltip"]')).toHaveCount(0);

      await expectNoSidewaysScroll(page, 'no horizontal page scroll');

      for (let i = 0; i < 3; i++) {
        const citation = citations.nth(i);
        await citation.evaluate((el) =>
          el.scrollIntoView({ block: 'center', behavior: 'instant' }),
        );
        await expect(citation).toBeVisible();
        await expect(citation).toHaveCSS('opacity', '1');
        await expectCitationInsideViewport(citation);
      }

      // Reach all three Source links with real Tab presses.
      await links.first().focus();
      await page.keyboard.press('Shift+Tab');
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Tab');
        await expect(links.nth(i)).toBeFocused();
      }
    });
  }
});

async function expectCitationInsideViewport(citation: Locator): Promise<void> {
  const bounds = await citation.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: window.innerHeight,
      contentWidth: el.scrollWidth,
      availableWidth: el.clientWidth,
    };
  });
  expect(bounds.left, 'citation left edge').toBeGreaterThanOrEqual(0);
  expect(bounds.right, 'citation right edge').toBeLessThanOrEqual(bounds.viewportWidth);
  expect(bounds.top, 'citation top edge').toBeGreaterThanOrEqual(0);
  expect(bounds.bottom, 'citation bottom edge').toBeLessThanOrEqual(bounds.viewportHeight);
  expect(bounds.contentWidth, 'citation text must not be clipped horizontally').toBe(
    bounds.availableWidth,
  );
}

// AECI-1862, AECI-1792: the "Most viewed" row ships in the server HTML whichever
// list fills it, and its height is reserved, so the page does not move after load.
// The layout-shift check on `/` is in `first-paint.spec.ts` "no layout shift while
// the stylesheet is late (AECI-1854)", at 390px and 1440px with a stricter bound
// (AECI-2027).
test.describe('/ — the "Most viewed" row holds its place (AECI-1862)', () => {
  test('the server HTML carries the row with a label that states its order', async ({
    request,
  }) => {
    const [html, stats, taxonomy] = await Promise.all([
      request.get('/').then((r) => r.text()),
      request
        .get('/api/stats/home')
        .then((r) => r.json() as Promise<{ popular_products?: unknown[] }>),
      request.get('/api/taxonomy').then((r) => r.json() as Promise<{ categories?: unknown[] }>),
    ]);
    expect(html).toContain('data-testid="home-popular"');
    expect(html, 'the old unlabelled order is gone').not.toContain('Popular:');
    if ((stats.popular_products ?? []).length > 0) {
      expect(html).toContain('Most viewed, last 30 days:');
    } else if ((taxonomy.categories ?? []).length > 0) {
      expect(html).toContain('Largest categories:');
    }
  });
});

// AECI-830: a rotor or `NVDA+F7` list strips the surrounding card, so each name
// must stand alone. axe's `identical-links-same-purpose` and `landmark-unique` are
// `best-practice` rules our WCAG-tag axe runs exclude, hence these explicit checks.
// Names come from the accessibility tree (`ariaSnapshot`), not from attributes, so a
// broken `aria-labelledby` fails here too.
test.describe('/ — home link and landmark names (AECI-830)', () => {
  // xl, so the header's inline search box renders beside the hero's.
  test.use({ viewport: { width: 1440, height: 900 } });

  // AECI-2027: one load at 1440px, one step per name check.
  test('the source links and the search landmarks have distinct names', async ({ page }) => {
    await page.goto('/');

    await test.step('the three source links have distinct names that begin with "Source"', async () => {
      const links = page.locator('[data-testid="home-why-figures"] a[target="_blank"]');
      await expect(links).toHaveCount(3);
      const names = await accessibleNames(links);
      for (const name of names) expect(name, 'link name').toMatch(/^Source\b.+/);
      expect(new Set(names).size, `names: ${JSON.stringify(names)}`).toBe(names.length);
    });

    await test.step('every search landmark has a non-empty, distinct name', async () => {
      const landmarks = page.getByRole('search');
      const names = await accessibleNames(landmarks);
      // Header box, hero box, pair finder.
      expect(names.length, `names: ${JSON.stringify(names)}`).toBeGreaterThanOrEqual(3);
      for (const name of names) expect(name, 'landmark name').not.toBe('');
      expect(new Set(names).size, `names: ${JSON.stringify(names)}`).toBe(names.length);
      expect(names).toEqual(
        expect.arrayContaining(['Site search', 'Search the directory', 'Do these two connect?']),
      );
    });
  });
});

// AECI-1823: the pair finder routes a pick whose pair does not resolve to
// `/search?q=`, while a direct request to a bad pair URL stays a real 404.
test.describe('pair finder: a pick that does not resolve (AECI-1823)', () => {
  test('a direct request to a bad pair URL still returns 404, not a redirect to search', async ({
    request,
  }) => {
    const res = await request.get('/products/no-such-product-a/integrations/no-such-product-b', {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(404);
  });

  // AECI-1868: deterministic. The suggestions come from a fixed Algolia answer,
  // not the shared index. Each option is looked up in its own field's listbox and
  // clicked by name, so neither the pre-selected first option nor the other
  // field's list can decide the pick. The field must show the picked title before
  // the test moves on.
  test('a finder pick whose pair is NOT_FOUND lands on /search?q= with the typed name', async ({
    page,
  }) => {
    await routeFinderSuggestions(page);
    await page.route('**/api/products/*/integrations/*', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }),
      }),
    );
    await page.goto('/');

    const form = page.locator('form[aria-labelledby="hero-pair-title"]');
    await untilHydrated(form);
    await pick(page, form.locator('#hero-pair-tool'), 'procore', 'Zz Finder Procore');
    await pick(page, form.locator('#hero-pair-other'), 'revit', 'Zz Finder Revit LT');
    // Both picks held: neither field was cleared or rewritten by the other.
    await expect(form.locator('#hero-pair-tool')).toHaveValue('Zz Finder Procore');
    await form.getByRole('button', { name: 'Show integrations' }).click();

    await expect(page).toHaveURL(/\/search\?q=/);
    expect(new URL(page.url()).searchParams.get('q')).toBe('Zz Finder Procore');
  });
});

/**
 * Fixed product suggestions for the pair finder (AECI-1868). Two hits per query, so a
 * pick of the second option proves the test chose by name. The slugs exist in no
 * database. `__AECI_ALGOLIA__` gets a stand-in config before the page scripts run;
 * the server's inline config replaces it where one is set. Either way every query
 * lands on the route below and never reaches a live index.
 */
const FINDER_HITS: Record<string, Array<{ name: string; slug: string }>> = {
  procore: [
    { name: 'Zz Finder Procore', slug: 'zz-e2e-finder-procore' },
    { name: 'Zz Finder Procore Pay', slug: 'zz-e2e-finder-procore-pay' },
  ],
  revit: [
    { name: 'Zz Finder Revit', slug: 'zz-e2e-finder-revit' },
    { name: 'Zz Finder Revit LT', slug: 'zz-e2e-finder-revit-lt' },
  ],
};

async function routeFinderSuggestions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as { __AECI_ALGOLIA__?: unknown }).__AECI_ALGOLIA__ = {
      appId: 'E2EFINDER',
      searchKey: 'e2e-search-only',
      indexes: {
        products: 'e2e_products',
        vendors: 'e2e_vendors',
        integrations: 'e2e_integrations',
      },
    };
  });
  await page.route(/\/1\/indexes\/\*\/queries/, async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as {
      requests?: Array<{ query?: string; params?: string }>;
    };
    const results = (body.requests ?? []).map((req, i) => {
      const query = (req.query ?? new URLSearchParams(req.params ?? '').get('query') ?? '')
        .trim()
        .toLowerCase();
      // Request 0 is products, request 1 vendors (autocomplete-search.factory.ts).
      const hits =
        i === 0
          ? (FINDER_HITS[query] ?? []).map((h) => ({
              objectID: h.slug,
              name: h.name,
              slug: h.slug,
              vendor_name: 'Zz Finder Vendor',
            }))
          : [];
      return {
        hits,
        nbHits: hits.length,
        page: 0,
        nbPages: 1,
        hitsPerPage: 5,
        processingTimeMS: 1,
        exhaustiveNbHits: true,
        query,
        params: '',
      };
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ results }),
    });
  });
}

/**
 * Type `term` into one finder field and commit the option named `title` from that
 * field's own listbox (the one its `aria-controls` names), then wait until the field
 * shows the title.
 */
async function pick(page: Page, input: Locator, term: string, title: string): Promise<void> {
  await input.fill(term);
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  const listId = await input.getAttribute('aria-controls');
  expect(listId, 'the expanded field names its listbox').toBeTruthy();
  // Exact title text, so "Procore" never matches "Procore Pay".
  const option = page
    .locator(`[id="${listId}"]`)
    .getByRole('option')
    .filter({ has: page.getByText(title, { exact: true }) });
  await option.click();
  await expect(input).toHaveValue(title);
  await expect(input).toHaveAttribute('aria-expanded', 'false');
}

/** Each element's computed accessible name, read from its ARIA snapshot line. */
async function accessibleNames(locator: Locator): Promise<string[]> {
  const names: string[] = [];
  for (const el of await locator.all()) {
    const firstLine = (await el.ariaSnapshot()).split('\n')[0] ?? '';
    names.push(/^- \w+ "((?:[^"\\]|\\.)*)"/.exec(firstLine)?.[1] ?? '');
  }
  return names;
}

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

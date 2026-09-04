import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test';

// AECI-145 / Phase 3.12 — the AECI-143 faceted filter sidebar on the API-backed
// listing pages. Covers the acceptance criteria:
//   - "Listing-page facet interactions (3.10) covered by E2E" — facet click
//     drives the URL filter, the grid, and the Clear affordance.
//   - "search → results → facet refine → result click lands on the correct
//     detail page" — covered DETERMINISTICALLY here via the /products path
//     (Algolia is absent in CI, so the live /search results flow is a
//     self-skipping block in search.spec.ts instead).
//   - "cache-key correctness (distinct facets → distinct cache entries)" — the
//     distinct-KEY half is proven by src/cache-key-url.spec.ts (HIT/MISS is
//     unobservable on localhost Miniflare); here we prove the complementary
//     half: distinct facet URLs are independently cacheable and carry the SAME
//     Cache-Tag (facets live in the key, not the tag, so an `index:products`
//     purge clears every facet combo).
//
// AECI-189 extends the same suite with the facet-interaction criteria the
// AECI-145 pass left uncovered (filed as gap F2 by AECI-146):
//   - AC2 — the grid actually filters to the selected term (the term's facet
//     count IS the filtered grid total) and sibling-dimension counts rescope
//     disjunctively.
//   - AC3 — facet toggle semantics. SUPERSEDED by AECI-223: the dimensions are
//     now MULTI-select, so a sibling click APPENDS (both stay selected) rather
//     than replacing, and re-clicking a term removes just that one. The ids are
//     emitted as one sorted CSV `{kind}_id` param (cache-stable).
//   - AC4 — "Clear filters" is absent on an unfiltered load, and Clear restores
//     the unfiltered total.
//   - AC5 — a browse page's locked dimension rides the API requests as
//     `{kind}_id`, never the URL.
//   - AC6 — a browse page under an active filter serves the same §4 cache
//     headers + tags as unfiltered (facets live in the cache KEY, not the tag).
//
// Data-dependent tests self-skip when no facet data is seeded (same posture as
// products-index.spec.ts), so the suite stays green on an empty/unseeded DB.
//
// Flakiness discipline (AECI-189): the initial page load fires ZERO client API
// requests (the SSR HTTP transfer cache satisfies the grid + rail), so response
// waits are only valid around a CLICK — and must be registered BEFORE it. After
// a click, `httpResource` nulls its value during the refetch (the lede loses its
// number, the rail unmounts), so post-click DOM checks use only retrying
// assertions; element snapshots (counts, text) are taken before clicks.

const FACET_PARAM = /[?&](category_id|audience_id|trade_id|phase_id)=/;
// Infinite-scroll listings (#328) set `[resetsPage]="false"` on the /products
// and browse sidebars: a filter change no longer writes a `page` param (the list
// appends client-side; `?page=N` is only the load-more deep-link). These tests
// assert that contract — refining must NOT introduce `page=…`.
const PAGE_PARAM = /[?&]page=/;
// The total appears in the lede ("…indexed on AEC Integrations (N in total).")
// AND, once the list is fully loaded, the pagination footer ("You've reached the
// end (N in total)."). Scope to the lede so the count assertion stays a single
// match regardless of how many pages are loaded.
const LEDE_TOTAL = /indexed on AEC Integrations \(\d+ in total\)/;
const FACET_CHECKBOX = 'aec-facet-sidebar aec-search-refinement-list input[type="checkbox"]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CROSS_PARAMS = ['audience_id', 'trade_id', 'phase_id'] as const;

type FacetParam = 'category_id' | 'audience_id' | 'trade_id' | 'phase_id';

/**
 * `<legend>` text → URL/API param. The first fieldset is the first *non-empty*
 * group (empty groups render nothing), not necessarily Categories — so the
 * dimension under test is derived from its legend, never assumed.
 */
const LEGEND_PARAM: Record<string, FacetParam> = {
  Categories: 'category_id',
  Audiences: 'audience_id',
  Trades: 'trade_id',
  Phases: 'phase_id',
};

/** Facet param → its own dimension's key in the `/api/products/facets` body. */
const PARAM_RESPONSE_KEY: Record<FacetParam, 'categories' | 'audiences' | 'trades' | 'phases'> = {
  category_id: 'categories',
  audience_id: 'audiences',
  trade_id: 'trades',
  phase_id: 'phases',
};

type Term = { id: string; slug: string; name: string; product_count: number };
type FacetsBody = Record<'categories' | 'audiences' | 'trades' | 'phases', Term[]>;

/** First category term from `/api/taxonomy`, preferring one with products. */
async function firstCategoryTerm(request: APIRequestContext): Promise<Term | null> {
  const res = await request.get('/api/taxonomy');
  if (!res.ok()) return null;
  const body = (await res.json()) as { categories?: Term[] };
  const categories = body.categories ?? [];
  return categories.find((t) => t.product_count > 0) ?? categories[0] ?? null;
}

/**
 * Waiter for one of the two client refetches a facet click fires
 * (`/api/products` for the grid, `/api/products/facets` for the rail). MUST be
 * registered before the click; the URL/checked-state flips land before the data
 * does, so they can't prove the refetch happened.
 */
function apiResponse(
  page: Page,
  pathSuffix: '/api/products' | '/api/products/facets',
  predicate: (sp: URLSearchParams) => boolean,
): Promise<Response> {
  return page.waitForResponse((res) => {
    const u = new URL(res.url());
    return u.pathname.endsWith(pathSuffix) && predicate(u.searchParams);
  });
}

/** Query params of the page's CURRENT url (the router writes them pre-fetch). */
const qp = (page: Page): URLSearchParams => new URL(page.url()).searchParams;

/**
 * The first rendered facet group and its dimension param (from the legend).
 * Null when no facet data is seeded — callers self-skip.
 */
async function firstFacetGroup(
  page: Page,
): Promise<{ group: ReturnType<Page['locator']>; param: FacetParam } | null> {
  const group = page.locator('aec-facet-sidebar fieldset').first();
  if ((await group.count()) === 0) return null;
  const legend = ((await group.locator('legend').textContent()) ?? '').trim();
  const param = LEGEND_PARAM[legend];
  if (!param) throw new Error(`unmapped facet group legend "${legend}"`);
  return { group, param };
}

test.describe('/products — facet sidebar interaction (AECI-143 / AECI-145 / AECI-189)', () => {
  test('clicking a facet filters the URL + grid and shows Clear; Clear is absent unfiltered and restores the unfiltered total (AECI-189 AC4)', async ({
    page,
  }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    // AECI-189 AC4 (half 1) — Clear is URL-driven (`hasActiveFilters`), so its
    // absence on an unfiltered load is deterministic even on an unseeded DB.
    const clear = page.getByRole('button', { name: /Clear filters/i });
    await expect(clear).toHaveCount(0);

    const firstFacet = page.locator(FACET_CHECKBOX).first();
    test.skip((await firstFacet.count()) === 0, 'no facet data seeded in this environment');

    // Unfiltered total from the lede — the restore target for Clear below.
    const lede = page.getByText(LEDE_TOTAL);
    await expect(lede).toBeVisible();
    const unfilteredTotal = ((await lede.textContent()) ?? '').match(/\((\d+) in total\)/)?.[1];
    expect(unfilteredTotal, 'lede must expose the unfiltered total').toBeTruthy();

    // Refining wires the facet to the URL (the API-driven filter — CACHE_STRATEGY
    // §4 facets-in-the-key). AECI-328: the append-mode list pages internally, so
    // the refine keeps `?page=` OUT of the URL (the engine resets to page 1 on
    // its own) rather than reintroducing `page=1`.
    await firstFacet.click();
    await expect(page).toHaveURL(FACET_PARAM);
    await expect(page).not.toHaveURL(PAGE_PARAM);

    // The filtered results still render. AECI-190 made the card grid the default
    // /products view (the table is behind the ?view=table toggle).
    await expect(page.locator('aec-product-card-grid')).toBeVisible();

    // The Clear-filters affordance appears whenever a filter is active (driven by
    // the URL via `hasActiveFilters`, not facet data), and clearing it drops the
    // facet param. We intentionally do NOT assert the refined checkbox's persisted
    // state: the disjunctive-facet refetch re-renders the rail from *scoped*
    // counts, so a term's checkbox presence is data-dependent — the widget's
    // checked binding is covered by its component unit test. The URL + grid +
    // Clear are the stable, meaningful interaction outcomes.
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(page).not.toHaveURL(FACET_PARAM);

    // AECI-189 AC4 (half 2) — the unfiltered listing is restored (the retrying
    // assertion rides out the refetch window, during which the lede drops its
    // number) and the Clear affordance disappears again.
    await expect(lede).toContainText(`(${unfilteredTotal} in total)`);
    await expect(clear).toHaveCount(0);
  });

  test('criterion #1: facet refine → result click lands on the product detail page', async ({
    page,
  }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const first = await firstFacetGroup(page);
    test.skip(first === null, 'no facet data seeded in this environment');
    const { group, param } = first!;

    // The term's facet count N is the same oracle AC2 uses: the facets endpoint
    // computes each dimension's counts with every active filter EXCEPT its own,
    // so refining by this term must produce exactly N grid matches. Read it
    // BEFORE the click, while no refetch is in flight.
    const checkbox = group.locator('input[type="checkbox"]').first();
    const countText = (await group.locator('span.tabular-nums').first().textContent()) ?? '';
    const n = Number(countText.match(/\d+/)?.[0] ?? '');
    expect(n, `first facet count must be a positive number, got "${countText}"`).toBeGreaterThan(0);

    // Register the refine refetch BEFORE the click (per the discipline note
    // above) so the response can't be missed while the action retries.
    const refine = apiResponse(page, '/api/products', (sp) => sp.has(param));

    // Retry the ACTION, not just the assertion: `app-root` being attached is
    // satisfied by the SSR HTML alone, so a click dispatched before Angular
    // attaches its listeners is dropped outright and the URL never changes
    // (same failure the listing-toolbar helpers work around). Unlike those
    // toggles this checkbox is not idempotent — a second click would REMOVE the
    // term — so the inner window is generous enough that a landed click is not
    // mistaken for a dropped one, and the retry converges either way because
    // every attempt ends by asserting the refined URL.
    await expect(async () => {
      await checkbox.click();
      await expect(page).toHaveURL(FACET_PARAM, { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await refine;

    // `waitForResponse` resolves when the response ARRIVES, not when Angular has
    // applied it — so the grid can still be showing pre-refine data here. Gate
    // on the DOM instead: the lede and the grid are driven by the same
    // `httpResource` value, so a lede reading N proves the rendered grid is the
    // FINAL, refined one. Without this the snapshot below reads the stale first
    // card and the click then navigates to the refined one (read "Fixture
    // Procore", landed on "ConEst IntelliBid").
    await expect(page.getByText(LEDE_TOTAL)).toContainText(`(${n} in total)`);

    // AECI-190: the default view is the card grid, so select the product link
    // view-agnostically within #main rather than via the table-row selector.
    const firstCard = page.locator('#main a[href^="/products/"]').first();
    await firstCard.waitFor({ timeout: 8000 }).catch(() => {});
    test.skip((await firstCard.count()) === 0, 'no product rows after refine in this environment');

    // Snapshot the href and the name in ONE evaluation so they cannot describe
    // two different products. The whole card is the link, so its textContent is
    // the full tile (name + vendor + chips + count); the product name itself is
    // the card's display heading — the only `p.font-display` in the tile (the
    // integration-stat figure is a <span>).
    const card = await firstCard.evaluate((el) => ({
      href: el.getAttribute('href') ?? '',
      name: el.querySelector('p.font-display')?.textContent?.trim() ?? '',
    }));
    await firstCard.click();
    await expect(page).toHaveURL(/\/products\/[^/?#]+$/);
    // Landing anywhere other than the snapshotted card means the grid swapped
    // under us — fail on the URL, which names the cause, rather than on the <h1>.
    expect(new URL(page.url()).pathname).toBe(card.href);

    // Proof we landed on the CORRECT detail page: the <h1> is the product name.
    const heading = page.getByRole('heading', { level: 1 }).first();
    await expect(heading).toBeVisible();
    if (card.name) {
      await expect(heading).toHaveText(card.name);
    } else {
      await expect(heading).not.toHaveText('');
    }
  });

  test('distinct facet URLs are independently cacheable with an identical Cache-Tag', async ({
    request,
  }) => {
    // Synthetic, well-formed UUIDs — no seeding needed: the index page returns
    // 200 (empty result set) and the Cache-Tag is derived from the PATH, not the
    // query, so the assertion is deterministic regardless of DB contents.
    const urls = [
      '/products',
      '/products?category_id=00000000-0000-4000-8000-0000000000a1',
      '/products?category_id=00000000-0000-4000-8000-0000000000b2',
    ];

    const tags: string[] = [];
    for (const url of urls) {
      const res = await request.get(url);
      expect(res.status(), `GET ${url} must return 200`).toBe(200);

      const cacheControl = res.headers()['cache-control'] ?? '';
      expect(cacheControl, `${url} Cache-Control must be s-maxage=300`).toContain('s-maxage=300');
      expect(cacheControl, `${url} Cache-Control must be max-age=0`).toContain('max-age=0');

      const cacheTag = res.headers()['cache-tag'] ?? '';
      expect(cacheTag, `${url} Cache-Tag must include route:index`).toContain('route:index');
      expect(cacheTag, `${url} Cache-Tag must include index:products`).toContain('index:products');
      tags.push(cacheTag);
    }

    // Facets live in the cache KEY (proven distinct by cache-key-url.spec.ts),
    // NOT the tag — so every facet combination shares one purge tag.
    expect(tags[0]).toBe(tags[1]);
    expect(tags[1]).toBe(tags[2]);
  });

  test('refining filters the grid to the term and rescopes sibling counts disjunctively (AECI-189 AC2)', async ({
    page,
  }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const first = await firstFacetGroup(page);
    test.skip(first === null, 'no facet data seeded in this environment');
    const { group, param } = first!;

    // Pre-click snapshots (safe: no refetch in flight). The first term's facet
    // count N is the deterministic oracle: the facets endpoint computes each
    // dimension's counts with every active filter EXCEPT its own, so refining
    // by this term must produce exactly N grid matches — and leave the own
    // group's item set (rendered at count>0) unchanged.
    const checkboxes = group.locator('input[type="checkbox"]');
    const itemsBefore = await checkboxes.count();
    const countText = (await group.locator('span.tabular-nums').first().textContent()) ?? '';
    const n = Number(countText.match(/\d+/)?.[0] ?? '');
    expect(n, `first facet count must be a positive number, got "${countText}"`).toBeGreaterThan(0);

    const gridWait = apiResponse(page, '/api/products', (sp) => sp.has(param));
    const facetsWait = apiResponse(page, '/api/products/facets', (sp) => sp.has(param));
    await checkboxes.first().click();
    const [gridResp, facetsResp] = await Promise.all([gridWait, facetsWait]);
    expect(gridResp.status()).toBe(200);
    expect(facetsResp.status()).toBe(200);

    // AC2 (grid filters): API truth first — the filtered total IS the term's
    // facet count — then the DOM agrees (retrying through the refetch window).
    // The intercepted responses prove the refetch fired with the right params;
    // their BODIES are re-fetched through the request fixture because Chromium
    // releases page-initiated fetch bodies once the app consumes them
    // (`Network.getResponseBody: No data found` flake). Same URL + read-only DB
    // ⇒ identical payload.
    const gridBody = (await (await page.request.get(gridResp.url())).json()) as { total: number };
    expect(gridBody.total).toBe(n);
    await expect(page.getByText(LEDE_TOTAL)).toContainText(`(${n} in total)`);
    if (n <= 24) {
      // One page of results (perPage=24) — every match is exactly one card link.
      await expect(page.locator('aec-product-card-grid a[href^="/products/"]')).toHaveCount(n);
    }

    // AC2 (disjunctive rescope): the clicked term's own count is computed
    // WITHOUT its own filter (still N), while every other dimension's counts
    // scope to the N filtered products.
    const termId = new URL(gridResp.url()).searchParams.get(param)!;
    const facetsBody = (await (await page.request.get(facetsResp.url())).json()) as FacetsBody;
    const ownKey = PARAM_RESPONSE_KEY[param];
    const clicked = facetsBody[ownKey].find((t) => t.id === termId);
    expect(clicked?.product_count, 'own-dimension count must ignore its own filter').toBe(n);
    for (const [key, terms] of Object.entries(facetsBody)) {
      if (key === ownKey) continue;
      for (const term of terms) {
        expect(
          term.product_count,
          `${key}/"${term.slug}" count must rescope to the ${n} filtered products`,
        ).toBeLessThanOrEqual(n);
      }
    }
    // DOM proof of the unchanged own group: identical counts ⇒ no sibling
    // collapsed out of the count>0 render filter.
    await expect(checkboxes).toHaveCount(itemsBefore);
  });

  test('multi-select semantics: a sibling click APPENDS (both stay selected); re-clicking a term removes just it (AECI-223)', async ({
    page,
  }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const first = await firstFacetGroup(page);
    test.skip(first === null, 'no facet data seeded in this environment');
    const { group, param } = first!;

    // Index stability: the own group's item set/order is invariant under its
    // own refinement (own-dimension counts exclude the own filter and terms
    // never reorder by count), so nth() addressing within THIS group is safe.
    const checkboxes = group.locator('input[type="checkbox"]');
    test.skip((await checkboxes.count()) < 2, 'needs at least two terms in the first facet group');

    // Select the first term. After awaiting the rail's refetch, the URL is
    // already final (the router writes it before the fetch fires).
    let facetsWait = apiResponse(page, '/api/products/facets', (sp) => sp.has(param));
    await checkboxes.first().click();
    expect((await facetsWait).status()).toBe(200);
    const v1 = qp(page).get(param)!;
    expect(v1, 'facet param must be the term UUID').toMatch(UUID_RE);
    // Infinite scroll (#328): a refine never adds a `page` param.
    expect(qp(page).get('page')).toBeNull();
    await expect(checkboxes.first()).toBeChecked(); // render barrier: rail is back

    // Toggle-off: clicking the ACTIVE term clears the param (and refires the
    // rail fetch with no taxonomy filter).
    facetsWait = apiResponse(page, '/api/products/facets', (sp) => !sp.has(param));
    await checkboxes.first().click();
    expect((await facetsWait).status()).toBe(200);
    await expect.poll(() => qp(page).get(param)).toBeNull();
    await expect(checkboxes.first()).not.toBeChecked();

    // Re-select the first term (with barrier), then click a sibling — APPEND
    // semantics (AECI-223): the dimension now holds BOTH ids as one sorted CSV
    // param, and BOTH checkboxes stay checked.
    facetsWait = apiResponse(page, '/api/products/facets', (sp) => sp.get(param) === v1);
    await checkboxes.first().click();
    expect((await facetsWait).status()).toBe(200);
    await expect(checkboxes.first()).toBeChecked();

    // The sibling click fires a multi-value request — the param value carries a
    // comma — and the grid refetches with the same CSV (OR within the dimension).
    facetsWait = apiResponse(page, '/api/products/facets', (sp) =>
      (sp.get(param) ?? '').includes(','),
    );
    const gridWait = apiResponse(page, '/api/products', (sp) =>
      (sp.get(param) ?? '').includes(','),
    );
    await checkboxes.nth(1).click();
    expect((await facetsWait).status()).toBe(200);
    expect((await gridWait).status()).toBe(200);

    // Still ONE param (CSV-encoded, not repeated), holding both ids, SORTED, and
    // including the original v1 — proving append (not replace) and cache-stable
    // ordering.
    await expect.poll(() => (qp(page).get(param) ?? '').includes(',')).toBe(true);
    expect(qp(page).getAll(param), 'multi-select is one CSV param, never repeated').toHaveLength(1);
    const ids = qp(page).get(param)!.split(',');
    expect(ids, 'append keeps the first term').toContain(v1);
    expect(ids, 'two distinct terms selected').toHaveLength(2);
    expect(ids, 'ids emitted in sorted order (cache-stable)').toEqual([...ids].sort());
    await expect(checkboxes.first()).toBeChecked();
    await expect(checkboxes.nth(1)).toBeChecked();
    expect(qp(page).get('page')).toBeNull();
  });
});

test.describe('/categories/:slug — locked-kind facet sidebar (AECI-143 / AECI-145 / AECI-189)', () => {
  // Stable reference slug — the same category browse page Lighthouse collects.
  const SLUG = '/categories/project-management';

  test('hides its own (Categories) dimension and refines the others in-place', async ({ page }) => {
    const res = await page.goto(SLUG);
    test.skip(res?.status() !== 200, `${SLUG} not available (status ${res?.status()})`);
    await expect(page.locator('app-root')).toBeAttached();

    const sidebar = page.locator('aec-facet-sidebar');
    test.skip((await sidebar.count()) === 0, 'no facet sidebar on this browse page');

    // Locked kind = category, so the Categories group never renders; only the
    // other two taxonomy dimensions appear.
    await expect(sidebar.locator('legend', { hasText: 'Categories' })).toHaveCount(0);

    const firstFacet = sidebar.locator('aec-search-refinement-list input[type="checkbox"]').first();
    await firstFacet.waitFor({ timeout: 8000 }).catch(() => {});
    test.skip((await firstFacet.count()) === 0, 'no facet data seeded for this category');

    await firstFacet.click();
    // A non-locked dimension is refined; the page stays on the browse route.
    await expect(page).toHaveURL(/\/categories\/project-management\?/);
    await expect(page).toHaveURL(/[?&](audience_id|phase_id)=/);
    // Infinite scroll (#328): the refine must not reintroduce a `page` param.
    await expect(page).not.toHaveURL(PAGE_PARAM);
  });

  test('the locked dimension rides the API requests as category_id, never the URL (AECI-189 AC5)', async ({
    page,
    request,
  }) => {
    const term = await firstCategoryTerm(request);
    test.skip(term === null, 'no category terms seeded in this environment');

    const res = await page.goto(`/categories/${term!.slug}`);
    test.skip(
      res?.status() !== 200,
      `/categories/${term!.slug} not available (status ${res?.status()})`,
    );
    await expect(page.locator('app-root')).toBeAttached();

    const firstFacet = page.locator(FACET_CHECKBOX).first();
    await firstFacet.waitFor({ timeout: 8000 }).catch(() => {});
    test.skip((await firstFacet.count()) === 0, 'no facet data seeded for this category');

    // The initial load is satisfied by the SSR transfer cache (zero client API
    // traffic), so the lock is only observable on a CLICK-driven refetch:
    // refine a cross-filter and intercept the request pair it fires. Both must
    // carry the page's lock as `category_id=<term.id>`.
    const gridWait = apiResponse(page, '/api/products', (sp) => sp.get('category_id') === term!.id);
    const facetsWait = apiResponse(
      page,
      '/api/products/facets',
      (sp) => sp.get('category_id') === term!.id,
    );
    await firstFacet.click();
    const [gridResp, facetsResp] = await Promise.all([gridWait, facetsWait]);
    expect(gridResp.status()).toBe(200);
    expect(facetsResp.status()).toBe(200);

    // The clicked cross-filter rode the same requests (whichever non-locked
    // dimension the first rendered group happens to be).
    for (const resp of [gridResp, facetsResp]) {
      const sp = new URL(resp.url()).searchParams;
      expect(
        CROSS_PARAMS.some((p) => sp.has(p)),
        `${resp.url()} must carry the refined cross-filter`,
      ).toBe(true);
    }

    // The lock NEVER reaches the URL — only the cross-filter does.
    await expect(page).toHaveURL(/[?&](audience_id|phase_id)=/);
    expect(qp(page).get('category_id'), 'the locked dimension must stay out of the URL').toBeNull();
  });

  test('a filtered browse URL serves identical §4 cache headers and tags (AECI-189 AC6)', async ({
    request,
  }) => {
    const term = await firstCategoryTerm(request);
    test.skip(term === null, 'no category terms seeded in this environment');

    // The browse route needs a REAL slug (unknown slugs are hard 404s), but the
    // filter value only has to parse — synthetic well-formed UUID.
    const urls = [
      `/categories/${term!.slug}`,
      `/categories/${term!.slug}?audience_id=00000000-0000-4000-8000-0000000000c3&page=1`,
    ];

    const tags: string[] = [];
    for (const url of urls) {
      const res = await request.get(url);
      expect(res.status(), `GET ${url} must return 200`).toBe(200);

      const cacheControl = res.headers()['cache-control'] ?? '';
      expect(cacheControl, `${url} Cache-Control must be s-maxage=300`).toContain('s-maxage=300');
      expect(cacheControl, `${url} Cache-Control must be max-age=0`).toContain('max-age=0');

      const cacheTag = res.headers()['cache-tag'] ?? '';
      expect(cacheTag, `${url} Cache-Tag must include route:browse`).toContain('route:browse');
      expect(cacheTag, `${url} Cache-Tag must include the entity tag`).toContain(
        `category:${term!.slug}`,
      );
      if (term!.product_count > 0) {
        // The resolver embeds product:{slug} tags from the TERM's products (a
        // superset of any filtered grid), so they appear filtered or not.
        expect(cacheTag, `${url} Cache-Tag must embed product tags`).toContain('product:');
      }
      tags.push(cacheTag);
    }

    // Facets live in the cache KEY, never the tag — a filtered browse page
    // shares the unfiltered page's purge tag set, byte for byte.
    expect(tags[0]).toBe(tags[1]);
  });
});

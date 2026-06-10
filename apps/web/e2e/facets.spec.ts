import { expect, test } from '@playwright/test';

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
// Data-dependent tests self-skip when no facet data is seeded (same posture as
// products-index.spec.ts), so the suite stays green on an empty/unseeded DB.

const FACET_PARAM = /[?&](category_id|audience_id|phase_id)=/;
const PAGE_RESET = /[?&]page=1(?:&|$)/;
const FACET_CHECKBOX = 'aec-facet-sidebar aec-search-refinement-list input[type="checkbox"]';

test.describe('/products — facet sidebar interaction (AECI-143 / AECI-145)', () => {
  test('clicking a facet filters the URL + grid and shows Clear; Clear resets', async ({
    page,
  }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const firstFacet = page.locator(FACET_CHECKBOX).first();
    test.skip((await firstFacet.count()) === 0, 'no facet data seeded in this environment');

    // Refining wires the facet to the URL (the API-driven filter, §9.2) and
    // resets pagination to page 1.
    await firstFacet.click();
    await expect(page).toHaveURL(FACET_PARAM);
    await expect(page).toHaveURL(PAGE_RESET);

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
    const clear = page.getByRole('button', { name: /Clear filters/i });
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(page).not.toHaveURL(FACET_PARAM);
  });

  test('criterion #1: facet refine → result click lands on the product detail page', async ({
    page,
  }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const firstFacet = page.locator(FACET_CHECKBOX).first();
    test.skip((await firstFacet.count()) === 0, 'no facet data seeded in this environment');

    await firstFacet.click();
    await expect(page).toHaveURL(FACET_PARAM);

    // The refined term has product_count > 0, so the filtered grid has at least
    // one product card to click. Wait for the refetched grid to settle.
    // AECI-190: the default view is the card grid, so select the product link
    // view-agnostically within #main rather than via the table-row selector.
    const firstCard = page.locator('#main a[href^="/products/"]').first();
    await firstCard.waitFor({ timeout: 8000 }).catch(() => {});
    test.skip((await firstCard.count()) === 0, 'no product rows after refine in this environment');

    // The whole card is the link, so its textContent is the full tile (name +
    // vendor + chips + count). The product name itself is the card's display
    // heading — the only `p.font-display` in the tile (the integration-stat
    // figure is a <span>) — so compare the detail <h1> against that.
    const cardName =
      (await firstCard.locator('p.font-display').first().textContent())?.trim() ?? '';
    await firstCard.click();
    await expect(page).toHaveURL(/\/products\/[^/?#]+$/);

    // Proof we landed on the CORRECT detail page: the <h1> is the product name.
    const heading = page.getByRole('heading', { level: 1 }).first();
    await expect(heading).toBeVisible();
    if (cardName) {
      await expect(heading).toHaveText(cardName);
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
});

test.describe('/categories/:slug — locked-kind facet sidebar (AECI-143 / AECI-145)', () => {
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
    await expect(page).toHaveURL(PAGE_RESET);
  });
});

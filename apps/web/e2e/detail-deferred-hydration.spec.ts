/**
 * AECI-130 — incremental-hydration proof for the detail-page `@defer` grids.
 *
 * Both detail pages render children past the first 20 inside a
 * `@defer (on viewport; hydrate on viewport)` block:
 *   - vendor-detail.ts  → products `slice(20)`
 *   - product-detail.ts → integrations `slice(20)` (source ++ target)
 *
 * With Angular v22 incremental hydration enabled (AECI-130 dropped the PR-1
 * `withNoIncrementalHydration()` opt-out), the deferred grid's *main template*
 * is SSR-rendered instead of the `@placeholder` — so deferred rows land in the
 * raw HTML, crawlable and visible with JS off. Before AECI-130 those rows were
 * absent from SSR (the placeholder shipped instead) and only appeared after
 * client hydration + viewport entry.
 *
 * This asserts that directly against whatever DB the app reads: it discovers a
 * real entity with > 20 children via the list API, reads the (21st) deferred
 * child from the detail API, then asserts that child's rendered text is in the
 * raw SSR HTML from `request.get` — no browser, no scroll, no JS.
 *
 * Topology note: the app only ever reads the shared dev DB over Prisma
 * Accelerate (see docs/environments.md §"Local dev: running the API Worker"
 * and pr-preview.yml — "No per-PR Supabase branches, no [seed]"). It never
 * reads supabase/seed.sql / local Postgres, so a seeded fixture would be
 * invisible here. Instead this self-activates: it asserts when the DB under
 * test has a > 20-child entity and skips (loudly) otherwise, so it stays green
 * on an empty DB and becomes a live guard the moment rich data lands.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';

const PER_PAGE = 100;
const MAX_PAGES = 5; // cap: scan up to MAX_PAGES * PER_PAGE entities, then skip.
const DEFER_THRESHOLD = 20; // both pages defer children after the first 20.

/**
 * Angular escapes `&` / `<` / `>` in interpolated text nodes (quotes are left
 * as-is in text content). Mirror that so names containing those chars still
 * match the serialized SSR HTML.
 */
function htmlEscapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Page through a list endpoint looking for the first entity whose child count
 * exceeds the defer threshold. Returns its slug, or null if none is found
 * within the page cap (or the list endpoint is unavailable).
 */
async function findEntityWithDeferredChildren(
  request: APIRequestContext,
  listPath: string,
  countField: string,
): Promise<string | null> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await request.get(`${listPath}?perPage=${PER_PAGE}&page=${page}`);
    if (!res.ok()) return null;
    const body = await res.json();
    const items: Array<Record<string, unknown>> = body.data ?? [];
    const hit = items.find((i) => Number(i[countField] ?? 0) > DEFER_THRESHOLD);
    if (hit) return String(hit['slug']);
    const total = Number(body.total ?? 0);
    if (page * PER_PAGE >= total) break; // no further pages to scan
  }
  return null;
}

test.describe('detail pages — deferred grids SSR-render under incremental hydration (AECI-130)', () => {
  test('vendor with > 20 products: the deferred product is in the raw SSR HTML', async ({
    request,
  }) => {
    const slug = await findEntityWithDeferredChildren(request, '/api/vendors', 'product_count');
    test.skip(
      slug === null,
      `no vendor with > ${DEFER_THRESHOLD} products in the first ${MAX_PAGES * PER_PAGE} ` +
        'rows of the DB under test — deferred product grid not exercisable here',
    );

    const detail = await (await request.get(`/api/vendors/${slug}`)).json();
    const products: Array<{ name: string }> = detail.products ?? [];
    test.skip(
      products.length <= DEFER_THRESHOLD,
      `vendor "${slug}" detail returned ${products.length} products (≤ ${DEFER_THRESHOLD})`,
    );

    const deferred = products[DEFER_THRESHOLD]; // the 21st product → slice(20)[0]
    const html = await (await request.get(`/vendors/${slug}`)).text();
    expect(
      html,
      `deferred product "${deferred.name}" must appear in raw SSR HTML for /vendors/${slug}`,
    ).toContain(htmlEscapeText(deferred.name));
  });

  test('product with > 20 integrations: the deferred integration is in the raw SSR HTML', async ({
    request,
  }) => {
    const slug = await findEntityWithDeferredChildren(
      request,
      '/api/products',
      'integration_count',
    );
    test.skip(
      slug === null,
      `no product with > ${DEFER_THRESHOLD} integrations in the first ${MAX_PAGES * PER_PAGE} ` +
        'rows of the DB under test — deferred integration grid not exercisable here',
    );

    const detail = await (await request.get(`/api/products/${slug}`)).json();
    // product-detail.ts composes the grid as source ++ target, then slices(20).
    const combined: Array<{ name: string }> = [
      ...(detail.integrations_as_source ?? []),
      ...(detail.integrations_as_target ?? []),
    ];
    test.skip(
      combined.length <= DEFER_THRESHOLD,
      `product "${slug}" has ${combined.length} integrations (≤ ${DEFER_THRESHOLD}); ` +
        'integration_count and the embedded arrays disagree',
    );

    const deferred = combined[DEFER_THRESHOLD]; // the 21st integration → slice(20)[0]
    const html = await (await request.get(`/products/${slug}`)).text();
    expect(
      html,
      `deferred integration "${deferred.name}" must appear in raw SSR HTML for /products/${slug}`,
    ).toContain(htmlEscapeText(deferred.name));
  });
});

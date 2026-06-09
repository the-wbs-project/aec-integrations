import { expect, test } from '@playwright/test';

/**
 * AECI-66 / Phase 2.20 — Datadog metric verification traffic generator.
 *
 * NOT a CI assertion suite. It exists to drive real traffic across the Phase 2
 * page types so the three custom metrics (`aeci.page.render.duration_ms`,
 * `aeci.api.query.duration_ms`, `aeci.cache.purge`) appear in Datadog after a
 * deploy. Visits a representative set of static / index / browse / detail URLs
 * TWICE — pass 1 is a cache MISS, pass 2 a HIT — so both `cache_status` values
 * and all three `route_class` values are exercised.
 *
 * Gated behind `DATADOG_TRAFFIC_GEN` so it never runs in the normal E2E job.
 * Run it against a deployed env where `DD_API_KEY` is set:
 *
 *   DATADOG_TRAFFIC_GEN=1 PLAYWRIGHT_BASE_URL=https://<staging-url> \
 *     pnpm --filter @aeci/web exec playwright test e2e/traffic-gen.spec.ts
 *
 * See docs/OBSERVABILITY.md → "Verifying metrics flow".
 */

// Cacheable routes that always exist (static + index + browse facet roots).
// AECI-165 removed the `/vendors` and `/integrations` index pages (they now
// 301-redirect to `/products`), so they are no longer driven here.
const FIXED_ROUTES = [
  '/',
  '/about',
  '/legal/privacy',
  '/products',
  '/categories',
  '/audiences',
  '/phases',
];

// Patterns used to harvest live detail/browse slugs from the index pages, so we
// exercise `route_class:detail` + `route_class:browse` against real entities.
// Vendor / integration DETAIL slugs are harvested transitively from the product
// detail pages discovered below (their `/vendors/:slug` + `/integrations/:id`
// links) — there is no longer a vendor/integration index to scrape (AECI-165).
const DISCOVERY: { from: string; pattern: RegExp }[] = [
  { from: '/products', pattern: /\/products\/[a-z0-9][a-z0-9-]*/g },
  { from: '/categories', pattern: /\/categories\/[a-z0-9][a-z0-9-]*/g },
];

test.describe('Datadog traffic generator (AECI-66)', () => {
  test.skip(
    !process.env['DATADOG_TRAFFIC_GEN'],
    'Set DATADOG_TRAFFIC_GEN=1 (against a deployed PLAYWRIGHT_BASE_URL) to run.',
  );

  // Generous: discovery + two passes over ~20+ URLs across a network hop.
  test.setTimeout(120_000);

  test('drives traffic across Phase 2 page types (MISS then HIT)', async ({ request }) => {
    // 1. Discover up to 3 detail/browse slugs per type from the index pages.
    const discovered = new Set<string>();
    for (const { from, pattern } of DISCOVERY) {
      const res = await request.get(from);
      if (!res.ok()) continue;
      const html = await res.text();
      const matches = [...new Set(html.match(pattern) ?? [])].slice(0, 3);
      matches.forEach((m) => discovered.add(m));
    }

    const urls = [...new Set([...FIXED_ROUTES, ...discovered])];
    expect(urls.length, 'expected a non-trivial set of URLs to exercise').toBeGreaterThan(8);

    // 2. Two passes: pass 1 fills the edge cache (MISS), pass 2 should HIT.
    const cacheStatusCounts: Record<string, number> = {};
    const serverErrors: string[] = [];

    for (const pass of [1, 2] as const) {
      for (const url of urls) {
        const res = await request.get(url);
        const status = res.status();
        const cf = (res.headers()['cf-cache-status'] ?? 'none').toLowerCase();
        cacheStatusCounts[`pass${pass}:${cf}`] = (cacheStatusCounts[`pass${pass}:${cf}`] ?? 0) + 1;
        if (status >= 500) serverErrors.push(`${url} → ${status}`);
      }
    }

    console.log(
      `[traffic-gen] ${urls.length} URLs × 2 passes against ${process.env['PLAYWRIGHT_BASE_URL'] ?? 'local'}\n` +
        `  cf-cache-status: ${JSON.stringify(cacheStatusCounts)}\n` +
        `  (discovered ${discovered.size} detail/browse slugs)\n` +
        '  → check Datadog within ~5 min: aeci.page.render.duration_ms (cache_status hit/miss, route_class), ' +
        'aeci.api.query.duration_ms (endpoint). Confirm dashboard widgets populate.',
    );

    // The only hard failure condition is a 5xx — everything else is informational.
    expect(serverErrors, `5xx responses during traffic gen: ${serverErrors.join(', ')}`).toEqual(
      [],
    );
  });
});

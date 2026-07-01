/**
 * AECI-60 / AECI-294 — legacy `/integrations/:id` 404-path coverage.
 *
 * AECI-294 retired the standalone integration detail page: `/integrations/:id`
 * now 301-redirects to the product-PAIR page (see `server-runtime.ts`). A
 * well-formed id that the API can't resolve is NOT redirected — it falls through
 * to the SSR pipeline, which renders the branded, accessible, `noindex` 404 (the
 * Angular `**` wildcard) with a real HTTP 404 + `NOT_FOUND_TTL` + `route:404`.
 * This spec is seed-free and covers exactly that path (a syntactically valid UUID
 * that isn't in the dev DB, guaranteeing a clean NOT_FOUND rather than a
 * validation error). The redirect-success path is covered by the server unit
 * tests; the pair page's own success path by the AECI-64 crawler + axe harness.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const BOGUS_ID = '00000000-0000-4000-8000-000000000404';

test.describe('integration detail — 404 path', () => {
  test('GET /integrations/<bogus-uuid> returns a real HTTP 404 with NOT_FOUND_TTL', async ({
    request,
  }) => {
    const res = await request.get(`/integrations/${BOGUS_ID}`, { maxRedirects: 0 });

    expect(res.status(), 'must be a real 404 — never the pinned-404 trap').toBe(404);
    expect(res.headers()['cache-control']).toBe('public, max-age=0, s-maxage=60');
    expect(res.headers()['cache-tag']).toBe('route:404');
  });

  test('404 body carries noindex robots meta in the SSR HTML', async ({ request }) => {
    const res = await request.get(`/integrations/${BOGUS_ID}`);
    const html = await res.text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
  });

  test('404 page has zero axe violations at WCAG AA', async ({ page }) => {
    await page.goto(`/integrations/${BOGUS_ID}`);
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});

/**
 * AECI-60 / Phase 2.14 — integration detail page end-to-end coverage.
 *
 * Seed-free, mirroring the vendor/product detail e2e: covers the 404 path
 * (`/integrations/:id` with a well-formed UUID that isn't in the dev DB).
 * Integrations are keyed by ID, not slug (Phase 2 Spec §6.5), so the bogus
 * id is a syntactically valid UUID to guarantee a clean NOT_FOUND from the
 * API rather than a validation error.
 *
 * Success-path coverage (hero / breadcrumbs / Cache-Tag with embedded
 * product + vendor tags) runs against seeded data in the Phase 2.18 crawler
 * (AECI-64) and the Lighthouse/axe harness (AECI-65).
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

/**
 * AECI-57 / Phase 2.11 — product detail page end-to-end coverage.
 *
 * Two seed-free paths plus one fixture-gated guard are covered here:
 *   1. 404 path (`/products/:slug` with a slug that isn't in the dev DB).
 *      Asserts the global 404 shell renders (AECI-62), the response is a real
 *      HTTP 404 (not the pinned-404 trap — see Stage 1 Spec §9.1b), the cache
 *      headers honour `NOT_FOUND_TTL`, and `Cache-Tag: route:404` is set.
 *   2. Claim/correction request forms (`/products/:slug/claim`,
 *      `/products/:slug/correction`, AECI-128) render the `RequestForm` with
 *      `<meta name="robots" content="noindex">`.
 *   3. "How teams use it" usefulness section (AECI-170) — a regression guard
 *      that the section stays INERT (heading absent) while the API returns a
 *      null `usefulness` stub (AECI-169). Gated on the seed fixture
 *      (`fixture-procore`, like `phase2-a11y.spec.ts`); self-skips when the
 *      fixture is absent so the file stays green pre-seed. The populated-state
 *      assertion lands later with API hydration.
 *
 * The success-path coverage (hero / breadcrumbs / Cache-Tag with vendor +
 * integration tags / second-visit cache HIT) lives in the Phase 2.18 crawler
 * (AECI-64) and Phase 2.19 Lighthouse/axe harness (AECI-65) once those land
 * — they run against a seeded dev DB / preview deployment where the assertions
 * have data to bite on. This file is intentionally seed-free so it stays
 * green on `pnpm dev:bound` against an empty local DB and on `pr-preview.yml`
 * runs before the seed lands.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, request as playwrightRequest, test } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';

test.describe('product detail — 404 path', () => {
  test('GET /products/<bogus> returns a real HTTP 404 with NOT_FOUND_TTL', async ({ request }) => {
    const res = await request.get('/products/no-such-slug-aeci-57', {
      maxRedirects: 0,
    });

    expect(res.status(), 'must be a real 404 — never the pinned-404 trap').toBe(404);

    // §8.3 / §9.1b / AECI-62 AC — 404s on cacheable routes carry a short edge
    // TTL but no browser cache, so a re-navigation after admin fixes the
    // entity revalidates immediately.
    expect(res.headers()['cache-control']).toBe('public, max-age=0, s-maxage=60');

    // AECI-62 AC — single sentinel tag so admin can bulk-purge negative
    // responses after a config fix.
    expect(res.headers()['cache-tag']).toBe('route:404');
  });

  test('404 body renders the global NotFound shell (i18n copy)', async ({ page }) => {
    const res = await page.goto('/products/no-such-slug-aeci-57');
    expect(res?.status()).toBe(404);

    // Eyebrow + headline from `not-found.ts` (AECI-62).
    await expect(page.getByText('404: Not found', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: "We couldn't find that page." })).toBeVisible();

    // The four AC-pinned recovery links live inside the 404 shell's directory
    // nav landmark — scope to it so the site-header's primary nav doesn't
    // double-match.
    const directory = page.getByRole('navigation', { name: 'Browse the directory' });
    await expect(directory.getByRole('link', { name: /Products/ })).toHaveAttribute(
      'href',
      /\/products$/,
    );
    await expect(directory.getByRole('link', { name: /Audiences/ })).toHaveAttribute(
      'href',
      /\/audiences$/,
    );
    await expect(directory.getByRole('link', { name: /Phases/ })).toHaveAttribute(
      'href',
      /\/phases$/,
    );
    await expect(directory.getByRole('link', { name: /Categories/ })).toHaveAttribute(
      'href',
      /\/categories$/,
    );
    await expect(page.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
  });

  test('404 panel carries noindex robots meta in the SSR HTML', async ({ request }) => {
    // Stage 1 Spec §9.1b + §20.7 — 404s must not be indexed.
    const res = await request.get('/products/no-such-slug-aeci-57');
    const html = await res.text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
  });

  test('404 page has zero axe violations at WCAG AA', async ({ page }) => {
    await page.goto('/products/no-such-slug-aeci-57');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});

test.describe('product detail — claim/correction request forms (AECI-128)', () => {
  test('GET /products/<slug>/claim renders the claim form', async ({ page }) => {
    await page.goto('/products/anything/claim');
    await expect(page.getByRole('heading', { name: 'Claim this listing' })).toBeVisible();
    await expect(page.locator('#claim-email')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send claim' })).toBeVisible();
  });

  test('GET /products/<slug>/claim ships noindex robots meta', async ({ request }) => {
    const html = await (await request.get('/products/anything/claim')).text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
  });

  test('GET /products/<slug>/correction renders the correction form', async ({ page }) => {
    await page.goto('/products/anything/correction');
    await expect(page.getByRole('heading', { name: 'Suggest a correction' })).toBeVisible();
    await expect(page.locator('#correction-body')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send correction' })).toBeVisible();
  });

  test('GET /products/<slug>/correction ships noindex robots meta', async ({ request }) => {
    const html = await (await request.get('/products/anything/correction')).text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
  });
});

test.describe('product detail — usefulness section (AECI-170)', () => {
  // The "How teams use it" section ships inert: it renders only when the API
  // returns a non-null `usefulness`, which is a typed null-stub for every
  // product until the data pipeline lands (AECI-169). This guards that inert
  // state — the heading must be ABSENT even on a real (fixture) product page.
  // Gated on the seed fixture so it self-skips pre-seed (mirrors phase2-a11y).
  const FIXTURE_PRODUCT_SLUG = 'fixture-procore';
  let fixturesPresent = false;

  test.beforeAll(async () => {
    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      const res = await ctx.get(`/products/${FIXTURE_PRODUCT_SLUG}`, { maxRedirects: 0 });
      fixturesPresent = res.status() === 200;
      if (!fixturesPresent) {
        console.warn(
          `[products-detail] Fixtures absent: GET /products/${FIXTURE_PRODUCT_SLUG} -> ${res.status()}. ` +
            'Usefulness-section guard will be SKIPPED. Seed supabase/fixtures/phase2-fixtures.sql ' +
            'into the dev DB (CI: set DIRECT_URL_STAGING) to enable it.',
        );
      }
    } finally {
      await ctx.dispose();
    }
  });

  test('stays inert (heading absent) while usefulness is null-stubbed', async ({ page }) => {
    test.skip(!fixturesPresent, 'fixtures not seeded — see beforeAll warning');

    await page.goto(`/products/${FIXTURE_PRODUCT_SLUG}`);
    await expect(page.locator('app-root')).toBeAttached();
    await expect(page.getByRole('heading', { name: 'How teams use it' })).toHaveCount(0);
  });
});

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
 *   3. "How teams use it" usefulness section (AECI-170/-173) — covers BOTH the
 *      populated state (`fixture-procore` carries a `usefulness` blob: heading,
 *      both facet columns, group label, and a seeded point render) and the null
 *      path (`fixture-acme-connector` has no usefulness: heading absent). Each
 *      test gates on the API actually returning the expected usefulness state, so
 *      both self-skip when the fixture isn't seeded and the file stays green
 *      pre-seed (mirrors `phase2-a11y.spec.ts`).
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

test.describe('product detail — "How teams use it" usefulness section (AECI-170/-173)', () => {
  // The section renders only when the API returns a non-null `usefulness` (AECI-173
  // reads the jsonb column; AECI-170 renders it). Both states are exercised against
  // the seed fixture (supabase/fixtures/phase2-fixtures.sql): `fixture-procore`
  // carries a usefulness blob (populated) and `fixture-acme-connector` does not
  // (null path). Each test gates on the API ACTUALLY returning the expected
  // usefulness state — so a product that exists but wasn't re-seeded skips loudly
  // instead of failing. The SSR Worker proxies `/api/*`, so the probe reads the
  // same hydration the page renders from.
  const POPULATED_SLUG = 'fixture-procore';
  const NULL_SLUG = 'fixture-acme-connector';
  // A seeded point unique to fixture-procore's usefulness blob (not a taxonomy label).
  const SEEDED_POINT =
    'Track RFIs and submittals across every job so nothing slips between trades.';
  let populatedSeeded = false;
  let nullPathSeeded = false;

  test.beforeAll(async () => {
    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      const populated = await ctx.get(`/api/products/${POPULATED_SLUG}`, { maxRedirects: 0 });
      const populatedBody = populated.ok() ? await populated.json() : null;
      populatedSeeded = populatedBody?.usefulness != null;

      const nullPath = await ctx.get(`/api/products/${NULL_SLUG}`, { maxRedirects: 0 });
      const nullBody = nullPath.ok() ? await nullPath.json() : null;
      nullPathSeeded = nullPath.ok() && nullBody?.usefulness == null;

      if (!populatedSeeded) {
        console.warn(
          `[products-detail] usefulness not seeded: GET /api/products/${POPULATED_SLUG} -> ` +
            `${populated.ok() ? 'usefulness=null' : `HTTP ${populated.status()}`}. ` +
            'Populated-state test will be SKIPPED. Seed supabase/fixtures/phase2-fixtures.sql ' +
            'into the dev DB (CI: set DIRECT_URL_STAGING) after the AECI-171 migration.',
        );
      }
    } finally {
      await ctx.dispose();
    }
  });

  test('renders columns + points when the product carries usefulness', async ({ page }) => {
    test.skip(!populatedSeeded, 'usefulness fixture not seeded — see beforeAll warning');

    await page.goto(`/products/${POPULATED_SLUG}`);
    await expect(page.locator('app-root')).toBeAttached();

    // The section is a `region` landmark named by its <h2> — scope label
    // assertions to it so the audience facet chip (same "General Contracting"
    // text) elsewhere on the page doesn't double-match.
    const section = page.getByRole('region', { name: 'How teams use it' });
    await expect(section.getByRole('heading', { name: 'How teams use it' })).toBeVisible();
    await expect(section.getByRole('heading', { name: 'By audience' })).toBeVisible();
    await expect(section.getByRole('heading', { name: 'By phase' })).toBeVisible();
    await expect(section.getByText('General Contracting')).toBeVisible();

    // The seeded point string is unique to the usefulness blob.
    await expect(page.getByText(SEEDED_POINT)).toBeVisible();
  });

  test('stays inert (heading absent) for a product with no usefulness', async ({ page }) => {
    test.skip(!nullPathSeeded, 'null-path fixture not seeded — see beforeAll warning');

    await page.goto(`/products/${NULL_SLUG}`);
    await expect(page.locator('app-root')).toBeAttached();
    await expect(page.getByRole('heading', { name: 'How teams use it' })).toHaveCount(0);
  });
});

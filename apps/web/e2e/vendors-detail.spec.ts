/**
 * AECI-59 / Phase 2.13 — vendor detail page end-to-end coverage.
 *
 * Two paths are covered here without depending on seeded data:
 *   1. 404 path (`/vendors/:slug` with a slug that isn't in the dev DB).
 *      Asserts the inline NotFound panel renders, the response is a real
 *      HTTP 404 (not the pinned-404 trap — see Stage 1 Spec §9.1b), and the
 *      cache headers honour `NOT_FOUND_TTL`.
 *   2. Placeholder CTAs (`/vendors/:slug/claim`, `/vendors/:slug/correction`)
 *      render the "Coming soon — Phase 6" panel with `<meta name="robots"
 *      content="noindex">`.
 *
 * The success-path coverage (hero / breadcrumbs / Cache-Tag with embedded
 * product tags / second-visit cache HIT) lives in the Phase 2.18 crawler
 * (AECI-64) and Phase 2.19 Lighthouse/axe harness (AECI-65) once those land
 * — they run against a seeded dev DB / preview deployment where the
 * assertions have data to bite on. This file is intentionally seed-free so
 * it stays green on `pnpm dev:bound` against an empty local DB and on
 * `pr-preview.yml` runs before the seed lands.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('vendor detail — 404 path', () => {
  test('GET /vendors/<bogus> returns a real HTTP 404 with NOT_FOUND_TTL', async ({ request }) => {
    const res = await request.get('/vendors/no-such-slug-aeci-59', {
      maxRedirects: 0,
    });

    expect(res.status(), 'must be a real 404 — never the pinned-404 trap').toBe(404);

    // §8.3 / §9.1b — 404s on cacheable routes get a short edge TTL.
    expect(res.headers()['cache-control']).toBe('public, max-age=60, s-maxage=60');

    // Per cache-tags.ts: 404s on cacheable routes skip Cache-Tag (they aren't
    // stored in the Worker's `caches.default` so the tag would never be a
    // purge target).
    expect(res.headers()['cache-tag']).toBeUndefined();
  });

  test('404 body renders the inline NotFound panel (i18n copy)', async ({ page }) => {
    const res = await page.goto('/vendors/no-such-slug-aeci-59');
    expect(res?.status()).toBe(404);

    // Eyebrow + headline from `vendor-not-found.ts`.
    await expect(page.getByText('404 — Not found', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: "We couldn't find a vendor with that slug." }),
    ).toBeVisible();

    await expect(page.getByRole('link', { name: 'Browse all vendors' })).toHaveAttribute(
      'href',
      /\/vendors$/,
    );
    await expect(page.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
  });

  test('404 panel carries noindex robots meta in the SSR HTML', async ({ request }) => {
    // Stage 1 Spec §9.1b + §20.7 — 404s must not be indexed.
    const res = await request.get('/vendors/no-such-slug-aeci-59');
    const html = await res.text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
  });

  test('404 page has zero axe violations at WCAG AA', async ({ page }) => {
    await page.goto('/vendors/no-such-slug-aeci-59');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});

test.describe('vendor detail — placeholder CTA routes (Phase 6 stubs)', () => {
  test('GET /vendors/<slug>/claim renders the Coming-Soon panel', async ({ page }) => {
    await page.goto('/vendors/anything/claim');
    await expect(page.getByText('Claim this listing', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Coming soon — Phase 6.' })).toBeVisible();
    await expect(page.getByRole('link', { name: '← Back to vendor' })).toHaveAttribute(
      'href',
      /\/vendors\/anything$/,
    );
  });

  test('GET /vendors/<slug>/claim ships noindex robots meta', async ({ request }) => {
    const html = await (await request.get('/vendors/anything/claim')).text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
  });

  test('GET /vendors/<slug>/correction renders the Coming-Soon panel', async ({ page }) => {
    await page.goto('/vendors/anything/correction');
    await expect(page.getByText('Suggest a correction', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Coming soon — Phase 6.' })).toBeVisible();
  });

  test('GET /vendors/<slug>/correction ships noindex robots meta', async ({ request }) => {
    const html = await (await request.get('/vendors/anything/correction')).text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
  });
});

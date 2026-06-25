/**
 * AECI-201 / Phase 5.10 — the Reviews section on the product detail page must
 * stay **edge-cache neutral**. The product page is cacheable and keyed only by
 * URL, so its server-rendered HTML must be identical for every visitor. The
 * approved-reviews list + summary are public and may be baked into the cached
 * SSR; the personalized submission CTA must NOT be — it hydrates client-side.
 *
 * These assertions read the **raw SSR HTML** (`request.get`, no JS), so they
 * see exactly what the edge caches:
 *   - the Reviews section + the neutral "Write a review" CTA are present;
 *   - the personalized labels ("Sign in to review" / "Submit a review") are
 *     ABSENT (they only appear after client hydration);
 *   - the response is `public`-cacheable (not `private, no-store`).
 *
 * Fixture-gated like `products-detail.spec.ts`: probes the product API and
 * self-skips when the dev DB has not seeded `fixture-procore`, so the file
 * stays green pre-seed.
 */
import { expect, request as playwrightRequest, test } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';
const PRODUCT_SLUG = 'fixture-procore';
const PRODUCT_PATH = `/products/${PRODUCT_SLUG}`;

let productSeeded = false;

test.beforeAll(async () => {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    const res = await ctx.get(`/api/products/${PRODUCT_SLUG}`, { maxRedirects: 0 });
    productSeeded = res.ok();
    if (!productSeeded) {
      console.warn(
        `[product-reviews] Fixture absent: GET /api/products/${PRODUCT_SLUG} -> ${res.status()}. ` +
          'Cache-neutrality tests SKIPPED. Seed the local D1 via ' +
          '`pnpm --filter @aeci/api db:seed:fixtures:local` (run automatically by `dev:bound`).',
      );
    }
  } finally {
    await ctx.dispose();
  }
});

test.describe('product reviews — SSR cache neutrality (AECI-201)', () => {
  test('SSR HTML ships the Reviews section + neutral CTA, never a personalized one', async ({
    request,
  }) => {
    test.skip(!productSeeded, 'fixture-procore not seeded — see beforeAll warning');

    const res = await request.get(PRODUCT_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    const html = await res.text();

    // The public reviews section is SSR'd (its heading anchors the in-page nav).
    expect(html).toContain('id="reviews"');
    expect(html).toContain('id="reviews-title"');

    // The CTA is baked in its NEUTRAL form only.
    expect(html).toContain('Write a review');

    // Visitor-specific labels must never be in the cached HTML — they hydrate
    // client-side (§8). This is the binding constraint for this issue.
    expect(html).not.toContain('Sign in to review');
    expect(html).not.toContain('Submit a review');
    expect(html).not.toContain("You've already reviewed");
  });

  test('the product page stays publicly cacheable (not private/no-store)', async ({ request }) => {
    test.skip(!productSeeded, 'fixture-procore not seeded — see beforeAll warning');

    const res = await request.get(PRODUCT_PATH, { maxRedirects: 0 });
    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl).toContain('public');
    expect(cacheControl).not.toContain('no-store');
  });

  test('a forged session cookie does not change the cached CTA region', async ({ request }) => {
    test.skip(!productSeeded, 'fixture-procore not seeded — see beforeAll warning');

    // The SSR render must not read the session on this cacheable route, so the
    // CTA stays neutral even when a session-shaped cookie is present.
    const withCookie = await request.get(PRODUCT_PATH, {
      maxRedirects: 0,
      headers: { cookie: 'sb-access-token=forged; sb-refresh-token=forged' },
    });
    const html = await withCookie.text();
    expect(html).toContain('Write a review');
    expect(html).not.toContain('Sign in to review');
    expect(html).not.toContain('Submit a review');
  });
});

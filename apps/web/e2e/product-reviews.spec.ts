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
import { E2E_BASE_URL as BASE_URL } from './base-url';

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

/**
 * AECI-1613 (`STAGE_1_SPEC.md` §4.7a): an approved reviewer update renders under
 * its review, and a rejected or pending one never reaches the page. Seeded by
 * `apps/api/seed/review-update-fixtures.sql` on Dynamo for Revit. Self-skips when
 * that seed is absent.
 */
const UPDATE_PRODUCT = 'dynamo-for-revit';
const UPDATED_REVIEW_ID = 'd0000000-0000-4000-8000-000000001110';
const UPDATED_REVIEW_TITLE = 'Graphs broke on every Revit upgrade';
const APPROVED_UPDATE_TEXT = 'Dynamo 3.2 fixed the upgrade breakage for us.';
const REJECTED_UPDATE_TEXT = 'Autodesk sent me a gift card';
const PENDING_UPDATE_TEXT = 'The 3.2 release made large graphs much faster.';

test.describe('product reviews — reviewer updates (AECI-1613)', () => {
  let updateSeeded = false;

  test.beforeAll(async () => {
    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      const res = await ctx.get(`/api/products/${UPDATE_PRODUCT}/reviews?perPage=100`);
      if (res.ok()) {
        const body = (await res.json()) as {
          data: Array<{ id: string; updates?: Array<{ body: string }> }>;
        };
        const review = body.data.find((r) => r.id === UPDATED_REVIEW_ID);
        updateSeeded = (review?.updates ?? []).some((u) => u.body.includes(APPROVED_UPDATE_TEXT));
      }
    } finally {
      await ctx.dispose();
    }
  });

  test('the public read carries only the approved update', async ({ request }) => {
    test.skip(!updateSeeded, 'review-update-fixtures.sql not seeded');
    const res = await request.get(`/api/products/${UPDATE_PRODUCT}/reviews?perPage=100`);
    const text = await res.text();
    expect(text).toContain(APPROVED_UPDATE_TEXT);
    expect(text).not.toContain(REJECTED_UPDATE_TEXT);
    expect(text).not.toContain(PENDING_UPDATE_TEXT);
  });

  test('the update renders under its review with its own date and new stars', async ({ page }) => {
    test.skip(!updateSeeded, 'review-update-fixtures.sql not seeded');
    await page.goto(`/products/${UPDATE_PRODUCT}`);
    const review = page.locator('article', {
      has: page.getByRole('heading', { name: UPDATED_REVIEW_TITLE, level: 3 }),
    });
    // The seeded review is older than the first page, so load more until it shows.
    const loadMore = page.getByRole('button', { name: 'Load more reviews' });
    for (let i = 0; i < 10 && (await review.count()) === 0; i++) {
      if ((await loadMore.count()) === 0) break;
      await loadMore.click();
      await page.waitForTimeout(300);
    }
    await expect(review).toHaveCount(1);

    const update = review.getByRole('region', { name: /^Update from the reviewer/ });
    await expect(update).toHaveCount(1);
    await expect(update).toContainText(APPROVED_UPDATE_TEXT);
    await expect(update.locator('time')).toHaveAttribute('datetime', '2026-09-20T10:00:00.000Z');
    await expect(update.getByRole('img', { name: 'Overall rating 4 out of 5' })).toBeVisible();
    // The original card keeps its own ratings.
    await expect(
      review.getByRole('img', { name: 'Overall rating 2 out of 5' }).first(),
    ).toBeVisible();
    await expect(page.getByText(REJECTED_UPDATE_TEXT)).toHaveCount(0);
  });
});

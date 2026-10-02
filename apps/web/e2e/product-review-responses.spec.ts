/**
 * AECI-1178: a published vendor reply renders under its review on the product
 * page (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.15).
 *
 * Runs against the local seed: `apps/api/seed/review-response-fixtures.sql` puts
 * five Autodesk replies on Dynamo for Revit, one per status. Only the published
 * one (on "The best way into computational design") may render. The others are
 * pending, rejected, withdrawn and removed, and their bodies must never reach the
 * page.
 *
 * Never count every reply on the page. `admin-review-responses.spec.ts` sorts
 * first and, when CI can mint an admin session, approves its own e2e reply
 * (…1158) on another Dynamo review. A page-wide count then reads 2. Assert
 * per article and per hidden body instead, so the spec holds in any order.
 *
 * Relative URLs only, so the spec follows the config's `baseURL` (and
 * `AECI_WEB_PORT` / `PLAYWRIGHT_BASE_URL`) instead of hardcoding 8788. Self-skips
 * when the fixture is not seeded, like `product-reviews.spec.ts`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const SLUG = 'dynamo-for-revit';
const PATH = `/products/${SLUG}`;
const PUBLISHED_REVIEW_TITLE = 'The best way into computational design';
const PUBLISHED_REPLY = 'The package manager was rebuilt in 3.0.';
/** Bodies of the pending, rejected, withdrawn and removed fixture replies. */
const HIDDEN_REPLIES = [
  'Dynamo 3.2 keeps graphs working',
  'we will give you a discount',
  'The documentation site now tracks each release.',
  'does not know how to use the product',
  // …1159, which the admin spec leaves pending or rejects. Never published.
  'Call our sales line on 555 0100',
];

let seeded = false;

test.beforeAll(async ({ playwright }, testInfo) => {
  // `request` is test-scoped, so build a context on the project's own baseURL.
  const ctx = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
  try {
    const res = await ctx.get(`/api/products/${SLUG}/reviews`, { maxRedirects: 0 });
    if (res.ok()) {
      const body = (await res.json()) as {
        data: Array<{ vendor_responses?: unknown[] }>;
      };
      seeded = body.data.some((r) => (r.vendor_responses ?? []).length > 0);
    }
  } finally {
    await ctx.dispose();
  }
  if (!seeded) {
    console.warn(
      `[product-review-responses] No published reply on ${SLUG}. Tests SKIPPED. ` +
        'Seed the local D1 with `pnpm db:seed:local` (review-response-fixtures.sql).',
    );
  }
});

test.describe('vendor reply under its review (AECI-1178)', () => {
  test('SSR HTML carries the published reply and none of the hidden ones', async ({ request }) => {
    test.skip(!seeded, 'review-response fixtures not seeded');

    const res = await request.get(PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain('Response from Autodesk');
    expect(html).toContain(PUBLISHED_REPLY);
    for (const hidden of HIDDEN_REPLIES) expect(html).not.toContain(hidden);
  });

  test('the reply renders inside its review article, labelled and dated, and passes axe', async ({
    page,
  }) => {
    test.skip(!seeded, 'review-response fixtures not seeded');

    await page.goto(PATH);
    const article = page.getByRole('article', { name: PUBLISHED_REVIEW_TITLE });
    await expect(article).toBeVisible();

    const reply = article.getByRole('region', { name: /^Response from Autodesk/ });
    await expect(reply).toBeVisible();
    await expect(reply).toContainText(PUBLISHED_REPLY);
    await expect(reply.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);

    // Exactly one reply in this review's article, and no unpublished reply
    // anywhere on the page. Not a page-wide count: see the header.
    await expect(article.locator('[data-testid="vendor-response"]')).toHaveCount(1);
    const replies = page.locator('[data-testid="vendor-response"]');
    for (const hidden of HIDDEN_REPLIES) {
      await expect(replies.filter({ hasText: hidden })).toHaveCount(0);
    }

    await reply.scrollIntoViewIfNeeded();
    const results = await new AxeBuilder({ page })
      .include('#reviews')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(blocking).toEqual([]);
  });
});

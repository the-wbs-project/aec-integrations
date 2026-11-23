/**
 * AECI-1178: a published vendor reply renders after its review text on the product
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

/**
 * AECI-1872 (ruling 42): the Review Guidelines say a response "appears after the
 * review text, in its own panel labeled "Response from" the company's name, with
 * the date it was published. It is never mixed with the reviewer's words." These
 * hold the four build conditions that keep that sentence true in the browser.
 */
test.describe('the reply panel keeps the Review Guidelines promise (AECI-1872)', () => {
  // (a) runs on the 1440px load that (b) makes first, so it costs no page load of its own.
  // It used the default desktop viewport before. 1440 is in the same layout band.
  test('(a) the review text comes first, and (b) the label and the date are visible', async ({
    page,
  }) => {
    test.skip(!seeded, 'review-response fixtures not seeded');
    const article = page.getByRole('article', { name: PUBLISHED_REVIEW_TITLE });
    const reply = article.locator('[data-testid="vendor-response"]');
    const labelAndDate = async () => {
      await reply.scrollIntoViewIfNeeded();
      await expect(reply.getByText('Response from Autodesk', { exact: true })).toBeVisible();
      await expect(reply.locator('time')).toBeVisible();
      await expect(reply.locator('time')).not.toBeEmpty();
    };

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PATH);

    await test.step('(a) the review text comes first and the reply is outside it', async () => {
      const original = article.locator('[data-testid="review-original"]');
      await expect(original).toBeVisible();
      await expect(original).not.toContainText(PUBLISHED_REPLY);
      const [o, r] = [await original.boundingBox(), await reply.boundingBox()];
      expect(o && r && r.y >= o.y + o.height).toBe(true);
    });

    await test.step('(b) the label and the date are visible whenever the reply is', async () => {
      await labelAndDate();
      await page.setViewportSize({ width: 390, height: 900 });
      await page.goto(PATH);
      await labelAndDate();
    });
  });

  test('(c) in forced-colors mode the panel keeps an edge and its label', async ({ browser }) => {
    test.skip(!seeded, 'review-response fixtures not seeded');
    const ctx = await browser.newContext({ forcedColors: 'active' });
    const page = await ctx.newPage();
    try {
      await page.goto(PATH);
      const reply = page
        .getByRole('article', { name: PUBLISHED_REVIEW_TITLE })
        .locator('[data-testid="vendor-response"]');
      await reply.scrollIntoViewIfNeeded();
      const edge = await reply.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          forced: matchMedia('(forced-colors: active)').matches,
          width: cs.borderTopWidth,
          style: cs.borderTopStyle,
          color: cs.borderTopColor,
        };
      });
      expect(edge.forced).toBe(true);
      expect(edge.width).toBe('1px');
      expect(edge.style).toBe('solid');
      // The system colours a transparent author border, so the edge shows.
      expect(edge.color).not.toBe('rgba(0, 0, 0, 0)');
      await expect(reply.getByText('Response from Autodesk', { exact: true })).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test('(d) structured data carries no reply text and no review text', async ({ request }) => {
    test.skip(!seeded, 'review-response fixtures not seeded');
    const html = await (await request.get(PATH, { maxRedirects: 0 })).text();
    const ld = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .join('\n');
    expect(ld).not.toContain(PUBLISHED_REPLY);
    expect(ld).not.toContain('Response from');
    expect(ld).not.toContain(PUBLISHED_REVIEW_TITLE);
    expect(ld).not.toMatch(/"@type":\s*"Review"|aggregateRating/);
  });
});

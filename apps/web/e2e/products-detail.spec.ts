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
 * — they run against a seeded dev DB / staging where the assertions
 * have data to bite on. This file is intentionally seed-free so it stays
 * green on `pnpm dev:bound` against an empty local DB.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, request as playwrightRequest, test } from '@playwright/test';
import { E2E_BASE_URL as BASE_URL } from './base-url';

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
    await expect(page.getByRole('heading', { name: 'Claim your company' })).toBeVisible();
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
  // the seed fixture (apps/api/seed/phase2-fixtures.sql): `fixture-procore`
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
            'Populated-state test will be SKIPPED. Seed the local D1 via ' +
            '`pnpm --filter @aeci/api db:seed:fixtures:local` (run automatically by `dev:bound`) ' +
            'after the AECI-171 migration.',
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

test.describe('product detail — table names and section-nav location (AECI-831)', () => {
  const SLUG = 'fixture-procore';
  let seeded = false;

  test.beforeAll(async () => {
    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      const res = await ctx.get(`/api/products/${SLUG}`, { maxRedirects: 0 });
      seeded = res.ok();
    } finally {
      await ctx.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(!seeded, `${SLUG} not seeded — run db:seed:fixtures:local`);
  });

  // A7: every integrations lane is its own table, named by its heading, so a
  // user moving by table can tell "Direct integrations" from "Via {connector}".
  test('every integrations table has a non-empty accessible name (A7)', async ({ page }) => {
    await page.goto(`/products/${SLUG}`);
    const tables = page.locator('aec-product-integrations-table table');
    await expect(tables.first()).toBeAttached();
    for (const table of await tables.all()) {
      await expect(table).toHaveAccessibleName(/\S/);
    }
  });

  // A8: the "On this page" nav always names exactly one current section.
  test('the section nav marks exactly one link aria-current="location" on load (A8)', async ({
    page,
  }) => {
    await page.goto(`/products/${SLUG}`);
    const nav = page.getByRole('navigation', { name: 'On this page' });
    await expect(nav.locator('a[aria-current="location"]')).toHaveCount(1);
  });
});

// AECI-1778 review: below md every hero action is on one line and 44px tall. From 480px
// to md they are equal columns. Below 480px they stack full width (AECI-1780), because two
// columns at 390px wrapped "Sign in to review" to two lines.
test.describe('product hero actions below md (AECI-1778)', () => {
  for (const width of [320, 390, 640]) {
    const stacked = width < 480;
    test(`at ${width}px "Visit website" and "Write a review" are ${stacked ? 'full width' : 'equal'} and on one line`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/products/fixture-procore');
      const band = page.locator('.aec-hero-band');
      await expect(band.locator('h1')).toBeVisible();
      // Computed sizes are read once every finite animation has finished.
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document
                .getAnimations()
                .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).length,
          ),
        )
        .toBe(0);
      // The hero's actions row only: the pair finder's button (AECI-1787) is not an action.
      const boxes = await band
        .getByTestId('hero-band-actions')
        .locator('[data-variant^="on-brand"]')
        .evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            // One line of label text: every visible text box of the label shares one row.
            // The sr-only new-tab note is a clipped 1px box, so text in it is skipped.
            const tops: number[] = [];
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
              const parent = n.parentElement!;
              if (!n.textContent!.trim() || parent.getBoundingClientRect().width <= 2) continue;
              const range = document.createRange();
              range.selectNodeContents(n);
              for (const q of range.getClientRects()) if (q.width > 0) tops.push(q.top);
            }
            tops.sort((x, y) => x - y);
            const lines = tops.filter((t, i) => i === 0 || t - tops[i - 1]! > 6).length;
            return {
              text: el.textContent!.trim(),
              width: r.width,
              height: r.height,
              lines,
            };
          }),
        );
      expect(boxes.map((b) => b.text)).toEqual([
        expect.stringContaining('Visit website'),
        // Signed-out visitors see either label, depending on the auth config of the stack.
        expect.stringMatching(/^(Write a review|Sign in to review)$/),
      ]);
      const [visit, review] = boxes;
      expect(Math.abs(visit!.width - review!.width), JSON.stringify(boxes)).toBeLessThanOrEqual(1);
      const row = await band
        .locator('[data-testid="hero-band-actions"]')
        .evaluate((el) => el.getBoundingClientRect().width);
      if (stacked) {
        // One column: each action spans the whole row, one under the other.
        for (const b of boxes) {
          expect(Math.abs(b.width - row), JSON.stringify(boxes)).toBeLessThanOrEqual(1);
        }
      } else {
        // Two equal columns of one row: each is about half the row, less the 12px gap.
        expect(Math.abs(visit!.width - (row - 12) / 2), JSON.stringify(boxes)).toBeLessThanOrEqual(
          1,
        );
      }
      for (const b of boxes) {
        expect(b.lines, `${b.text} at ${width}px: ${JSON.stringify(boxes)}`).toBe(1);
        expect(b.height).toBe(44);
      }
    });
  }
});

// AECI-1780: the About band holds the description and "Who it is for", on the Bone band.
// fixture-procore carries a description and audience terms in the e2e seed.
test.describe('product About band (AECI-1780)', () => {
  for (const [width, sideBySide] of [
    [1280, true],
    [390, false],
  ] as const) {
    test(`at ${width}px "Who it is for" sits ${sideBySide ? 'beside' : 'under'} the description`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/products/fixture-procore');
      const about = page.locator('#about');
      const description = about.locator('[data-testid="product-description"]');
      const panel = about.locator('[data-testid="product-who-it-is-for"]');
      await expect(description).toBeVisible();
      await expect(panel.getByRole('heading', { name: 'Who it is for' })).toBeVisible();
      // The facts card no longer holds the facets.
      await expect(page.locator('[data-testid="product-facts"] #audiences-label')).toHaveCount(0);
      const d = (await description.boundingBox())!;
      const p = (await panel.boundingBox())!;
      if (sideBySide) {
        expect(p.x).toBeGreaterThan(d.x + d.width - 1);
      } else {
        expect(p.y).toBeGreaterThanOrEqual(d.y + d.height);
      }
      // The band is the page's Bone band, and the panel is a white card on it.
      const ground = await page
        .locator('[data-testid="detail-lead-band"]')
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      const white = await page
        .locator('[data-testid="detail-body-band"]')
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      const card = await panel.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(ground).not.toBe(card);
      expect(card).toBe(white);
    });
  }
});

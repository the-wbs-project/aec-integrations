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
import { untilHydrated } from './hydration';
import { expectNoSidewaysScroll } from './no-sideways-scroll';

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
    // AECI-1720: the heading names the product ("How teams use {product}").
    const section = page.getByRole('region', { name: /^How teams use / });
    await expect(section.getByRole('heading', { level: 2, name: /^How teams use / })).toBeVisible();
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
    await expect(page.getByRole('heading', { name: /^How teams use / })).toHaveCount(0);
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
  // AECI-1782: cards are the default, so the lane lists are checked first, then the
  // tables after the reader picks "Table". The naming rule is the same for both.
  test('every integrations lane list and table has a non-empty accessible name (A7)', async ({
    page,
  }) => {
    await page.goto(`/products/${SLUG}`);
    const lists = page.locator(
      'aec-product-integration-cards > ul[data-testid="integration-cards"]',
    );
    await expect(lists.first()).toBeAttached();
    for (const list of await lists.all()) {
      await expect(list).toHaveAccessibleName(/\S/);
    }

    const toggle = page.locator('#integrations aec-listing-view-toggle button', {
      hasText: 'Table',
    });
    await untilHydrated(toggle);
    await toggle.click();
    const tables = page.locator('aec-product-integrations-table table');
    await expect(tables.first()).toBeAttached();
    for (const table of await tables.all()) {
      await expect(table).toHaveAccessibleName(/\S/);
    }
  });

  // AECI-1782: every row is in the server HTML as a card, and the filter panel works
  // in the browser without changing what the server sent.
  test('every integration is a card in the raw SSR HTML, and the panel filters in the browser', async ({
    page,
    request,
  }) => {
    const api = await (await request.get(`/api/products/${SLUG}`)).json();
    const rows = [...api.integrations_as_source, ...api.integrations_as_target] as {
      source: { slug: string };
      target: { slug: string };
      context_direction: string | null;
    }[];
    const html = await (await request.get(`/products/${SLUG}`)).text();
    for (const row of rows) {
      const other = row.source.slug === SLUG ? row.target.slug : row.source.slug;
      expect(html).toContain(`/products/${SLUG}/integrations/${other}`);
    }
    expect(html).toContain('data-testid="integrations-filter-panel"');

    await page.goto(`/products/${SLUG}`);
    // Idle, the status is empty (AECI-1720 kept it so): a row count beside the heading
    // can differ from the facts card's figure, which the 2026-11-16 ruling closed.
    const status = page.locator('#integrations [role="status"]');
    await expect(status).toHaveText('');
    // The first chip not pressed and not disabled: "Any direction" opens the direction row
    // pressed (AECI-1720 restore C), so pressing it again filters nothing.
    const chips = page.locator('#integrations aec-chip button[aria-pressed]');
    const free = page
      .locator('#integrations aec-chip button[aria-pressed="false"]:not([disabled])')
      .first();
    test.skip((await free.count()) === 0, 'no filter chips on this fixture');
    // Pin the chip by its index, so the locator does not move once it is pressed.
    const index = await free.evaluate((b) =>
      [...document.querySelectorAll('#integrations aec-chip button[aria-pressed]')].indexOf(b),
    );
    const chip = chips.nth(index);
    await untilHydrated(chip);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(status).toHaveText(/Showing \d+ of \d+/);
    await page.locator('[data-testid="integrations-filter-clear"]').click();
    await expect(status).toHaveText('');
  });

  // A8: the "On this page" nav always names exactly one current section.
  test('the section nav marks exactly one link aria-current="location" on load (A8)', async ({
    page,
  }) => {
    await page.goto(`/products/${SLUG}`);
    const nav = page.getByRole('navigation', { name: 'On this page' });
    await expect(nav.locator('a[aria-current="location"]')).toHaveCount(1);
  });

  // AECI-1856: a click names its own section, even one shorter than the spy's
  // band, where the next section used to take aria-current after the jump.
  test('a clicked section link stays aria-current after the jump (AECI-1856)', async ({ page }) => {
    await page.goto(`/products/${SLUG}`);
    await untilHydrated(page.locator('aec-section-nav'));
    const links = page
      .getByRole('navigation', { name: 'On this page' })
      .locator('a[data-section-id]');
    const count = await links.count();
    expect(count).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < count; i++) {
      const link = links.nth(i);
      await link.click();
      // Let the smooth scroll and the spy's callbacks finish.
      await page.waitForTimeout(800);
      await expect(link).toHaveAttribute('aria-current', 'location');
    }
  });

  // AECI-1856: in print the sticky bar and the metadata rail are static, so neither
  // prints over the page. On the redesign's band shell the facts card (the Metadata
  // aside) sits above the bar, so the check is that the two never overlap.
  test('the section nav and the metadata rail are static in print (AECI-1856)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/products/${SLUG}`);
    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.emulateMedia({ media: 'print' });
    const position = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).position);
    expect(await position('aec-section-nav')).toBe('static');
    expect(['static', 'relative']).toContain(await position('aside[aria-label="Metadata"]'));
    const navBox = await page.locator('aec-section-nav').boundingBox();
    const railBox = await page.locator('aside[aria-label="Metadata"]').first().boundingBox();
    expect(navBox && railBox).toBeTruthy();
    const apart =
      navBox!.y + navBox!.height <= railBox!.y || railBox!.y + railBox!.height <= navBox!.y;
    expect(apart).toBe(true);
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

/**
 * AECI-1785: "Similar products" is in the server HTML, A to Z, and absent with its
 * section-nav link when the list is empty. JavaScript is off, so this is what a
 * crawler and a first paint see.
 *
 * The catalog seed (`apps/api/seed/catalog.sql`) gives Trimble Accubid Classic two
 * products in its category, written with one timestamp. ConEst IntelliBid has the
 * higher id, so the old newest-first order (`created_at DESC, id ASC`) put McCormick
 * Estimating first and A to Z puts ConEst first. `fixture-acme-connector` has no
 * category, so it has no similar products. Both self-skip when the seed is absent.
 */
test.describe('product detail — Similar products (AECI-1785)', () => {
  test.use({ javaScriptEnabled: false });

  const WITH = 'trimble-accubid-classic';
  const WITHOUT = 'fixture-acme-connector';

  async function relatedNames(slug: string): Promise<string[] | null> {
    const api = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      const res = await api.get(`/api/products/${slug}`);
      if (!res.ok()) return null;
      const body = (await res.json()) as { related_products?: { name: string }[] };
      return body.related_products?.map((p) => p.name) ?? null;
    } finally {
      await api.dispose();
    }
  }

  test('renders in the server HTML, A to Z, with its nav link', async ({ page }) => {
    const names = await relatedNames(WITH);
    test.skip(names === null || names.length < 2, `seed missing: ${WITH} has ${names?.length}`);

    await page.goto(`/products/${WITH}`);
    const section = page.locator('section#similar');
    await expect(
      section.getByRole('heading', { level: 2, name: 'Similar products' }),
    ).toBeVisible();
    await expect(section.getByTestId('similar-products-order')).toHaveText('A to Z by name.');

    const shown = await section.locator('li a').allTextContents();
    const trimmed = shown.map((s) => s.trim());
    expect(trimmed).toEqual(names);
    expect(trimmed).toEqual(
      [...trimmed].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
    );
    expect(trimmed.slice(0, 2)).toEqual(['ConEst IntelliBid', 'McCormick Estimating']);

    await expect(page.locator('a[data-section-id="similar"]')).toHaveAttribute(
      'href',
      new RegExp(`/products/${WITH}#similar$`),
    );
  });

  test('is absent, with its nav link, when the list is empty', async ({ page }) => {
    const names = await relatedNames(WITHOUT);
    test.skip(names === null || names.length > 0, `seed missing: ${WITHOUT} has ${names?.length}`);

    await page.goto(`/products/${WITHOUT}`);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('#similar')).toHaveCount(0);
    await expect(page.locator('a[data-section-id="similar"]')).toHaveCount(0);
    await expect(page.locator('a[href$="#similar"]')).toHaveCount(0);
  });
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

// AECI-1720 restore: a long product name wraps at word boundaries beside the mark, at
// every width from 320px. The e2e seed has no long name, so the test sets one in place
// on the rendered page and reads where each word's letters land.
test.describe('product hero name wraps at word boundaries (AECI-1720)', () => {
  for (const width of [320, 360, 390, 768, 1024, 1440]) {
    test(`no word of a long name breaks mid-word at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/products/fixture-procore');
      await page.evaluate(() => document.fonts.ready);
      const broken = await page.locator('h1 > span').evaluate((span) => {
        span.textContent = 'Construction Management Platform Enterprise';
        const text = span.firstChild!;
        const out: string[] = [];
        for (const m of text.textContent!.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(text, m.index!);
          range.setEnd(text, m.index! + m[0].length);
          const tops = new Set(
            [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
          );
          if (tops.size > 1) out.push(m[0]);
        }
        return out;
      });
      expect(broken).toEqual([]);
      await expectNoSidewaysScroll(page);
    });
  }
});

// AECI-1925: the claim button reads "Claim Vendor" (Chris, 2026-11-18). The company name
// stays in the accessible name as visually hidden text, so several claim buttons can be
// told apart, and the name still starts with the visible words (WCAG 2.5.3).
/** The label a sighted reader sees: the element's text without its `.sr-only` parts. */
const visibleLabel = (el: Element): string => {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('.sr-only').forEach((n) => n.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
};
test.describe('product facts card claim button (AECI-1925)', () => {
  for (const width of [320, 1440]) {
    test(`reads "Claim Vendor" and names the company at ${width}px`, async ({ page, request }) => {
      const res = await request.get('/api/products/fixture-procore');
      const body = res.ok() ? ((await res.json()) as { vendor?: { name?: string } | null }) : null;
      const name = body?.vendor?.name;
      test.skip(!name, 'seed missing: fixture-procore has no vendor');
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/products/fixture-procore');
      const claim = page
        .getByTestId('product-facts-actions')
        .getByRole('link', { name: `Claim Vendor ${name}`, exact: true });
      await expect(claim).toBeVisible();
      await expect(claim).toHaveAccessibleName(`Claim Vendor ${name}`);
      expect(await claim.evaluate(visibleLabel)).toBe('Claim Vendor');
      await expectNoSidewaysScroll(page);
    });
  }
});

/**
 * AECI-2012 (Chris, 2026-11-23): "remove it from the sticky bar for now, but still show." The
 * ruling 41 trial tag is out of the stuck bar at every width. An unclaimed product still shows
 * the Unclaimed note in the hero, under its name. A claimed product shows no Unclaimed marking
 * anywhere. `revit` is an unclaimed product with a vendor, `fixture-acme-connector` one with no
 * vendor record, `fixture-procore` the claimed one.
 */
test.describe('product page Unclaimed marking: in the hero, never in the stuck bar (AECI-2012)', () => {
  test.beforeEach(async ({ page }) => {
    // Any PostHog request is answered here, so nothing leaves the machine.
    await page.route(
      (url) => url.hostname === 'posthog.com' || url.hostname.endsWith('.posthog.com'),
      (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );
  });

  for (const width of [1440, 390]) {
    for (const slug of ['revit', 'fixture-acme-connector', 'fixture-procore']) {
      test(`${slug} at ${width}px: the hero carries the note when unclaimed, the bar never`, async ({
        page,
        request,
      }) => {
        const res = await request.get(`/api/products/${slug}`);
        test.skip(!res.ok(), `seed missing: ${slug}`);
        const claim = ((await res.json()) as { claim_status?: string }).claim_status;
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/products/${slug}`);
        const note = page.locator('aec-hero-band aec-unclaimed-note');
        if (claim === 'unclaimed') {
          await expect(note).toHaveCount(1);
          await expect(note).toBeVisible();
          await expect(note).toBeInViewport();
          await expect(note).toHaveText(
            'Unclaimed · not affiliated with or endorsed by this vendor',
          );
        } else {
          await expect(page.locator('aec-unclaimed-note')).toHaveCount(0);
        }

        const nav = page.locator('aec-section-nav');
        test.skip((await nav.count()) === 0, `${slug} has too few sections for the bar`);
        await untilHydrated(nav);
        await page.evaluate(() => {
          const bar = document.querySelector('aec-section-nav')!;
          window.scrollTo({
            top: bar.getBoundingClientRect().top + window.scrollY + 600,
            behavior: 'instant',
          });
        });
        await expect(nav).toHaveAttribute('data-stuck', '');
        await expect(nav.getByTestId('section-nav-unclaimed')).toHaveCount(0);
        expect(await nav.evaluate((el) => (el as HTMLElement).innerText)).not.toContain(
          'Unclaimed',
        );
        await expectNoSidewaysScroll(page);
      });
    }
  }
});

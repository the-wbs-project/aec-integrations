/**
 * AECI-987: page width is not reading width. Routed pages sit on the standard
 * 7xl canvas (or, inside the docs shell, the full content column), and reading
 * measure applies to prose blocks only. `DESIGN.md` §3 "The Page-Width Rule".
 *
 * Geometry only, no pixel baselines (ruled 2026-10-23). For each page:
 *   - at 1280 and 1536 the canvas box is at least 1000px wide;
 *   - at 1280 a form's context rail sits beside the form, and a docs index runs
 *     two columns;
 *   - at 1023 and 375 the page is one column with no horizontal page scroll
 *     (1024 is the `lg` boundary, so it is never tested exactly);
 *   - a prose child stays at or under 75ch.
 *
 * `/account` and `/welcome` need a real session, so their layout is covered by
 * `account.component.spec.ts` and `welcome.component.spec.ts`.
 *
 * The review form 303s an anonymous visitor, so it reuses the dummy
 * `sb-…-auth-token` cookie and the seed-product probe from
 * `reviews-submission.spec.ts`. Paths are `baseURL`-relative: never hardcode a port.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';

const PRODUCT_SLUG = 'fixture-procore';

/** Add a dummy Supabase session cookie so the SSR presence gate passes. */
async function addAuthCookie(context: BrowserContext, baseURL: string): Promise<void> {
  const url = new URL(baseURL);
  await context.addCookies([
    {
      name: 'sb-localdev-auth-token',
      value: 'base64-e2e-page-width',
      domain: url.hostname,
      path: '/',
      secure: url.protocol === 'https:',
      sameSite: 'Lax',
    },
  ]);
}

/** Resolve a real pair from the live catalog, as `products-pair.spec.ts` does. */
async function findPair(request: APIRequestContext): Promise<string | null> {
  const res = await request.get('/api/integrations?perPage=25');
  if (!res.ok()) return null;
  const body = (await res.json()) as {
    data?: { source?: { slug?: string }; target?: { slug?: string } }[];
  };
  for (const row of body.data ?? []) {
    const context = row.source?.slug;
    const other = row.target?.slug;
    if (context && other && context !== other) {
      return `/products/${context}/integrations/${other}`;
    }
  }
  return null;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * `boundingBox()` does not wait, and hydration can replace a node that was just
 * visible, so a single read can return null. Retry the read until it lands.
 */
async function box(page: Page, selector: string): Promise<Box> {
  const target = page.locator(selector).first();
  let b: Box | null = null;
  await expect(async () => {
    b = await target.boundingBox();
    expect(b, `${selector} has a box`).not.toBeNull();
  }).toPass();
  return b!;
}

/** The first two items of a docs list, read together after hydration settles. */
async function firstTwo(page: Page, list: string): Promise<[Box, Box]> {
  const items = page.locator(`[data-testid="${list}"] > *`);
  let pair: [Box, Box] | null = null;
  await expect(async () => {
    const first = await items.nth(0).boundingBox();
    const second = await items.nth(1).boundingBox();
    expect(first, `${list} has a first item`).not.toBeNull();
    expect(second, `${list} has a second item`).not.toBeNull();
    pair = [first!, second!];
  }).toPass();
  return pair!;
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'no horizontal page scroll').toBeLessThanOrEqual(clientWidth);
}

/** The prose block's width against 75ch measured in its own font. */
async function proseWithinMeasure(page: Page, selector: string): Promise<void> {
  const { width, limit } = await page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.cssText = 'display:block;width:75ch;position:absolute;visibility:hidden';
      el.appendChild(probe);
      const limit = probe.getBoundingClientRect().width;
      probe.remove();
      return { width: el.getBoundingClientRect().width, limit };
    });
  expect(width, `${selector} stays within 75ch (${Math.round(limit)}px)`).toBeLessThanOrEqual(
    limit + 0.5,
  );
}

/** A form page with a context rail: canvas, rail beside or stacked, prose. */
function formPageSuite(name: string, path: string, prose: string, needsSession: boolean): void {
  test.describe(name, () => {
    test.beforeEach(async ({ context, baseURL, request }) => {
      if (!needsSession) return;
      const probe = await request.get(`/products/${PRODUCT_SLUG}`, { maxRedirects: 0 });
      test.skip(probe.status() !== 200, `seed product ${PRODUCT_SLUG} is absent`);
      await addAuthCookie(context, baseURL!);
    });

    for (const width of [1280, 1536]) {
      test(`takes the 7xl canvas at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await expect(page.locator('[data-testid="context-rail"]')).toBeVisible();
        expect((await box(page, '[data-testid="page-canvas"]')).width).toBeGreaterThanOrEqual(1000);
        await proseWithinMeasure(page, prose);
      });
    }

    test('docks the rail beside the form at 1280px', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path);
      const form = await box(page, '[data-testid="page-canvas"] form');
      const rail = await box(page, '[data-testid="context-rail"]');
      expect(rail.x, 'rail starts right of the form').toBeGreaterThanOrEqual(form.x + form.width);
      expect(rail.y, 'rail starts above the form ends').toBeLessThan(form.y + form.height);
    });

    for (const width of [1023, 375]) {
      test(`stacks into one column at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        const form = await box(page, '[data-testid="page-canvas"] form');
        const rail = await box(page, '[data-testid="context-rail"]');
        expect(Math.abs(rail.x - form.x), 'rail and form share a left edge').toBeLessThan(2);
        await noHorizontalScroll(page);
        await proseWithinMeasure(page, prose);
      });
    }
  });
}

formPageSuite(
  '/products/:slug/review',
  `/products/${PRODUCT_SLUG}/review`,
  '[data-testid="page-canvas"] p.max-w-prose',
  true,
);
formPageSuite(
  '/products/:slug/claim',
  `/products/${PRODUCT_SLUG}/claim`,
  '[data-testid="page-canvas"] p.max-w-prose',
  false,
);

/** A docs index page: canvas width, two columns from lg, prose measure. */
function docsIndexSuite(path: string, list: string): void {
  test.describe(path, () => {
    for (const width of [1280, 1536]) {
      test(`takes the docs content column at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        expect((await box(page, '[data-testid="page-canvas"]')).width).toBeGreaterThanOrEqual(1000);
        await proseWithinMeasure(page, '[data-testid="page-canvas"] header p');
      });
    }

    test('runs the list two columns at 1280px', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path);
      const [first, second] = await firstTwo(page, list);
      expect(Math.abs(first.y - second.y), 'first two items share a row').toBeLessThan(2);
      expect(second.x).toBeGreaterThan(first.x + first.width);
    });

    for (const width of [1023, 375]) {
      test(`stacks into one column at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        const [first, second] = await firstTwo(page, list);
        expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 1);
        await noHorizontalScroll(page);
        await proseWithinMeasure(page, '[data-testid="page-canvas"] header p');
      });
    }
  });
}

docsIndexSuite('/docs', 'docs-all-sections');
docsIndexSuite('/docs/reviewers', 'docs-section-pages');

test.describe('/products/:context/integrations/:other', () => {
  for (const width of [1280, 1536]) {
    test(`takes the 7xl canvas at ${width}px`, async ({ page, request }) => {
      const path = await findPair(request);
      test.skip(path === null, 'no integration in the local catalog to build a pair from');
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path!);
      expect((await box(page, '[data-testid="page-canvas"]')).width).toBeGreaterThanOrEqual(1000);
      await noHorizontalScroll(page);
      await proseWithinMeasure(page, '[data-testid="page-canvas"] header p');
    });
  }

  for (const width of [1023, 375]) {
    test(`has no horizontal page scroll at ${width}px`, async ({ page, request }) => {
      const path = await findPair(request);
      test.skip(path === null, 'no integration in the local catalog to build a pair from');
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path!);
      await noHorizontalScroll(page);
      await proseWithinMeasure(page, '[data-testid="page-canvas"] header p');
    });
  }
});

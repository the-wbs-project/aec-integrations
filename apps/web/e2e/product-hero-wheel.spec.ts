/**
 * AECI-2018: the integrations wheel in the product hero (DESIGN.md §5 "The hero
 * diagram", mock-up 9w). It replaced the AECI-1787 category hub and pair finder.
 *
 * Local seed data: `fixture-long-list` has 14 products in three categories plus one with
 * none, all unclaimed. `fixture-hybrid-via` has 25 products and no category: two rings
 * beside the text, one ring on a 390px phone, dots at 320px. `autocad` has no
 * integrations. The order and the geometry are pinned in the unit specs
 * (`on-page-ordering-firewall.spec.ts`, `integration-wheel.spec.ts`); this spec pins what
 * only a browser shows: the server HTML, stepping, the title list, the keyboard, the
 * card, the lines, no-script, motion, layout shift and axe.
 *
 * Every request off the local stack is answered here: PostHog with an empty 200, the
 * rest aborted. Nothing is submitted and nothing signs in.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { untilHydrated } from './hydration';
import { expectNoSidewaysScroll } from './no-sideways-scroll';

const LONG = 'fixture-long-list';
const MANY = 'fixture-hybrid-via';
const ZERO = 'autocad';
const ORDER_LINE = 'Shown A to Z. Position is not a ranking.';
const LOGO_LINE =
  'Logos identify products only and imply no endorsement or affiliation. Listings may be unclaimed.';
const DOTS_LINE = 'Too many to show as tiles. Each dot is one integration.';

async function offline(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return route.continue();
    if (/posthog/.test(host)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
}

test.beforeEach(async ({ context }) => offline(context));

const wheel = (page: Page) => page.getByTestId('product-hero-wheel');
const tiles = (page: Page) => page.getByTestId('product-hero-wheel-tile');

/**
 * The wheel is hydrated. `data-live` is set only by the hydrated component
 * (`afterNextRender`), so it is the hydration gate here. The layout itself is the
 * server's: the browser keeps the same width bands.
 */
async function live(page: Page): Promise<void> {
  await expect(wheel(page)).toHaveAttribute('data-live', '', { timeout: 15_000 });
}

test.describe('product hero integrations wheel (AECI-2018)', () => {
  test('the first slide is in the server HTML: a list of links, A to Z, one layout per width', async ({
    request,
  }) => {
    const res = await request.get(`/products/${LONG}`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="product-hero-wheel"');
    expect(html).not.toContain('data-testid="product-category-hub"');
    expect(html).not.toContain('data-testid="product-pair-finder"');
    // Every band's mode, and a position per band on each tile.
    for (const k of ['0', '1', '2', '3', '4']) expect(html).toMatch(new RegExp(`data-m${k}="one"`));
    expect(html).toMatch(/--x0:[^;"]+;--y0:[^;"]+;--x1:/);
    // The tiles: links to the pair pages, A to Z, with no tab index before hydration.
    const hrefs = [
      ...html.matchAll(/data-testid="product-hero-wheel-tile"[^>]*href="([^"]+)"/g),
    ].map((m) => m[1]!);
    const alt = [...html.matchAll(/href="([^"]+)"[^>]*data-testid="product-hero-wheel-tile"/g)].map(
      (m) => m[1]!,
    );
    const links = hrefs.length ? hrefs : alt;
    expect(links).toHaveLength(14);
    expect(links.every((h) => h.startsWith(`/products/${LONG}/integrations/`))).toBe(true);
    expect(html).not.toMatch(/data-testid="product-hero-wheel-tile"[^>]*tabindex/);
    // Both lines, always, on a tile slide.
    expect(html).toContain(ORDER_LINE);
    expect(html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')).toContain(LOGO_LINE);
  });

  test('steps with the arrows, announces the slide, and wraps', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/products/${LONG}`);
    await live(page);
    const title = page.getByTestId('product-hero-wheel-title');
    await expect(title).toContainText('All integrations');
    await expect(title).toContainText('14 products');
    const next = page.getByTestId('product-hero-wheel-next');
    await expect(next).toHaveAttribute('aria-label', 'Next category: Zz Fixture Category Alpha');
    await next.click();
    await expect(title).toContainText('Zz Fixture Category Alpha');
    await expect(page.getByTestId('product-hero-wheel-live')).toHaveText(
      /Zz Fixture Category Alpha, \d+ products\. 2 of 4\./,
    );
    // A to Z on the slide too.
    const names = await tiles(page).evaluateAll((as) =>
      as.map((a) => a.querySelector('.aec-wheel-label')!.textContent!.trim()),
    );
    expect(names).toEqual(
      [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
    );
    // Back twice wraps to the last category.
    await page.getByTestId('product-hero-wheel-prev').click();
    await page.getByTestId('product-hero-wheel-prev').click();
    await expect(title).toContainText('Zz Fixture Category Gamma');
  });

  test('the title opens a flat A to Z list that jumps, and Escape closes it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/products/${LONG}`);
    await live(page);
    const title = page.getByTestId('product-hero-wheel-title');
    await title.click();
    const list = page.getByRole('list', { name: 'Jump to a category' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('button')).toHaveText([
      /All integrations/,
      /Zz Fixture Category Alpha/,
      /Zz Fixture Category Beta/,
      /Zz Fixture Category Gamma/,
    ]);
    await expect(list.getByRole('button').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(list).toBeHidden();
    await expect(title).toContainText('Zz Fixture Category Beta');
    await expect(title).toBeFocused();
    await title.click();
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await expect(title).toHaveAttribute('aria-expanded', 'false');
  });

  test('the ring is one tab stop; arrows, Home and End move within it, wrapping', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/products/${LONG}`);
    await live(page);
    await page.getByTestId('product-hero-wheel-next').focus();
    await page.keyboard.press('Tab');
    await expect(tiles(page).first()).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(tiles(page).nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(tiles(page).last()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(tiles(page).first()).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(tiles(page).last()).toBeFocused();
    // One stop: Tab leaves the ring.
    await page.keyboard.press('Tab');
    await expect(tiles(page).last()).not.toBeFocused();
    expect(await tiles(page).evaluateAll((as) => as.filter((a) => a.tabIndex === 0).length)).toBe(
      1,
    );
  });

  test('the card: name, Unclaimed and vendor; toward the centre, inside the stage; Escape closes', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/products/${LONG}`);
    await live(page);
    for (const i of [0, 3, 7, 10]) {
      const tile = tiles(page).nth(i);
      await tile.hover();
      const card = page.getByTestId('product-hero-wheel-card');
      await expect(card).toBeVisible();
      // Measured after the hover, which may have scrolled the page.
      const stage = await page.locator('.aec-wheel-stage').boundingBox();
      const name = (await tile.locator('.aec-wheel-label').textContent())!.trim();
      await expect(card).toContainText(name);
      // The seed's partners are unclaimed, so the card says so, read with the name.
      await expect(card.getByTestId('product-hero-wheel-card-unclaimed')).toHaveText('Unclaimed');
      const box = (await card.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(stage!.y - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);
      // Toward the centre: the card's centre is nearer the wheel's centre than the tile's.
      const t = (await tile.boundingBox())!;
      const cx = stage!.x + stage!.width / 2;
      const cy = stage!.y + stage!.height / 2;
      const dist = (x: number, y: number) => Math.hypot(x - cx, y - cy);
      expect(dist(box.x + box.width / 2, box.y + box.height / 2)).toBeLessThan(
        dist(t.x + t.width / 2, t.y + t.height / 2),
      );
    }
    // Hoverable: the pointer can travel onto the card.
    await page.getByTestId('product-hero-wheel-card').hover();
    await expect(page.getByTestId('product-hero-wheel-card')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('product-hero-wheel-card')).toHaveCount(0);
    // WCAG 1.4.13: a press outside the card and its tile closes it too.
    await tiles(page).nth(2).hover();
    await expect(page.getByTestId('product-hero-wheel-card')).toBeVisible();
    await page.locator('h1').click();
    await expect(page.getByTestId('product-hero-wheel-card')).toHaveCount(0);
  });

  test('the two lines under a tile slide, the one dots line under a dots slide', async ({
    browser,
  }) => {
    for (const [width, slug, dots] of [
      [1440, LONG, false],
      [320, MANY, true],
    ] as const) {
      const ctx = await browser.newContext({ viewport: { width, height: 1200 } });
      await offline(ctx);
      const page = await ctx.newPage();
      await page.goto(`/products/${slug}`);
      await live(page);
      const tilesLines = page.getByTestId('product-hero-wheel-lines');
      const dotsLine = page.getByTestId('product-hero-wheel-dots-line');
      if (dots) {
        await expect(dotsLine).toBeVisible();
        await expect(dotsLine).toHaveText(DOTS_LINE);
        await expect(tilesLines).toBeHidden();
        // No category on record, so the centre says only how many integrations.
        await expect(page.getByTestId('product-hero-wheel-hub-count')).toHaveText(
          /^\s*25\s+integrations\s*$/,
        );
        // One slide (no category), so the static title names it.
        await expect(page.getByTestId('product-hero-wheel-static-title')).toContainText(
          '25 products',
        );
      } else {
        await expect(tilesLines).toBeVisible();
        await expect(tilesLines).toContainText(ORDER_LINE);
        await expect(tilesLines).toContainText('Logos identify products only');
        await expect(tilesLines).toContainText('Listings may be unclaimed.');
        await expect(dotsLine).toBeHidden();
        // The same size, weight and colour.
        const styles = await tilesLines.locator('.aec-wheel-line').evaluateAll((els) =>
          els.map((el) => {
            const s = getComputedStyle(el);
            return `${s.fontSize} ${s.fontWeight} ${s.color}`;
          }),
        );
        expect(new Set(styles).size).toBe(1);
      }
      await ctx.close();
    }
  });

  // A phone has an overlay scrollbar. Headless Chromium draws a 15px one, which takes a
  // 390px viewport's stage from 294px to 279px, one product short of 25 on one ring. So
  // the phone case runs at 414px: a 303px stage, still a phone (under 320px).
  test('two rings beside the text, one ring on a phone', async ({ browser }) => {
    for (const [width, mode] of [
      [1440, 'two'],
      [414, 'one'],
    ] as const) {
      const ctx = await browser.newContext({ viewport: { width, height: 1200 } });
      await offline(ctx);
      const page = await ctx.newPage();
      await page.goto(`/products/${MANY}`);
      await live(page);
      await expect(tiles(page)).toHaveCount(25);
      // Rings, read off the painted tiles: how many distinct radii their centres sit on.
      const rings = await page.locator('.aec-wheel-stage').evaluate((stage) => {
        const s = stage.getBoundingClientRect();
        const cx = s.left + s.width / 2;
        const cy = s.top + s.height / 2;
        const radii = [...stage.querySelectorAll('.aec-wheel-tile')].map((a) => {
          const r = a.getBoundingClientRect();
          return Math.round(Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy));
        });
        return new Set(radii.map((r) => Math.round(r / 4))).size;
      });
      expect(rings, mode).toBe(mode === 'two' ? 2 : 1);
      await ctx.close();
    }
  });

  test('with no script a 320px phone gets the static title and tiles no smaller than 24px', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      viewport: { width: 320, height: 1200 },
      javaScriptEnabled: false,
    });
    await offline(ctx);
    const page = await ctx.newPage();
    await page.goto(`/products/${LONG}`);
    await expect(page.getByTestId('product-hero-wheel-static-title')).toBeVisible();
    await expect(page.getByTestId('product-hero-wheel-title')).toBeHidden();
    await expect(page.getByTestId('product-hero-wheel-next')).toBeHidden();
    const sizes = await tiles(page).evaluateAll((as) =>
      as.map((a) => a.getBoundingClientRect().width),
    );
    expect(sizes).toHaveLength(14);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(24);
    // Inside the stage: no tile spills out of the wheel.
    const stage = (await page.locator('.aec-wheel-stage').boundingBox())!;
    for (const box of await tiles(page).evaluateAll((as) =>
      as.map((a) => {
        const r = a.getBoundingClientRect();
        return { x: r.x, right: r.right };
      }),
    )) {
      expect(box.x).toBeGreaterThanOrEqual(stage.x - 1);
      expect(box.right).toBeLessThanOrEqual(stage.x + stage.width + 1);
    }
    await expectNoSidewaysScroll(page);
    await ctx.close();
  });

  // The AECI-1839 trap: under `<base href="/">` a bare `#integrations` resolves to
  // `/#integrations`, the home page.
  test("with no script a dots slide's link stays on the product page", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 320, height: 1200 },
      javaScriptEnabled: false,
    });
    await offline(ctx);
    const page = await ctx.newPage();
    await page.goto(`/products/${MANY}`);
    const link = page.getByTestId('product-hero-wheel-see-all');
    await expect(link).toBeVisible();
    const resolved = await link.evaluate((a) => (a as HTMLAnchorElement).href);
    expect(new URL(resolved).pathname).toBe(`/products/${MANY}`);
    expect(new URL(resolved).hash).toBe('#integrations');
    await ctx.close();
  });

  // Ranking page 1.2: "A product with no integration of its own has no wheel." A product
  // with none at all, and a pure connector (`fixture-connector-hub` powers 39 pairs between
  // other products and is an endpoint of none), get no wheel and no hero panel: the text
  // column is the whole hero, with nothing beside it and no sideways scroll.
  for (const width of [1440, 375]) {
    test(`no integration of its own: no wheel and no panel at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const slug of [ZERO, 'fixture-connector-hub']) {
        await page.goto(`/products/${slug}`);
        await expect(wheel(page), slug).toHaveCount(0);
        await expect(page.locator('.aec-hero-panel'), slug).toBeHidden();
        const grid = (await page.getByTestId('hero-band-grid').boundingBox())!;
        const text = (await page.getByTestId('hero-band-text').boundingBox())!;
        expect(Math.abs(text.width - grid.width), slug).toBeLessThan(2);
        await expectNoSidewaysScroll(page);
      }
    });
  }

  test('one entrance, and none under reduced motion', async ({ browser }) => {
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      const ctx = await browser.newContext({
        reducedMotion,
        viewport: { width: 1280, height: 900 },
      });
      await offline(ctx);
      const page = await ctx.newPage();
      await page.goto(`/products/${LONG}`);
      const name = await page
        .locator('.aec-wheel-art')
        .evaluate((el) => getComputedStyle(el).animationName);
      if (reducedMotion === 'reduce') expect(name).toBe('none');
      else {
        // Unless it already finished and settled the wheel.
        const settled = await wheel(page).evaluate((el) => el.hasAttribute('data-settled'));
        expect(settled ? 'none' : name).toBe(settled ? 'none' : 'aec-wheel-in');
      }
      await ctx.close();
    }
  });

  // Every layout-shift source on the page counts after the wheel hydrates, not only the
  // wheel's. The seed's products cover the boundaries: 7 products (one ring, names under
  // the tiles), 14 (one ring), 21 and 24 (one ring on a phone, two from 336) and 25 (dots
  // on a narrow phone, one ring at 294). 360 and 430 are the widths where a server band and
  // a measured layout used to disagree.
  //
  // The web fonts are blocked here, and that is the one thing excluded. When a web font
  // arrives, every line of text on the page re-measures: the header nav, the hero name, the
  // consent banner and the wheel's text alike, on a page with no wheel too. AECI-1892 keeps
  // that swap still with size-matched fallback faces built on Georgia and Arial, which
  // Linux CI does not have, so there the swap moves text (seen at about 300ms in run
  // 45347285193). That is the font-loading spec's subject, and it skips on Linux for the
  // same reason. With no web font the text never swaps, so any shift left is layout: the
  // server bands, hydration, the names space, the title row.
  const SHIFT_SLUGS = [
    'fx-procore',
    LONG,
    'fixture-connector-lists-hub-two',
    'fixture-connector-lists-hub-one',
    MANY,
  ];
  for (const width of [1280, 1024, 430, 390, 375, 360, 320]) {
    test(`no layout shift anywhere on the page at ${width}px`, async ({ page }) => {
      // Five page loads, each waiting for the network to settle.
      test.setTimeout(120_000);
      await page.route(/\.woff2(\?|$)/, (route) => route.abort());
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => {
        type Entry = { t: number; value: number; sources: string[]; inWheel: boolean };
        const w = window as unknown as { __entries: Entry[]; __hydratedAt: number | null };
        w.__entries = [];
        w.__hydratedAt = null;
        // When the wheel hydrates (`data-live` appears).
        new MutationObserver(() => {
          if (w.__hydratedAt === null && document.querySelector('.aec-wheel[data-live]')) {
            w.__hydratedAt = performance.now();
          }
        }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-live'] });
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as unknown as {
            startTime: number;
            value: number;
            hadRecentInput: boolean;
            sources?: { node?: Node | null }[];
          }[]) {
            if (e.hadRecentInput) continue;
            const nodes = (e.sources ?? []).map((s) => s.node ?? null);
            w.__entries.push({
              t: e.startTime,
              value: e.value,
              sources: nodes.map((n) =>
                n instanceof Element
                  ? `${n.tagName}.${String(n.className).slice(0, 40)}`
                  : String(n?.textContent ?? n).slice(0, 40),
              ),
              inWheel: nodes.some((n) => {
                const el = n instanceof Element ? n : (n?.parentElement ?? null);
                return !!el?.closest('.aec-wheel');
              }),
            });
          }
        }).observe({ type: 'layout-shift', buffered: true });
      });
      for (const slug of SHIFT_SLUGS) {
        await page.goto(`/products/${slug}`, { waitUntil: 'networkidle' });
        await live(page);
        // A fixed wait on purpose: the observer needs a window to watch.
        await page.waitForTimeout(600);
        const { entries, hydratedAt } = await page.evaluate(() => {
          const w = window as unknown as {
            __entries: { t: number; value: number; sources: string[]; inWheel: boolean }[];
            __hydratedAt: number | null;
          };
          return { entries: w.__entries, hydratedAt: w.__hydratedAt };
        });
        const describe = (list: typeof entries) =>
          list.map((e) => `${Math.round(e.t)}ms ${e.value.toFixed(4)} ${e.sources.join(' | ')}`);
        // From hydration on, nothing on the page may move: every source counts.
        const after = entries.filter((e) => hydratedAt !== null && e.t >= hydratedAt);
        expect(
          after.reduce((sum, e) => sum + e.value, 0),
          `${slug} after hydration: ${describe(after).join('; ')}`,
        ).toBeLessThan(0.001);
        // At any time, before hydration or after, no node of the wheel moves on its own:
        // a shift whose sources include the wheel's title, stage, tiles or lines fails. A
        // shift of the hero above it that carries the whole panel down (AECI-2054, the
        // first-paint hero text shift on narrow phones, seen on pages with no wheel too)
        // names the panel, not the wheel's nodes, and is reported, not failed here.
        expect(
          entries.filter((e) => e.inWheel),
          `${slug}: ${describe(entries).join('; ')}`,
        ).toEqual([]);
        test.info().annotations.push({
          type: 'layout-shift',
          description: `${width}px ${slug}: ${describe(entries).join('; ') || 'none'}`,
        });
        await expectNoSidewaysScroll(page);
      }
    });
  }

  test('no axe violations with the title list open and with a card open (WCAG 2.2 AA)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/products/${LONG}`);
    await live(page);
    const axe = () =>
      new AxeBuilder({ page })
        .include('aec-hero-band')
        .include('.cdk-overlay-container')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
    await page.getByTestId('product-hero-wheel-title').click();
    await expect(page.getByRole('list', { name: 'Jump to a category' })).toBeVisible();
    expect((await axe()).violations, 'list open').toEqual([]);
    await page.keyboard.press('Escape');
    await tiles(page).first().focus();
    await expect(page.getByTestId('product-hero-wheel-card')).toBeVisible();
    expect((await axe()).violations, 'card open').toEqual([]);
  });

  for (const width of [1440, 390, 375, 320]) {
    test(`the hero has no axe violations at ${width}px (WCAG 2.2 AA)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      for (const slug of [LONG, MANY, ZERO]) {
        await page.goto(`/products/${slug}`);
        await untilHydrated(page.locator('aec-hero-band'));
        const results = await new AxeBuilder({ page })
          .include('aec-hero-band')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(results.violations, slug).toEqual([]);
      }
    });
  }
});

/**
 * AECI-1854: first paint equals final paint.
 *
 * The SSR Worker inlines a page's critical CSS (Beasties, run by Angular SSR)
 * and loads the full `styles-*.css` late, without blocking render. Until that
 * file arrives the page paints with the inlined subset alone. Two Beasties
 * defects made that subset wrong on every page:
 *
 * - 0.5.4 wrote `;` after each `@property` rule. The browser then dropped the
 *   rule after each `;`: 78 of 80 `@property` rules and the whole `:root`
 *   token block. Every `var(--token)` was empty at first paint.
 * - It drops a rule whose selector is wholly `:where(…)`, so every Tailwind
 *   `space-*` and `divide-*` rule was missing.
 *
 * `pnpm-workspace.yaml` pins beasties 0.5.5 and patches the second defect. This
 * spec guards both. The first test parses the inlined CSS the way the browser
 * does. The next renders the server HTML with scripts off, once with the full
 * stylesheet blocked and once with it loaded. Every element must paint the same
 * in both. Content that only appears after hydration is out of scope here: its
 * rules are never in the critical CSS. Rule for authors: `ANGULAR_STYLE_GUIDE.md`
 * "First paint and critical CSS".
 *
 * Paths are `baseURL`-relative: never hardcode a port.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

const STYLESHEET = /\/styles-[^/]+\.css(?:\?|$)/;

const PAGES = [
  '/',
  '/products',
  '/products/revit',
  '/products/revit/integrations/procore',
  '/docs',
  '/vendor-program',
];

/** Tokens a first paint cannot do without. Each must be set on `:root`. */
const TOKENS = [
  '--t-fig',
  '--accent-primary',
  '--surface-base',
  '--text-primary',
  '--border-field',
  '--radius-control',
];

test.describe('the inlined critical CSS (AECI-1854)', () => {
  test('parses whole: every @property rule and the :root token block survive', async ({
    page,
    request,
    baseURL,
  }) => {
    const html = await (await request.get('/')).text();
    const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1])
      .find((text) => text.startsWith('@layer'));
    expect(css, 'the server HTML inlines a critical stylesheet').toBeTruthy();

    // Parse with the browser's own CSS parser, as the page does.
    await page.goto(`${baseURL}/robots.txt`);
    const parsed = await page.evaluate(
      ({ text, tokens }) => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(text);
        let propertyRules = 0;
        const rootValues: Record<string, string> = {};
        const walk = (rules: CSSRuleList) => {
          for (const rule of Array.from(rules)) {
            if (rule instanceof CSSPropertyRule) propertyRules++;
            if (rule instanceof CSSStyleRule && rule.selectorText === ':root') {
              for (const token of tokens) {
                const value = rule.style.getPropertyValue(token).trim();
                if (value) rootValues[token] = value;
              }
            }
            if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
          }
        };
        walk(sheet.cssRules);
        return { propertyRules, rootValues };
      },
      { text: css!, tokens: TOKENS },
    );

    const declared = (css!.match(/@property\s/g) ?? []).length;
    expect(declared, 'Tailwind registers its variables with @property').toBeGreaterThan(0);
    expect(parsed.propertyRules, 'every @property rule parses').toBe(declared);
    expect(css!, 'no stray ";" between top-level rules').not.toMatch(/\}\s*;/);
    for (const token of TOKENS) expect(parsed.rootValues[token], `${token} on :root`).toBeTruthy();
    // The home page uses `space-y-*`. Tailwind writes it as a selector that is
    // wholly `:where(…)`, which unpatched beasties drops. This line fails if
    // `patches/beasties@0.5.5.patch` stops applying.
    expect(css!, 'space-y rules reach the critical CSS').toMatch(/:where\(\.space-y-[\w.\\-]+>/);
    // A selector that is only a pseudo-element has no element part to match, so
    // unpatched beasties dropped it too: the placeholder painted in the
    // `placeholder:` utility's colour until the full stylesheet's unlayered
    // `::placeholder` rule arrived. This line fails if that half of the patch goes.
    expect(css!, 'the unlayered ::placeholder rule reaches the critical CSS').toMatch(
      /(?:^|[}\s])::placeholder\s*\{\s*color:\s*var\(--text-tertiary\)/,
    );
  });
});

/**
 * The whole page (AECI-1854 audit). Scripts off, so both runs hold exactly the
 * server HTML. Every element must keep its box, display, visibility, opacity,
 * transform, background, colour and corner radius, and a screenshot of the first
 * screen must match, up to raster noise (see RASTER_NOISE_PIXELS), whether or not
 * the full stylesheet has loaded. Content that renders only after hydration (the
 * consent banner) is not in this DOM: its rules come from the full stylesheet alone.
 *
 * Each run first proves its stylesheet state. Without that check a renamed
 * stylesheet would slip past the block, and the test would compare a loaded page
 * with a loaded page and pass. AECI-2027 folded the old four-element test into
 * this one: its stylesheet check, its corner radius and its header and heading
 * check now live here.
 */
interface ElementPaint {
  d: string;
  v: string;
}

async function wholePage(
  browser: Browser,
  url: string,
  width: number,
  stylesheet: 'blocked' | 'loaded',
): Promise<{
  elements: ElementPaint[];
  shot: Buffer;
  shown: { header: boolean; heading: boolean };
}> {
  // Scripts off in both runs, so the DOM is exactly the server HTML: no
  // hydration, no client-only content. The full stylesheet then arrives through
  // the `<noscript>` link, which is what a visitor's browser applies once the
  // late `styles-*.css` loads.
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    javaScriptEnabled: false,
  });
  const page = await context.newPage();
  if (stylesheet === 'blocked') await page.route(STYLESHEET, (route) => route.abort());
  await page.goto(url, { waitUntil: 'load' });
  // An aborted sheet stays in `document.styleSheets` but its rules throw.
  const applied = await page.evaluate(() =>
    Array.from(document.styleSheets).some((s) => {
      if (!/styles-[^/]+\.css/.test(s.href ?? '') || s.media.mediaText === 'print') return false;
      try {
        return s.cssRules.length > 0;
      } catch {
        return false;
      }
    }),
  );
  expect(applied, `the full stylesheet is ${stylesheet}`).toBe(stylesheet === 'loaded');
  // Fonts are inlined in both runs; wait for them and for any transition the
  // full stylesheet started, so both reads see a settled frame.
  await page.evaluate(async () => {
    await document.fonts.ready;
    // An infinite animation (a spinner, a pulse) never finishes, so it is not waited on.
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
  });
  const elements = await page.evaluate(() =>
    Array.from(document.body.querySelectorAll('*')).map((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).slice(0, 4).join('.');
      return {
        d: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`,
        v: [
          [r.x, r.y + scrollY, r.width, r.height].map((n) => Math.round(n)).join(','),
          s.display,
          s.visibility,
          s.opacity,
          s.transform,
          s.backgroundColor,
          s.color,
          s.borderTopLeftRadius,
          // AECI-2088: a border colour that drifts between first and final paint.
          s.borderTopColor,
          s.borderRightColor,
          s.borderBottomColor,
          s.borderLeftColor,
        ].join(' | '),
      };
    }),
  );
  // The header and the first heading render, so the comparison is never empty.
  const shown = await page.evaluate(() => {
    const visible = (el: Element | null) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    return {
      header: visible(document.querySelector('aec-site-header header')),
      heading: visible(document.querySelector('main h1')),
    };
  });
  const shot = await page.screenshot();
  await context.close();
  return { elements, shot, shown };
}

/**
 * Raster noise the screenshot comparison accepts, and nothing more. In CI (Linux,
 * software rendering) two paints of the same DOM and the same computed styles can
 * antialias a rounded corner one level apart. Run 45007653563 (2026-11-22) showed it
 * on `/products/revit` at 1440px: exactly 10 pixels, every one on the two right corners
 * of the "Suggest a correction" button (x 1226 to 1227, y 630 to 658), each off by 1 in
 * one or more channels. Every computed property and every unrounded box on the page
 * matched between the two runs. A third screenshot of the page from the same CI run (the
 * one Playwright keeps when a context closes) differed from both compared screens at
 * other rounded corners, again by 1 level. A level of 1 in 255 at a
 * corner pixel is not visible to a reader. So a pixel may differ by at most 1 per
 * channel, and at most 32 pixels may differ. A real first-paint change moves a colour
 * by many levels (the `::placeholder` defect moved text by about 30) or covers a
 * region, and still fails.
 */
const RASTER_NOISE_DELTA = 1;
const RASTER_NOISE_PIXELS = 32;

interface PixelDiff {
  /** Pixels whose colour differs at all. */
  differ: number;
  /** The largest difference in any one channel, 0 to 255. */
  maxDelta: number;
  /** Each differing pixel: `(x,y) r,g,b -> r,g,b`, at most 200. */
  pixels: string[];
  /** A PNG the size of the screenshot: differing pixels in red on the first shot, dimmed. */
  diffPng: string;
}

/** Compare two same-size PNG screenshots, decoded in a page. */
async function pixelDiff(page: Page, a: Buffer, b: Buffer): Promise<PixelDiff> {
  return page.evaluate(
    async ([one, two]) => {
      const load = async (b64: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return { data: ctx.getImageData(0, 0, img.width, img.height).data, canvas, ctx };
      };
      const [x, y] = await Promise.all([load(one), load(two)]);
      const w = x.canvas.width;
      if (x.data.length !== y.data.length) {
        return { differ: Infinity, maxDelta: 255, pixels: ['size differs'], diffPng: '' };
      }
      const out = x.ctx.createImageData(w, x.canvas.height);
      let differ = 0;
      let maxDelta = 0;
      const pixels: string[] = [];
      for (let i = 0; i < x.data.length; i += 4) {
        const d = Math.max(
          Math.abs(x.data[i]! - y.data[i]!),
          Math.abs(x.data[i + 1]! - y.data[i + 1]!),
          Math.abs(x.data[i + 2]! - y.data[i + 2]!),
        );
        if (d > 0) {
          differ++;
          maxDelta = Math.max(maxDelta, d);
          if (pixels.length < 200) {
            const p = i / 4;
            pixels.push(
              `(${p % w},${Math.floor(p / w)}) ${x.data[i]},${x.data[i + 1]},${x.data[i + 2]} -> ${y.data[i]},${y.data[i + 1]},${y.data[i + 2]}`,
            );
          }
          out.data.set([255, 0, 0, 255], i);
        } else {
          out.data.set([x.data[i]! / 3, x.data[i + 1]! / 3, x.data[i + 2]! / 3, 255], i);
        }
      }
      x.ctx.putImageData(out, 0, 0);
      const diffPng = x.canvas.toDataURL('image/png').split(',')[1] ?? '';
      return { differ, maxDelta, pixels, diffPng };
    },
    [a.toString('base64'), b.toString('base64')] as const,
  );
}

test.describe('the whole server-rendered page paints the same before the stylesheet (AECI-1854)', () => {
  for (const path of PAGES) {
    for (const width of [1440, 390]) {
      test(`${path} at ${width}px`, async ({ browser, baseURL, page }, testInfo) => {
        const url = `${baseURL}${path}`;
        const first = await wholePage(browser, url, width, 'blocked');
        const final = await wholePage(browser, url, width, 'loaded');
        expect(final.shown, 'the header and heading render').toEqual({
          header: true,
          heading: true,
        });
        expect(first.elements.length, 'the same server HTML in both runs').toBe(
          final.elements.length,
        );
        const changed = final.elements
          .map((el, i) =>
            el.v === first.elements[i]!.v ? null : `${el.d}: ${first.elements[i]!.v} -> ${el.v}`,
          )
          .filter((line): line is string => line !== null);
        expect(changed, 'elements that change when the stylesheet lands').toEqual([]);
        await page.goto(`${baseURL}/robots.txt`);
        const diff = await pixelDiff(page, first.shot, final.shot);
        if (diff.differ > 0) {
          // The evidence for a reviewer: both screens, the differing pixels in red, and
          // each pixel's colour in both runs.
          await testInfo.attach('first-paint-blocked.png', {
            body: first.shot,
            contentType: 'image/png',
          });
          await testInfo.attach('first-paint-loaded.png', {
            body: final.shot,
            contentType: 'image/png',
          });
          if (diff.diffPng) {
            await testInfo.attach('first-paint-diff.png', {
              body: Buffer.from(diff.diffPng, 'base64'),
              contentType: 'image/png',
            });
          }
          await testInfo.attach('first-paint-pixels.txt', {
            body: diff.pixels.join('\n'),
            contentType: 'text/plain',
          });
        }
        const detail = `max channel delta ${diff.maxDelta}: ${diff.pixels.slice(0, 20).join('; ')}`;
        // No pixel may change by more than one level in any channel.
        expect(diff.maxDelta, `first screen pixel colour (${detail})`).toBeLessThanOrEqual(
          RASTER_NOISE_DELTA,
        );
        expect(diff.differ, `first screen pixels (${detail})`).toBeLessThanOrEqual(
          RASTER_NOISE_PIXELS,
        );
      });
    }
  }
});

/**
 * The two shifts PR #1328 left open, with scripts on and the full stylesheet held
 * back 1.5s, cold, so hydration and the data run while the page has only the
 * inlined CSS. The home "Most viewed" row was a data shift: it filled in after
 * hydration. AECI-1792 put it in the server HTML with a height floor. The
 * `/products` grid is kept by hydration since #1344. Both stay at no shift.
 * This is the only layout-shift check on `/`. AECI-2027 removed the looser one in
 * `home.spec.ts`.
 */
test.describe('no layout shift while the stylesheet is late (AECI-1854)', () => {
  for (const path of ['/', '/products']) {
    for (const width of [1440, 390]) {
      test(`${path} at ${width}px`, async ({ browser, baseURL }) => {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await context.newPage();
        await page.route(/posthog/, (route) => route.fulfill({ status: 200, body: '{}' }));
        await page.route(STYLESHEET, async (route) => {
          const response = await route.fetch();
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await route.fulfill({ response });
        });
        await page.addInitScript(() => {
          const w = window as unknown as { __cls: number };
          w.__cls = 0;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as (PerformanceEntry & {
              value: number;
              hadRecentInput: boolean;
            })[]) {
              if (!entry.hadRecentInput) w.__cls += entry.value;
            }
          }).observe({ type: 'layout-shift', buffered: true });
        });
        await page.goto(`${baseURL}${path}`, { waitUntil: 'networkidle' });
        // The late stylesheet has landed and applied.
        await expect
          .poll(() =>
            page.evaluate(() =>
              Array.from(document.styleSheets).some(
                (s) => /styles-[^/]+\.css/.test(s.href ?? '') && s.media.mediaText !== 'print',
              ),
            ),
          )
          .toBe(true);
        // A fixed wait on purpose. The test proves that the late stylesheet causes no
        // layout shift, so the observer needs a window after it applies.
        await page.waitForTimeout(500);
        const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
        expect(cls, 'cumulative layout shift').toBeLessThan(0.01);
        await context.close();
      });
    }
  }
});

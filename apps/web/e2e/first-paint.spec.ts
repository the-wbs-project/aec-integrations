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
 * does. The rest render the server HTML with scripts off, once with the full
 * stylesheet blocked and once with it loaded. The header, the first heading, the
 * first button and the header search field must paint the same in both. Content
 * that only appears after hydration is out of scope here: its rules are never in
 * the critical CSS. Rule for authors: `ANGULAR_STYLE_GUIDE.md`
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

interface Paint {
  background: string;
  color: string;
  radius: string;
  box: number[];
}

/** The elements a visitor sees first, read the same way in both runs. */
async function readPaint(page: Page): Promise<Record<string, Paint>> {
  return page.evaluate(() => {
    const visible = (el: Element | null): el is HTMLElement => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const targets: Record<string, Element | null> = {
      header: document.querySelector('aec-site-header header'),
      heading: document.querySelector('main h1'),
      button: Array.from(document.querySelectorAll('.aec-btn')).find(visible) ?? null,
      // The field itself, not its host element (both can carry the id).
      search: document.querySelector('input#header-search, #header-search input'),
    };
    const out: Record<string, Paint> = {};
    for (const [name, el] of Object.entries(targets)) {
      if (!visible(el)) continue;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      out[name] = {
        background: s.backgroundColor,
        color: s.color,
        radius: s.borderTopLeftRadius,
        box: [r.x, r.y + scrollY, r.width, r.height].map((v) => Math.round(v)),
      };
    }
    return out;
  });
}

async function paintAt(
  browser: Browser,
  url: string,
  width: number,
  stylesheet: 'blocked' | 'loaded',
): Promise<Record<string, Paint>> {
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
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  });
  const paint = await readPaint(page);
  await context.close();
  return paint;
}

test.describe('first paint equals the final paint (AECI-1854)', () => {
  for (const path of PAGES) {
    for (const width of [1440, 390]) {
      test(`${path} at ${width}px`, async ({ browser, baseURL }) => {
        const url = `${baseURL}${path}`;
        const first = await paintAt(browser, url, width, 'blocked');
        const final = await paintAt(browser, url, width, 'loaded');
        expect(Object.keys(final), 'the header and heading render').toEqual(
          expect.arrayContaining(['header', 'heading']),
        );
        for (const [name, want] of Object.entries(final)) {
          const got = first[name];
          expect(got, `${name} paints before the stylesheet loads`).toBeTruthy();
          expect(got.background, `${name} background`).toBe(want.background);
          expect(got.color, `${name} colour`).toBe(want.color);
          expect(got.radius, `${name} corner radius`).toBe(want.radius);
          got.box.forEach((v, i) =>
            expect(Math.abs(v - want.box[i]), `${name} box [x,y,w,h][${i}]`).toBeLessThanOrEqual(1),
          );
        }
      });
    }
  }
});

/**
 * The whole page, not four elements (AECI-1854 audit). Scripts off, so both runs
 * hold exactly the server HTML. Every element must keep its box, display,
 * visibility, opacity, transform, background and colour, and a screenshot of the
 * first screen must match pixel for pixel, whether or not the full stylesheet
 * has loaded. Content that renders only after hydration (the consent banner) is
 * not in this DOM: its rules come from the full stylesheet alone.
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
): Promise<{ elements: ElementPaint[]; shot: Buffer }> {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    javaScriptEnabled: false,
  });
  const page = await context.newPage();
  if (stylesheet === 'blocked') await page.route(STYLESHEET, (route) => route.abort());
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
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
        ].join(' | '),
      };
    }),
  );
  const shot = await page.screenshot();
  await context.close();
  return { elements, shot };
}

/** Share of differing pixels between two same-size PNG screenshots, decoded in a page. */
async function pixelDiff(page: Page, a: Buffer, b: Buffer): Promise<number> {
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
        return ctx.getImageData(0, 0, img.width, img.height).data;
      };
      const [x, y] = await Promise.all([load(one), load(two)]);
      if (x.length !== y.length) return 1;
      let differ = 0;
      for (let i = 0; i < x.length; i += 4) {
        if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) differ++;
      }
      return differ / (x.length / 4);
    },
    [a.toString('base64'), b.toString('base64')] as const,
  );
}

test.describe('the whole server-rendered page paints the same before the stylesheet (AECI-1854)', () => {
  for (const path of PAGES) {
    for (const width of [1440, 390]) {
      test(`${path} at ${width}px`, async ({ browser, baseURL, page }) => {
        const url = `${baseURL}${path}`;
        const first = await wholePage(browser, url, width, 'blocked');
        const final = await wholePage(browser, url, width, 'loaded');
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
        expect(await pixelDiff(page, first.shot, final.shot), 'first screen pixels').toBe(0);
      });
    }
  }
});

/**
 * The two shifts PR #1328 left open, with scripts on and the full stylesheet held
 * back 1.5s, cold, so hydration and the data run while the page has only the
 * inlined CSS. The home "Most viewed" row was a data shift: it filled in after
 * hydration. AECI-1792 put it in the server HTML with a height floor. The
 * `/products` grid is kept by hydration, not rebuilt. Both stay at no shift.
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
        await page.waitForTimeout(500);
        const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
        expect(cls, 'cumulative layout shift').toBeLessThan(0.01);
        await context.close();
      });
    }
  }
});

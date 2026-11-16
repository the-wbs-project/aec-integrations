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
      search: document.querySelector('#header-search'),
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

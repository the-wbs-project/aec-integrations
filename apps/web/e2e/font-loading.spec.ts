/**
 * AECI-1892: the web fonts are self-hosted, and the text that paints before they
 * arrive takes the same space as the text after.
 *
 * - `index.html` declares every `@font-face`: the two web fonts from `/fonts/`, and
 *   the size-matched fallback faces. They must sit in the server HTML. The SSR
 *   critical-CSS pass (Beasties) drops `@font-face` rules from the inlined styles,
 *   so a face moved into `styles.css` would only exist once the late stylesheet
 *   loads, and the text would move twice.
 * - Every fallback family the token stacks in `styles.css` name must be declared.
 * - No font is preloaded (a preload delayed first paint, see index.html).
 * - The font files carry a one-year immutable Cache-Control (`public/_headers`).
 * - With the web fonts blocked, the first heading and the block under it sit where
 *   they sit with the fonts loaded. That check needs the local fallback fonts
 *   (Georgia, Arial), so it skips on a machine without them (Linux CI).
 *
 * Paths are `baseURL`-relative: never hardcode a port.
 */
import { expect, test, type Browser } from './fixtures';

const FONT_FILE = /\.woff2(?:\?|$)/;

/** `@font-face` blocks in the server HTML. The inlined critical CSS carries none. */
function fontFaces(html: string): { family: string; src: string }[] {
  return [...html.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => ({
    family: m[1].match(/font-family:\s*'([^']+)'/)?.[1] ?? '',
    src: m[1].match(/src:\s*([^;]+);/)?.[1] ?? '',
  }));
}

test.describe('self-hosted web fonts (AECI-1892)', () => {
  test('the server HTML declares every face and preloads none', async ({ request }) => {
    for (const path of ['/', '/products/revit']) {
      const html = await (await request.get(path)).text();
      expect(html, `${path}: no Google Fonts request`).not.toMatch(
        /fonts\.(googleapis|gstatic)\.com/,
      );

      // No font preload: one delayed first paint without making the fonts arrive sooner
      // (index.html). The critical-CSS pass adds none either.
      expect(html, `${path}: no font preload`).not.toMatch(/<link[^>]*as="font"[^>]*>/);

      const families = new Set(fontFaces(html).map((f) => f.family));
      expect(families.has('Source Serif 4'), 'Source Serif 4 face').toBe(true);
      expect(families.has('Atkinson Hyperlegible Next'), 'Atkinson face').toBe(true);

      // Every fallback family a token stack names (in the inlined :root block) is
      // declared in the HTML.
      const named = new Set(
        [
          ...html.matchAll(
            /["'](Source Serif 4 Fallback \d+|Atkinson Hyperlegible Next(?: Caps)? Fallback)["']/g,
          ),
        ].map((m) => m[1]),
      );
      // Serif 24, 32, 40 and 60, the Atkinson face and its caps face. AECI-1927 moved the
      // display-scale roles onto the 60 face and removed the 48 and 56 bands.
      expect(named.size, 'the stacks name fallback faces').toBeGreaterThanOrEqual(6);
      for (const family of named) expect(families.has(family), `${family} is declared`).toBe(true);
    }
  });

  test('the font files are served from /fonts/ with a one-year immutable cache', async ({
    request,
  }) => {
    const html = await (await request.get('/')).text();
    const urls = new Set(
      fontFaces(html).flatMap((f) => [...f.src.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1])),
    );
    expect(urls.size, 'ten font files').toBe(10);
    for (const url of urls) {
      expect(url, 'same origin, under /fonts/').toMatch(/^\/fonts\/[a-z0-9-]+\.woff2$/);
      const res = await request.get(url);
      expect(res.status(), url).toBe(200);
      expect(res.headers()['content-type'], url).toBe('font/woff2');
      expect(res.headers()['cache-control'], url).toBe('public, max-age=31536000, immutable');
    }
  });
});

interface Geometry {
  heading: number[];
  next: number[];
  fallbackFaces: string[];
}

async function geometry(
  browser: Browser,
  url: string,
  width: number,
  fonts: 'blocked' | 'loaded',
): Promise<Geometry> {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() =>
    globalThis.localStorage.setItem('aeci_analytics_consent', 'denied'),
  );
  const page = await context.newPage();
  if (fonts === 'blocked') await page.route(FONT_FILE, (route) => route.abort());
  await page.goto(url, { waitUntil: 'load' });
  const result = await page.evaluate(async () => {
    await document.fonts.ready;
    const box = (el: Element | null) => {
      if (!el) return [];
      const r = el.getBoundingClientRect();
      return [r.y + scrollY, r.height].map((v) => Math.round(v));
    };
    const heading = document.querySelector('main h1');
    let next = heading?.nextElementSibling ?? null;
    while (next && next.getBoundingClientRect().height === 0) next = next.nextElementSibling;
    return {
      heading: box(heading),
      next: box(next),
      fallbackFaces: [...document.fonts]
        .filter((f) => f.family.includes('Fallback') && f.status === 'loaded')
        .map((f) => f.family),
    };
  });
  await context.close();
  return result;
}

test.describe('the fallback takes the web font’s space (AECI-1892)', () => {
  for (const path of ['/', '/products/revit']) {
    for (const width of [390, 1280]) {
      test(`${path} at ${width}px`, async ({ browser, baseURL }) => {
        const url = `${baseURL}${path}`;
        const first = await geometry(browser, url, width, 'blocked');
        test.skip(
          first.fallbackFaces.length === 0,
          'no local fallback font (Georgia, Arial) on this machine',
        );
        const final = await geometry(browser, url, width, 'loaded');
        expect(final.heading.length, 'the page has an h1').toBe(2);
        expect(Math.abs(first.heading[1] - final.heading[1]), 'h1 height').toBeLessThanOrEqual(1);
        expect(
          Math.abs(first.next[0] - final.next[0]),
          'the block after the h1, top',
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(first.next[1] - final.next[1]),
          'the block after the h1, height',
        ).toBeLessThanOrEqual(1);
      });
    }
  }
});

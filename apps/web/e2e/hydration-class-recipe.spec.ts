/**
 * AECI-1937: nothing resolves an `aecButton` or `aecCard` style while hydration
 * has it without its recipe.
 *
 * When Angular hydrates an element, it writes the element's static classes
 * (`class="mt-12"`) first. That replaces the server's full class list. The
 * directive's `[class]` host binding restores the recipe in the update pass. The
 * zoneless scheduler runs that pass before any rendering step, so no frame paints
 * the bare state. The gap is there by design. A style read from a script during
 * the gap does see it, and the colour transition then fades the fill back in.
 * That is what made the AECI-1922 e2e flaky (`ANGULAR_STYLE_GUIDE.md` §10).
 *
 * THE PROBE. An injected rule gives a guarded element that lacks its recipe's
 * first class a 1ms animation. `animationstart` fires only if the browser
 * resolved that element's style while the class was missing, whatever caused it:
 * a frame, a third-party script, or app code. The test reads no style itself,
 * and it only loads each route passively (no clicks, no visibility polling),
 * because a test tool's own reads can resolve style mid-creation.
 *
 * Paths are `baseURL`-relative: never hardcode a port.
 */
import { expect, test, type Page } from '@playwright/test';

/** The guarded directives: the attribute their selector leaves, and the recipe's first class. */
const HOSTS = [
  { attr: 'aecbutton', marker: 'aec-btn' },
  { attr: 'aeccard', marker: 'aec-card' },
];

const PROBE = 'aec-recipe-probe';

/** Each route hydrates guarded elements that have a static `class` beside the directive. */
const ROUTES = ['/never-a-real-route', '/', '/products', '/vendor-program', '/docs'];

function installProbe({
  hosts,
  probe,
}: {
  hosts: readonly { attr: string; marker: string }[];
  probe: string;
}): void {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(
    `@keyframes ${probe} { from { opacity: 1 } to { opacity: 1 } }\n` +
      hosts.map((h) => `[${h.attr}]:not(.${h.marker})`).join(',') +
      ` { animation: ${probe} 1ms !important; }`,
  );
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const hits: string[] = [];
  (window as unknown as { __recipeProbe: string[] }).__recipeProbe = hits;
  document.addEventListener(
    'animationstart',
    (e) => {
      if (e.animationName !== probe) return;
      const el = e.target as Element;
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
      hits.push(`${el.tagName.toLowerCase()} "${text}": class="${el.getAttribute('class') ?? ''}"`);
    },
    true,
  );
}

/** Load, a quiet event-replay contract, no busy region, then two frames. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  let last = -1;
  let quiet = 0;
  for (let i = 0; i < 40 && quiet < 3; i++) {
    const pending = await page.locator('[jsaction]').count();
    const busy = await page.locator('[aria-busy="true"]').count();
    quiet = pending === last && busy === 0 ? quiet + 1 : 0;
    last = pending;
    // A fixed interval on purpose. "Quiet" means the same counts on three samples
    // taken apart in time, so the samples need a gap between them.
    await page.waitForTimeout(150);
  }
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

test.describe('no style resolves on aecButton or aecCard in the hydration gap (AECI-1937)', () => {
  test.beforeEach(async ({ page, context }) => {
    const rate = Number(process.env['AECI_CPU_THROTTLE'] ?? 1);
    if (rate > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    }
    await page.addInitScript(installProbe, { hosts: HOSTS, probe: PROBE });
  });

  for (const route of ROUTES) {
    test(`hydrating ${route}`, async ({ page }) => {
      await page.goto(route);
      await settle(page);
      const guarded = HOSTS.map((h) => `[${h.attr}][class]`).join(',');
      expect(
        await page.locator(guarded).count(),
        'the route hydrates guarded elements',
      ).toBeGreaterThan(0);
      const hits = await page.evaluate(
        () => (window as unknown as { __recipeProbe: string[] }).__recipeProbe,
      );
      expect(hits, 'style resolved on an element without its recipe').toEqual([]);
    });
  }
});

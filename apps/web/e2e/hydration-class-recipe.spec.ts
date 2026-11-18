/**
 * AECI-1937: an `aecButton` or `aecCard` is never left without its recipe in a
 * state the browser can style or paint.
 *
 * When Angular creates or hydrates an element, it writes the element's static
 * classes (`class="mt-12"`) first and applies a `[class]` host binding later, in
 * the first update pass. During hydration that write replaced the server's full
 * class list with the static part alone. A style read or a frame can land in the
 * gap before the update pass. A button resolved then has no fill, and its colour
 * transition fades the fill back in. That is how the AECI-1922 e2e read a
 * part-transparent Forest. `shared/host-recipe.ts` puts the recipe back in the
 * same creation pass.
 *
 * TWO DETECTORS, neither of which reads style itself:
 *
 * 1. Class lists. A MutationObserver on every `class` attribute and every
 *    inserted node, installed before the HTML parses. Its callback runs when the
 *    script that made the writes is done, which is where a style read or a frame
 *    can land. So a list read in the callback is one the browser could style.
 *    Writes inside one script are never seen on their own. This is
 *    deterministic: before the fix the reduced list showed in a callback on
 *    every load. These counts are observer states, not paints.
 * 2. A style probe. An injected rule gives a guarded element that lacks its
 *    recipe's first class a 1ms animation. `animationstart` fires only if the
 *    browser resolved style while the class was missing, whoever caused it.
 *
 * WHAT FAILS, for an element carrying either directive:
 * - A server element in a callback missing a class it had both in the server
 *   HTML and at the end.
 * - A client-created element first seen without its recipe's first class, or
 *   carrying a class it does not have at the end (a wrong guess, such as a
 *   Forest fill on a button that settles secondary).
 * - The probe's animation starting on it.
 *
 * The observation runs from before first paint to two frames after the page has
 * settled: the load event, the event-replay `jsaction` attributes no longer
 * changing, and no `aria-busy` region. `AECI_CPU_THROTTLE=4` runs it on a slowed
 * CPU.
 *
 * Paths are `baseURL`-relative: never hardcode a port.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

/** The directives under guard: the attribute their selector leaves, and the recipe's first class. */
const HOSTS = [
  { attr: 'aecbutton', marker: 'aec-btn' },
  { attr: 'aeccard', marker: 'aec-card' },
];

const PROBE = 'aec-recipe-probe';

/** Each route renders guarded elements with a static `class` beside the directive. */
const ROUTES = ['/never-a-real-route', '/', '/products', '/vendor-program', '/docs'];

interface Finding {
  readonly el: string;
  readonly at: number;
  readonly why: string;
}

function installObserver({
  hosts,
  probe,
}: {
  hosts: readonly { attr: string; marker: string }[];
  probe: string;
}): void {
  const t0 = performance.now();
  const toks = (s: string | null) => (s ?? '').split(/\s+/).filter(Boolean);
  const hostOf = (el: Element) => hosts.find((h) => el.hasAttribute(h.attr));
  const hostSelector = hosts.map((h) => `[${h.attr}]`).join(',');

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(
    `@keyframes ${probe} { from { opacity: 1 } to { opacity: 1 } }\n` +
      hosts.map((h) => `[${h.attr}]:not(.${h.marker})`).join(',') +
      ` { animation: ${probe} 1ms !important; }`,
  );
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  /** The server's class list: the old value of the first mutation of a parsed element. */
  const ssr = new Map<Element, string[]>();
  /** Every class list seen in a callback. */
  const states = new Map<Element, { at: number; cls: string[] }[]>();
  /** Elements the client inserted. */
  const inserted = new Set<Element>();
  const probed: { el: Element; at: number }[] = [];
  // Parsing is over once the state leaves `loading`, before the app's deferred
  // scripts run. Nodes added before that are the server's.
  const parsed = () => document.readyState !== 'loading';

  new MutationObserver((records) => {
    const at = performance.now() - t0;
    const touched = new Set<Element>();
    for (const r of records) {
      if (r.type === 'attributes') {
        const el = r.target as Element;
        if (!hostOf(el)) continue;
        if (parsed() && !ssr.has(el) && !inserted.has(el)) ssr.set(el, toks(r.oldValue));
        touched.add(el);
      } else if (parsed()) {
        for (const n of Array.from(r.addedNodes)) {
          if (!(n instanceof Element)) continue;
          for (const el of [n, ...Array.from(n.querySelectorAll(hostSelector))]) {
            if (!hostOf(el)) continue;
            inserted.add(el);
            touched.add(el);
          }
        }
      }
    }
    for (const el of touched) {
      if (!el.isConnected) continue;
      if (!states.has(el)) states.set(el, []);
      states.get(el)!.push({ at, cls: toks(el.getAttribute('class')) });
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
    attributeOldValue: true,
  });

  document.addEventListener(
    'animationstart',
    (e) => {
      if (e.animationName === probe)
        probed.push({ el: e.target as Element, at: performance.now() - t0 });
    },
    true,
  );

  const label = (el: Element) => {
    const v = el.getAttribute('data-variant');
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return `${el.tagName.toLowerCase()}${v ? `[${v}]` : ''} "${text}"`;
  };

  (window as unknown as { __recipeFindings: () => Finding[] }).__recipeFindings = () => {
    const out: Finding[] = [];
    for (const [el, list] of states) {
      const host = hostOf(el);
      if (!el.isConnected || !host) continue;
      const final = new Set(toks(el.getAttribute('class')));
      const server = ssr.get(el);
      if (server) {
        const required = server.filter((t) => final.has(t));
        for (const s of list) {
          const missing = required.filter((t) => !s.cls.includes(t));
          if (missing.length > 0) {
            out.push({
              el: label(el),
              at: s.at,
              why: `class list missing ${missing.length}: ${missing.slice(0, 4).join(' ')}`,
            });
          }
        }
      } else if (inserted.has(el)) {
        if (list.length > 0 && !list[0].cls.includes(host.marker)) {
          out.push({ el: label(el), at: list[0].at, why: `inserted without ${host.marker}` });
        }
        for (const s of list) {
          const wrong = s.cls.filter((t) => !final.has(t));
          if (wrong.length > 0) {
            out.push({
              el: label(el),
              at: s.at,
              why: `wrong class: ${wrong.slice(0, 4).join(' ')}`,
            });
          }
        }
      }
    }
    for (const p of probed) {
      out.push({ el: label(p.el), at: p.at, why: 'style resolved without the recipe' });
    }
    return out.map((f) => ({ ...f, at: Math.round(f.at) }));
  };
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
    await page.waitForTimeout(150);
  }
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

async function findings(page: Page): Promise<Finding[]> {
  return page.evaluate(() =>
    (window as unknown as { __recipeFindings: () => Finding[] }).__recipeFindings(),
  );
}

/** Clicks until `opened` shows: a click before hydration ends can be dropped. */
async function openWith(trigger: Locator, opened: Locator): Promise<void> {
  await expect(async () => {
    await trigger.click();
    await expect(opened).toBeVisible({ timeout: 2000 });
  }).toPass();
}

const guarded = HOSTS.map((h) => `[${h.attr}][class]`).join(',');

test.describe('aecButton and aecCard keep their recipe from the first render (AECI-1937)', () => {
  test.beforeEach(async ({ page, context }) => {
    const rate = Number(process.env['AECI_CPU_THROTTLE'] ?? 1);
    if (rate > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    }
    await page.addInitScript(installObserver, { hosts: HOSTS, probe: PROBE });
  });

  for (const route of ROUTES) {
    test(`hydrating ${route}`, async ({ page }) => {
      await page.goto(route);
      await settle(page);
      expect(
        await page.locator(guarded).count(),
        'the route renders guarded elements',
      ).toBeGreaterThan(0);
      expect(await findings(page)).toEqual([]);
    });
  }

  test('hydrating a product page, deferred sections included', async ({ page }) => {
    await page.goto('/products/revit');
    await settle(page);
    // The integrations section hydrates on viewport (`@defer (hydrate on viewport)`).
    await page.evaluate(() =>
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }),
    );
    await settle(page);
    expect(await findings(page)).toEqual([]);
  });

  test('a client navigation to the home page', async ({ page }) => {
    await page.goto('/vendor-program');
    await settle(page);
    await page.locator('header a[href="/"]').first().click();
    await expect(page).toHaveURL(/\/$/);
    await settle(page);
    expect(await findings(page)).toEqual([]);
  });

  test('buttons created in the claim dialog', async ({ page }) => {
    await page.goto('/vendor-program');
    await settle(page);
    const dialog = page.getByRole('dialog');
    await openWith(page.getByRole('link', { name: 'Claim your listing' }).first(), dialog);
    await settle(page);
    expect(await dialog.locator('[aecbutton]').count()).toBeGreaterThan(0);
    expect(await findings(page)).toEqual([]);
  });

  test('buttons created in the correction drawer', async ({ page }) => {
    await page.goto('/products/dynamo-for-revit');
    await settle(page);
    const drawer = page.locator('.aec-drawer');
    await openWith(page.getByRole('link', { name: 'Suggest a correction' }).first(), drawer);
    await settle(page);
    expect(await drawer.locator('[aecbutton]').count()).toBeGreaterThan(0);
    expect(await findings(page)).toEqual([]);
  });

  test('buttons created in a @defer block: the home feedback dialog', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    const dialog = page.getByRole('dialog');
    await openWith(page.getByRole('button', { name: 'Suggest a tool' }), dialog);
    await settle(page);
    expect(await dialog.locator('[aecbutton]').count()).toBeGreaterThan(0);
    expect(await findings(page)).toEqual([]);
  });
});

/**
 * AECI-1937: an `aecButton` or `aecCard` never paints without its recipe.
 *
 * When Angular creates or hydrates an element, it writes the element's static
 * classes (`class="mt-12"`) first and applies a `[class]` host binding later, in
 * the first update pass. During hydration that write replaced the server's full
 * class list with the static part alone. When a frame painted before the update
 * pass, the button had no fill and faded back in through its colour transition,
 * and a card had no frame. `shared/host-recipe.ts` puts the recipe back in the
 * same creation pass.
 *
 * HOW IT OBSERVES. A MutationObserver on every `class` attribute and every
 * inserted node, installed before the HTML parses. Its callback runs when the
 * script that made the writes is done, and a frame can only paint between
 * scripts. So the class list read in the callback is one the next frame could
 * paint. The writes inside one script (the static write and the recipe's return)
 * are never paintable on their own. This makes the check deterministic: before
 * the fix, the reduced list showed in a callback on every load, whether or not a
 * frame happened to paint.
 *
 * WHAT FAILS, for an element carrying either directive:
 * - A paintable class list missing a class the element had both in the server
 *   HTML and at the end.
 * - A client-created element first seen without its final classes.
 * - A computed background, read at those same moments, that differs from the
 *   settled one.
 * - Any colour transition on the element. Nothing hovers it, so a transition
 *   means its fill or edge changed.
 *
 * The observation runs from before first paint to two frames after the page has
 * settled: the load event, the event-replay `jsaction` attributes no longer
 * changing, and no `aria-busy` region.
 *
 * Paths are `baseURL`-relative: never hardcode a port.
 */
import { expect, test, type Page } from '@playwright/test';

/** The directives under guard, by the attribute their selector leaves on the element. */
const HOSTS = ['aecbutton', 'aeccard'];

/** Each route renders guarded elements with a static `class` beside the directive. */
const ROUTES = [
  '/never-a-real-route',
  '/',
  '/products',
  '/products/dynamo-for-revit',
  '/vendor-program',
  '/docs',
];

interface Finding {
  readonly el: string;
  readonly at: number;
  readonly why: string;
}

interface ObserverOptions {
  readonly hosts: readonly string[];
  /**
   * Read the computed background at each paintable moment. Off for a client
   * navigation: a style read there runs before the next page's styles attach,
   * and that read alone starts a colour transition that no real frame would.
   */
  readonly readStyle: boolean;
}

function installObserver({ hosts, readStyle }: ObserverOptions): void {
  const t0 = performance.now();
  const toks = (s: string | null) => (s ?? '').split(/\s+/).filter(Boolean);
  const isHost = (el: Element) => hosts.some((h) => el.hasAttribute(h));
  const hostSelector = hosts.map((h) => `[${h}]`).join(',');
  // Colours come back as `oklch(…)` or, mid-transition, `oklab(…)`. Compare them as RGBA.
  const canvas = document.createElement('canvas').getContext('2d');
  const rgba = (c: string) => {
    if (!canvas) return c;
    canvas.clearRect(0, 0, 1, 1);
    canvas.fillStyle = c;
    canvas.fillRect(0, 0, 1, 1);
    return canvas.getImageData(0, 0, 1, 1).data.join(',');
  };
  /** The server's class list: the old value of the first mutation of a parsed element. */
  const ssr = new Map<Element, string[]>();
  /** Every paintable moment: the class list, and the background if read. */
  const states = new Map<Element, { at: number; cls: string[]; bg: string | null }[]>();
  /** Elements the client inserted, with the class list they had when first seen. */
  const inserted = new Map<Element, { at: number; cls: string[] }>();
  const transitions: { el: Element; at: number; prop: string }[] = [];
  // Parsing is over once the state leaves `loading`, before the app's deferred
  // scripts run. Nodes added before that are the server's.
  const parsed = () => document.readyState !== 'loading';

  new MutationObserver((records) => {
    const at = performance.now() - t0;
    const touched = new Set<Element>();
    for (const r of records) {
      if (r.type === 'attributes') {
        const el = r.target as Element;
        if (!isHost(el)) continue;
        if (parsed() && !ssr.has(el) && !inserted.has(el)) ssr.set(el, toks(r.oldValue));
        touched.add(el);
      } else if (parsed()) {
        for (const n of Array.from(r.addedNodes)) {
          if (!(n instanceof Element)) continue;
          for (const el of [n, ...Array.from(n.querySelectorAll(hostSelector))]) {
            if (!isHost(el)) continue;
            if (!inserted.has(el)) inserted.set(el, { at, cls: toks(el.getAttribute('class')) });
            touched.add(el);
          }
        }
      }
    }
    for (const el of touched) {
      if (!el.isConnected) continue;
      if (!states.has(el)) states.set(el, []);
      states.get(el)!.push({
        at,
        cls: toks(el.getAttribute('class')),
        bg: readStyle ? rgba(getComputedStyle(el).backgroundColor) : null,
      });
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
    attributeOldValue: true,
  });

  document.addEventListener(
    'transitionrun',
    (e) => {
      const el = e.target as Element;
      if (isHost(el) && /color/.test(e.propertyName)) {
        transitions.push({ el, at: performance.now() - t0, prop: e.propertyName });
      }
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
      if (!el.isConnected) continue;
      const final = new Set(toks(el.getAttribute('class')));
      const settledBg = rgba(getComputedStyle(el).backgroundColor);
      const server = ssr.get(el);
      const created = inserted.get(el);
      // A server element keeps every class it had both in the HTML and at the end.
      // A client element has its final classes from the moment it is seen.
      const required = server ? server.filter((t) => final.has(t)) : [...final];
      if (created && !server) {
        const missing = required.filter((t) => !created.cls.includes(t));
        if (missing.length > 0) {
          out.push({ el: label(el), at: created.at, why: `inserted without ${missing.join(' ')}` });
        }
      }
      for (const s of list) {
        const missing = required.filter((t) => !s.cls.includes(t));
        if (missing.length > 0) {
          out.push({
            el: label(el),
            at: s.at,
            why: `paintable class list missing ${missing.length}: ${missing.slice(0, 4).join(' ')}`,
          });
        } else if (s.bg !== null && s.bg !== settledBg) {
          out.push({ el: label(el), at: s.at, why: `background ${s.bg}, settles at ${settledBg}` });
        }
      }
    }
    for (const t of transitions) {
      out.push({ el: label(t.el), at: t.at, why: `${t.prop} transition ran` });
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

test.describe('aecButton and aecCard keep their recipe from first paint (AECI-1937)', () => {
  for (const route of ROUTES) {
    test(`hydrating ${route}`, async ({ page }) => {
      await page.addInitScript(installObserver, { hosts: HOSTS, readStyle: true });
      await page.goto(route);
      await settle(page);
      const seen = await page.locator(HOSTS.map((h) => `[${h}][class]`).join(',')).count();
      expect(seen, 'the route renders guarded elements').toBeGreaterThan(0);
      expect(await findings(page)).toEqual([]);
    });
  }

  test('a client navigation to the home page', async ({ page }) => {
    await page.addInitScript(installObserver, { hosts: HOSTS, readStyle: false });
    await page.goto('/vendor-program');
    await settle(page);
    await page.locator('header a[href="/"]').first().click();
    await expect(page).toHaveURL(/\/$/);
    await settle(page);
    expect(await findings(page)).toEqual([]);
  });
});

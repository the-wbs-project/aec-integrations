/**
 * AECI-1881: the in-page half of the magnification checks.
 *
 * Each reader runs in the page and returns plain facts. It moves no focus and
 * changes nothing but the one style element `applyMagnification` adds. The
 * decisions are in `magnify-geometry.ts`, which is pure and unit tested.
 *
 * `docs/TESTING_STRATEGY.md` §8.4.6.
 */
import type { CDPSession, Page } from '@playwright/test';
import { untilAppStable } from '../../e2e/hydration';
import type { Box, ScrollerFact, TextFacts } from './magnify-geometry';

/**
 * The two style overrides. 200% text is the root font size, so every `rem` and
 * `em` grows. The text spacing values are WCAG 1.4.12's, as the W3C bookmarklet
 * sets them: `!important` on every element, paragraph spacing on `p`.
 */
export const MAGNIFICATIONS = {
  'text 200%': 'html { font-size: 200% !important; }',
  'text spacing': [
    '*, *::before, *::after {',
    '  line-height: 1.5 !important;',
    '  letter-spacing: 0.12em !important;',
    '  word-spacing: 0.16em !important;',
    '}',
    'p { margin-bottom: 2em !important; }',
  ].join('\n'),
} as const;

export type Magnification = keyof typeof MAGNIFICATIONS;

const STYLE_ID = 'aeci-1881-magnification';

/** Add one override. `clearMagnification` takes it away again. */
export async function applyMagnification(page: Page, which: Magnification): Promise<void> {
  await page.evaluate(
    ({ id, css }) => {
      document.getElementById(id)?.remove();
      const style = document.createElement('style');
      style.id = id;
      style.textContent = css;
      document.head.appendChild(style);
    },
    { id: STYLE_ID, css: MAGNIFICATIONS[which] },
  );
  await settleLayout(page);
}

export async function clearMagnification(page: Page): Promise<void> {
  await page.evaluate((id) => document.getElementById(id)?.remove(), STYLE_ID);
  await settleLayout(page);
}

/**
 * Wait until a measurement would read a still page: web fonts loaded, every
 * finite animation and transition finished, then the document's size and
 * element count the same over three samples 100ms apart. A resize or a new
 * style can make a component render again (a breakpoint observer, a
 * `ResizeObserver`), so the app must also be stable afterwards.
 */
export async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const finite = document.getAnimations().filter((a) => {
      const end = a.effect?.getComputedTiming().endTime;
      return a.playState === 'running' && typeof end === 'number' && Number.isFinite(end);
    });
    await Promise.race([
      Promise.all(finite.map((a) => a.finished.catch(() => undefined))),
      wait(5_000),
    ]);
    const signature = () => {
      const root = document.documentElement;
      return `${root.scrollWidth}x${root.scrollHeight}:${document.getElementsByTagName('*').length}`;
    };
    let last = '';
    let same = 0;
    for (let round = 0; round < 50 && same < 2; round++) {
      await frame();
      await frame();
      const now = signature();
      same = now === last ? same + 1 : 0;
      last = now;
      await wait(100);
    }
  });
  await untilAppStable(page, 30_000);
}

/**
 * 400% zoom on a 1280px window is a 320px CSS viewport at four device pixels
 * per CSS pixel. Playwright sets the scale only when a context is made, so this
 * sends the same DevTools call it uses (`Emulation.setDeviceMetricsOverride`)
 * on the open page, and reports the scale the page then sees.
 *
 * The override lives as long as its DevTools session, so the session stays
 * open until the page closes. Detaching it drops the page back to the
 * browser's own 1280px window, not to the context's viewport. Call it last.
 */
export async function emulateZoom(
  page: Page,
  viewport: { width: number; height: number },
  deviceScaleFactor: number,
): Promise<{ devicePixelRatio: number; innerWidth: number }> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    ...viewport,
    deviceScaleFactor,
    mobile: false,
  });
  await settleLayout(page);
  return page.evaluate(() => ({
    devicePixelRatio: window.devicePixelRatio,
    innerWidth: window.innerWidth,
  }));
}

/** The page root's scroll and client widths, and the elements that stick out past it. */
export interface RootFacts {
  readonly scrollWidth: number;
  readonly clientWidth: number;
  /** Up to five of the innermost boxes past the right edge, for triage. */
  readonly pastEdge: readonly string[];
}

export function readRoot(page: Page): Promise<RootFacts> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const edge = root.clientWidth + 1;
    const past = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > edge;
    };
    const leaves: string[] = [];
    // Only a page that overflows has a source to find.
    const all = root.scrollWidth > edge ? Array.from(document.body.querySelectorAll('*')) : [];
    for (const el of all) {
      if (leaves.length >= 5) break;
      if (!past(el) || Array.from(el.children).some(past)) continue;
      const id = el.getAttribute('data-testid');
      const r = el.getBoundingClientRect();
      leaves.push(
        `${el.tagName.toLowerCase()}${id ? `[data-testid="${id}"]` : ''} right edge ${Math.round(r.right)}px`,
      );
    }
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, pastEdge: leaves };
  });
}

/** Every element under `body` that scrolls sideways on its own. */
export function readScrollers(page: Page): Promise<ScrollerFact[]> {
  return page.evaluate(() => {
    const describe = (el: Element) => {
      const id = el.getAttribute('data-testid');
      return `<${el.tagName.toLowerCase()}${id ? ` data-testid="${id}"` : ''}>`;
    };
    const nearest = (el: Element) => {
      const host = el.parentElement?.closest('[data-testid]');
      return host ? `[data-testid="${host.getAttribute('data-testid')}"]` : '';
    };
    const out: ScrollerFact[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const s = getComputedStyle(el);
      if (s.overflowX !== 'auto' && s.overflowX !== 'scroll') continue;
      if (el.scrollWidth <= el.clientWidth + 1 || el.clientWidth === 0) continue;
      if (s.visibility !== 'visible' || el.getClientRects().length === 0) continue;
      const holdsTable =
        el.matches('table, [role="table"], [role="grid"]') ||
        el.querySelector('table, [role="table"], [role="grid"]') !== null;
      out.push({
        desc: describe(el),
        near: nearest(el),
        text: ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
        holdsTable,
      });
    }
    return out;
  });
}

/**
 * Every text node with glyphs on screen, its line boxes, and the ancestors that
 * could clip it. The containing-block rules decide which ancestors count: an
 * absolutely positioned box escapes every ancestor below its nearest positioned
 * one, and a fixed box escapes all of them unless a transform holds it.
 */
export function readText(page: Page): Promise<TextFacts> {
  return page.evaluate(() => {
    type Rect = { left: number; top: number; right: number; bottom: number };
    const styles = new Map<Element, CSSStyleDeclaration>();
    const style = (el: Element) => {
      let s = styles.get(el);
      if (!s) {
        s = getComputedStyle(el);
        styles.set(el, s);
      }
      return s;
    };
    const describe = (el: Element) => {
      const id = el.getAttribute('data-testid');
      return `<${el.tagName.toLowerCase()}${id ? ` data-testid="${id}"` : ''}>`;
    };
    const nearest = (el: Element) => {
      const host = el.closest('[data-testid]');
      return host ? `[data-testid="${host.getAttribute('data-testid')}"]` : '';
    };
    /**
     * The component a text belongs to: the nearest custom element, with the
     * nearest `aec…` attribute directive host in front when one is closer. Angular
     * keeps a template's static attributes, so `aecCard` stays as `aeccard`.
     */
    const hostOf = (el: Element) => {
      let directive = '';
      for (let a: Element | null = el; a; a = a.parentElement) {
        const tag = a.tagName.toLowerCase();
        if (tag.includes('-')) return directive ? `${tag} [${directive}]` : tag;
        if (!directive) {
          const attr = Array.from(a.attributes).find((x) => /^aec[a-z]/.test(x.name));
          if (attr) directive = attr.name;
        }
      }
      return directive ? `[${directive}]` : '';
    };
    const box = (r: DOMRect): Rect => ({
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
    });
    /** A fixed box's containing block is the viewport unless one of these holds it. */
    const holdsFixed = (s: CSSStyleDeclaration) =>
      s.transform !== 'none' ||
      s.perspective !== 'none' ||
      s.filter !== 'none' ||
      /paint|layout|strict|content/.test(s.contain) ||
      /transform|perspective|filter/.test(s.willChange);
    const positioned = (s: CSSStyleDeclaration) => s.position !== 'static' || holdsFixed(s);

    const containers: TextFacts['containers'][number][] = [];
    const containerIndex = new Map<Element, number>();
    const containerOf = (el: Element, s: CSSStyleDeclaration) => {
      let i = containerIndex.get(el);
      if (i === undefined) {
        const r = el.getBoundingClientRect();
        const left = r.left + el.clientLeft;
        const top = r.top + el.clientTop;
        const clamp = s.getPropertyValue('-webkit-line-clamp').trim();
        i = containers.length;
        containers.push({
          desc: describe(el),
          box: { left, top, right: left + el.clientWidth, bottom: top + el.clientHeight },
          overflowX: s.overflowX,
          overflowY: s.overflowY,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          lineClamp: clamp === '' || clamp === 'none' ? null : clamp,
          textOverflow: s.textOverflow,
        });
        containerIndex.set(el, i);
      }
      return i;
    };
    const layers = new Map<Element, number>();

    const SKIP = 'script, style, noscript, template, svg, select, option, textarea, iframe';
    const texts: TextFacts['texts'][number][] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
      const el = node.parentElement;
      if (!text || !el || el.closest(SKIP)) continue;
      if (style(el).visibility !== 'visible') continue;
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects())
        .filter((r) => r.width > 0.5 && r.height > 0.5)
        .map(box);
      if (rects.length === 0) continue;

      let invisible = false;
      let layer = 0;
      const chain: number[] = [];
      // `escape`: which ancestors the nearest positioned box skips on the way up.
      let escape: 'none' | 'absolute' | 'fixed' = 'none';
      for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
        const s = style(a);
        if (Number(s.opacity) === 0) {
          invisible = true;
          break;
        }
        let clips = true;
        if (a !== el) {
          if (escape === 'fixed') {
            if (holdsFixed(s)) escape = 'none';
            else clips = false;
          } else if (escape === 'absolute') {
            if (positioned(s)) escape = 'none';
            else clips = false;
          }
        }
        if (clips && (s.overflowX !== 'visible' || s.overflowY !== 'visible')) {
          chain.push(containerOf(a, s));
        }
        if (s.position === 'fixed') {
          escape = 'fixed';
          if (layer === 0) {
            let id = layers.get(a);
            if (id === undefined) {
              id = layers.size + 1;
              layers.set(a, id);
            }
            layer = id;
          }
        } else if (s.position === 'absolute' && escape === 'none') {
          escape = 'absolute';
        }
      }
      if (invisible) continue;
      texts.push({
        text,
        el: describe(el),
        near: nearest(el),
        host: hostOf(el),
        rects,
        layer,
        chain,
      });
    }
    range.detach();
    return { texts, containers };
  });
}

/** What the orientation check reads at one viewport. */
export interface OrientationFacts {
  readonly mainBox: Box | null;
  readonly mainShown: boolean;
  /** `main`, its ancestors up to `html`: each element's computed `transform` and `rotate`. */
  readonly turns: readonly {
    readonly desc: string;
    readonly transform: string;
    readonly rotate: string;
  }[];
  /** Calls to `screen.orientation.lock` since the page loaded. */
  readonly lockCalls: number;
}

/**
 * Take scrollbars out of the layout, so every run measures the same width.
 *
 * Chromium draws classic scrollbars, 15 CSS px wide, on Linux CI. On macOS it
 * follows a system setting that picks overlay scrollbars, which take no space,
 * or classic ones, and by default that depends on whether a mouse is attached.
 * The same machine measured a page 305px wide one day and 320px the next, and
 * three product names fitted at 400% zoom or did not (AECI-1881 review round 2).
 * `scrollbar-width: none` gives every box a scrollbar of 0 and a gutter of 0.
 * Scrolling still works. Install before the page loads.
 *
 * Hiding them is not lenient where it matters. A phone and macOS draw overlay
 * scrollbars, so 320px is right for reflow. A Windows reader at 400% zoom keeps
 * a classic scrollbar of about 4 CSS px, so the 400% check narrows its viewport
 * to 315px instead (`ZOOM_400` in `magnification.spec.ts`).
 */
export async function hideScrollbars(page: Page): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.id = 'aeci-1881-no-scrollbars';
      style.textContent = '*, *::before, *::after { scrollbar-width: none !important; }';
      document.head.appendChild(style);
    });
  });
}

/**
 * Count calls to `screen.orientation.lock`, the one script API that forces an
 * orientation. Install before the page loads.
 */
export async function watchOrientationLock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __aeciOrientationLocks: number };
    w.__aeciOrientationLocks = 0;
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    if (!o || typeof o.lock !== 'function') return;
    const original = o.lock.bind(o);
    o.lock = (orientation: string) => {
      w.__aeciOrientationLocks++;
      return original(orientation);
    };
  });
}

export function readOrientation(page: Page): Promise<OrientationFacts> {
  return page.evaluate(() => {
    const main = document.querySelector('main, [role="main"]');
    const turns: { desc: string; transform: string; rotate: string }[] = [];
    for (let a: Element | null = main; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      turns.push({
        desc: `<${a.tagName.toLowerCase()}>`,
        transform: s.transform,
        rotate: s.rotate,
      });
    }
    if (!main) {
      const s = getComputedStyle(document.documentElement);
      turns.push({ desc: '<html>', transform: s.transform, rotate: s.rotate });
    }
    let mainShown = false;
    let mainBox: Box | null = null;
    if (main) {
      const r = main.getBoundingClientRect();
      mainBox = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      const s = getComputedStyle(main);
      let opaque = true;
      for (let a: Element | null = main; a; a = a.parentElement) {
        if (Number(getComputedStyle(a).opacity) === 0) opaque = false;
      }
      mainShown =
        opaque &&
        s.visibility === 'visible' &&
        r.width > 0 &&
        r.height > 0 &&
        r.left < window.innerWidth &&
        r.right > 0;
    }
    const locks = (window as unknown as { __aeciOrientationLocks?: number }).__aeciOrientationLocks;
    return { mainBox, mainShown, turns, lockCalls: locks ?? 0 };
  });
}

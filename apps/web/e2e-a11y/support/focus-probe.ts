/**
 * AECI-1878: the in-page half of the focus ring checks.
 *
 * Like `./probe.ts`, it reads the page and never moves focus. It does scroll:
 * the unfocused picture of a stop is taken at the scroll position the stop had
 * when it was focused, and the position is put back straight after. Scrolling
 * moves no focus, and it does not move the sequential focus navigation
 * starting point, so the Tab walk goes on from the focused element.
 *
 * Every colour is read from computed styles and converted to sRGB bytes by a
 * 1x1 canvas, because Chrome serialises `oklch()` tokens as `oklch()`. Class
 * names are never read: `border-color` utilities do not apply in this
 * codebase (`styles.css`), so a class says nothing about the colour drawn.
 */
import type { Page } from '@playwright/test';
import type { Rect, Rgba } from './focus-pixels';
import { ensureProbe } from './probe';

/** How far past the element the pictures reach: a 3px outline at a 3px offset, and some room. */
export const RING_MARGIN = 8;

export interface ScrollState {
  readonly x: number;
  readonly y: number;
  /** Scrollable ancestors of the element, by probe key. */
  readonly containers: readonly {
    readonly key: number;
    readonly left: number;
    readonly top: number;
  }[];
}

export type ControlKind = 'text' | 'select' | 'combobox' | 'choice';

export interface ControlRead {
  readonly kind: ControlKind;
  /** The element's own box, in the picture's coordinates. */
  readonly boxInClip: Rect;
  /** Border colour of each side that has a border at least 1px wide. */
  readonly borders: readonly Rgba[];
  readonly fill: Rgba;
  /** A checkbox or radio the browser draws (`appearance` is not `none`). */
  readonly drawnByBrowser: boolean;
}

export interface FocusedRead {
  readonly key: number;
  /** What the indicator is judged on, in viewport coordinates. A visually hidden input is judged on its labels. */
  readonly box: Rect;
  /** The input is visually hidden, so its labels stand in for it. */
  readonly hiddenInput: boolean;
  /** The picture's region, in whole viewport pixels. `null` when none of it is on screen. */
  readonly clip: Rect | null;
  /** The part of `box` on screen, for the pixel count. */
  readonly visibleBox: Rect | null;
  readonly scroll: ScrollState;
  /** `elementFromPoint` at the centre of `box`. */
  readonly hit: { readonly ok: boolean; readonly found: string };
  /** Computed outline, for the failure message. */
  readonly outline: string;
  readonly control: ControlRead | null;
  /** In the site header or footer, the same component on every page. */
  readonly inSharedChrome: boolean;
}

export interface BaselineSetup {
  /** The scroll state before the stop's own was put back. Restore it after the picture. */
  readonly saved: ScrollState;
  /** The page could not be scrolled back to the stop's position. */
  readonly moved: boolean;
  /** The focused element's ring would show in the picture. Try again from a later stop. */
  readonly blocked: boolean;
}

interface FocusProbeApi {
  read(): Promise<FocusedRead | null>;
  prepareBaseline(scroll: ScrollState, clip: Rect): Promise<BaselineSetup>;
  restore(scroll: ScrollState): Promise<void>;
}

declare global {
  interface Window {
    __aeciFocusProbe?: FocusProbeApi;
  }
}

/** Install the focus probe in the current document, after the keyboard probe it keys elements with. */
export async function ensureFocusProbe(page: Page): Promise<void> {
  await ensureProbe(page);
  await page.evaluate((MARGIN) => {
    if (window.__aeciFocusProbe) return;
    const keys = window.__aeciKeyboardProbe!;

    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const rgba = (css: string): Rgba => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = 'rgba(0, 0, 0, 0)';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    };

    const frames = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );

    const rectOf = (r: DOMRect | Rect): Rect => ({
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
    });
    const union = (a: Rect, b: Rect): Rect => {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      return {
        x,
        y,
        width: Math.max(a.x + a.width, b.x + b.width) - x,
        height: Math.max(a.y + a.height, b.y + b.height) - y,
      };
    };
    const viewport = (): Rect => ({
      x: 0,
      y: 0,
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    });
    const clamp = (r: Rect, to: Rect): Rect | null => {
      const x = Math.max(r.x, to.x);
      const y = Math.max(r.y, to.y);
      const right = Math.min(r.x + r.width, to.x + to.width);
      const bottom = Math.min(r.y + r.height, to.y + to.height);
      return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
    };
    const overlaps = (a: Rect, b: Rect) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

    const tiny = (r: Rect) => r.width * r.height <= 4;
    const labelsOf = (el: Element): Element[] =>
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
        ? Array.from(el.labels ?? [])
        : [];

    /** The box the indicator is judged on: the element, or the labels of a visually hidden input. */
    const targetBox = (el: Element): { box: Rect; hiddenInput: boolean } => {
      const own = rectOf(el.getBoundingClientRect());
      if (!tiny(own)) return { box: own, hiddenInput: false };
      const labels = labelsOf(el)
        .map((l) => rectOf(l.getBoundingClientRect()))
        .filter((r) => !tiny(r));
      if (labels.length === 0) return { box: own, hiddenInput: false };
      return { box: labels.reduce(union), hiddenInput: true };
    };

    const hasOutline = (el: Element) => {
      const s = getComputedStyle(el);
      return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
    };

    /**
     * The box plus any ancestor that draws an outline while the element is
     * focused: an interactive card draws its ring round the whole card
     * (`has-focus-visible`), not round the link inside it.
     */
    const ringBox = (el: Element, box: Rect): Rect => {
      let ring = box;
      let node = el.parentElement;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        if (node.matches('body, header, nav, main, footer, aside, [role="dialog"]')) break;
        if (hasOutline(node)) ring = union(ring, rectOf(node.getBoundingClientRect()));
      }
      return ring;
    };

    const clipFor = (ring: Rect): Rect | null => {
      const grown = {
        x: ring.x - MARGIN,
        y: ring.y - MARGIN,
        width: ring.width + 2 * MARGIN,
        height: ring.height + 2 * MARGIN,
      };
      const on = clamp(grown, viewport());
      if (!on) return null;
      const x = Math.floor(on.x);
      const y = Math.floor(on.y);
      return {
        x,
        y,
        width: Math.ceil(on.x + on.width) - x,
        height: Math.ceil(on.y + on.height) - y,
      };
    };

    const scrollers = (el: Element): ScrollState['containers'] => {
      const out: { key: number; left: number; top: number }[] = [];
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        const s = getComputedStyle(node);
        const scrolls = (v: string) => v !== 'visible' && v !== 'clip';
        const y = scrolls(s.overflowY) && node.scrollHeight > node.clientHeight;
        const x = scrolls(s.overflowX) && node.scrollWidth > node.clientWidth;
        if (x || y) out.push({ key: keys.keyOf(node), left: node.scrollLeft, top: node.scrollTop });
      }
      return out;
    };

    const describe = (el: Element): string => {
      const bits = [el.tagName.toLowerCase()];
      if (el.id) bits.push(`#${el.id}`);
      // The nearest component host names where the covering element comes from.
      let host: Element | null = el;
      while (host && !host.tagName.includes('-')) host = host.parentElement;
      if (host) bits.push(`in ${host.tagName.toLowerCase()}`);
      // `body` would quote the inline scripts. Its tag says enough.
      if (el !== document.body && el !== document.documentElement) {
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
        if (text) bits.push(`"${text}"`);
      }
      return bits.join(' ');
    };

    const TEXT_TYPES = new Set([
      'text',
      'email',
      'search',
      'url',
      'tel',
      'password',
      'number',
      'date',
      'datetime-local',
      'month',
      'week',
      'time',
    ]);
    const controlKind = (el: Element): ControlKind | null => {
      if (el instanceof HTMLTextAreaElement) return 'text';
      if (el instanceof HTMLSelectElement) return 'select';
      if (el instanceof HTMLInputElement) {
        if (el.type === 'checkbox' || el.type === 'radio') return 'choice';
        return TEXT_TYPES.has(el.type) ? 'text' : null;
      }
      return el.getAttribute('role') === 'combobox' ? 'combobox' : null;
    };

    const SIDES = ['top', 'right', 'bottom', 'left'] as const;

    const waitForAnimations = async (el: Element) => {
      // Finite animations on the element, its ancestors and descendants: a
      // ring or fill that fades in. An infinite one never settles, and the
      // screenshot's `animations: 'disabled'` handles it.
      const related = document.getAnimations().filter((a) => {
        const target = (a.effect as KeyframeEffect | null)?.target;
        if (!target) return false;
        const end = a.effect?.getComputedTiming().endTime;
        if (end === undefined || !Number.isFinite(Number(end))) return false;
        return target === el || target.contains(el) || el.contains(target);
      });
      if (related.length === 0) return;
      await Promise.race([
        Promise.all(related.map((a) => a.finished.catch(() => undefined))),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      await frames();
    };

    /**
     * Wait until the element's box holds still for two frames, up to ten frames.
     * Leaving a field can render its error a frame later (zoneless change
     * detection), and that pushes the next field down after Tab has scrolled it
     * into view. The check judges where the field ends up, as a visitor sees it.
     */
    const waitForStillBox = async (el: Element) => {
      let last = '';
      let still = 0;
      for (let i = 0; i < 10 && still < 2; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const r = el.getBoundingClientRect();
        const now = `${r.x},${r.y},${r.width},${r.height},${window.scrollX},${window.scrollY}`;
        still = now === last ? still + 1 : 0;
        last = now;
      }
    };

    const sameScroll = (
      want: ScrollState,
      containers: { c: ScrollState['containers'][number]; el: Element }[],
    ) =>
      Math.abs(window.scrollX - want.x) <= 1 &&
      Math.abs(window.scrollY - want.y) <= 1 &&
      containers.every(
        ({ c, el }) => Math.abs(el.scrollLeft - c.left) <= 1 && Math.abs(el.scrollTop - c.top) <= 1,
      );

    /**
     * Is the element on top at the centre of one of its boxes? A link that wraps
     * has a box per line, and the centre of their bounding box can fall on the
     * text between them. Only the on-screen part of a box counts, so a tall
     * field scrolled half into view is judged on the half a visitor sees.
     */
    const hitTest = (el: Element, hiddenInput: boolean): FocusedRead['hit'] => {
      const view = viewport();
      const labels = labelsOf(el);
      const owners = hiddenInput ? labels : [el];
      const boxes = owners
        .flatMap((o) => Array.from(o.getClientRects()))
        .map((r) => clamp(rectOf(r), view))
        .filter((r): r is Rect => !!r && !tiny(r));
      if (boxes.length === 0) return { ok: false, found: 'nothing: no part of it is on screen' };
      let found: Element | null = null;
      for (const r of boxes) {
        found = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        if (found && (el.contains(found) || labels.some((l) => l.contains(found!)))) {
          return { ok: true, found: describe(found) };
        }
      }
      return { ok: false, found: found ? describe(found) : 'nothing' };
    };

    const api: FocusProbeApi = {
      async read() {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        await waitForAnimations(el);
        await waitForStillBox(el);
        const { box, hiddenInput } = targetBox(el);
        const ring = ringBox(el, box);
        const clip = clipFor(ring);
        const view = viewport();
        const hit = hitTest(el, hiddenInput);

        const s = getComputedStyle(el);
        const outline =
          s.outlineStyle === 'none' || parseFloat(s.outlineWidth) === 0
            ? 'none'
            : `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}, offset ${s.outlineOffset}`;

        let control: ControlRead | null = null;
        const kind = controlKind(el);
        if (kind && clip && !hiddenInput) {
          const own = rectOf(el.getBoundingClientRect());
          control = {
            kind,
            boxInClip: {
              x: own.x - clip.x,
              y: own.y - clip.y,
              width: own.width,
              height: own.height,
            },
            borders: SIDES.filter((side) => {
              const style = s.getPropertyValue(`border-${side}-style`);
              return (
                style !== 'none' &&
                style !== 'hidden' &&
                parseFloat(s.getPropertyValue(`border-${side}-width`)) >= 1
              );
            }).map((side) => rgba(s.getPropertyValue(`border-${side}-color`))),
            fill: rgba(s.backgroundColor),
            drawnByBrowser: kind === 'choice' && s.appearance !== 'none',
          };
        }

        return {
          key: keys.keyOf(el),
          box,
          hiddenInput,
          clip,
          visibleBox: clamp(box, view),
          scroll: { x: window.scrollX, y: window.scrollY, containers: scrollers(el) },
          hit,
          outline,
          control,
          inSharedChrome: !!el.closest('aec-site-header, aec-site-footer'),
        };
      },

      async prepareBaseline(scroll, clip) {
        const containers = scroll.containers
          .map((c) => ({ c, el: keys.byKey(c.key) }))
          .filter((x): x is { c: (typeof scroll.containers)[number]; el: Element } => !!x.el);
        const saved: ScrollState = {
          x: window.scrollX,
          y: window.scrollY,
          containers: containers.map(({ c, el }) => ({
            key: c.key,
            left: el.scrollLeft,
            top: el.scrollTop,
          })),
        };
        if (!sameScroll(scroll, containers)) {
          window.scrollTo({ left: scroll.x, top: scroll.y, behavior: 'instant' });
          for (const { c, el } of containers) {
            el.scrollTo({ left: c.left, top: c.top, behavior: 'instant' });
          }
          // Let sticky bars and anything that watches the scroll catch up.
          await frames();
        }
        const moved =
          containers.length !== scroll.containers.length || !sameScroll(scroll, containers);
        let blocked = false;
        const active = document.activeElement;
        if (active && active !== document.body && active !== document.documentElement) {
          const ring = ringBox(active, targetBox(active).box);
          const grown = {
            x: ring.x - MARGIN,
            y: ring.y - MARGIN,
            width: ring.width + 2 * MARGIN,
            height: ring.height + 2 * MARGIN,
          };
          blocked = overlaps(grown, clip);
        }
        return { saved, moved, blocked };
      },

      async restore(scroll) {
        const containers = scroll.containers
          .map((c) => ({ c, el: keys.byKey(c.key) }))
          .filter((x): x is { c: (typeof scroll.containers)[number]; el: Element } => !!x.el);
        if (sameScroll(scroll, containers)) return;
        window.scrollTo({ left: scroll.x, top: scroll.y, behavior: 'instant' });
        for (const { c, el } of containers) {
          el.scrollTo({ left: c.left, top: c.top, behavior: 'instant' });
        }
        // The next picture may be of another stop at this same position, and
        // `prepareBaseline` waits only when it scrolls.
        await frames();
      },
    };
    window.__aeciFocusProbe = api;
  }, RING_MARGIN);
}

const MISSING = '__aeciFocusProbeMissing';

/**
 * Run `call` against the probe, installing it first in a document that does
 * not have it yet. One round trip in the common case: the walk calls this on
 * every stop. `call` returns `MISSING` when the document has no probe.
 */
async function withProbe<T>(page: Page, call: () => Promise<unknown>): Promise<T> {
  let out = await call();
  if (out === MISSING) {
    await ensureFocusProbe(page);
    out = await call();
  }
  if (out === MISSING) throw new Error('the focus probe did not install');
  return out as T;
}

export function readFocused(page: Page): Promise<FocusedRead | null> {
  return withProbe(page, () =>
    page.evaluate<unknown, string>((m) => window.__aeciFocusProbe?.read() ?? m, MISSING),
  );
}

export function prepareBaseline(
  page: Page,
  scroll: ScrollState,
  clip: Rect,
): Promise<BaselineSetup> {
  return withProbe(page, () =>
    page.evaluate<unknown, { s: ScrollState; c: Rect; m: string }>(
      ({ s, c, m }) => window.__aeciFocusProbe?.prepareBaseline(s, c) ?? m,
      {
        s: scroll,
        c: clip,
        m: MISSING,
      },
    ),
  );
}

export async function restoreScroll(page: Page, scroll: ScrollState): Promise<void> {
  await withProbe(page, () =>
    page.evaluate<unknown, { s: ScrollState; m: string }>(
      ({ s, m }) => window.__aeciFocusProbe?.restore(s).then(() => 'ok') ?? m,
      {
        s: scroll,
        m: MISSING,
      },
    ),
  );
}

/** A picture of `clip` with animations stopped and no caret. One pixel is one CSS pixel. */
export function shoot(page: Page, clip: Rect): Promise<Buffer> {
  return page.screenshot({ clip, animations: 'disabled', caret: 'hide', scale: 'css' });
}

/** Take focus off the page, once the walk is over, for the last unfocused pictures. */
export async function blurActive(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/**
 * AECI-1881: the pure half of the magnification checks. No DOM, no Playwright.
 *
 * `magnify-probe.ts` reads the page into the plain facts below. These functions
 * decide what is wrong. They are pinned by `magnify-geometry.unit.spec.ts` in the
 * plain Vitest runner, because the in-page half needs a real layout engine and
 * jsdom has none.
 *
 * The clip detector has two halves:
 *
 *   1. Clipped text. A text node is clipped when a container that hides its
 *      overflow (`overflow: hidden` or `clip`) overflows on that axis
 *      (`scrollHeight > clientHeight`, or the width pair) and one of the text's
 *      line boxes reaches past the container's padding box. A container under
 *      2px on either side is collapsed or visually hidden on purpose (a closed
 *      panel, `.sr-only`), so its text counts as hidden, not clipped.
 *   2. Overlapping text. Two text nodes overlap when the parts of their line
 *      boxes that are not clipped away cross by more than `OVERLAP_MIN_WIDTH`
 *      across and `OVERLAP_MIN_HEIGHT_SHARE` of the shorter line's height. Only
 *      text in the same layer is compared: a fixed bar (the consent banner)
 *      lies over the page by design.
 *
 * `docs/TESTING_STRATEGY.md` §8.4.6.
 */

/** A box in CSS px, relative to the viewport, as `getBoundingClientRect` gives it. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** An ancestor of some text whose overflow is not `visible`. */
export interface ContainerFact {
  /** `tag[data-testid]`, from `describeElement` in the probe. */
  readonly desc: string;
  /** The padding box: what the container shows of its content. */
  readonly box: Box;
  readonly overflowX: string;
  readonly overflowY: string;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  /** Computed `-webkit-line-clamp`, or `null` when it is `none`. */
  readonly lineClamp: string | null;
  readonly textOverflow: string;
}

/** One text node with visible glyphs. */
export interface TextFact {
  /** The text, whitespace collapsed. */
  readonly text: string;
  /** The text's parent element. */
  readonly el: string;
  /** The nearest ancestor with a `data-testid`, for triage. Empty when none. */
  readonly near: string;
  /**
   * The component the text belongs to, from the page, not from a test id: the
   * nearest custom element (`aec-product-card-grid`), and before it the nearest
   * `aec…` attribute directive host when one is closer (`aec-taxonomy-index [aeccard]`).
   * Empty when neither exists. Known barriers anchor on it.
   */
  readonly host: string;
  /** One box per line, from `Range.getClientRects()`. */
  readonly rects: readonly Box[];
  /** 0 for the page. Otherwise one number per `position: fixed` ancestor. */
  readonly layer: number;
  /**
   * Indexes into `TextFacts.containers` of the ancestors that can clip this
   * text, innermost first. The probe has already dropped ancestors an
   * absolutely positioned or fixed box escapes.
   */
  readonly chain: readonly number[];
}

export interface TextFacts {
  readonly texts: readonly TextFact[];
  readonly containers: readonly ContainerFact[];
}

/** A horizontal scrollbar inside the page, not on the page root. */
export interface ScrollerFact {
  readonly desc: string;
  readonly near: string;
  /** The first visible words inside it. */
  readonly text: string;
  /** It is, or holds, a `table` or an element with role `table` or `grid`. */
  readonly holdsTable: boolean;
}

export type ClipKind = 'line-clamp' | 'ellipsis' | 'hidden';

export interface ClipFinding {
  readonly clip: ClipKind;
  readonly axis: 'x' | 'y';
  readonly text: string;
  readonly el: string;
  readonly near: string;
  readonly host: string;
  readonly container: string;
}

export interface OverlapFinding {
  readonly a: { readonly text: string; readonly el: string };
  readonly b: { readonly text: string; readonly el: string };
  readonly near: string;
}

/** Sub-pixel rounding and a glyph's side bearing reach about a pixel past a box. */
export const CLIP_TOLERANCE_X = 2;
/**
 * A line box from `getClientRects` is the font's content area, which is taller
 * than the glyphs. With `leading-none` it pokes out of its own box by about a
 * tenth of its height, top and bottom, with nothing cut. A quarter of the line
 * is a cut a reader sees.
 */
export const CLIP_TOLERANCE_Y_SHARE = 0.25;
export const OVERLAP_MIN_WIDTH = 2;
/** The same content-area slack, for two lines that meet. */
export const OVERLAP_MIN_HEIGHT_SHARE = 0.3;
/** A container narrower or shorter than this hides its text on purpose. */
export const COLLAPSED_BELOW = 2;

/** The longest text a problem string quotes. */
const SNIPPET = 48;

/**
 * Quote text for a problem string. Digits become `#`, so a count or a date in
 * the seed does not change the string from run to run.
 */
export function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim().replace(/\d/g, '#');
  return flat.length > SNIPPET ? `${flat.slice(0, SNIPPET - 1)}…` : flat;
}

const HIDES = new Set(['hidden', 'clip']);
const SCROLLS = new Set(['auto', 'scroll']);

function collapsed(c: ContainerFact): boolean {
  return c.clientWidth < COLLAPSED_BELOW || c.clientHeight < COLLAPSED_BELOW;
}

/** Does the container clip on this axis, and does it have content past its edge? */
function overflowsHidden(c: ContainerFact, axis: 'x' | 'y'): boolean {
  const mode = axis === 'x' ? c.overflowX : c.overflowY;
  if (!HIDES.has(mode)) return false;
  // `overflow: clip` makes no scroll container, so its scroll sizes say nothing.
  if (mode === 'clip') return true;
  return axis === 'x' ? c.scrollWidth > c.clientWidth + 1 : c.scrollHeight > c.clientHeight + 1;
}

function pastX(r: Box, box: Box): boolean {
  return r.right > box.right + CLIP_TOLERANCE_X || r.left < box.left - CLIP_TOLERANCE_X;
}

function pastY(r: Box, box: Box): boolean {
  const slack = Math.max(COLLAPSED_BELOW, (r.bottom - r.top) * CLIP_TOLERANCE_Y_SHARE);
  return r.bottom > box.bottom + slack || r.top < box.top - slack;
}

function clipKind(c: ContainerFact, axis: 'x' | 'y'): ClipKind {
  if (c.lineClamp !== null) return 'line-clamp';
  if (axis === 'x' && c.textOverflow === 'ellipsis') return 'ellipsis';
  return 'hidden';
}

/** Is this text hidden on purpose, inside a collapsed container? */
function insideCollapsed(t: TextFact, containers: readonly ContainerFact[]): boolean {
  return t.chain.some((i) => collapsed(containers[i]!));
}

/** Half 1: text cut off by a container that hides its overflow. One finding per text node. */
export function clipFindings(facts: TextFacts): ClipFinding[] {
  const out: ClipFinding[] = [];
  for (const t of facts.texts) {
    if (insideCollapsed(t, facts.containers)) continue;
    let found: ClipFinding | null = null;
    // Past a scroll container on an axis, the text is reachable by scrolling it. A
    // container further out clips the scroller's box on that axis, not the text.
    const reachable = { x: false, y: false };
    for (const i of t.chain) {
      const c = facts.containers[i]!;
      for (const axis of ['y', 'x'] as const) {
        if (reachable[axis] || !overflowsHidden(c, axis)) continue;
        const past = axis === 'x' ? pastX : pastY;
        if (t.rects.some((r) => past(r, c.box))) {
          found = {
            clip: clipKind(c, axis),
            axis,
            text: t.text,
            el: t.el,
            near: t.near,
            host: t.host,
            container: c.desc,
          };
          break;
        }
      }
      if (found) break;
      if (SCROLLS.has(c.overflowX)) reachable.x = true;
      if (SCROLLS.has(c.overflowY)) reachable.y = true;
    }
    if (found) out.push(found);
  }
  return out;
}

function intersect(a: Box, b: Box): Box | null {
  const box = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return box.right - box.left > 0.5 && box.bottom - box.top > 0.5 ? box : null;
}

/**
 * The parts of a text's line boxes a reader can see: each box cut to every
 * ancestor that does not let its overflow show. Scroll containers count, since
 * what is scrolled out of them is not painted over anything.
 */
export function visibleRects(t: TextFact, containers: readonly ContainerFact[]): Box[] {
  const out: Box[] = [];
  for (const rect of t.rects) {
    let r: Box | null = rect;
    for (const i of t.chain) {
      const c = containers[i]!;
      const clipBox: Box = {
        left: c.overflowX === 'visible' ? -Infinity : c.box.left,
        right: c.overflowX === 'visible' ? Infinity : c.box.right,
        top: c.overflowY === 'visible' ? -Infinity : c.box.top,
        bottom: c.overflowY === 'visible' ? Infinity : c.box.bottom,
      };
      r = intersect(r, clipBox);
      if (!r) break;
    }
    if (r) out.push(r);
  }
  return out;
}

/** Half 2: two text nodes painted over each other. One finding per pair. */
export function overlapFindings(facts: TextFacts): OverlapFinding[] {
  interface Line {
    readonly owner: number;
    readonly box: Box;
  }
  const lines: Line[] = [];
  facts.texts.forEach((t, owner) => {
    if (insideCollapsed(t, facts.containers)) return;
    for (const box of visibleRects(t, facts.containers)) lines.push({ owner, box });
  });
  lines.sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);

  const pairs = new Set<string>();
  const out: OverlapFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i]!;
    for (let j = i + 1; j < lines.length && lines[j]!.box.top < a.box.bottom; j++) {
      const b = lines[j]!;
      if (a.owner === b.owner) continue;
      const ta = facts.texts[a.owner]!;
      const tb = facts.texts[b.owner]!;
      if (ta.layer !== tb.layer) continue;
      const cross = intersect(a.box, b.box);
      if (!cross) continue;
      const shorter = Math.min(a.box.bottom - a.box.top, b.box.bottom - b.box.top);
      if (cross.right - cross.left <= OVERLAP_MIN_WIDTH) continue;
      if (cross.bottom - cross.top <= shorter * OVERLAP_MIN_HEIGHT_SHARE) continue;
      const key = `${Math.min(a.owner, b.owner)}:${Math.max(a.owner, b.owner)}`;
      if (pairs.has(key)) continue;
      pairs.add(key);
      const [first, second] = a.owner < b.owner ? [ta, tb] : [tb, ta];
      out.push({
        a: { text: first.text, el: first.el },
        b: { text: second.text, el: second.el },
        near: first.near || second.near,
      });
    }
  }
  return out;
}

/**
 * The page root scrolls sideways. The rule of `e2e/no-sideways-scroll.ts`: compare
 * the root's `scrollWidth` with its `clientWidth`, never for equality, because on
 * Linux the classic scrollbar gutter makes `scrollWidth` the smaller one on a page
 * that fits (PR #1321). AECI-1881 allows the one pixel of rounding its issue names.
 */
export function scrollsSideways(root: { scrollWidth: number; clientWidth: number }): boolean {
  return root.scrollWidth > root.clientWidth + 1;
}

const MATRIX = /^matrix(3d)?\(([^)]*)\)$/;

/**
 * A computed `transform` or `rotate` that turns the element. `matrix(a, b, c, d, …)`
 * turns or skews when `b` or `c` is not zero. `matrix3d` holds them at 1 and 4.
 */
export function isRotated(transform: string, rotate: string): boolean {
  const turn = rotate.trim();
  if (turn !== '' && turn !== 'none' && !/^0(deg|rad|turn|grad)?$/.test(turn)) return true;
  const m = transform.trim().match(MATRIX);
  if (!m) return false;
  const v = m[2]!.split(',').map((n) => Number(n.trim()));
  const [b, c] = m[1] ? [v[1], v[4]] : [v[1], v[2]];
  return Math.abs(b ?? 0) > 1e-6 || Math.abs(c ?? 0) > 1e-6;
}

const where = (near: string) => (near ? ` near ${near}` : '');
const within = (host: string) => (host ? ` within ${host}` : '');

export function formatClip(f: ClipFinding): string {
  return `clipped (${f.clip}) "${snippet(f.text)}" in ${f.el} by ${f.container}${within(f.host)}${where(f.near)}`;
}

export function formatOverlap(f: OverlapFinding): string {
  return `"${snippet(f.a.text)}" in ${f.a.el} overlaps "${snippet(f.b.text)}" in ${f.b.el}${where(f.near)}`;
}

export function formatScroller(s: ScrollerFact): string {
  return `${s.desc} scrolls sideways inside the page${where(s.near)}: "${snippet(s.text)}"`;
}

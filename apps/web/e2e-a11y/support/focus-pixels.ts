/**
 * AECI-1878: the pure half of the focus ring checks. Colour maths and pixels.
 *
 * Nothing here touches a page, so the plain Vitest runner pins it
 * (`./focus-pixels.unit.spec.ts`). The page half is `./focus-probe.ts`, and
 * `./focus-check.ts` puts the two together for `../focus-ring.spec.ts`.
 *
 * Colours are sRGB bytes. The contrast ratio is WCAG 2.2's: relative
 * luminance with the 0.04045 sRGB threshold, then (L1 + 0.05) / (L2 + 0.05).
 */
import { inflateSync } from 'node:zlib';

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** An sRGB colour with alpha from 0 to 1. */
export interface Rgba extends Rgb {
  readonly a: number;
}

/** A decoded image, four bytes per pixel (RGBA), rows top to bottom. */
export interface Bitmap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** WCAG's floor for a focus indicator and a control boundary (1.4.11). */
export const NON_TEXT_CONTRAST = 3;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 for black to 1 for white. */
export function relativeLuminance(color: Rgb): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG contrast ratio, 1 to 21. The order of the two colours does not matter. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Paint `top` over an opaque `bottom`, as the browser does. */
export function composite(top: Rgba, bottom: Rgb): Rgb {
  const a = Math.min(1, Math.max(0, top.a));
  return {
    r: Math.round(top.r * a + bottom.r * (1 - a)),
    g: Math.round(top.g * a + bottom.g * (1 - a)),
    b: Math.round(top.b * a + bottom.b * (1 - a)),
  };
}

/** `#rgb` or `#rrggbb` to a colour. For tests and messages. */
export function hex(value: string): Rgb {
  let h = value.replace(/^#/, '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`not a hex colour: ${value}`);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function toHex(color: Rgb): string {
  return `#${[color.r, color.g, color.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// --- PNG ------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode the PNG a Playwright screenshot returns: 8-bit RGB or RGBA, not
 * interlaced. Anything else throws, so a format change cannot pass silently.
 * The repo has no PNG library, and this is the one format Chromium writes.
 */
export function decodePng(png: Buffer): Bitmap {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8];
      colorType = body[9];
      const interlace = body[12];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error(
          `unsupported PNG: bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}`,
        );
      }
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error('PNG has no IHDR');
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      cur[i] = value & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = cur[x * bpp];
      out[o + 1] = cur[x * bpp + 1];
      out[o + 2] = cur[x * bpp + 2];
      out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, data: out };
}

export function pixel(image: Bitmap, x: number, y: number): Rgb {
  const o = (y * image.width + x) * 4;
  return { r: image.data[o], g: image.data[o + 1], b: image.data[o + 2] };
}

// --- The indicator --------------------------------------------------------

export interface IndicatorMeasure {
  /** Pixels that differ between the focused and the unfocused image. */
  readonly changed: number;
  /** Changed pixels whose focused colour is at least 3:1 against the unfocused one. */
  readonly strong: number;
  /** The highest contrast any changed pixel reached. 1 when none changed. */
  readonly best: number;
  /** Changed pixels left out because they fall in a region `exclude` names. */
  readonly excluded: number;
}

/** Is the pixel at (x, y) inside one of `rects`? A partly covered pixel counts as inside. */
function inAny(rects: readonly Rect[], x: number, y: number): boolean {
  for (const r of rects) {
    if (
      x >= Math.floor(r.x) &&
      x < Math.ceil(r.x + r.width) &&
      y >= Math.floor(r.y) &&
      y < Math.ceil(r.y + r.height)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Compare the same region focused and unfocused. A changed pixel is part of
 * the focus indicator. Its contrast is the indicator colour against what was
 * there before: the adjacent background the ring is drawn on.
 *
 * `exclude` names regions, in the pictures' coordinates, where something other
 * than focus changed between the two pictures: an error that appeared when the
 * stop lost focus, or the stop's own box when its state changed (`changedRegions`).
 * A change there is not a ring, so it is not counted.
 */
export function measureIndicator(
  focused: Bitmap,
  unfocused: Bitmap,
  exclude: readonly Rect[] = [],
): IndicatorMeasure {
  if (focused.width !== unfocused.width || focused.height !== unfocused.height) {
    throw new Error(
      `images differ in size: ${focused.width}x${focused.height} and ${unfocused.width}x${unfocused.height}`,
    );
  }
  let changed = 0;
  let strong = 0;
  let best = 1;
  let excluded = 0;
  const a = focused.data;
  const b = unfocused.data;
  for (let o = 0; o < a.length; o += 4) {
    if (a[o] === b[o] && a[o + 1] === b[o + 1] && a[o + 2] === b[o + 2]) continue;
    const p = o / 4;
    if (exclude.length > 0 && inAny(exclude, p % focused.width, Math.floor(p / focused.width))) {
      excluded++;
      continue;
    }
    changed++;
    const ratio = contrastRatio(
      { r: a[o], g: a[o + 1], b: a[o + 2] },
      { r: b[o], g: b[o + 1], b: b[o + 2] },
    );
    if (ratio > best) best = ratio;
    if (ratio >= NON_TEXT_CONTRAST) strong++;
  }
  return { changed, strong, best, excluded };
}

/** An element near a stop, as read when the stop was focused and again when it was not. */
export interface RegionElement {
  /** The keyboard probe's key, the same element in both reads. */
  readonly key: number;
  /** Its border box, in the pictures' coordinates. */
  readonly rect: Rect;
  /** Its attributes and its own text. A change means it changed for a reason of its own. */
  readonly sig: string;
}

/**
 * The regions where something other than focus changed between the two
 * pictures: an element that appeared, went, moved, resized, or changed its
 * attributes or its own text. An error message that renders when a field
 * loses focus is one. Both its rects are returned when it moved, so neither
 * place counts. Pure, so the plain Vitest runner pins it.
 */
export function changedRegions(
  focused: readonly RegionElement[],
  unfocused: readonly RegionElement[],
): Rect[] {
  const before = new Map(focused.map((e) => [e.key, e]));
  const after = new Map(unfocused.map((e) => [e.key, e]));
  const out: Rect[] = [];
  for (const e of focused) {
    const now = after.get(e.key);
    if (!now || now.sig !== e.sig || !sameRect(now.rect, e.rect)) out.push(e.rect);
  }
  for (const e of unfocused) {
    const then = before.get(e.key);
    if (!then || then.sig !== e.sig || !sameRect(then.rect, e.rect)) out.push(e.rect);
  }
  return out;
}

/**
 * The same box, to a hundredth of a pixel. A stop that moved or resized
 * between its two pictures cannot be compared: every edge in the clip would
 * read as a change.
 */
export function sameRect(a: Rect, b: Rect): boolean {
  const close = (p: number, q: number) => Math.abs(p - q) < 0.01;
  return close(a.x, b.x) && close(a.y, b.y) && close(a.width, b.width) && close(a.height, b.height);
}

/**
 * How many 3:1 pixels the indicator needs: a line 1 CSS pixel wide all the
 * way round the focused element's visible box. A 3px outline gives about three
 * times this. A ring that vanishes on its ground, or a faint background tint,
 * gives far less. Screenshots are taken at `scale: 'css'`, so a pixel is a CSS pixel.
 *
 * `visible` is the part of `box` on screen. Only the sides of `box` that are on
 * screen count: a tall field scrolled half into view has no ring to show along
 * the viewport's edge.
 */
export function requiredIndicatorPixels(box: Rect, visible: Rect = box): number {
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;
  let length = 0;
  if (near(visible.y, box.y)) length += visible.width;
  if (near(visible.y + visible.height, box.y + box.height)) length += visible.width;
  if (near(visible.x, box.x)) length += visible.height;
  if (near(visible.x + visible.width, box.x + box.width)) length += visible.height;
  return Math.max(4, Math.round(length));
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The colour of the ground around a box: the median, by luminance, of the
 * pixels on a ring `distance` pixels outside it, in the unfocused image. The
 * median ignores the odd glyph or neighbouring edge on the ring. Corners are
 * left out, where a rounded box shows ground on both sides. `box` is in the
 * image's coordinates. Returns `null` when the ring is outside the image.
 */
export function groundAround(image: Bitmap, box: Rect, distance = 2): Rgb | null {
  const left = Math.floor(box.x) - distance;
  const top = Math.floor(box.y) - distance;
  const right = Math.ceil(box.x + box.width) - 1 + distance;
  const bottom = Math.ceil(box.y + box.height) - 1 + distance;
  const corner = 6;
  const samples: Rgb[] = [];
  const take = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < image.width && y < image.height) samples.push(pixel(image, x, y));
  };
  for (let x = left + corner; x <= right - corner; x++) {
    take(x, top);
    take(x, bottom);
  }
  for (let y = top + corner; y <= bottom - corner; y++) {
    take(left, y);
    take(right, y);
  }
  if (samples.length === 0) return null;
  samples.sort((p, q) => relativeLuminance(p) - relativeLuminance(q));
  return samples[Math.floor(samples.length / 2)];
}

/** The highest contrast any pixel inside `box` reaches against `ground`. */
export function strongestInside(image: Bitmap, box: Rect, ground: Rgb): number {
  let best = 1;
  const x0 = Math.max(0, Math.ceil(box.x));
  const y0 = Math.max(0, Math.ceil(box.y));
  const x1 = Math.min(image.width, Math.floor(box.x + box.width));
  const y1 = Math.min(image.height, Math.floor(box.y + box.height));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const ratio = contrastRatio(pixel(image, x, y), ground);
      if (ratio > best) best = ratio;
    }
  }
  return best;
}

// --- The control boundary (1.4.11) ------------------------------------------

export interface BoundaryInput {
  /** The ground just outside the control, from the unfocused image. */
  readonly ground: Rgb;
  /** Border colour per side with a border at least 1px wide, top, right, bottom, left. */
  readonly borders: readonly Rgba[];
  /** The control's own computed background colour. */
  readonly fill: Rgba;
  /** For a box the browser draws (a native checkbox or radio): its strongest pixel against the ground. */
  readonly drawnBox: number | null;
}

export interface BoundaryVerdict {
  readonly pass: boolean;
  /** The best of the three ways a control can show its edge, as a ratio. */
  readonly best: number;
  readonly by: 'border' | 'fill' | 'drawn box' | 'none';
}

/**
 * A control shows where it is (WCAG 1.4.11) when one of these reaches 3:1
 * against the ground around it: every border it has, its own fill, or, for a
 * box the browser draws, some pixel of that box. A border is painted over the
 * control's fill, so a translucent border is composited onto the fill first.
 */
export function boundaryVerdict(input: BoundaryInput): BoundaryVerdict {
  const fill = composite(input.fill, input.ground);
  const borderRatio =
    input.borders.length === 0
      ? 1
      : Math.min(...input.borders.map((c) => contrastRatio(composite(c, fill), input.ground)));
  const fillRatio = contrastRatio(fill, input.ground);
  const drawn = input.drawnBox ?? 1;
  const options: [BoundaryVerdict['by'], number][] = [
    ['border', borderRatio],
    ['fill', fillRatio],
    ['drawn box', drawn],
  ];
  options.sort((p, q) => q[1] - p[1]);
  const [by, best] = options[0];
  const pass = best >= NON_TEXT_CONTRAST;
  return { pass, best, by: best > 1 ? by : 'none' };
}

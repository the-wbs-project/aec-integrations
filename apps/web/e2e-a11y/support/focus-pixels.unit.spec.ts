import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  boundaryVerdict,
  changedRegions,
  composite,
  contrastRatio,
  decodePng,
  groundAround,
  hex,
  measureIndicator,
  relativeLuminance,
  requiredIndicatorPixels,
  sameRect,
  strongestInside,
  toHex,
  type Bitmap,
  type RegionElement,
  type Rgb,
} from './focus-pixels';

// AECI-1878: the colour maths and pixel rules behind the focus ring checks.
// The known pairs come from WCAG's own examples and from the ratios DESIGN.md
// records for the brand tokens, so a drift in the formula shows up here first.

const WHITE = hex('#ffffff');
const BLACK = hex('#000000');
const FOREST = hex('#1E3A2F');
const BONE = hex('#F5F2EA');
const CLAY_DEEP = hex('#A14D22');

describe('contrastRatio against known colour pairs', () => {
  it.each([
    ['black on white', BLACK, WHITE, 21],
    ['white on white', WHITE, WHITE, 1],
    // The darkest grey that passes 4.5:1 on white, the usual reference value.
    ['#767676 on white', hex('#767676'), WHITE, 4.54],
    // DESIGN.md "Focus ring on Forest": Bone is 11.03:1 on Forest.
    ['Bone on Forest', BONE, FOREST, 11.03],
    // DESIGN.md "Clay deep": 5.83:1 on white, 5.21:1 on Bone.
    ['Clay deep on white', CLAY_DEEP, WHITE, 5.83],
    ['Clay deep on Bone', CLAY_DEEP, BONE, 5.21],
    // The vendor portal filter edge AECI-2098 records: border-default on the panel ground.
    ['#E4E4E7 on #FAFAFA', hex('#E4E4E7'), hex('#FAFAFA'), 1.22],
  ])('%s', (_label, a, b, expected) => {
    expect(contrastRatio(a, b)).toBeCloseTo(expected, 2);
    // The order of the two colours does not matter.
    expect(contrastRatio(b, a)).toBeCloseTo(expected, 2);
  });

  it('puts the 3:1 line where WCAG does', () => {
    // #949494 is the lightest grey at or above 3:1 on white. #959595 falls under.
    expect(contrastRatio(hex('#949494'), WHITE)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(hex('#959595'), WHITE)).toBeLessThan(3);
  });

  it('gives luminance 0 for black and 1 for white', () => {
    expect(relativeLuminance(BLACK)).toBe(0);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10);
  });
});

describe('composite', () => {
  it('paints a translucent colour over its ground', () => {
    expect(composite({ ...BLACK, a: 0.5 }, WHITE)).toEqual({ r: 128, g: 128, b: 128 });
    expect(composite({ ...FOREST, a: 1 }, WHITE)).toEqual(FOREST);
    expect(composite({ ...FOREST, a: 0 }, BONE)).toEqual(BONE);
  });
});

describe('hex and toHex', () => {
  it('round-trips, and reads the short form', () => {
    expect(toHex(hex('#1e3a2f'))).toBe('#1e3a2f');
    expect(hex('#fff')).toEqual(WHITE);
    expect(() => hex('forest')).toThrow();
  });
});

// --- PNG ---------------------------------------------------------------

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** Encode RGB or RGBA rows, each with the filter type given for its row. */
function encodePng(
  width: number,
  height: number,
  bpp: 3 | 4,
  pixelAt: (x: number, y: number) => number[],
  filters: number[],
): Buffer {
  const stride = width * bpp;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const raw = Buffer.from(Array.from({ length: width }, (_, x) => pixelAt(x, y)).flat());
    const filter = filters[y % filters.length];
    const out = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? raw[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[i] = (raw[i] - predictor) & 0xff;
    }
    rows.push(Buffer.concat([Buffer.from([filter]), out]));
    prev = raw;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = bpp === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('decodePng', () => {
  const colourAt = (x: number, y: number) => [(x * 37) & 0xff, (y * 59) & 0xff, (x * y) & 0xff];

  it.each([3, 4] as const)('decodes %i bytes per pixel through all five filters', (bpp) => {
    const png = encodePng(
      7,
      10,
      bpp,
      (x, y) => (bpp === 4 ? [...colourAt(x, y), 200] : colourAt(x, y)),
      [0, 1, 2, 3, 4],
    );
    const image = decodePng(png);
    expect(image.width).toBe(7);
    expect(image.height).toBe(10);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 7; x++) {
        const o = (y * 7 + x) * 4;
        expect([...image.data.subarray(o, o + 4)]).toEqual([
          ...colourAt(x, y),
          bpp === 4 ? 200 : 255,
        ]);
      }
    }
  });

  it('refuses what it cannot read', () => {
    expect(() => decodePng(Buffer.from('not a png'))).toThrow('not a PNG');
  });
});

// --- The indicator -----------------------------------------------------

function solid(width: number, height: number, color: Rgb): Bitmap {
  const data = new Uint8Array(width * height * 4);
  for (let o = 0; o < data.length; o += 4) {
    data[o] = color.r;
    data[o + 1] = color.g;
    data[o + 2] = color.b;
    data[o + 3] = 255;
  }
  return { width, height, data };
}

function paint(image: Bitmap, x0: number, y0: number, w: number, h: number, color: Rgb): Bitmap {
  const data = new Uint8Array(image.data);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const o = (y * image.width + x) * 4;
      data[o] = color.r;
      data[o + 1] = color.g;
      data[o + 2] = color.b;
    }
  }
  return { ...image, data };
}

/** A `thickness` ring round the box at (x, y, w, h). */
function ring(image: Bitmap, x: number, y: number, w: number, h: number, t: number, c: Rgb) {
  let out = paint(image, x - t, y - t, w + 2 * t, t, c);
  out = paint(out, x - t, y + h, w + 2 * t, t, c);
  out = paint(out, x - t, y, t, h, c);
  return paint(out, x + w, y, t, h, c);
}

describe('measureIndicator', () => {
  const ground = solid(60, 40, WHITE);

  it('finds no change when nothing is drawn: the visible check fails', () => {
    expect(measureIndicator(ground, ground)).toEqual({
      changed: 0,
      strong: 0,
      best: 1,
      excluded: 0,
    });
  });

  it('counts a Forest ring on white as strong, and passes the 1px-line rule', () => {
    const focused = ring(ground, 10, 10, 30, 10, 3, FOREST);
    const m = measureIndicator(focused, ground);
    expect(m.changed).toBe(m.strong);
    expect(m.best).toBeCloseTo(contrastRatio(FOREST, WHITE), 5);
    expect(m.strong).toBeGreaterThanOrEqual(
      requiredIndicatorPixels({ x: 10, y: 10, width: 30, height: 10 }),
    );
  });

  it('counts a Forest ring on a Forest ground as changed only if it differs, and weak', () => {
    const forestGround = solid(60, 40, hex('#2a4a3c'));
    const focused = ring(forestGround, 10, 10, 30, 10, 3, FOREST);
    const m = measureIndicator(focused, forestGround);
    expect(m.changed).toBeGreaterThan(0);
    expect(m.strong).toBe(0);
  });

  it('counts a faint background tint as weak', () => {
    const focused = paint(ground, 10, 10, 30, 10, hex('#F4F4F5'));
    const m = measureIndicator(focused, ground);
    expect(m.changed).toBe(300);
    expect(m.strong).toBe(0);
  });

  it('refuses two pictures of different sizes', () => {
    expect(() => measureIndicator(ground, solid(10, 10, WHITE))).toThrow('differ in size');
  });

  // Review round 2: a field with no ring whose only change on blur is an error
  // message below it and a red edge on itself. Neither is a ring.
  it('does not count an error that appears on blur, so a ringless field fails visible', () => {
    const red = hex('#b91c1c');
    // Focused: nothing drawn. Unfocused: a red edge on the field and a message under it.
    let unfocused = ring(ground, 10, 10, 30, 10, 1, red);
    unfocused = paint(unfocused, 10, 24, 25, 6, red);
    const field = { x: 9, y: 9, width: 32, height: 12 };
    const message = { x: 10, y: 24, width: 25, height: 6 };
    expect(measureIndicator(ground, unfocused).strong).toBeGreaterThan(0);
    const m = measureIndicator(ground, unfocused, [field, message]);
    expect(m.changed).toBe(0);
    expect(m.excluded).toBeGreaterThan(0);
  });

  it('still counts a ring outside the excluded regions', () => {
    let focused = ring(ground, 10, 10, 30, 10, 3, FOREST);
    focused = paint(focused, 10, 30, 25, 6, hex('#b91c1c'));
    const m = measureIndicator(focused, ground, [
      { x: 10, y: 10, width: 30, height: 10 },
      { x: 10, y: 30, width: 25, height: 6 },
    ]);
    expect(m.strong).toBeGreaterThanOrEqual(
      requiredIndicatorPixels({ x: 10, y: 10, width: 30, height: 10 }),
    );
    expect(m.excluded).toBe(150);
  });

  it('treats a partly covered pixel as excluded', () => {
    const focused = paint(ground, 5, 5, 1, 1, BLACK);
    expect(
      measureIndicator(focused, ground, [{ x: 5.5, y: 5.5, width: 0.2, height: 0.2 }]),
    ).toMatchObject({
      changed: 0,
      excluded: 1,
    });
  });
});

describe('changedRegions', () => {
  const el = (key: number, x: number, sig = 'p[]'): RegionElement => ({
    key,
    rect: { x, y: 0, width: 10, height: 10 },
    sig,
  });

  it('is empty when nothing round the stop changed', () => {
    expect(changedRegions([el(1, 0), el(2, 20)], [el(1, 0), el(2, 20)])).toEqual([]);
  });

  it('names an element that appeared on blur, such as an error message', () => {
    expect(changedRegions([el(1, 0)], [el(1, 0), el(2, 20)])).toEqual([el(2, 20).rect]);
  });

  it('names an element that went', () => {
    expect(changedRegions([el(1, 0), el(2, 20)], [el(1, 0)])).toEqual([el(2, 20).rect]);
  });

  it('names an element whose text or attributes changed, in both pictures', () => {
    const before = el(1, 0, 'p[class=hint]');
    const after = el(1, 0, 'p[class=error]Enter a value');
    expect(changedRegions([before], [after])).toEqual([before.rect, after.rect]);
  });

  it('names both places of an element that moved', () => {
    expect(changedRegions([el(1, 0)], [el(1, 1)])).toEqual([el(1, 0).rect, el(1, 1).rect]);
  });
});

describe('sameRect', () => {
  it('allows no movement of a pixel or more, and none of a tenth', () => {
    const a = { x: 10, y: 20, width: 30, height: 40 };
    expect(sameRect(a, { ...a })).toBe(true);
    expect(sameRect(a, { ...a, y: 21 })).toBe(false);
    expect(sameRect(a, { ...a, x: 10.1 })).toBe(false);
    expect(sameRect(a, { ...a, width: 31 })).toBe(false);
  });
});

describe('requiredIndicatorPixels', () => {
  it('is the perimeter of the box', () => {
    expect(requiredIndicatorPixels({ x: 0, y: 0, width: 100, height: 40 })).toBe(280);
  });

  it('counts only the sides on screen', () => {
    // The bottom 100px of a 200px-tall field is below the viewport.
    const box = { x: 10, y: 600, width: 300, height: 200 };
    const visible = { x: 10, y: 600, width: 300, height: 100 };
    expect(requiredIndicatorPixels(box, visible)).toBe(300 + 100 + 100);
  });

  it('never asks for fewer than four pixels', () => {
    expect(requiredIndicatorPixels({ x: 0, y: 0, width: 1, height: 1 })).toBe(4);
  });
});

describe('groundAround and strongestInside', () => {
  it('takes the median of the ring, so a stray glyph does not move it', () => {
    let image = solid(60, 40, BONE);
    image = paint(image, 20, 7, 3, 1, BLACK);
    expect(groundAround(image, { x: 10, y: 10, width: 40, height: 20 })).toEqual(BONE);
  });

  it('returns null when the ring is outside the picture', () => {
    expect(groundAround(solid(10, 10, WHITE), { x: -50, y: -50, width: 5, height: 5 })).toBeNull();
  });

  it('finds the strongest pixel of a drawn box', () => {
    let image = solid(30, 30, WHITE);
    image = ring(image, 10, 10, 10, 10, 1, hex('#767676'));
    expect(strongestInside(image, { x: 9, y: 9, width: 12, height: 12 }, WHITE)).toBeCloseTo(
      4.54,
      2,
    );
  });
});

describe('boundaryVerdict', () => {
  const none = { r: 0, g: 0, b: 0, a: 0 };

  it('passes a field whose border reaches 3:1', () => {
    const v = boundaryVerdict({
      ground: WHITE,
      borders: Array(4).fill({ ...hex('#767676'), a: 1 }),
      fill: { ...WHITE, a: 1 },
      drawnBox: null,
    });
    expect(v).toMatchObject({ pass: true, by: 'border' });
  });

  it('fails the AECI-2098 field: a faint border, a white fill, a near-white ground', () => {
    const v = boundaryVerdict({
      ground: hex('#FAFAFA'),
      borders: Array(4).fill({ ...hex('#E4E4E7'), a: 1 }),
      fill: { ...WHITE, a: 1 },
      drawnBox: null,
    });
    expect(v.pass).toBe(false);
    expect(v.best).toBeCloseTo(1.22, 2);
  });

  it('judges every border: one faint side fails the border route', () => {
    const strong = { ...BLACK, a: 1 };
    const faint = { ...hex('#eeeeee'), a: 1 };
    const v = boundaryVerdict({
      ground: WHITE,
      borders: [strong, strong, strong, faint],
      fill: none,
      drawnBox: null,
    });
    expect(v.pass).toBe(false);
  });

  it('passes a borderless field whose own fill reaches 3:1', () => {
    const v = boundaryVerdict({
      ground: WHITE,
      borders: [],
      fill: { ...FOREST, a: 1 },
      drawnBox: null,
    });
    expect(v).toMatchObject({ pass: true, by: 'fill' });
  });

  it('composites a translucent border over the fill', () => {
    // Bone at 50% over a Forest-wash fill on Forest: the header search box.
    const v = boundaryVerdict({
      ground: FOREST,
      borders: Array(4).fill({ ...BONE, a: 0.5 }),
      fill: { ...BONE, a: 0.1 },
      drawnBox: null,
    });
    expect(v.by).toBe('border');
    expect(v.pass).toBe(true);
  });

  it('uses the drawn box for a native checkbox', () => {
    const v = boundaryVerdict({ ground: WHITE, borders: [], fill: none, drawnBox: 4.54 });
    expect(v).toMatchObject({ pass: true, by: 'drawn box' });
  });

  it('says none when nothing differs from the ground', () => {
    const v = boundaryVerdict({ ground: WHITE, borders: [], fill: none, drawnBox: null });
    expect(v).toEqual({ pass: false, best: 1, by: 'none' });
  });
});

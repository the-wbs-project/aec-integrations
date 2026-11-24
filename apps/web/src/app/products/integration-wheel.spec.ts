/**
 * AECI-2018: the wheel's geometry (`integration-wheel.ts`). The cut-offs are not
 * hard-coded anywhere: they come from the ring maths, and these pin what that maths gives
 * at the mock-up's measured stage widths (476 at 1280 and up, 336 at 1024, 294 at 390,
 * 279 at 375, 224 at 320). Order and membership are pinned in
 * `on-page-ordering-firewall.spec.ts`; the rendering in the component spec.
 */
import type { ProductIntegrationItem } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import {
  TILE_MIN_DESKTOP,
  TILE_MIN_PHONE,
  WHEEL_BANDS,
  dotsMax,
  isPhoneStage,
  layoutSlide,
  wheelLayout,
  wheelModel,
  oneRingMax,
  wheelMode,
  wheelBandFor,
  wheelCapacity,
  wheelTileSize,
  type WheelSlide,
} from './integration-wheel';

/** The "All" slide's mode for n products, with the product's own tile size. */
const modeOfAll = (n: number, d: number) => {
  const tile = wheelTileSize([n], d);
  return tile === null ? 'dots' : wheelMode(n, d);
};

/** The largest n that takes each mode, and the first n that is dots. */
function cutOffs(d: number) {
  let one = 0;
  let two = 0;
  let n = 1;
  for (; n < 400; n++) {
    const mode = modeOfAll(n, d);
    if (mode === 'one') one = n;
    else if (mode === 'two') two = n;
    else break;
  }
  return { one, two, dotsFrom: n };
}

describe('the wheel cut-offs (the "All" slide)', () => {
  it.each([
    [476, { one: 20, two: 69, dotsFrom: 70 }],
    [400, { one: 20, two: 55, dotsFrom: 56 }],
    [336, { one: 18, two: 43, dotsFrom: 44 }],
    [294, { one: 25, two: 0, dotsFrom: 26 }],
    [279, { one: 23, two: 0, dotsFrom: 24 }],
    [320, { one: 27, two: 0, dotsFrom: 28 }],
    [260, { one: 21, two: 0, dotsFrom: 22 }],
    [224, { one: 18, two: 0, dotsFrom: 19 }],
  ])('at a %ipx stage', (d, expected) => {
    expect(cutOffs(d)).toEqual(expected);
  });

  it('the second ring opens after 20 products beside the text, never on a phone', () => {
    expect(isPhoneStage(294)).toBe(true);
    expect(isPhoneStage(336)).toBe(false);
    expect(modeOfAll(20, 476)).toBe('one');
    expect(modeOfAll(21, 476)).toBe('two');
    expect(modeOfAll(25, 294)).toBe('one');
  });

  it('one-ring tiles are as large as fit, up to 48px; two-ring up to 40px', () => {
    expect(wheelTileSize([6], 476)).toBe(48);
    expect(wheelTileSize([20], 476)).toBe(48);
    expect(wheelTileSize([21], 476)).toBe(40);
    expect(wheelTileSize([69], 476)).toBe(TILE_MIN_DESKTOP);
    // At 1024 one ring holds 18 at 40px or more; from 19 two rings at up to 40px.
    expect(wheelTileSize([18], 336)).toBe(41);
    expect(wheelTileSize([19], 336)).toBe(40);
    // Phones: one ring, up to 40px, never under 24px.
    expect(wheelTileSize([6], 294)).toBe(40);
    expect(wheelTileSize([25], 294)).toBe(TILE_MIN_PHONE);
    expect(wheelTileSize([19], 224)).toBeNull();
  });

  it('every server band lays a tile at or above the minimum for its width', () => {
    for (const d of WHEEL_BANDS) {
      const min = isPhoneStage(d) ? TILE_MIN_PHONE : TILE_MIN_DESKTOP;
      for (let n = 1; n < 80; n++) {
        const tile = wheelTileSize([n], d);
        if (tile !== null) expect(tile, `${n} at ${d}`).toBeGreaterThanOrEqual(min);
      }
    }
  });
});

let seq = 0;
const link = (slug: string, name: string) => ({ id: `id-${slug}`, slug, name, logo_url: null });
const page = link('page', 'Page');

function row(partner: string, categories: string[]): ProductIntegrationItem {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    name: `${partner} link`,
    mechanism_kind: 'native',
    mechanism_name: null,
    direction: null,
    context_direction: null,
    source: page,
    target: link(partner, partner),
    via: null,
    powered_by_product: null,
    data_object_slugs: [],
    data_objects: [],
    partner_categories: categories.map((c) => ({ slug: c, name: c })),
    agreement: null,
    caption: null,
    corrections: [],
    under_review: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  } as ProductIntegrationItem;
}

/** n partners named p00.. with the first `inSmall` also in category "small". */
function rows(n: number, inSmall = 0): ProductIntegrationItem[] {
  return Array.from({ length: n }, (_, i) =>
    row(`p${String(i).padStart(2, '0')}`, i < inSmall ? ['small', 'all-of-them'] : ['all-of-them']),
  );
}

describe('the wheel layout per slide', () => {
  it('the ring count is decided per slide, at the product tile size', () => {
    const model = wheelModel(rows(40, 5), [], []);
    const all = layoutSlide(model, 0, 476);
    const small = layoutSlide(
      model,
      model.slides.findIndex((s) => s.key === 'small'),
      476,
    );
    expect(all.mode).toBe('two');
    expect(small.mode).toBe('one');
    // One size per product, so stepping never resizes a tile.
    expect(small.tilePx).toBe(all.tilePx);
  });

  it('a one-ring slide sits on the outer circle; on two rings A to Z fills the inner first', () => {
    const one = layoutSlide(wheelModel(rows(6), [], []), 0, 476);
    const radius = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);
    for (const p of one.points) expect(radius(p)).toBeCloseTo(one.outer, 1);
    // The first tile is at 12 o'clock.
    expect(one.points[0]).toEqual({ x: 0, y: -one.outer });

    const two = layoutSlide(wheelModel(rows(40), [], []), 0, 476);
    const inner = two.points.filter((p) => Math.abs(radius(p) - two.inner!) < 0.1);
    const outer = two.points.filter((p) => Math.abs(radius(p) - two.outer) < 0.1);
    expect(inner.length + outer.length).toBe(40);
    expect(two.points.slice(0, inner.length)).toEqual(inner);
    // Split by circumference, so both rings keep the same spacing.
    expect(inner.length / outer.length).toBeCloseTo(two.inner! / two.outer, 0);
  });

  it('a slide too big for tiles shows one dot per integration and no product', () => {
    const slide: WheelSlide = {
      key: 'all',
      name: null,
      products: wheelModel(rows(90), [], []).slides[0]!.products,
      integrations: 212,
    };
    const layout = wheelLayout(slide, 476, null);
    expect(layout.mode).toBe('dots');
    expect(layout.points).toEqual([]);
    expect(layout.dotRings.reduce((n, r) => n + r.dots, 0)).toBe(212);
    // Outer ring first.
    const radii = layout.dotRings.map((r) => r.r);
    expect([...radii].sort((a, b) => b - a)).toEqual(radii);
  });

  it('dots follow the integration count, not the product count', () => {
    // Two rows to each of 90 products: 180 dots for 90 products.
    const twice = [...rows(90), ...rows(90).map((r) => ({ ...r, id: `${r.id}-b`, name: 'Again' }))];
    const model = wheelModel(twice, [], []);
    expect(model.slides[0]!.products).toHaveLength(90);
    const layout = layoutSlide(model, 0, 476);
    expect(layout.mode).toBe('dots');
    expect(layout.dotRings.reduce((n, r) => n + r.dots, 0)).toBe(180);
  });

  it('names show under the tiles on slides of 8 or fewer, and never under a 260px stage', () => {
    expect(layoutSlide(wheelModel(rows(8), [], []), 0, 476).names).toBe(true);
    expect(layoutSlide(wheelModel(rows(9), [], []), 0, 476).names).toBe(false);
    expect(layoutSlide(wheelModel(rows(8), [], []), 0, 224).names).toBe(false);
  });
});

describe('the two-ring order (ranking page 1.2 wording)', () => {
  it('A to Z starts at 12 o’clock on the inner ring, runs clockwise, then continues from 12 o’clock on the outer ring', () => {
    const model = wheelModel(rows(40), [], []);
    const layout = layoutSlide(model, 0, 476);
    expect(layout.mode).toBe('two');
    const radius = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);
    const onInner = layout.points.map((p) => Math.abs(radius(p) - layout.inner!) < 0.1);
    const k = onInner.lastIndexOf(true) + 1;
    // The inner ring holds products 0..k-1 and the outer ring k..n-1: contiguous A to Z,
    // none skipped or repeated.
    expect(onInner.slice(0, k).every(Boolean)).toBe(true);
    expect(onInner.slice(k).some(Boolean)).toBe(false);
    expect(layout.points).toHaveLength(model.slides[0]!.products.length);
    // Both rings start at 12 o'clock.
    expect(layout.points[0]).toEqual({ x: 0, y: -layout.inner! });
    expect(layout.points[k]).toEqual({ x: 0, y: -layout.outer });
    // Clockwise: the angle from 12 o'clock rises along each ring.
    const angle = (p: { x: number; y: number }) =>
      (Math.atan2(p.x, -p.y) + 2 * Math.PI) % (2 * Math.PI);
    for (const ring of [layout.points.slice(0, k), layout.points.slice(k)]) {
      const angles = ring.map(angle);
      expect(angles).toEqual([...angles].sort((a, b) => a - b));
    }
  });
});

describe("a connector's own page", () => {
  it('a pure connector, with only the pairs it powers, has no wheel', () => {
    // The page holds those pairs in integrations_as_connector. The wheel reads only the
    // two endpoint arrays, which are empty for a pure connector.
    expect(wheelModel([], [], []).slides).toEqual([]);
  });

  it('a hybrid shows its own integrations, direct and via a connector, and counts only those', () => {
    const direct = [row('alpha', ['AI']), row('beta', ['AI'])];
    const via = {
      ...row('gamma', ['BIM']),
      via: link('kroo', 'kroo'),
      mechanism_kind: null,
    } as ProductIntegrationItem;
    const model = wheelModel([...direct, via], [], []);
    const all = model.slides[0]!;
    expect(all.products.map((p) => p.slug)).toEqual(['alpha', 'beta', 'gamma']);
    // The title's "3 products" and a dots centre's "3 integrations" count what it shows.
    expect(all.integrations).toBe(3);
    expect(model.categoryCount).toBe(2);
  });
});

describe('the dots always equal the integrations', () => {
  const slideOf = (integrations: number): WheelSlide => ({
    key: 'all',
    name: null,
    products: [],
    integrations,
  });
  it.each([
    [224, 400],
    [224, 1_400],
    [224, 5_000],
    [476, 2_000],
    [476, 12_000],
  ])('at a %ipx stage, %i integrations draw that many dots', (d, m) => {
    const layout = wheelLayout(slideOf(m), d, null);
    expect(layout.dotRings.reduce((n, r) => n + r.dots, 0)).toBe(m);
  });

  it('the only cap is the whole disc at the tightest pitch, far above the catalog', () => {
    expect(dotsMax(224)).toBeGreaterThan(8_000);
    const layout = wheelLayout(slideOf(dotsMax(224)), 224, null);
    expect(layout.dotRings.reduce((n, r) => n + r.dots, 0)).toBe(dotsMax(224));
  });
});

describe('the bands', () => {
  it('a stage takes the band at or below its width, so the server and the browser agree', () => {
    expect(wheelBandFor(200)).toBe(224);
    expect(wheelBandFor(259)).toBe(224);
    expect(wheelBandFor(264)).toBe(260);
    expect(wheelBandFor(279)).toBe(279);
    expect(wheelBandFor(294)).toBe(294);
    expect(wheelBandFor(319)).toBe(294);
    expect(wheelBandFor(320)).toBe(320);
    expect(wheelBandFor(334)).toBe(320);
    expect(wheelBandFor(336)).toBe(336);
    expect(wheelBandFor(476)).toBe(476);
  });

  it('every rule boundary is a band edge: names at 260, the phone rule at 336', () => {
    expect(WHEEL_BANDS).toContain(260);
    expect(WHEEL_BANDS).toContain(336);
    expect(isPhoneStage(335)).toBe(true);
    expect(isPhoneStage(336)).toBe(false);
  });

  it('a phone never takes two rings (Chris: "Phones: keep the circle, no second ring")', () => {
    for (const d of WHEEL_BANDS.filter(isPhoneStage)) {
      for (let n = 1; n <= 120; n++) expect(wheelMode(n, d), `${n} at ${d}`).not.toBe('two');
    }
    // The 320 band is reached only by a stacked hero on 416 to 431px phones.
    expect(isPhoneStage(320)).toBe(true);
  });
});

describe('ring count and tiles or dots depend only on the slide and the width', () => {
  const BANDS_AND_WIDTHS = [...WHEEL_BANDS, 640];
  it.each(BANDS_AND_WIDTHS)('at a %ipx stage, whatever the product\u2019s other slides', (d) => {
    for (let n = 1; n <= 120; n++) {
      const results = new Set<string>();
      for (let largest = n; largest <= 400; largest++) {
        // A product whose slides are n and `largest`.
        const tile = wheelTileSize([n, largest], d);
        const slide: WheelSlide = {
          key: 'x',
          name: 'x',
          products: Array.from({ length: n }, (_, i) => ({
            id: `p${i}`,
            slug: `p${i}`,
            name: `p${i}`,
            vendorName: null,
            logoUrl: null,
            claimStatus: null,
            categorySlugs: [],
            integrations: 1,
          })),
          integrations: n,
        };
        const layout = wheelLayout(slide, d, tile);
        results.add(layout.mode);
        // And the tiles fit the ring count at the product's tile size.
        if (layout.mode !== 'dots') {
          const c = wheelCapacity(d, tile!);
          expect(n, `${n} of ${largest} at ${d}px`).toBeLessThanOrEqual(
            layout.mode === 'one' ? c.one : c.two,
          );
        }
      }
      expect([...results], `${n} products at ${d}px`).toEqual([wheelMode(n, d)]);
    }
  });

  it('the one-ring limit per band', () => {
    expect(WHEEL_BANDS.filter((d) => !isPhoneStage(d)).map((d) => [d, oneRingMax(d)])).toEqual([
      [336, 18],
      [400, 20],
      [476, 20],
    ]);
  });
});

describe('which integrations the wheel shows (ranking page 1.2)', () => {
  it('rows where this product is the source or the target, and the other product is the tile', () => {
    const asTarget = { ...row('delta', []), source: link('delta', 'delta'), target: page };
    const model = wheelModel([row('alpha', [])], [asTarget], []);
    expect(model.slides[0]!.products.map((p) => p.slug)).toEqual(['alpha', 'delta']);
  });

  it('through a connector the tile is the other product; the connector is a tile only with its own direct row', () => {
    const viaKroo = {
      ...row('gamma', []),
      via: link('kroo', 'kroo'),
      mechanism_kind: null,
    } as ProductIntegrationItem;
    expect(wheelModel([viaKroo], [], []).slides[0]!.products.map((p) => p.slug)).toEqual(['gamma']);
    // A direct integration with the connector itself makes it a partner like any other.
    const withKroo = wheelModel([viaKroo, row('kroo', [])], [], []);
    expect(withKroo.slides[0]!.products.map((p) => p.slug)).toEqual(['gamma', 'kroo']);
    expect(withKroo.slides[0]!.integrations).toBe(2);
  });
});

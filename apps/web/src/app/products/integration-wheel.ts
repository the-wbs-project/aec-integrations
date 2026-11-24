import type { ClaimStatus, ProductIntegrationItem, WheelMark } from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { splitIntegrationLanes } from './connector-lane-grouping';

/**
 * AECI-2018 - the integrations wheel in the product page hero. The model and the
 * geometry, as pure functions, so the component, the firewall spec and the component
 * spec all read one rule. Mock-up 9w (`docs/design/mockups/redesign-2026-11/mockups/
 * 9-product-hero-wheel.html`, `src/9w.js`) is the reference; `DESIGN.md` §5 "The hero
 * diagram" has the built values.
 *
 * Who is on it. Every product the page product has an integration with on record: the
 * partner of each row the Integrations section lists (`splitIntegrationLanes`, direct and
 * via rows alike). Connector-powered rows (`integrations_as_connector`) are not read: the
 * page product is not an endpoint there.
 *
 * Order (ruling R1, a new list). Products A to Z by name through `compareText`, which
 * ignores capitals, then id. Category slides A to Z by category name, then slug, after
 * "All integrations". A product with two categories is on both slides. A category with no
 * product for this page is not offered, because a slide exists only for a category some
 * row carries.
 *
 * Nothing here reads an input a paid plan can change. Inclusion reads the rows, order
 * reads the partner's name and id, the category slides read `partner_categories` (the Free
 * plan edits categories), and size reads only how many products a slide has and the
 * stage width. A mark's logo and claim state reach the tile's image and the card's label,
 * and nothing else. `on-page-ordering-firewall.spec.ts` `[surface:product-page-hero-wheel]`
 * holds that.
 */

/** One product on the wheel. */
export interface WheelProduct {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** "by {vendor}" in the card. `null` when the row names no vendor. */
  readonly vendorName: string | null;
  /** Ruling 64: the stored logo, claimed or not, from `wheel_marks`. */
  readonly logoUrl: string | null;
  /** The card's "Unclaimed" label reads it. `null` when the payload has no mark. */
  readonly claimStatus: ClaimStatus | null;
  /** The partner's category slugs, as its rows carry them. */
  readonly categorySlugs: readonly string[];
  /** Rows the Integrations section lists for this product: one dot each. */
  readonly integrations: number;
}

/** One slide: "All integrations" first, then one per category. */
export interface WheelSlide {
  /** `'all'`, or the category slug. */
  readonly key: string;
  /** The category name. `null` on "All integrations", whose name is a message. */
  readonly name: string | null;
  /** A to Z by name, then id. */
  readonly products: readonly WheelProduct[];
  /** Rows whose partner is on the slide. The centre of a dots slide counts these. */
  readonly integrations: number;
}

export interface WheelModel {
  readonly slides: readonly WheelSlide[];
  /** Category slides, for "in {n} categories". */
  readonly categoryCount: number;
}

const byNameThenId = (a: WheelProduct, b: WheelProduct) =>
  compareText(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The wheel's slides for one product page. Empty when it has no endpoint rows. */
export function wheelModel(
  asSource: readonly ProductIntegrationItem[],
  asTarget: readonly ProductIntegrationItem[],
  marks: readonly WheelMark[] | undefined,
): WheelModel {
  const view = splitIntegrationLanes(asSource, asTarget);
  const rows = [...view.direct, ...view.via.flatMap((g) => g.rows)];
  const markById = new Map((marks ?? []).map((m) => [m.product_id, m]));
  const products = new Map<
    string,
    {
      id: string;
      slug: string;
      name: string;
      vendorName: string | null;
      categories: Map<string, string>;
      integrations: number;
    }
  >();
  for (const row of rows) {
    const other = row.other;
    let entry = products.get(other.id);
    if (!entry) {
      entry = {
        id: other.id,
        slug: other.slug,
        name: other.name,
        vendorName: row.integration.partner_vendor_name ?? null,
        categories: new Map(),
        integrations: 0,
      };
      products.set(other.id, entry);
    }
    entry.integrations += 1;
    for (const term of row.integration.partner_categories) {
      entry.categories.set(term.slug, term.name);
    }
  }
  const all: WheelProduct[] = [...products.values()]
    .map((p) => {
      const mark = markById.get(p.id);
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        vendorName: p.vendorName,
        logoUrl: mark?.logo_url ?? null,
        claimStatus: mark?.claim_status ?? null,
        categorySlugs: [...p.categories.keys()],
        integrations: p.integrations,
      };
    })
    .sort(byNameThenId);
  if (all.length === 0) return { slides: [], categoryCount: 0 };

  const names = new Map<string, string>();
  for (const p of products.values()) for (const [slug, name] of p.categories) names.set(slug, name);
  const categories = [...names.entries()].sort(
    ([sa, na], [sb, nb]) => compareText(na, nb) || (sa < sb ? -1 : sa > sb ? 1 : 0),
  );
  const count = (list: readonly WheelProduct[]) => list.reduce((sum, p) => sum + p.integrations, 0);
  const slides: WheelSlide[] = [
    { key: 'all', name: null, products: all, integrations: count(all) },
    ...categories.map(([slug, name]) => {
      // `all` is already A to Z, so a filter keeps the order.
      const members = all.filter((p) => p.categorySlugs.includes(slug));
      return { key: slug, name, products: members, integrations: count(members) };
    }),
  ];
  return { slides, categoryCount: categories.length };
}

// ─── Geometry ─────────────────────────────────────────────────────────────────

/** Between tiles on a ring, px. */
const GAP = 8;
/** Kept at the stage edge for the 3px focus ring, px. */
const EDGE = 6;
/** Between the two rings, px. */
const RING_GAP = 12;
/** The largest tile on one ring beside the text, on two rings, and on a phone. */
const TILE_MAX_ONE = 48;
const TILE_MAX_TWO = 40;
const TILE_MAX_PHONE = 40;
/** The smallest tile beside the text, and on a phone. */
export const TILE_MIN_DESKTOP = 28;
export const TILE_MIN_PHONE = 24;
/** Desktop: no slide puts more than this on one ring (`oneRingMax`). */
export const ONE_RING_MAX = 20;
/**
 * A stage narrower than this is a phone: one ring, never two (Chris: "Phones: keep the
 * circle, no second ring"). 336 is the narrowest side-by-side stage (the 400px panel at
 * 1024), so every narrower stage is a stacked hero on a phone.
 */
const PHONE_BELOW = 336;
/** Names under the tiles on slides of this many products or fewer. */
export const NAMES_MAX = 8;
/** No names under the tiles on a stage narrower than this: they run into the hub. */
const NAMES_FROM = 260;

export type WheelMode = 'one' | 'two' | 'dots';

/** A placed tile, its centre in percent of the stage from the centre. */
export interface WheelPoint {
  readonly x: number;
  readonly y: number;
}

/** One dot ring: its radius in percent of the stage, and how many dots. */
export interface WheelDotRing {
  readonly r: number;
  readonly dots: number;
}

/** One slide laid out at one stage diameter. */
export interface WheelLayout {
  readonly d: number;
  readonly mode: WheelMode;
  /** Tile size in percent of the stage (0 on a dots slide). */
  readonly tile: number;
  /** Tile size in px at `d`. */
  readonly tilePx: number;
  /** In product order. Empty on a dots slide. */
  readonly points: readonly WheelPoint[];
  /** Orbit radii in percent: the outer always, the inner on a desktop stage. */
  readonly outer: number;
  readonly inner: number | null;
  /** The dot rings, outer first. Empty on a tile slide. */
  readonly dotRings: readonly WheelDotRing[];
  /** Dot diameter in percent. */
  readonly dot: number;
  /** Whether names show under the tiles. */
  readonly names: boolean;
  /** The frame circle's radius in percent. */
  readonly frame: number;
}

export const isPhoneStage = (d: number) => d < PHONE_BELOW;

function radii(d: number, t: number) {
  const outer = d / 2 - EDGE - t / 2;
  return { outer, inner: outer - t - RING_GAP };
}
const ringCapacity = (r: number, t: number) =>
  Math.max(0, Math.floor((2 * Math.PI * r) / (t + GAP)));

/** How many products one ring, and two, hold at tile size `t`. Two is 0 on a phone. */
export function wheelCapacity(d: number, t: number): { one: number; two: number } {
  const r = radii(d, t);
  const one = ringCapacity(r.outer, t);
  return { one, two: isPhoneStage(d) ? 0 : ringCapacity(r.inner, t) + one };
}

/**
 * The most products a slide may put on one ring at stage `d`, beside the text: 20, or
 * fewer where one ring of 40px tiles (the two-ring maximum) holds fewer. 18 at a 336px
 * stage (1024), 20 at 476px. A phone has no second ring, so this is not used there.
 */
export function oneRingMax(d: number): number {
  return Math.min(ONE_RING_MAX, wheelCapacity(d, TILE_MAX_TWO).one);
}

/**
 * A slide's mode: a pure function of its product count and the stage width, so nothing
 * else about the product (its other slides, its tile size) can change it.
 *
 * Beside the text: one ring up to `oneRingMax(d)`, two rings while they fit at the
 * smallest tile (28px), then dots. On a phone: one ring while it fits at 24px, then dots.
 *
 * Every tile size `wheelTileSize` can pick fits the mode this gives, because capacity
 * only falls as the tile grows:
 *  - if the product's largest tiled slide is one-ring, its tile is the largest up to 48px
 *    that fits it on one ring. That slide is at most `oneRingMax(d)`, which fits at 40px,
 *    so the tile is 40px or more and every slide (all smaller) fits too.
 *  - otherwise the tile is the largest up to 40px that fits that slide on two rings. A
 *    one-ring slide is at most `oneRingMax(d)`, which fits one ring at 40px, so it fits
 *    at any tile of 40px or less. A two-ring slide is at most the largest, which fits.
 *  - on a phone the tile is the largest up to 40px that fits the largest slide on one
 *    ring, and every smaller slide fits too.
 */
export function wheelMode(n: number, d: number): WheelMode {
  if (isPhoneStage(d)) return n <= wheelCapacity(d, TILE_MIN_PHONE).one ? 'one' : 'dots';
  if (n <= oneRingMax(d)) return 'one';
  return n <= wheelCapacity(d, TILE_MIN_DESKTOP).two ? 'two' : 'dots';
}

/**
 * The product's one tile size at stage `d`, or `null` when no slide can be tiled. It
 * comes from the largest slide that can be tiled: on one ring, the largest size up to
 * 48px (40px on a phone) that fits it; on two rings, the largest up to 40px. Every slide
 * keeps its own mode (`wheelMode`) at that size, so stepping never resizes the tiles.
 */
export function wheelTileSize(counts: readonly number[], d: number): number | null {
  const min = isPhoneStage(d) ? TILE_MIN_PHONE : TILE_MIN_DESKTOP;
  let ref = 0;
  for (const n of counts) if (n > ref && wheelMode(n, d) !== 'dots') ref = n;
  if (ref === 0) return null;
  const mode = wheelMode(ref, d);
  let t = mode === 'two' ? TILE_MAX_TWO : isPhoneStage(d) ? TILE_MAX_PHONE : TILE_MAX_ONE;
  for (; t > min; t--) {
    const c = wheelCapacity(d, t);
    if (mode === 'one' ? ref <= c.one : ref <= c.two) break;
  }
  return t;
}

const round = (v: number) => Math.round(v * 100) / 100;

function ringPoints(count: number, r: number, d: number): WheelPoint[] {
  return Array.from({ length: count }, (_, j) => {
    // 12 o'clock, then clockwise.
    const a = (j / count) * 2 * Math.PI - Math.PI / 2;
    return { x: round((Math.cos(a) * r * 100) / d), y: round((Math.sin(a) * r * 100) / d) };
  });
}

/**
 * One dot per integration, on rings from the outer edge inward, spread over the rings by
 * circumference. The dots identify no product. The rings first keep clear of the centre's
 * count; a slide with more integrations than that room holds tightens the pitch, then
 * lets the rings reach in toward the centre. The count always equals `m` up to
 * `DOTS_MAX`: on a 224px stage, about 1,400 integrations fit before the rings reach the
 * centre's text.
 */
function dotRings(m: number, d: number): { rings: WheelDotRing[]; dot: number } {
  const desk = d >= 400;
  let size = desk ? 6 : 5;
  let pitch = desk ? 10 : 8;
  const clear = (d / 2 - EDGE) * 0.6;
  for (;;) {
    // Keep clear of the centre while the pitch is 4px or more, then use the whole disc.
    const floor = pitch >= 4 ? clear : pitch;
    const top = d / 2 - EDGE - size / 2;
    const caps: { r: number; cap: number }[] = [];
    let total = 0;
    for (let r = top; total < m && r >= floor; r -= pitch) {
      const cap = Math.floor((2 * Math.PI * r) / pitch);
      caps.push({ r, cap });
      total += cap;
    }
    if (total >= m || pitch <= DOT_PITCH_MIN) {
      const sumR = caps.reduce((sum, c) => sum + c.r, 0);
      let left = m;
      const counts = caps.map((c) => {
        const n = Math.min(c.cap, Math.round((m * c.r) / sumR), left);
        left -= n;
        return n;
      });
      // Rounding can leave a few: give them to the rings with room, outer first.
      for (let i = 0; left > 0 && i < caps.length; i++) {
        const add = Math.min(left, caps[i]!.cap - counts[i]!);
        counts[i]! += add;
        left -= add;
      }
      return {
        rings: caps
          .map((c, i) => ({ r: round((c.r * 100) / d), dots: counts[i]! }))
          .filter((ring) => ring.dots !== 0),
        dot: round((size * 100) / d),
      };
    }
    pitch -= 1;
    size = Math.max(1.5, Math.min(size, pitch * 0.6));
  }
}

/** The tightest dot pitch, px. */
const DOT_PITCH_MIN = 2;

/**
 * The most dots a stage of diameter `d` can draw, one per integration: the capacity of
 * the whole disc at the tightest pitch. About 8,800 on a 224px stage, far above any
 * product in the catalog (387 today). Past it the wheel would undercount, so the spec
 * pins it.
 */
export function dotsMax(d: number): number {
  let total = 0;
  for (let r = d / 2 - EDGE - 0.75; r >= DOT_PITCH_MIN; r -= DOT_PITCH_MIN) {
    total += Math.floor((2 * Math.PI * r) / DOT_PITCH_MIN);
  }
  return total;
}

/** One slide laid out at stage diameter `d`, with the product's tile size `tile`. */
export function wheelLayout(slide: WheelSlide, d: number, tile: number | null): WheelLayout {
  const n = slide.products.length;
  const frame = round(50 - (EDGE * 50) / d);
  const mode: WheelMode = tile === null ? 'dots' : wheelMode(n, d);
  const t = tile ?? TILE_MIN_DESKTOP;
  const r = radii(d, t);
  const base = {
    d,
    mode,
    outer: round((r.outer * 100) / d),
    inner: isPhoneStage(d) ? null : round((r.inner * 100) / d),
    frame,
  };
  if (mode === 'dots') {
    const dots = dotRings(slide.integrations, d);
    return {
      ...base,
      tile: 0,
      tilePx: 0,
      points: [],
      dotRings: dots.rings,
      dot: dots.dot,
      names: false,
    };
  }
  let points: WheelPoint[];
  if (mode === 'one') {
    points = ringPoints(n, r.outer, d);
  } else {
    // A to Z fills the inner ring, then continues on the outer one, split by
    // circumference so both rings keep the same spacing.
    const capInner = ringCapacity(r.inner, t);
    const capOuter = ringCapacity(r.outer, t);
    const k = Math.max(
      n - capOuter,
      Math.min(capInner, Math.round((n * r.inner) / (r.inner + r.outer))),
    );
    points = [...ringPoints(k, r.inner, d), ...ringPoints(n - k, r.outer, d)];
  }
  return {
    ...base,
    tile: round((t * 100) / d),
    tilePx: t,
    points,
    dotRings: [],
    dot: 0,
    names: n <= NAMES_MAX && d >= NAMES_FROM,
  };
}

/** Lay out a slide of `model` at stage `d`: the product's tile size, then the slide. */
export function layoutSlide(model: WheelModel, index: number, d: number): WheelLayout {
  const tile = wheelTileSize(
    model.slides.map((s) => s.products.length),
    d,
  );
  return wheelLayout(model.slides[index]!, d, tile);
}

/**
 * The stage widths the wheel lays a slide out at, and the one place the width is
 * quantised. A stage takes the band at or below its width (the first below 260), and
 * percentages scale the layout up to the stage, so a tile is never smaller than the size
 * it was laid out at: a phone with no script never gets a tile under 24px.
 *
 * The server cannot know the width, so it writes every band and CSS picks one by
 * container query (`styles.css`, `.aec-wheel`). Hydration lays nothing out again: the
 * browser uses the same bands, so names, ring count and tiles or dots never change at
 * hydration. Each boundary is a rule: 260 (names under tiles), 336 (a phone below it, one
 * ring only). The rest are the stages the mock-up measured: 224, 279 and 294 at 320, 375
 * and 390, 336 at 1024, 476 from 1280 and every width from 768. 400 splits the wide
 * tablet range and is where the dots grow to 6px.
 */
export const WHEEL_BANDS = [224, 260, 279, 294, 320, 336, 400, 476] as const;

/** The band a stage of `width` px uses: the largest at or below it, the first below that. */
export function wheelBandFor(width: number): number {
  let band: number = WHEEL_BANDS[0];
  for (const d of WHEEL_BANDS) if (width >= d) band = d;
  return band;
}

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
/** Desktop: a slide with more products than this takes two rings. */
export const ONE_RING_MAX = 20;
/** A stage narrower than this is a phone: one ring, never two. */
const PHONE_BELOW = 320;
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

/** A slide's mode at tile size `t`. */
export function wheelModeAt(n: number, d: number, t: number): WheelMode {
  const c = wheelCapacity(d, t);
  if (isPhoneStage(d)) return n <= c.one ? 'one' : 'dots';
  if (n <= ONE_RING_MAX && n <= c.one) return 'one';
  return n <= c.two ? 'two' : 'dots';
}

/**
 * The product's one tile size at stage `d`, or `null` when no slide can be tiled. It
 * comes from the largest slide that fits at the smallest tile: on one ring, the largest
 * size up to 48px (40px on a phone) that still fits; on two rings, up to 40px. Every slide
 * then takes its own ring count at that size, so stepping never resizes the tiles.
 */
export function wheelTileSize(counts: readonly number[], d: number): number | null {
  const min = isPhoneStage(d) ? TILE_MIN_PHONE : TILE_MIN_DESKTOP;
  let ref = 0;
  for (const n of counts) if (n > ref && wheelModeAt(n, d, min) !== 'dots') ref = n;
  if (ref === 0) return null;
  const mode = wheelModeAt(ref, d, min);
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
 * circumference. The dots identify no product. If the rings would reach the hub's text,
 * the pitch tightens rather than covering it.
 */
function dotRings(m: number, d: number): { rings: WheelDotRing[]; dot: number } {
  const desk = d >= 400;
  let size = desk ? 6 : 5;
  let pitch = desk ? 10 : 8;
  const floor = (d / 2 - EDGE) * 0.6;
  for (;;) {
    const top = d / 2 - EDGE - size / 2;
    const caps: { r: number; cap: number }[] = [];
    let total = 0;
    for (let r = top; total < m && r >= floor; r -= pitch) {
      const cap = Math.floor((2 * Math.PI * r) / pitch);
      caps.push({ r, cap });
      total += cap;
    }
    if (total >= m || pitch <= 4) {
      const sumR = caps.reduce((s, c) => s + c.r, 0);
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
    size = Math.max(3, size - 0.5);
  }
}

/** One slide laid out at stage diameter `d`, with the product's tile size `tile`. */
export function wheelLayout(slide: WheelSlide, d: number, tile: number | null): WheelLayout {
  const n = slide.products.length;
  const frame = round(50 - (EDGE * 50) / d);
  const mode: WheelMode = tile === null ? 'dots' : wheelModeAt(n, d, tile);
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
 * The server's layouts. The server cannot know the stage width, so it lays the first
 * slide out at each of these diameters and CSS picks one by container query
 * (`styles.css`, `.aec-wheel`). Each applies from its own width up to the next, and
 * percentages scale it, so a tile is never smaller than the size it was laid out at:
 * a phone with no script never gets a tile under 24px. 224, 279 and 294 are the stage at
 * 320, 375 and 390; 336 is 1024; 476 is 1280 and up, and every width from 768. After
 * hydration the component lays the slide out at the measured width instead, which is the
 * same layout at those widths.
 */
export const WHEEL_BANDS = [224, 279, 294, 336, 476] as const;

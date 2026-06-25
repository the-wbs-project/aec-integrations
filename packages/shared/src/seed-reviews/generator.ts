/**
 * Pure review-plan generator — shared by the seed-reviews CLI
 * (`apps/api/scripts/seed-reviews.ts`) and the datatool Worker (`apps/datatool`).
 *
 * Deterministic and runtime-agnostic: a given `seed` + product set yields a
 * byte-identical plan in Node or in a Worker (no `node:*` or Worker-only APIs
 * here). The CLI renders the plan to a `.sql` file; the Worker renders it to
 * bound D1 statements. Both use the helpers in `./sql.ts`, so the generated
 * review ids/content are identical across the two callers — that equivalence is
 * the regression test.
 */

import {
  DISTRIBUTION,
  MAX_AGE_DAYS,
  REVIEW_FRAGMENTS,
  ROLES,
  SENTIMENT_MIX,
  VERIFIED_WORK_EMAIL_RATE,
  type ReviewFragment,
  type Sentiment,
} from './data';

/** Recognizable marker that opens every seeded review id — used to delete/teardown
 * the seeded block. Matching on the marker (not the full prefix) catches rows from
 * any past seed run, so a format change still cleans up the old ids. */
export const ID_MARKER = 'aeceed00-';
/** Full id prefix for GENERATION: marker + a valid RFC-4122 version/variant
 * (`-4000-8000-`, i.e. version 4 + variant 8, matching the repo's deterministic-UUID
 * convention in seed/*.sql). The `-4xxx-[89ab]xxx-` shape is REQUIRED — the API's
 * review contract validates `id` with a strict `z.uuid()`, which rejects a 0 version
 * or variant nibble (the original `…-0000-0000-…` ids 400'd every detail page). */
export const ID_PREFIX = `${ID_MARKER}0000-4000-8000-`;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ─── Seeded PRNG (mulberry32) + helpers ──────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(private readonly next: () => number) {}
  /** float [0,1) */
  float(): number {
    return this.next();
  }
  /** integer in [min, max] inclusive */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  /** Weighted pick over {item, weight}. Weights need not be normalized. */
  weighted<T>(entries: ReadonlyArray<{ item: T; weight: number }>): T {
    const total = entries.reduce((s, e) => s + e.weight, 0);
    let r = this.next() * total;
    for (const e of entries) {
      r -= e.weight;
      if (r < 0) return e.item;
    }
    return entries[entries.length - 1].item;
  }
}

// ─── Plan model ──────────────────────────────────────────────────────────────────

export interface ProductInput {
  id: string;
  slug: string;
  name: string;
  categorySlugs: string[];
}

export interface PlannedReview {
  id: string;
  productId: string;
  reviewerId: null;
  ratingOverall: number;
  ratingOnboarding: number;
  title: string;
  body: string;
  roleAtCompany: string | null;
  yearsUsing: number | null;
  wouldRecommend: string | null;
  status: 'approved';
  moderatedAt: Date;
  verifiedWorkEmail: boolean;
  locale: 'en-US';
  createdAt: Date;
}

export interface Plan {
  reviews: PlannedReview[];
  /** product id → planned review count (includes 0-count products). */
  perProduct: Map<string, number>;
}

const YEARS_POOL = [0, 1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 8, 10, 12, 15] as const;

/** Derive a 1–5 overall/onboarding pair consistent with a sentiment tier.
 * Onboarding is drawn at or below overall — the "great product, rough setup"
 * story that motivates the dual rating. */
function ratingsFor(sentiment: Sentiment, rng: Rng): { overall: number; onboarding: number } {
  if (sentiment === 'positive') {
    const overall = rng.chance(0.6) ? 5 : 4;
    const onboarding = clamp(overall - rng.pick([0, 1, 1, 2]), 3, 5);
    return { overall, onboarding };
  }
  if (sentiment === 'mixed') {
    const overall = rng.chance(0.7) ? 3 : 4;
    const onboarding = clamp(overall - rng.pick([0, 1, 1, 2]), 2, overall);
    return { overall, onboarding };
  }
  // critical
  const overall = rng.chance(0.6) ? 2 : 1;
  const onboarding = clamp(overall + rng.pick([-1, 0, 0, 1]), 1, 3);
  return { overall, onboarding };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function recommendFor(sentiment: Sentiment, rng: Rng): string | null {
  if (rng.chance(0.12)) return null;
  if (sentiment === 'positive')
    return rng.weighted([
      { item: 'yes', weight: 0.85 },
      { item: 'maybe', weight: 0.15 },
    ]);
  if (sentiment === 'mixed')
    return rng.weighted([
      { item: 'maybe', weight: 0.6 },
      { item: 'yes', weight: 0.25 },
      { item: 'no', weight: 0.15 },
    ]);
  return rng.weighted([
    { item: 'no', weight: 0.65 },
    { item: 'maybe', weight: 0.35 },
  ]);
}

function tagMatchesProduct(fragment: ReviewFragment, product: ProductInput): boolean {
  if (!fragment.tags?.length) return false;
  return fragment.tags.some((tag) => product.categorySlugs.some((slug) => slug.includes(tag)));
}

/** Pick a fragment for `product`, preferring the desired sentiment + a category
 * match, falling back gracefully. Returns the fragment AND its effective
 * sentiment (ratings are derived from this so text never contradicts the stars). */
function pickFragment(
  product: ProductInput,
  desired: Sentiment,
  usedTitles: Set<string>,
  rng: Rng,
): { fragment: ReviewFragment; sentiment: Sentiment } {
  const unusedSameSentiment = REVIEW_FRAGMENTS.filter(
    (f) => f.sentiment === desired && !usedTitles.has(f.title),
  );
  const catMatched = unusedSameSentiment.filter((f) => tagMatchesProduct(f, product));
  if (catMatched.length) return { fragment: rng.pick(catMatched), sentiment: desired };
  if (unusedSameSentiment.length)
    return { fragment: rng.pick(unusedSameSentiment), sentiment: desired };

  // Desired-sentiment pool exhausted for this product → any unused fragment,
  // adopting its sentiment so ratings stay consistent.
  const anyUnused = REVIEW_FRAGMENTS.filter((f) => !usedTitles.has(f.title));
  if (anyUnused.length) {
    const f = rng.pick(anyUnused);
    return { fragment: f, sentiment: f.sentiment };
  }
  // Everything used (product wants more reviews than the whole bank) → reuse.
  const f = rng.pick(REVIEW_FRAGMENTS.filter((x) => x.sentiment === desired));
  return { fragment: f ?? rng.pick(REVIEW_FRAGMENTS), sentiment: desired };
}

function render(text: string, product: ProductInput): string {
  return text.replaceAll('{product}', product.name);
}

function toUuid(counter: number): string {
  return ID_PREFIX + counter.toString(16).padStart(12, '0');
}

export function buildPlan(products: ProductInput[], rng: Rng, now: number): Plan {
  const sorted = [...products].sort((a, b) => a.slug.localeCompare(b.slug));
  const buckets = DISTRIBUTION.map((b) => ({ item: b, weight: b.weight }));
  const sentimentEntries: ReadonlyArray<{ item: Sentiment; weight: number }> = [
    { item: 'positive', weight: SENTIMENT_MIX.positive },
    { item: 'mixed', weight: SENTIMENT_MIX.mixed },
    { item: 'critical', weight: SENTIMENT_MIX.critical },
  ];

  const reviews: PlannedReview[] = [];
  const perProduct = new Map<string, number>();
  let counter = 1;

  for (const product of sorted) {
    const bucket = rng.weighted(buckets);
    const count = rng.int(bucket.min, bucket.max);
    perProduct.set(product.id, count);

    const usedTitles = new Set<string>();
    for (let i = 0; i < count; i++) {
      const desired = rng.weighted(sentimentEntries);
      const { fragment, sentiment } = pickFragment(product, desired, usedTitles, rng);
      usedTitles.add(fragment.title);

      const { overall, onboarding } = ratingsFor(sentiment, rng);
      const ageDays = rng.int(1, MAX_AGE_DAYS);
      const createdAt = new Date(now - ageDays * DAY_MS - rng.int(0, 23) * HOUR_MS);
      const moderatedAt = new Date(Math.min(now, createdAt.getTime() + rng.int(1, 72) * HOUR_MS));

      reviews.push({
        id: toUuid(counter++),
        productId: product.id,
        reviewerId: null,
        ratingOverall: overall,
        ratingOnboarding: onboarding,
        title: render(fragment.title, product),
        body: render(fragment.body, product),
        roleAtCompany: rng.chance(0.15) ? null : rng.pick(ROLES),
        yearsUsing: rng.chance(0.15) ? null : rng.pick(YEARS_POOL),
        wouldRecommend: recommendFor(sentiment, rng),
        status: 'approved',
        moderatedAt,
        verifiedWorkEmail: rng.chance(VERIFIED_WORK_EMAIL_RATE),
        locale: 'en-US',
        createdAt,
      });
    }
  }

  return { reviews, perProduct };
}

/**
 * Pure ranking strategies for the `/preview/search-relevance` harness (AECI-286).
 *
 * This module models the candidate `customRanking` levers from
 * `docs/SEARCH_RANKING.md` §7 so they can be compared visually BEFORE there is
 * real query data (that real-data run is AECI-283, blocked on go-live). It is
 * deliberately framework-free and side-effect-free — no Angular, no Algolia
 * client — so it unit-tests under plain Vitest and the preview component stays a
 * thin view over it.
 *
 * Fidelity caveat (surfaced in the UI too): this is a *client-side model* of
 * Algolia's ranking, not Algolia itself.
 *  - `textScore()` is a deterministic token-overlap proxy for Algolia's textual
 *    ranking (typo…exact), weighted by field in the SAME priority order as the
 *    real `searchableAttributes` (`name` > `vendor_name` > taxonomy >
 *    `description`; see §3.1).
 *  - The *lexicographic* strategies (`baseline`, `ratings`) mirror Algolia's real
 *    model where `customRanking` only breaks ties AFTER textual relevance.
 *  - The *weighted* strategies (`coverage`, `blend`) are a "best-match" composite
 *    where signals CAN override text — itself one of the real tuning decisions.
 *  - The final tie-break is `name` ascending (deterministic), standing in for
 *    Algolia's arbitrary internal index order (§5) so the prototype is reproducible.
 */
import type { AlgoliaProductRecord } from '@aeci/shared/algolia-records';

export type StrategyId = 'baseline' | 'ratings' | 'coverage' | 'blend';

export type StrategyKind = 'lexicographic' | 'weighted';

export interface StrategyMeta {
  readonly id: StrategyId;
  readonly label: string;
  readonly kind: StrategyKind;
  readonly blurb: string;
}

/** The candidate strategies, in the §7 "expected order of adoption". */
export const STRATEGIES: readonly StrategyMeta[] = [
  {
    id: 'baseline',
    label: 'Baseline (today)',
    kind: 'lexicographic',
    blurb:
      'Production §3.1: text relevance, then desc(integration_count), then desc(review_count). Signals only break textual ties.',
  },
  {
    id: 'ratings',
    label: 'Ratings-forward',
    kind: 'lexicographic',
    blurb:
      '§7 lever #1: text relevance, then rating_overall_avg, then integration_count. Inert in prod until Phase 5 reviews exist.',
  },
  {
    id: 'coverage',
    label: 'Coverage-weighted',
    kind: 'weighted',
    blurb:
      '§7 lever #5: a best-match blend that weights integration coverage over text, so a heavily-integrated product can outrank a closer text match.',
  },
  {
    id: 'blend',
    label: 'Balanced blend',
    kind: 'weighted',
    blurb:
      'Tunable composite of text + coverage + ratings; drag the sliders to explore the trade-off.',
  },
];

export interface BlendWeights {
  /** Weight on the token-overlap text score. */
  readonly text: number;
  /** Weight on normalized integration_count (coverage). */
  readonly coverage: number;
  /** Weight on normalized rating_overall_avg. */
  readonly ratings: number;
}

/** Default weights for the tunable "Balanced blend" strategy. */
export const DEFAULT_BLEND_WEIGHTS: BlendWeights = { text: 0.5, coverage: 0.3, ratings: 0.2 };

/** Fixed preset for "Coverage-weighted" — coverage dominates, text still matters. */
const COVERAGE_PRESET_WEIGHTS: BlendWeights = { text: 0.35, coverage: 0.55, ratings: 0.1 };

/**
 * Per-field weights for the token-overlap text score, ordered to match the real
 * `products` `searchableAttributes` priority in `SEARCH_RANKING.md` §3.1.
 */
const FIELD_WEIGHTS = { name: 1, vendor: 0.9, taxonomy: 0.7, description: 0.4 } as const;

export interface ScoredHit {
  readonly record: AlgoliaProductRecord;
  /** Token-overlap text match, 0..1. */
  readonly textScore: number;
  /** integration_count normalized to 0..1 across the candidate set. */
  readonly coverageNorm: number;
  /** rating_overall_avg (null→0) normalized to 0..1 across the candidate set. */
  readonly ratingNorm: number;
  /** Composite score for weighted strategies; equals textScore for lexicographic ones. */
  readonly score: number;
  /** 1-based position under the active strategy. */
  readonly rank: number;
}

type Scored = Omit<ScoredHit, 'rank'>;

/** Lowercase + split on non-alphanumeric, dropping empties. */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

/**
 * Deterministic token-overlap text score (0..1). Each query token scores the
 * weight of the highest-priority field it appears in (name > vendor > taxonomy >
 * description); the result is averaged over the query's tokens. An empty query
 * scores 0 (browse mode — ranking is then driven purely by the signals).
 */
export function textScore(query: string, record: AlgoliaProductRecord): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;

  const name = record.name.toLowerCase();
  const vendor = (record.vendor_name ?? '').toLowerCase();
  const taxonomy = [...record.categories, ...record.audiences, ...record.phases]
    .join(' ')
    .toLowerCase();
  const description = (record.description ?? '').toLowerCase();

  let sum = 0;
  for (const token of tokens) {
    if (name.includes(token)) sum += FIELD_WEIGHTS.name;
    else if (vendor.includes(token)) sum += FIELD_WEIGHTS.vendor;
    else if (taxonomy.includes(token)) sum += FIELD_WEIGHTS.taxonomy;
    else if (description.includes(token)) sum += FIELD_WEIGHTS.description;
  }
  return sum / tokens.length;
}

const COMPARATORS: Record<StrategyId, (a: Scored, b: Scored) => number> = {
  baseline: (a, b) =>
    b.textScore - a.textScore ||
    b.record.integration_count - a.record.integration_count ||
    b.record.review_count - a.record.review_count ||
    a.record.name.localeCompare(b.record.name),
  ratings: (a, b) =>
    b.textScore - a.textScore ||
    (b.record.rating_overall_avg ?? 0) - (a.record.rating_overall_avg ?? 0) ||
    b.record.integration_count - a.record.integration_count ||
    a.record.name.localeCompare(b.record.name),
  coverage: (a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name),
  blend: (a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name),
};

/**
 * Rank a product set for a query under one strategy. Pure and deterministic.
 *
 * Candidate set mirrors Algolia: a non-empty query keeps only text matches; an
 * empty query keeps everything (browse). Signals are max-normalized (divide-by-max)
 * across that candidate set, then each strategy's comparator orders them.
 */
export function rankProducts(
  query: string,
  products: readonly AlgoliaProductRecord[],
  strategy: StrategyId,
  weights: BlendWeights = DEFAULT_BLEND_WEIGHTS,
): ScoredHit[] {
  const hasQuery = tokenize(query).length > 0;

  const base = products.map((record) => ({ record, textScore: textScore(query, record) }));
  const candidates = hasQuery ? base.filter((candidate) => candidate.textScore > 0) : base;

  // Divide-by-max normalization; guard the all-zero case so a missing signal
  // (e.g. no ratings pre-Phase-5) contributes 0 rather than NaN.
  const maxCoverage = Math.max(
    1,
    ...candidates.map((candidate) => candidate.record.integration_count),
  );
  const maxRating = Math.max(
    0,
    ...candidates.map((candidate) => candidate.record.rating_overall_avg ?? 0),
  );

  const activeWeights = strategy === 'coverage' ? COVERAGE_PRESET_WEIGHTS : weights;
  const lexicographic = strategy === 'baseline' || strategy === 'ratings';

  const scored: Scored[] = candidates.map((candidate) => {
    const coverageNorm = candidate.record.integration_count / maxCoverage;
    const ratingNorm = maxRating > 0 ? (candidate.record.rating_overall_avg ?? 0) / maxRating : 0;
    const composite =
      activeWeights.text * candidate.textScore +
      activeWeights.coverage * coverageNorm +
      activeWeights.ratings * ratingNorm;
    return {
      record: candidate.record,
      textScore: candidate.textScore,
      coverageNorm,
      ratingNorm,
      score: lexicographic ? candidate.textScore : composite,
    };
  });

  scored.sort(COMPARATORS[strategy]);

  return scored.map((hit, index) => ({ ...hit, rank: index + 1 }));
}

/** Look up the strategy metadata (label/kind/blurb) by id. */
export function strategyMeta(id: StrategyId): StrategyMeta {
  return STRATEGIES.find((strategy) => strategy.id === id) ?? STRATEGIES[0];
}

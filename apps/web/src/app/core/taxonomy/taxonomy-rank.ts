import type { TaxonomyTermWithCount } from '@aeci/shared';

/**
 * Pure ranking policy for the primary-nav taxonomy flyouts, kept free of any
 * Angular import so the node unit runner can cover it directly (importing the
 * `@Injectable` store pulls in `httpResource` / `@angular/common` and fails the
 * JIT-less node runner). The store (`taxonomy-nav.store.ts`) consumes these.
 */

/**
 * How many values a flyout surfaces for the larger facets. Phases (~6–8 terms)
 * show all; categories and audiences cap at this.
 */
export const TOP_N = 10;

/**
 * The metric the flyouts rank taxonomy values by — the single swap point.
 * Re-point this const (and the comparator in `topByCount`) at a future
 * popularity field (e.g. a `view_count` once "most viewed" data exists) to
 * re-rank every flyout without touching a consumer. Today: product count.
 */
const SORT_KEY = 'product_count' as const satisfies keyof TaxonomyTermWithCount;

/**
 * The top `n` terms by `SORT_KEY`, descending, then sliced. Pure — never
 * mutates the input. Pass `Infinity` to keep every (sorted) term.
 */
export function topByCount(
  list: readonly TaxonomyTermWithCount[] | undefined,
  n: number,
): TaxonomyTermWithCount[] {
  if (!list) return [];
  return [...list].sort((a, b) => b[SORT_KEY] - a[SORT_KEY]).slice(0, n);
}

/**
 * Terms in editorial `display_order` (ascending), with `name` as a stable
 * tiebreak — the project-lifecycle order for phases (Concept → Design →
 * Pre-Construction → Construction → Closeout, set in
 * `apps/api/seed/taxonomy.sql`). Used instead of `topByCount` where a
 * facet must read in its intended sequence rather than by popularity. Pure —
 * never mutates the input.
 */
export function byDisplayOrder(
  list: readonly TaxonomyTermWithCount[] | undefined,
): TaxonomyTermWithCount[] {
  if (!list) return [];
  return [...list].sort(
    (a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name),
  );
}

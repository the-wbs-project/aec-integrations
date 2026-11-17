/**
 * Facet-value ordering policy for the `/search` refinement lists (AECI). Kept
 * free of the InstantSearch controller so the node unit runner can cover it
 * directly — the controller pulls in browser-only dynamic imports.
 *
 * Only `phases` is reordered. It must read in **project-lifecycle** order, which
 * is NOT a built-in Algolia sort: the connector keeps its default (count)
 * ordering — the full phase set (5 terms) fits under `limit`, so nothing is
 * truncated — and the rendered items are re-sorted by `orderFacetItems` after
 * each render. Every other facet (categories, audiences, …) keeps count
 * order, with `compareFacetValues` breaking ties by name.
 *
 * `trades` (AECI-545) deliberately gets NO case here. Its `display_order` is
 * alphabetical (`TRADES_VOCABULARY.md` §5), which encodes no meaning the way the
 * phase lifecycle does — so count-desc, the connector default, is the more useful
 * order and matches how categories/audiences already behave.
 */
import { compareText } from '@aeci/shared/text-sort';

import type { RefinementItem } from '../shared/facets/refinement-item';

/**
 * Project-lifecycle order for the `phases` facet, keyed by taxonomy term **name**
 * (Algolia indexes phase *names*, not slugs — see
 * `apps/api/src/lib/algolia-transforms.ts`). Mirrors `taxonomy_phases.display_order`
 * in `apps/api/seed/taxonomy.sql`; keep in sync if a phase is renamed.
 * A renamed/unknown value sorts to the end rather than vanishing (DB-backed
 * surfaces read live `display_order` and are unaffected).
 */
export const PHASE_LIFECYCLE_ORDER: readonly string[] = [
  'Concept & Planning',
  'Design',
  'Pre-Construction',
  'Construction',
  'Closeout & Operations',
];

/**
 * The facet value the connector's `sortBy` function receives (the helper's
 * `FacetValue`). Only the three fields the order reads.
 */
export interface FacetSortValue {
  readonly name: string;
  readonly count: number;
  readonly isRefined: boolean;
}

/**
 * The `/search` refinement-list order: checked terms first, then most matching
 * products, then name. It is the connector default (`isRefined`, `count:desc`,
 * `name:asc`) with one change: the name tie-break uses `compareText`. The
 * default compares code units, so "SRS Distribution" ran before "Spotable" on
 * equal counts and case decided the order (AECI-825). Render-only: the Algolia
 * request does not change. No index sets `renderingContent.facetOrdering`,
 * which a `sortBy` function would switch off.
 */
export function compareFacetValues(a: FacetSortValue, b: FacetSortValue): number {
  if (a.isRefined !== b.isRefined) return a.isRefined ? -1 : 1;
  if (a.count !== b.count) return b.count - a.count;
  return compareText(a.name, b.name);
}

/**
 * The `/search` refinement lists ordered by `compareFacetValues`: checked terms
 * first, then most matching products, then name. The `/search` order caption
 * names exactly these (AECI-1796), so a change here changes what it promises.
 * `phases` is not here, because `orderFacetItems` re-sorts it.
 */
export const COUNT_ORDERED_FACETS: readonly string[] = [
  'categories',
  'audiences',
  'trades',
  'vendor_name',
];

/**
 * Re-orders rendered facet items for attributes whose intended order isn't a
 * built-in Algolia sort. Today only `phases` (project-lifecycle); all other
 * attributes pass through unchanged. Pure — never mutates the input.
 */
export function orderFacetItems(
  attribute: string,
  items: readonly RefinementItem[],
): RefinementItem[] {
  if (attribute !== 'phases') return [...items];
  const rank = (value: string): number => {
    const i = PHASE_LIFECYCLE_ORDER.indexOf(value);
    return i === -1 ? PHASE_LIFECYCLE_ORDER.length : i;
  };
  return [...items].sort((a, b) => rank(a.value) - rank(b.value));
}

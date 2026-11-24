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
import { CONNECTOR_KINDS } from '@aeci/shared/api/connector-kind';
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
 * The connector's items plus every checked value it left out, each checked at a
 * count of 0, in `compareFacetValues` order (AECI-1899).
 *
 * Why. Algolia leaves a facet out of its response when no record matches it.
 * The helper adds a checked value back at 0 only when the facet itself is in the
 * response. So `?trades=Roofing&categories=Accounting%20%26%20ERP`, which
 * matches nothing, came back with no `trades` facet at all. The Trades group
 * vanished with Roofing still checked, and the reader could not uncheck it.
 *
 * `checked` comes from the UI state (the URL's filters), never from the
 * helper's own state. The connector's `refine` toggles any value, so a value
 * added here unchecks like any other. Nothing is added when nothing is missing,
 * so the connector's list passes through untouched, and a group with no values
 * and no checked value stays hidden. An added value lands where the helper puts
 * a checked value at 0: after the checked values with matches.
 */
export function withCheckedValues(
  items: readonly RefinementItem[],
  checked: readonly string[],
): readonly RefinementItem[] {
  const present = new Set(items.map((item) => item.value));
  const missing = checked.filter((value) => !present.has(value));
  if (missing.length === 0) return items;
  const added = missing.map((value) => ({ value, label: value, count: 0, isRefined: true }));
  const sortValue = (item: RefinementItem): FacetSortValue => ({
    name: item.value,
    count: item.count,
    isRefined: item.isRefined,
  });
  return [...items, ...added].sort((a, b) => compareFacetValues(sortValue(a), sortValue(b)));
}

/**
 * Re-orders rendered facet items for attributes whose intended order isn't a
 * built-in Algolia sort: `phases` (project-lifecycle) and `connector_kind`
 * (AECI-1662); all other attributes pass through unchanged. Pure — never mutates
 * the input.
 *
 * `connector_kind` reads in vocabulary order, Integration platform then Sync
 * Service, whatever the counts, because `/products` lists the two in that order
 * (`GET /api/products/facets`) and the Same-Behavior Rule wants one order. A value
 * outside the vocabulary is dropped: the record only ever carries the two kinds,
 * so it can come only from a hand-edited URL.
 */
export function orderFacetItems(
  attribute: string,
  items: readonly RefinementItem[],
): RefinementItem[] {
  if (attribute === 'connector_kind') {
    const kinds: readonly string[] = CONNECTOR_KINDS;
    return items
      .filter((item) => kinds.includes(item.value))
      .sort((a, b) => kinds.indexOf(a.value) - kinds.indexOf(b.value));
  }
  if (attribute !== 'phases') return [...items];
  const rank = (value: string): number => {
    const i = PHASE_LIFECYCLE_ORDER.indexOf(value);
    return i === -1 ? PHASE_LIFECYCLE_ORDER.length : i;
  };
  return [...items].sort((a, b) => rank(a.value) - rank(b.value));
}

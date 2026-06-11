/**
 * Facet-value ordering policy for the `/search` refinement lists (AECI). Kept
 * free of the InstantSearch controller so the node unit runner can cover it
 * directly — the controller pulls in browser-only dynamic imports.
 *
 * Only `phases` is reordered. It must read in **project-lifecycle** order, which
 * is NOT a built-in Algolia sort: the connector keeps its default (count)
 * ordering — the full phase set (5 terms) fits under `limit`, so nothing is
 * truncated — and the rendered items are re-sorted by `orderFacetItems` after
 * each render. Every other facet (categories, audiences, …) is left on the
 * connector default untouched.
 */
import type { RefinementItem } from '../shared/facets/refinement-item';

/**
 * Project-lifecycle order for the `phases` facet, keyed by taxonomy term **name**
 * (Algolia indexes phase *names*, not slugs — see
 * `apps/api/src/lib/algolia-transforms.ts`). Mirrors `taxonomy_phases.display_order`
 * in `supabase/reference-data/taxonomy.sql`; keep in sync if a phase is renamed.
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

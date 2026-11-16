import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

/**
 * Per-facet primary-nav copy, shared by the desktop Browse panel
 * (`browse-panel.ts`) and the mobile menu's panel (`nav-menu-panel.ts`)
 * so the two surfaces use one set of `@@app.nav.*` ids. `$localize` is a runtime
 * global (see resolvers for the same plain-function usage), so these stay pure
 * functions rather than living inside a component. AECI-159.
 */

/**
 * "1 product" or "N products", under each Browse destination (DESIGN.md §5,
 * "Counts are quiet tabular numbers"). The leading space keeps a link's
 * accessible name "AI 69 products", not "AI69 products": the name and the count
 * are separate blocks on screen, but a name is computed from text.
 */
export function browseCountText(count: number): string {
  const label =
    count === 1
      ? $localize`:@@app.nav.browse.countOne:1 product`
      : $localize`:@@app.nav.browse.countOther:${count}:count: products`;
  return ` ${label}`;
}

/** Top-level facet label (also the index link text). */
export function facetNavLabel(kind: TaxonomyKind): string {
  switch (kind) {
    case 'category':
      return $localize`:@@app.nav.categories:Categories`;
    case 'audience':
      return $localize`:@@app.nav.audiences:Audiences`;
    case 'phase':
      return $localize`:@@app.nav.phases:Phases`;
    case 'trade':
      return $localize`:@@app.nav.trades:Trades`;
  }
}

/**
 * "See all <facet>" link text at the foot of a facet's column (PLAN.md §4.8). It
 * names the facet, so the four "See all" links on one panel stay distinguishable.
 */
export function facetSeeAllLabel(kind: TaxonomyKind): string {
  switch (kind) {
    case 'category':
      return $localize`:@@app.nav.browse.seeAll.categories:See all categories`;
    case 'audience':
      return $localize`:@@app.nav.browse.seeAll.audiences:See all audiences`;
    case 'phase':
      return $localize`:@@app.nav.browse.seeAll.phases:See all phases`;
    case 'trade':
      return $localize`:@@app.nav.browse.seeAll.trades:See all trades`;
  }
}

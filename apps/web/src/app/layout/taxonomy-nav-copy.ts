import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

/**
 * Per-facet primary-nav copy, shared by the desktop Browse menu
 * (`browse-menu.ts`) and the mobile overlay disclosures (`nav-menu.ts`)
 * so the two surfaces use one set of `@@app.nav.*` ids. `$localize` is a runtime
 * global (see resolvers for the same plain-function usage), so these stay pure
 * functions rather than living inside a component. AECI-159.
 */

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

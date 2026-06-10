import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

/**
 * Per-facet primary-nav copy, shared by the desktop flyout trigger
 * (`nav-flyout-trigger.ts`) and the mobile overlay disclosures (`nav-menu.ts`)
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
  }
}

/** "View all <facet>" link text shown at the foot of a facet's value list. */
export function facetViewAllLabel(kind: TaxonomyKind): string {
  switch (kind) {
    case 'category':
      return $localize`:@@app.nav.flyout.viewAll.categories:View all categories`;
    case 'audience':
      return $localize`:@@app.nav.flyout.viewAll.audiences:View all audiences`;
    case 'phase':
      return $localize`:@@app.nav.flyout.viewAll.phases:View all phases`;
  }
}

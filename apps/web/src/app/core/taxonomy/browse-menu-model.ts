import { type TaxonomyResponse, type TaxonomyTermWithCount, isPublishedTrade } from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { byDisplayOrder, topByCount } from './taxonomy-rank';

/**
 * The Browse menu's model (AECI-1774, DESIGN.md §5 "The Browse menu", ruling R4 on
 * AECI-1735). Pure and free of Angular, so the node unit runner and the on-page
 * ordering firewall test (`products/on-page-ordering-firewall.spec.ts`) call it
 * directly. The desktop panel (`layout/browse-menu.ts`) and the mobile menu
 * (`layout/nav-menu.ts`) both read it through `TaxonomyNavStore.browse`.
 *
 * Every order has a source, and none reads a paid-plan input:
 *
 *  - Key categories: AECi's editorial pick, in this fixed order. Never a count order.
 *  - Categories: most products first, then name, then id. Categories are Free to tag.
 *  - Phases: all of them, in `display_order` (project order).
 *  - Audiences and trades: most products first, then name, then id. This is the one
 *    accepted exception in the firewall (`taxonomy-term-product-count`, AECI-1836).
 *
 * The input is `GET /api/taxonomy` and nothing else. That response carries no plan,
 * entitlement, license or review field, so no plan state can reach this model.
 */

/**
 * The key categories, in menu order: AI first, then Project management, BIM
 * authoring, and Accounting and ERP (ruling R4, 2026-11-14). An editorial list held
 * in config, not a table. `/docs/trust/how-ranking-works` says they are our pick.
 * If one ever has fewer than 5 products, it goes back to Chris (DESIGN.md §5).
 */
export const BROWSE_KEY_CATEGORY_SLUGS = [
  'ai',
  'project-management',
  'bim-authoring',
  'accounting-erp',
] as const;

/** Items per facet column (ruling R4). Phases show all of theirs. */
export const BROWSE_COLUMN_LENGTH = 7;

export interface BrowseMenuModel {
  /** The "All products" count. `undefined` from an older API Worker: print no count. */
  readonly totalProducts: number | undefined;
  readonly keyCategories: readonly TaxonomyTermWithCount[];
  readonly categories: readonly TaxonomyTermWithCount[];
  readonly phases: readonly TaxonomyTermWithCount[];
  readonly audiences: readonly TaxonomyTermWithCount[];
  readonly trades: readonly TaxonomyTermWithCount[];
}

export const EMPTY_BROWSE_MENU: BrowseMenuModel = {
  totalProducts: undefined,
  keyCategories: [],
  categories: [],
  phases: [],
  audiences: [],
  trades: [],
};

/**
 * A to Z by name, ignoring case, then id. Run before `topByCount`, which keeps input
 * order on a tie, so a count tie falls back to name and then id.
 */
function byNameThenId(list: readonly TaxonomyTermWithCount[]): TaxonomyTermWithCount[] {
  return [...list].sort(
    (a, b) => compareText(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** A term with no products never appears in the menu (production has one at 0). */
function withProducts(list: readonly TaxonomyTermWithCount[]): TaxonomyTermWithCount[] {
  return list.filter((term) => term.product_count > 0);
}

export function buildBrowseMenu(response: TaxonomyResponse | null): BrowseMenuModel {
  if (!response) return EMPTY_BROWSE_MENU;

  const keySlugs: readonly string[] = BROWSE_KEY_CATEGORY_SLUGS;
  const bySlug = new Map(response.categories.map((term) => [term.slug, term]));
  // A configured slug the API no longer returns is skipped.
  const keyCategories = withProducts(
    BROWSE_KEY_CATEGORY_SLUGS.flatMap((slug) => bySlug.get(slug) ?? []),
  );
  const otherCategories = response.categories.filter((term) => !keySlugs.includes(term.slug));

  return {
    totalProducts:
      typeof response.total_products === 'number' ? response.total_products : undefined,
    keyCategories,
    categories: topByCount(byNameThenId(withProducts(otherCategories)), BROWSE_COLUMN_LENGTH),
    phases: byDisplayOrder(response.phases),
    audiences: topByCount(byNameThenId(withProducts(response.audiences)), BROWSE_COLUMN_LENGTH),
    trades: topByCount(
      byNameThenId(response.trades.filter(isPublishedTrade)),
      BROWSE_COLUMN_LENGTH,
    ),
  };
}

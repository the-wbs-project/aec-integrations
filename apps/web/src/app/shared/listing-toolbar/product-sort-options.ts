import type { ListingSortOption } from './listing-toolbar';

/**
 * The `?sort=` keys every product listing accepts, and the one order in which
 * they are offered. Handed to `createPaginatedIndex` as `validSorts` and to
 * `aec-listing-toolbar` as its options, so a key can never be offered in the UI
 * without the controller accepting it (or vice versa).
 *
 * The set is `ProductSortSchema`'s enum (`packages/shared/src/api/products.ts`)
 * — the API is the ceiling, and every key it accepts is exposed. `STAGE_1_SPEC.md`
 * §4.5 asks the taxonomy browse pages for "alphabetical, most integrations, most
 * reviewed"; all three are here, plus the two `/products` already had.
 *
 * Before AECI-657 the taxonomy pages restricted themselves to `created` / `name`
 * / `updated` and rendered no control at all, so `rating` and `reviews` were
 * silently unreachable there even by hand-typed URL.
 */
export const PRODUCT_SORT_KEYS = [
  'created',
  'name',
  'updated',
  'rating',
  'reviews',
  'integrations',
] as const;

export const PRODUCT_VALID_SORTS: ReadonlySet<string> = new Set(PRODUCT_SORT_KEYS);

/** Default for every product listing — `created DESC`, per Phase 2 §7.4. */
export const PRODUCT_DEFAULT_SORT = 'created';

/**
 * Localized toolbar options, in display order. A function rather than a
 * module-level const so `$localize` is evaluated per component construction,
 * matching how the labels were written when they lived in `products-index.ts`.
 */
export function productSortOptions(): readonly ListingSortOption[] {
  return [
    { value: 'created', label: $localize`:@@listing.sort.newest:Newest` },
    { value: 'name', label: $localize`:@@listing.sort.name:Name (A–Z)` },
    { value: 'updated', label: $localize`:@@listing.sort.updated:Recently updated` },
    { value: 'rating', label: $localize`:@@listing.sort.rating:Highest rated` },
    { value: 'reviews', label: $localize`:@@listing.sort.reviews:Most reviewed` },
    { value: 'integrations', label: $localize`:@@listing.sort.integrations:Most integrations` },
  ];
}

import type { ListingSortOption } from './listing-toolbar';

/**
 * The localized half of the product sort vocabulary. The KEYS live in
 * `product-sort-keys.ts` and are re-exported here so existing consumers are
 * unchanged; anything the eager route graph can reach must import them from
 * there instead, because this module calls `$localize` (AECI-750).
 */
export { PRODUCT_DEFAULT_SORT, PRODUCT_SORT_KEYS, PRODUCT_VALID_SORTS } from './product-sort-keys';

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

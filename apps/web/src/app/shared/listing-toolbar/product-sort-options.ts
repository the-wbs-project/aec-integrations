import type { ListingSortOption } from './listing-toolbar';

/**
 * Localized toolbar options for the product listings.
 *
 * The key vocabulary itself lives in `product-sort-keys.ts` — pure data with no
 * `$localize` — because the eager route graph reaches it through the listing
 * prefetch resolvers, and this module's labels must not ride along into the
 * initial bundle. Re-exported here so existing importers are unaffected.
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

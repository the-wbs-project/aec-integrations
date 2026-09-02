/**
 * The `?sort=` keys every product listing accepts — **pure data, no `$localize`,
 * no imports** (AECI-750).
 *
 * Split out of `product-sort-options.ts` because the eager route graph reaches
 * these: `app.routes.ts` imports the listing prefetch resolvers, which import
 * `products-index.config.ts` / `taxonomy-browse.config.ts`, which need the valid-sort
 * set. Pulling the whole options module along would drag its six `$localize` labels
 * (and the `listing-toolbar` module they belong to) into the initial bundle, which
 * is measured against a 1 MB budget with single-digit kB of headroom.
 *
 * The set is `ProductSortSchema`'s enum (`packages/shared/src/api/products.ts`) — the
 * API is the ceiling, and every key it accepts is exposed. `STAGE_1_SPEC.md` §4.5 asks
 * the taxonomy browse pages for "alphabetical, most integrations, most reviewed"; all
 * three are here, plus the two `/products` already had.
 *
 * Before AECI-657 the taxonomy pages restricted themselves to `created` / `name` /
 * `updated` and rendered no control, so `rating` and `reviews` were silently
 * unreachable there even by hand-typed URL.
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

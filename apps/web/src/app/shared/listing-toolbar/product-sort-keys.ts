/**
 * The `?sort=` keys every product listing accepts, and the one order in which
 * they are offered.
 *
 * **Pure data, and deliberately its own module (AECI-750).** The eager route
 * graph reaches this file — `app.routes.ts` → `products-index.resolver.ts` →
 * `products-index.config.ts` → here — and the sibling `product-sort-options.ts`
 * calls `$localize`. Keeping the keys separate from the localized labels is what
 * lets the listing *configs* share this set without dragging the toolbar's
 * translation machinery into the initial bundle. See the header of
 * `products-index.config.ts` for what that cost the last time it happened.
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

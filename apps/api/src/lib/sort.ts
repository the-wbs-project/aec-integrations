/**
 * Resolves the public sort key on Phase 2.8 list endpoints to a Drizzle
 * `orderBy` clause. Direction is fixed per `docs/STAGE_1_PHASE_2_SPEC.md` §7.4:
 *
 *   - `created → DESC` ("newest first" lists feel alive)
 *   - `name    → ASC`  (alphabetical)
 *   - `updated → DESC` (most recently touched first)
 *
 * Products additionally expose two review-driven sorts (both `DESC`):
 *
 *   - `rating  → DESC` ("Highest rated") — products whose rating is hidden by
 *                      the §5.5 gate (`review_count < 5`) sort last (see
 *                      `resolveProductOrderBy`).
 *   - `reviews → DESC` ("Most reviewed")
 *   - `integrations → DESC` ("Most integrations") — on the denormalized
 *                      `products.integration_count`, so no join is needed. This
 *                      is the third sort `STAGE_1_SPEC.md` §4.5 asked for and
 *                      the last to be built (AECI-657).
 *
 * Each resolver returns an **array** whose last element is a unique `id` ASC
 * tiebreaker. The list handlers paginate with page-based `skip`/`take`, and a
 * single-column sort with ties (very likely on `name`; possible on
 * `createdAt`/`updatedAt` for rows bulk-promoted with one timestamp) orders the
 * tied rows unpredictably across separate page queries — so a row on a page
 * boundary can be dropped or duplicated. The `id` tiebreaker makes the ordering
 * total and stable. It never surfaces in the public query, so §7.4 (which fixes
 * only the primary field+direction) is unaffected (AECI-99).
 *
 * Callers pass the parsed (Zod-defaulted) value of `ProductSort` / `VendorSort`
 * / `IntegrationSort`. The shared schemas already default to `'created'` for
 * products+vendors and `'name'` for integrations, so unknown values cannot
 * reach this helper — the `as never` fall-throughs guard against schema drift.
 *
 * Kept in a single file rather than scattered across route handlers so the
 * §7.4 default-direction rule lives in exactly one place.
 */

import {
  ADMIN_USER_SORT_DEFAULT_ORDER,
  ADMIN_VENDOR_SORT_DEFAULT_ORDER,
  RATING_VISIBILITY_MIN_REVIEWS,
} from '@aeci/shared';
import type {
  AdminUsersSort,
  AdminVendorSort,
  IntegrationSort,
  ProductSort,
  SortOrder,
  VendorSort,
} from '@aeci/shared';
import { asc, desc, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import { integrations, products, profiles, vendorEntitlements, vendors } from '../db/schema';

type Direction = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Drizzle orderBy resolvers (ADR 0016 / AECI-253) — the live sort path. Same
// §7.4 directions + the stable `id ASC` tiebreaker, returning Drizzle `SQL[]`
// for `db.query.*` / `.orderBy(...)`. (The legacy object-form `resolveProductSort`
// below is retained only for the AECI-99 tiebreaker test; no route uses it.)
// ---------------------------------------------------------------------------

export function resolveProductOrderBy(sort: ProductSort): SQL[] {
  switch (sort) {
    case 'created':
      return [desc(products.createdAt), asc(products.id)];
    case 'name':
      return [asc(products.name), asc(products.id)];
    case 'updated':
      return [desc(products.updatedAt), asc(products.id)];
    case 'rating':
      // §5.5: a product's rating is hidden until it has ≥5 reviews
      // (drizzle-helpers.ts `ratingsVisible`), so rank those last. The CASE
      // nulls the sort key below the threshold and SQLite orders NULLs last
      // under DESC — so the order matches what the card actually shows. Tie-break
      // by review_count (more reviews = more confidence), then the stable id.
      return [
        desc(
          sql`case when ${products.reviewCount} >= ${RATING_VISIBILITY_MIN_REVIEWS} then ${products.ratingOverallAvg} end`,
        ),
        desc(products.reviewCount),
        asc(products.id),
      ];
    case 'reviews':
      return [desc(products.reviewCount), asc(products.id)];
    case 'integrations':
      // Denormalized counter, recomputed by `lib/recompute-counts.ts` — sorting
      // on it avoids a correlated count over `integrations`, which on D1 would
      // run per row. No §5.5-style visibility gate applies: unlike `rating`, the
      // count is displayed unconditionally (`IntegrationStat` renders "Not yet
      // connected" at zero), so the order always matches what the card shows.
      return [desc(products.integrationCount), asc(products.id)];
    default:
      return sort satisfies never;
  }
}

export function resolveVendorOrderBy(sort: VendorSort): SQL[] {
  switch (sort) {
    case 'created':
      return [desc(vendors.createdAt), asc(vendors.id)];
    case 'name':
      // Vendors have no `name` column; public `name` → `company_name`.
      return [asc(vendors.companyName), asc(vendors.id)];
    case 'updated':
      return [desc(vendors.updatedAt), asc(vendors.id)];
    default:
      return sort satisfies never;
  }
}

/**
 * Order for the admin vendor list (`GET /api/admin/vendors`).
 *
 * **Every column the operator's table renders is here, and that is the whole
 * point.** The screen shipped with two sortable headers on an explicit rule:
 * offering a control the API cannot honour would reorder the 25 rows on the
 * current page and present that as a ranking. The rule did not change — the API
 * did. Add a column to that table and it gets a case here, or it gets no header
 * control at all.
 *
 * Deliberately separate from {@link resolveVendorOrderBy}: that one serves the
 * PUBLIC `/api/vendors` directory, whose §7.4 key set (`created|name|updated`)
 * is a published contract. Four of the keys below (`slug`, `verified`,
 * `entitlement`, `term`) address operator concerns — mirror drift, renewal
 * windows — that the public list has no column for, and two of them
 * (`entitlement`, `term`) read `vendor_entitlements`, which the public list does
 * not join at all.
 *
 * **Each key has a NATURAL direction — the one an operator wants first — and the
 * caller may reverse it.** An `order`-less call gets the natural direction, so
 * every link, bookmark and test written before direction existed is unchanged;
 * passing `order` flips the primary term. The surface originally had no `order`
 * parameter at all, on the rule that a header should state how a column sorts
 * rather than toggle it. That was defensible with two sortable keys and became a
 * defect with seven: the arrow reads as a toggle, so clicking it twice must
 * reverse the list rather than no-op.
 *
 * **Only the PRIMARY term flips.** The `id ASC` tiebreaker and the intermediate
 * `company_name` term are not direction — they are what make the order total and
 * the page stable (AECI-99). Flipping them too would reverse rows *within* a tie
 * for no reader benefit, and reversing a tiebreaker is how a paginated list
 * starts duplicating and skipping rows.
 *
 * `term` is the one key where something deliberately does NOT flip. It sorts by
 * "is the date NULL" and then by the date; only the DATE reverses. Flipping the
 * NULL guard too would float every perpetual/no-row vendor to the top on the
 * second click — the exact burial that guard exists to prevent — and "who lapses
 * last" is still a question about vendors that lapse.
 *
 * Three cases are not a bare column:
 *
 *  - **`products`** orders by the SELECT alias `product_count`, not by repeating
 *    the correlated subquery in the ORDER BY. SQLite resolves an output alias,
 *    so the count is computed once per row rather than twice.
 *  - **`entitlement`** ranks the status by operational urgency, not
 *    alphabetically — `active < pending < expired < revoked < none`. Sorting the
 *    raw text would interleave "expired" between "active" and "pending" and mean
 *    nothing. A vendor with no entitlement row sorts last, which is where the
 *    majority live.
 *  - **`term`** puts the soonest expiry first ("who lapses next"), and pushes
 *    NULL — perpetual, or no row at all — LAST. SQLite orders NULLs first under
 *    ASC, which would have buried every real renewal date under thousands of
 *    blanks, so the `IS NULL` expression sorts ahead of the date itself.
 *
 * Every case ends in the AECI-99 `id ASC` tiebreaker; the ones whose primary key
 * is low-cardinality (`verified`, `entitlement`, `products`, `term`) sort by
 * company name in between, so the page inside a tie is still scannable.
 */
export function resolveAdminVendorOrderBy(sort: AdminVendorSort, order?: SortOrder): SQL[] {
  // The requested direction applies to the PRIMARY term directly, so a header
  // reading "descending" produces a descending list. `id ASC` and the
  // intermediate `company_name` term never move: they are what make the order
  // total and the page stable (AECI-99), not direction.
  const ascending = (order ?? ADMIN_VENDOR_SORT_DEFAULT_ORDER[sort]) === 'asc';
  const dir = (column: SQL | SQLiteColumn): SQL => (ascending ? asc(column) : desc(column));

  switch (sort) {
    case 'name':
      return [dir(vendors.companyName), asc(vendors.id)];
    case 'slug':
      return [dir(vendors.slug), asc(vendors.id)];
    case 'verified':
      return [dir(vendors.verified), asc(vendors.companyName), asc(vendors.id)];
    case 'entitlement':
      // Ascending ranks by operational urgency; descending reverses that ranking
      // rather than sorting the status text alphabetically.
      return [
        dir(sql`case ${vendorEntitlements.status}
          when 'active' then 0
          when 'pending' then 1
          when 'expired' then 2
          when 'revoked' then 3
          else 4 end`),
        asc(vendors.companyName),
        asc(vendors.id),
      ];
    case 'products':
      // The `product_count` SELECT alias, resolved by SQLite — not a second copy
      // of the correlated subquery.
      return [dir(sql`product_count`), asc(vendors.companyName), asc(vendors.id)];
    case 'term':
      // The NULL guard is PINNED ascending — see the docblock. Only the date
      // flips, so descending reads "who lapses last" with the perpetual and
      // no-row vendors still at the bottom where they belong.
      return [
        asc(sql`${vendorEntitlements.periodEnd} is null`),
        dir(vendorEntitlements.periodEnd),
        asc(vendors.companyName),
        asc(vendors.id),
      ];
    case 'updated':
      return [dir(vendors.updatedAt), asc(vendors.id)];
    default:
      return sort satisfies never;
  }
}

/**
 * Order for the admin user list (AECI-692).
 *
 * **D1 columns only, and that is a contract not an omission.** There is no
 * `last_sign_in` case: last sign-in lives in GoTrue and is fetched per-id AFTER
 * this ORDER BY has already chosen the page, so a "sort by last login" control
 * would reorder 24 arbitrary rows and call it a ranking. Adding one means
 * pulling every profile in the environment through the seam first.
 */
export function resolveAdminUserOrderBy(sort: AdminUsersSort, order?: SortOrder): SQL[] {
  // Only the primary term flips; `id ASC` stays the stable tiebreaker (AECI-99).
  const ascending = (order ?? ADMIN_USER_SORT_DEFAULT_ORDER[sort]) === 'asc';
  const dir = (column: SQLiteColumn): SQL => (ascending ? asc(column) : desc(column));

  switch (sort) {
    case 'created':
      return [dir(profiles.createdAt), asc(profiles.id)];
    case 'updated':
      return [dir(profiles.updatedAt), asc(profiles.id)];
    default:
      return sort satisfies never;
  }
}

export function resolveIntegrationOrderBy(sort: IntegrationSort): SQL[] {
  switch (sort) {
    case 'name':
      return [asc(integrations.name), asc(integrations.id)];
    case 'created':
      return [desc(integrations.createdAt), asc(integrations.id)];
    default:
      return sort satisfies never;
  }
}

// Unique, deterministic tiebreaker appended to every list orderBy so page-based
// skip/take pagination is stable across queries (AECI-99).
const ID_ASC = { id: 'asc' as Direction };

function withTiebreaker<T>(primary: T): [T, typeof ID_ASC] {
  return [primary, ID_ASC];
}

const CREATED_DESC = { createdAt: 'desc' as Direction };
const UPDATED_DESC = { updatedAt: 'desc' as Direction };

// NOTE: legacy Prisma-style object form, kept only for the AECI-99 tiebreaker
// test and type exhaustiveness — no route uses it (the live path is
// `resolveProductOrderBy`). The object form can't express the §5.5 `rating`
// CASE gate, so the gated behavior lives solely in `resolveProductOrderBy`.
export function resolveProductSort(sort: ProductSort): Array<{
  createdAt?: Direction;
  updatedAt?: Direction;
  name?: Direction;
  ratingOverallAvg?: Direction;
  reviewCount?: Direction;
  integrationCount?: Direction;
  id?: Direction;
}> {
  switch (sort) {
    case 'created':
      return withTiebreaker(CREATED_DESC);
    case 'name':
      return withTiebreaker({ name: 'asc' as Direction });
    case 'updated':
      return withTiebreaker(UPDATED_DESC);
    case 'rating':
      return withTiebreaker({ ratingOverallAvg: 'desc' as Direction });
    case 'reviews':
      return withTiebreaker({ reviewCount: 'desc' as Direction });
    case 'integrations':
      return withTiebreaker({ integrationCount: 'desc' as Direction });
    default:
      return sort satisfies never;
  }
}

export function resolveVendorSort(sort: VendorSort): Array<{
  createdAt?: Direction;
  updatedAt?: Direction;
  companyName?: Direction;
  id?: Direction;
}> {
  switch (sort) {
    case 'created':
      return withTiebreaker(CREATED_DESC);
    case 'name':
      // Vendors have no `name` column; the public `name` sort key maps to
      // `company_name` server-side per §"Sort & direction" in API_CONTRACTS.md.
      return withTiebreaker({ companyName: 'asc' as Direction });
    case 'updated':
      return withTiebreaker(UPDATED_DESC);
    default:
      return sort satisfies never;
  }
}

export function resolveIntegrationSort(sort: IntegrationSort): Array<{
  createdAt?: Direction;
  name?: Direction;
  id?: Direction;
}> {
  switch (sort) {
    case 'name':
      return withTiebreaker({ name: 'asc' as Direction });
    case 'created':
      return withTiebreaker(CREATED_DESC);
    default:
      return sort satisfies never;
  }
}

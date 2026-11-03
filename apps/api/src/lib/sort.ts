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
 *
 * `integrations` ("Most integrations", AECI-657) was retired by AECI-636 PR-B:
 * a count of integrations rewards shallow connectors. `ProductSortSchema` maps a
 * retired `?sort=integrations` to the default before it reaches this helper.
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
 * **Every text sort is case-insensitive** (`textAsc` / `textDir` from
 * `./collation`, i.e. `COLLATE NOCASE`). SQLite's default `BINARY` collation
 * ranked `ADP Workforce Now` ahead of `Access Coins Evo` and exiled `eSUB` past
 * `Zoho` — AECI-825. That makes the trailing `id ASC` tiebreaker load-bearing
 * rather than merely defensive: `NOCASE` reports `ADP` and `adp` as EQUAL, so
 * without it a case-only collision would page unstably. `slug` is the one text key
 * left on `BINARY`, because slugs are lowercase by construction.
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

import { integrations, products, profiles, vendors } from '../db/schema';
import { blankLast, textAsc, textDir } from './collation';

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
      // `textAsc`, not `asc` — SQLite's default BINARY collation would rank every
      // capital ahead of every lowercase letter (AECI-825). The `id` tiebreaker
      // below is now load-bearing: NOCASE ties `ADP` with `adp`.
      return [textAsc(products.name), asc(products.id)];
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
      // Case-insensitive per AECI-825; `id` keeps the order total.
      return [textAsc(vendors.companyName), asc(vendors.id)];
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
 * is a published contract. Three of the keys below (`slug`, `verified`,
 * `licenses`) address operator concerns — mirror drift, live licenses — that the
 * public list has no column for.
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
 * Two cases are not a bare column. Each orders by a SELECT alias, not by
 * repeating the correlated subquery in the ORDER BY: SQLite resolves an output
 * alias, so the count is computed once per row rather than twice.
 *
 *  - **`products`** orders by `product_count`.
 *  - **`licenses`** orders by `live_license_count` (AECI-1375; the vendor's
 *    licenses with `ended_at IS NULL`, `liveLicenseCountSql` in `lib/license.ts`).
 *    It replaced the `entitlement` and `term` keys, which read the retired
 *    entitlement join.
 *
 * Every case ends in the AECI-99 `id ASC` tiebreaker; the ones whose primary key
 * is low-cardinality (`verified`, `licenses`, `products`) sort by company name in
 * between, so the page inside a tie is still scannable.
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
      return [textDir(vendors.companyName, ascending), asc(vendors.id)];
    case 'slug':
      // NOT case-folded, and that is not an oversight: `vendors.slug` is lowercase
      // by construction (`@aeci/shared/slug`), so BINARY and NOCASE agree on every
      // row and BINARY can read the order off `vendors_slug_key`.
      return [dir(vendors.slug), asc(vendors.id)];
    case 'verified':
      return [dir(vendors.verified), textAsc(vendors.companyName), asc(vendors.id)];
    case 'licenses':
      // The `live_license_count` SELECT alias (`routes/admin-vendors.ts`).
      return [dir(sql`live_license_count`), textAsc(vendors.companyName), asc(vendors.id)];
    case 'products':
      // The `product_count` SELECT alias, resolved by SQLite — not a second copy
      // of the correlated subquery.
      return [dir(sql`product_count`), textAsc(vendors.companyName), asc(vendors.id)];
    case 'updated':
      return [dir(vendors.updatedAt), asc(vendors.id)];
    default:
      return sort satisfies never;
  }
}

/**
 * Order for the admin user list (AECI-692).
 *
 * **`last_sign_in` is not ordered here.** It lives in GoTrue, so the handler ranks
 * the filtered set in memory before choosing the page. This function only sees that
 * key when the GoTrue sweep failed, and answers with the `created` order. The screen
 * says so (`ADMIN_PANEL_SPEC.md` §5.8).
 */
export function resolveAdminUserOrderBy(sort: AdminUsersSort, order?: SortOrder): SQL[] {
  // Only the primary term flips; `id ASC` stays the stable tiebreaker (AECI-99).
  const ascending = (order ?? ADMIN_USER_SORT_DEFAULT_ORDER[sort]) === 'asc';
  const dir = (column: SQLiteColumn): SQL => (ascending ? asc(column) : desc(column));

  switch (sort) {
    case 'created':
    case 'last_sign_in':
      return [dir(profiles.createdAt), asc(profiles.id)];
    case 'updated':
      return [dir(profiles.updatedAt), asc(profiles.id)];
    case 'name':
      // AECI-1243. Case-insensitive, and an unnamed account (NULL or empty,
      // both render "Unnamed account") sorts LAST in both directions:
      // `blankLast` is 0/1 and stays ascending while the name flips.
      return [
        blankLast(profiles.displayName),
        textDir(profiles.displayName, ascending),
        asc(profiles.id),
      ];
    default:
      return sort satisfies never;
  }
}

export function resolveIntegrationOrderBy(sort: IntegrationSort): SQL[] {
  switch (sort) {
    case 'name':
      // Case-insensitive per AECI-825; `id` keeps the order total under NOCASE.
      return [textAsc(integrations.name), asc(integrations.id)];
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

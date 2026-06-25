/**
 * Resolves the public sort key on Phase 2.8 list endpoints to a Prisma
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

import type { IntegrationSort, ProductSort, VendorSort } from '@aeci/shared';
import { asc, desc, sql, type SQL } from 'drizzle-orm';

import { integrations, products, vendors } from '../db/schema';

type Direction = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Drizzle orderBy resolvers (ADR 0016 / AECI-253). Same §7.4 directions + the
// stable `id ASC` tiebreaker, returning Drizzle `SQL[]` for `db.query.*` /
// `.orderBy(...)`. Replace the Prisma resolvers above as each route migrates.
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
        desc(sql`case when ${products.reviewCount} >= 5 then ${products.ratingOverallAvg} end`),
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
      return [asc(vendors.companyName), asc(vendors.id)];
    case 'updated':
      return [desc(vendors.updatedAt), asc(vendors.id)];
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

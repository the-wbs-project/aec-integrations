/**
 * Resolves the public sort key on Phase 2.8 list endpoints to a Prisma
 * `orderBy` clause. Direction is fixed per `docs/STAGE_1_PHASE_2_SPEC.md` §7.4:
 *
 *   - `created → DESC` ("newest first" lists feel alive)
 *   - `name    → ASC`  (alphabetical)
 *   - `updated → DESC` (most recently touched first)
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

type Direction = 'asc' | 'desc';

const CREATED_DESC = { createdAt: 'desc' as Direction };
const UPDATED_DESC = { updatedAt: 'desc' as Direction };

export function resolveProductSort(sort: ProductSort): {
  createdAt?: Direction;
  updatedAt?: Direction;
  name?: Direction;
} {
  switch (sort) {
    case 'created':
      return CREATED_DESC;
    case 'name':
      return { name: 'asc' };
    case 'updated':
      return UPDATED_DESC;
    default:
      return sort satisfies never;
  }
}

export function resolveVendorSort(sort: VendorSort): {
  createdAt?: Direction;
  updatedAt?: Direction;
  companyName?: Direction;
} {
  switch (sort) {
    case 'created':
      return CREATED_DESC;
    case 'name':
      // Vendors have no `name` column; the public `name` sort key maps to
      // `company_name` server-side per §"Sort & direction" in API_CONTRACTS.md.
      return { companyName: 'asc' };
    case 'updated':
      return UPDATED_DESC;
    default:
      return sort satisfies never;
  }
}

export function resolveIntegrationSort(sort: IntegrationSort): {
  createdAt?: Direction;
  name?: Direction;
} {
  switch (sort) {
    case 'name':
      return { name: 'asc' };
    case 'created':
      return CREATED_DESC;
    default:
      return sort satisfies never;
  }
}

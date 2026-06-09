/**
 * Supabase-row → Algolia-record transforms (AECI-137 / Phase 3.2).
 *
 * The denormalizing mappers that turn a Prisma row into the flat, zero-join
 * Algolia record shapes from `@aeci/shared/algolia-records` (spec §7.1). This is
 * the single transform the sync pipeline (3.5 bulk import / 3.6 incremental
 * Worker) shares — keep the `*Select` shapes and the mappers here in lockstep.
 *
 * Pattern mirrors `prisma-helpers.ts`: an `as const satisfies Prisma.*Select`
 * shape, a `Raw*` payload type via `*GetPayload`, and a `to*` mapper that
 * coerces `Decimal → number` and denormalizes relations. We deliberately REUSE
 * the helpers from `prisma-helpers.ts` (`vendorListSelect`, `integrationListSelect`,
 * `pickPrimaryVendor`, `toMechanismKind`, `coerceDirection`, `toNumberOrNull`) so
 * the search index stays consistent with what the `/products`, `/vendors`, and
 * `/integrations` API endpoints already surface (counts, vendor selection, the
 * fail-loud out-of-enum `mechanism_kind` behaviour).
 *
 * The mappers return typed records but do NOT `.parse()` them (same as the
 * `prisma-helpers.ts` mappers) — callers validate against the Zod schema where it
 * matters (the unit test here; the sync pipeline before upload).
 *
 * Spec: `STAGE_1_SPEC.md` §7.1 (record shapes); ranking weights + settings live
 * in `@aeci/shared/algolia`.
 */

import { mechanismRank } from '@aeci/shared/algolia';
import type {
  AlgoliaIntegrationRecord,
  AlgoliaProductRecord,
  AlgoliaVendorRecord,
} from '@aeci/shared/algolia-records';
import type { Prisma } from '@prisma/client/edge';

import {
  coerceDirection,
  integrationListSelect,
  pickPrimaryVendor,
  toMechanismKind,
  toNumberOrNull,
  vendorListSelect,
  vendorLinkSelect,
} from './prisma-helpers';

// ---------------------------------------------------------------------------
// Select shapes
// ---------------------------------------------------------------------------

/** A taxonomy join that needs only the term's display **name** (Algolia facets
 *  on the names, not the slugs/ids). */
const taxonomyNameSelect = { name: true } as const;

/**
 * Fields for `AlgoliaProductRecord`. `vendor` reuses `vendorLinkSelect` so the
 * `productVendors` rows are exactly the shape `pickPrimaryVendor` consumes;
 * `categories` / `audiences` / `phases` pull every linked term's name (the
 * record is multi-valued, unlike the API list shape's single primary category).
 */
export const algoliaProductSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  logoUrl: true,
  hasApiDocs: true,
  integrationCount: true,
  reviewCount: true,
  ratingOverallAvg: true,
  productVendors: {
    select: {
      isPrimary: true,
      vendor: { select: vendorLinkSelect },
    },
    orderBy: { isPrimary: 'desc' as const },
  },
  productCategories: { select: { category: { select: taxonomyNameSelect } } },
  productAudiences: { select: { audience: { select: taxonomyNameSelect } } },
  productPhases: { select: { phase: { select: taxonomyNameSelect } } },
} as const satisfies Prisma.ProductSelect;

/** Fields for `AlgoliaVendorRecord` — `vendorListSelect` already carries the
 *  `_count` aggregation for `product_count` / `integration_count`; add the
 *  editorial `description`. */
export const algoliaVendorSelect = {
  ...vendorListSelect,
  description: true,
} as const satisfies Prisma.VendorSelect;

/** Fields for `AlgoliaIntegrationRecord` — `integrationListSelect` carries the
 *  source/target `ProductLink`s + mechanism/direction; add `description`. */
export const algoliaIntegrationSelect = {
  ...integrationListSelect,
  description: true,
} as const satisfies Prisma.IntegrationSelect;

// ---------------------------------------------------------------------------
// Row shape types
// ---------------------------------------------------------------------------

export type RawAlgoliaProductRow = Prisma.ProductGetPayload<{
  select: typeof algoliaProductSelect;
}>;
export type RawAlgoliaVendorRow = Prisma.VendorGetPayload<{
  select: typeof algoliaVendorSelect;
}>;
export type RawAlgoliaIntegrationRow = Prisma.IntegrationGetPayload<{
  select: typeof algoliaIntegrationSelect;
}>;

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function toAlgoliaProduct(row: RawAlgoliaProductRow): AlgoliaProductRecord {
  const vendor = pickPrimaryVendor(row.productVendors);
  return {
    objectID: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    vendor_name: vendor?.name ?? null,
    vendor_slug: vendor?.slug ?? null,
    categories: row.productCategories.map((r) => r.category.name),
    audiences: row.productAudiences.map((r) => r.audience.name),
    phases: row.productPhases.map((r) => r.phase.name),
    integration_count: row.integrationCount,
    review_count: row.reviewCount,
    rating_overall_avg: toNumberOrNull(row.ratingOverallAvg),
    has_api_docs: row.hasApiDocs,
    logo_url: row.logoUrl,
  };
}

export function toAlgoliaVendor(row: RawAlgoliaVendorRow): AlgoliaVendorRecord {
  return {
    objectID: row.id,
    company_name: row.companyName,
    slug: row.slug,
    description: row.description,
    headquarters: row.headquarters,
    founded_year: row.foundedYear,
    product_count: row._count.productVendors,
    integration_count: row._count.builtIntegrations,
    logo_url: row.logoUrl,
  };
}

export function toAlgoliaIntegration(row: RawAlgoliaIntegrationRow): AlgoliaIntegrationRecord {
  const mechanism_kind = toMechanismKind(row.mechanismKind, row.id);
  return {
    objectID: row.id,
    source_product_name: row.sourceProduct.name,
    source_product_slug: row.sourceProduct.slug,
    target_product_name: row.targetProduct.name,
    target_product_slug: row.targetProduct.slug,
    mechanism_kind,
    mechanism_name: row.mechanismName,
    direction: coerceDirection(row.direction),
    description: row.description,
    mechanism_rank: mechanismRank(mechanism_kind),
  };
}

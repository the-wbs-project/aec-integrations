/**
 * Drizzle-row → Algolia-record transforms (AECI-137 / Phase 3.2) — Drizzle/D1
 * (ADR 0016 / AECI-253).
 *
 * The denormalizing mappers that turn a Drizzle row into the flat, zero-join
 * Algolia record shapes from `@aeci/shared/algolia-records` (spec §7.1). The
 * single transform the sync pipeline (incremental Worker + promote hook) shares —
 * keep the `*Config` shapes and the mappers here in lockstep.
 *
 * Pattern mirrors `drizzle-helpers.ts`: a `*Config` object spread into
 * `db.query.<table>.findMany({ ...config, where })`, a `Raw*Row` interface the
 * `findMany` result is structurally checked against, and a `to*` mapper. Two old
 * Prisma conversions are gone under D1: `real` columns are already `number` (no
 * `Decimal`), and the vendor counts come from correlated-subquery `extras` (no
 * Prisma `_count`). The fail-loud out-of-enum `mechanism_kind` behaviour and the
 * `pickPrimaryVendor` selection are reused from `drizzle-helpers.ts`.
 *
 * The mappers return typed records but do NOT `.parse()` them — callers validate
 * against the Zod schema where it matters (the unit test here; the sync pipeline
 * before upload).
 */

import { mechanismRank } from '@aeci/shared/algolia';
import {
  type AlgoliaIntegrationRecord,
  type AlgoliaProductRecord,
  type AlgoliaVendorRecord,
  flattenTradeAliases,
} from '@aeci/shared/algolia-records';
import { sql } from 'drizzle-orm';

import { coerceDirection, pickPrimaryVendor, toMechanismKind } from './drizzle-helpers';

// ---------------------------------------------------------------------------
// Leaf column sets
// ---------------------------------------------------------------------------

const vendorLinkColumns = { id: true, companyName: true, slug: true, logoUrl: true } as const;
const taxonomyNameColumns = { name: true } as const;
/** Trades need MORE than the name (AECI-545): `aliases` feeds the searchable-only
 *  `trade_aliases` record attribute, so `taxonomyNameColumns` is insufficient. */
const tradeRecordColumns = { name: true, aliases: true } as const;

// ---------------------------------------------------------------------------
// Query configs (spread into db.query.<table>.findMany)
// ---------------------------------------------------------------------------

/**
 * `AlgoliaProductRecord` hydration. `productVendors` carries `isPrimary` + the
 * vendor link so `pickPrimaryVendor` resolves the primary; categories/audiences/
 * phases/trades pull every linked term's NAME (the record is multi-valued), and
 * trades additionally pull `aliases` for the searchable-only `trade_aliases`
 * attribute (AECI-545). Includes the incremental-sync signals
 * (`promotionStatus`, `updatedAt`) that `buildFromStatusRows` + the watermark
 * window read.
 *
 * Freshness note for trades: the nightly window is keyed on `products.updated_at`,
 * and `product_trades` rows are written only by the promote flow (AECI-542),
 * which touches the product row — so a re-promote carries its trade tags into the
 * index on the next sync. A bulk backfill that writes the join table WITHOUT
 * bumping `products.updated_at` would be invisible to the incremental sync and
 * needs a forced full reindex (`apps/datatool/src/algolia-reindex.ts`).
 */
export const algoliaProductConfig = {
  columns: {
    id: true,
    slug: true,
    name: true,
    description: true,
    logoUrl: true,
    hasApiDocs: true,
    integrationCount: true,
    reviewCount: true,
    ratingOverallAvg: true,
    promotionStatus: true,
    updatedAt: true,
  },
  with: {
    productVendors: {
      columns: { isPrimary: true },
      with: { vendor: { columns: vendorLinkColumns } },
    },
    productCategories: { columns: {}, with: { category: { columns: taxonomyNameColumns } } },
    productAudiences: { columns: {}, with: { audience: { columns: taxonomyNameColumns } } },
    productPhases: { columns: {}, with: { phase: { columns: taxonomyNameColumns } } },
    productTrades: { columns: {}, with: { trade: { columns: tradeRecordColumns } } },
  },
} as const;

/**
 * `AlgoliaVendorRecord` hydration. `product_count` / `integration_count` come from
 * correlated-subquery `extras` (the `drizzle-helpers.ts` vendor-list pattern); the
 * outer column MUST be qualified by the root alias (`"vendors"."id"`) so a
 * subquery's own `id` can't shadow it. Includes `promotionStatus` for the
 * membership filter.
 */
export const algoliaVendorConfig = {
  columns: {
    id: true,
    slug: true,
    companyName: true,
    description: true,
    headquarters: true,
    foundedYear: true,
    logoUrl: true,
    promotionStatus: true,
    updatedAt: true,
  },
  extras: {
    productCount:
      sql<number>`(SELECT count(*) FROM product_vendors pv WHERE pv.vendor_id = "vendors"."id")`.as(
        'product_count',
      ),
    integrationCount:
      sql<number>`(SELECT count(*) FROM integrations bi WHERE bi.built_by_vendor_id = "vendors"."id")`.as(
        'integration_count',
      ),
  },
} as const;

/** `AlgoliaIntegrationRecord` hydration — source/target product links + mechanism/
 *  direction + description + `updatedAt` (the watermark window). */
export const algoliaIntegrationConfig = {
  columns: {
    id: true,
    mechanismKind: true,
    mechanismName: true,
    direction: true,
    description: true,
    updatedAt: true,
  },
  with: {
    sourceProduct: { columns: { name: true, slug: true } },
    targetProduct: { columns: { name: true, slug: true } },
  },
} as const;

// ---------------------------------------------------------------------------
// Raw row shapes (what the configs above return)
// ---------------------------------------------------------------------------

export interface RawAlgoliaProductRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  hasApiDocs: boolean;
  integrationCount: number;
  reviewCount: number;
  ratingOverallAvg: number | null;
  promotionStatus: string;
  updatedAt: string;
  productVendors: Array<{
    isPrimary: boolean;
    vendor: { id: string; companyName: string; slug: string; logoUrl: string | null };
  }>;
  productCategories: Array<{ category: { name: string } }>;
  productAudiences: Array<{ audience: { name: string } }>;
  productPhases: Array<{ phase: { name: string } }>;
  productTrades: Array<{ trade: { name: string; aliases: string[] | null } }>;
}

export interface RawAlgoliaVendorRow {
  id: string;
  slug: string;
  companyName: string;
  description: string | null;
  headquarters: string | null;
  foundedYear: number | null;
  logoUrl: string | null;
  promotionStatus: string;
  updatedAt: string;
  productCount: number;
  integrationCount: number;
}

export interface RawAlgoliaIntegrationRow {
  id: string;
  mechanismKind: string | null;
  mechanismName: string | null;
  direction: string | null;
  description: string | null;
  updatedAt: string;
  sourceProduct: { name: string; slug: string };
  targetProduct: { name: string; slug: string };
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function toAlgoliaProduct(row: RawAlgoliaProductRow): AlgoliaProductRecord {
  const vendor = pickPrimaryVendor(row.productVendors);
  const tradeNames = row.productTrades.map((r) => r.trade.name);
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
    trades: tradeNames,
    trade_aliases: flattenTradeAliases(
      tradeNames,
      row.productTrades.map((r) => r.trade.aliases),
    ),
    integration_count: row.integrationCount,
    review_count: row.reviewCount,
    rating_overall_avg: row.ratingOverallAvg,
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
    product_count: row.productCount,
    integration_count: row.integrationCount,
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

/**
 * Drizzle query configs + mappers for the READ paths (ADR 0016 / AECI-253).
 * The D1 successor to the read surface of `prisma-helpers.ts`:
 *
 *   1. **Query configs** — `productListConfig`, `vendorListConfig`, … objects
 *      spread into `db.query.<table>.findMany({ ...config, where, orderBy })`.
 *      `columns`/`with` mirror the old Prisma `select`; `_count` becomes an
 *      `extras` correlated-subquery so list rows carry their counts without
 *      over-fetching join rows.
 *
 *   2. **Mappers** — `toProductListItem`, … convert the Drizzle row to the public
 *      `@aeci/shared` wire shape. Two old conversions are now near-identity and
 *      gone: D1 `real` columns are already `number` (no Prisma `Decimal`), and
 *      `*_at` columns are already ISO-8601 `text` (no `Date`). The fail-loud
 *      coalescing rules (AECI-115) are preserved verbatim.
 *
 * Raw row shapes are explicit interfaces (not `GetPayload`): the `findMany`
 * result is structurally checked against them at each call site, so dropping a
 * needed column from a config breaks the build — the same lockstep the Prisma
 * `select` discipline gave us.
 *
 * Admin/account review + request mappers remain in `prisma-helpers.ts` until
 * their write routes migrate (AECI-253 is incremental).
 */

import { ProductUsefulnessSchema } from '@aeci/shared';
import type {
  IntegrationDetail,
  IntegrationListItem,
  IntegrationMechanismKind,
  ProductDetail,
  ProductLink,
  ProductListItem,
  ProductRole,
  ProductUsefulness,
  PublicReview,
  TaxonomyTermWithCount,
  VendorDetail,
  VendorLink,
  VendorListItem,
} from '@aeci/shared';
import { and, eq, inArray, like, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  productAudiences,
  productCategories,
  productPhases,
  products,
  productVendors,
} from '../db/schema';

// ---------------------------------------------------------------------------
// Leaf column sets (reused by several parents)
// ---------------------------------------------------------------------------

const vendorLinkColumns = { id: true, companyName: true, slug: true, logoUrl: true } as const;
const productLinkColumns = { id: true, name: true, slug: true, logoUrl: true } as const;
const taxonomyLinkColumns = { id: true, name: true, slug: true } as const;
const taxonomyLinkWithOrderColumns = { ...taxonomyLinkColumns, displayOrder: true } as const;

// ---------------------------------------------------------------------------
// Query configs (spread into db.query.<table>.findMany / findFirst)
// ---------------------------------------------------------------------------

/** `IntegrationListItem` hydration — source + target as `ProductLink`. */
export const integrationListConfig = {
  columns: {
    id: true,
    name: true,
    mechanismKind: true,
    mechanismName: true,
    direction: true,
    createdAt: true,
    updatedAt: true,
  },
  with: {
    sourceProduct: { columns: productLinkColumns },
    targetProduct: { columns: productLinkColumns },
  },
} as const;

/** Detail adds the heavier hydration per API_CONTRACTS §3.4. */
export const integrationDetailConfig = {
  columns: {
    ...integrationListConfig.columns,
    description: true,
    listingUrl: true,
    docsUrl: true,
    mechanismUrl: true,
    pricingModel: true,
    maturity: true,
  },
  with: {
    sourceProduct: { columns: productLinkColumns },
    targetProduct: { columns: productLinkColumns },
    builtByVendor: { columns: vendorLinkColumns },
    poweredByProduct: { columns: productLinkColumns },
  },
} as const;

/** `ProductListItem` hydration. `vendor` resolves from `productVendors` ordered
 *  `isPrimary desc`; `primary_category` from the category joins. */
export const productListConfig = {
  columns: {
    id: true,
    slug: true,
    name: true,
    logoUrl: true,
    productRole: true,
    integrationCount: true,
    reviewCount: true,
    ratingOverallAvg: true,
    ratingOnboardingAvg: true,
    createdAt: true,
    updatedAt: true,
  },
  with: {
    // No `columns` restriction on the junctions: Drizzle's relational query needs
    // the FK columns to resolve the nested `with`, and the mappers ignore the
    // extra scalar fields. No orderBy — `pickPrimaryVendor` resolves the primary
    // via `find(isPrimary) ?? rows[0]`, so it is order-independent.
    productVendors: {
      with: { vendor: { columns: vendorLinkColumns } },
    },
    productCategories: {
      with: { category: { columns: taxonomyLinkWithOrderColumns } },
    },
  },
} as const;

/** Detail adds editorial fields, taxonomy joins, both integration sides. */
export const productDetailConfig = {
  columns: {
    ...productListConfig.columns,
    description: true,
    website: true,
    toolIntegrationsUrl: true,
    apiDocsUrl: true,
    hasApiDocs: true,
    usefulness: true,
  },
  with: {
    productVendors: {
      columns: { isPrimary: true },
      with: { vendor: { columns: vendorLinkColumns } },
    },
    productCategories: {
      columns: {},
      with: { category: { columns: taxonomyLinkWithOrderColumns } },
    },
    productAudiences: { columns: {}, with: { audience: { columns: taxonomyLinkColumns } } },
    productPhases: { columns: {}, with: { phase: { columns: taxonomyLinkColumns } } },
    sourceIntegrations: integrationListConfig,
    targetIntegrations: integrationListConfig,
  },
} as const;

/** Public-review display fields (`PublicReview`, §5.4). Omits all PII/moderation
 *  columns; always paired with a `status = 'approved'` filter by the caller. */
export const publicReviewColumns = {
  id: true,
  ratingOverall: true,
  ratingOnboarding: true,
  title: true,
  body: true,
  roleAtCompany: true,
  yearsUsing: true,
  wouldRecommend: true,
  verifiedWorkEmail: true,
  createdAt: true,
} as const;

/** First-page size for the approved-reviews list + the `ProductDetail` embed. */
export const EMBED_REVIEWS_PAGE_SIZE = 24;

/** `VendorListItem` — counts via correlated-subquery `extras`. */
export const vendorListConfig = {
  columns: {
    id: true,
    slug: true,
    companyName: true,
    logoUrl: true,
    verified: true,
    headquarters: true,
    foundedYear: true,
    createdAt: true,
    updatedAt: true,
  },
  // The correlated outer column MUST be table-qualified (`"vendors"."id"`).
  // Drizzle renders `${vendors.id}` as bare `"id"`, which a subquery's own table
  // shadows when it also has an `id` column (e.g. `integrations`) — silently
  // returning 0. The root table's alias is its own name in both the relational
  // (`db.query`) and core (`db.select`) builders, so the literal is stable.
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

/** Vendor detail adds editorial + social fields and the vendor's products. */
export const vendorDetailConfig = {
  columns: {
    ...vendorListConfig.columns,
    description: true,
    website: true,
    linkedinUrl: true,
    xUrl: true,
    facebookUrl: true,
    instagramUrl: true,
    youtubeUrl: true,
    githubOrg: true,
  },
  extras: vendorListConfig.extras,
  with: {
    productVendors: {
      columns: { isPrimary: true },
      with: { product: productListConfig },
    },
  },
} as const;

/** Per-model taxonomy term config; `_count` → an `extras` subquery on the model's
 *  own join table. */
// `_count` → an `extras` subquery on the model's own join table. The outer
// column is table-qualified (see the vendor extras note); these join tables have
// no `id` column so bare would also work, but qualifying keeps the pattern uniform.
export const categoryTermConfig = {
  columns: { id: true, slug: true, name: true, description: true, displayOrder: true },
  extras: {
    productCount:
      sql<number>`(SELECT count(*) FROM product_categories pc WHERE pc.category_id = "taxonomy_categories"."id")`.as(
        'product_count',
      ),
  },
} as const;
export const audienceTermConfig = {
  columns: { id: true, slug: true, name: true, description: true, displayOrder: true },
  extras: {
    productCount:
      sql<number>`(SELECT count(*) FROM product_audiences pa WHERE pa.audience_id = "taxonomy_audiences"."id")`.as(
        'product_count',
      ),
  },
} as const;
export const phaseTermConfig = {
  columns: { id: true, slug: true, name: true, description: true, displayOrder: true },
  extras: {
    productCount:
      sql<number>`(SELECT count(*) FROM product_phases pp WHERE pp.phase_id = "taxonomy_phases"."id")`.as(
        'product_count',
      ),
  },
} as const;

// ---------------------------------------------------------------------------
// Raw row shapes (what the configs above return)
// ---------------------------------------------------------------------------

interface RawVendorLink {
  id: string;
  companyName: string;
  slug: string;
  logoUrl: string | null;
}
interface RawProductLink {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}
interface RawTaxonomyLink {
  id: string;
  name: string;
  slug: string;
}
interface RawTaxonomyLinkWithOrder extends RawTaxonomyLink {
  displayOrder: number | null;
}

export interface RawIntegrationListRow {
  id: string;
  name: string | null;
  mechanismKind: string | null;
  mechanismName: string | null;
  direction: string | null;
  createdAt: string;
  updatedAt: string;
  sourceProduct: RawProductLink;
  targetProduct: RawProductLink;
}
export interface RawIntegrationDetailRow extends RawIntegrationListRow {
  description: string | null;
  listingUrl: string | null;
  docsUrl: string | null;
  mechanismUrl: string | null;
  pricingModel: string | null;
  maturity: string | null;
  builtByVendor: RawVendorLink | null;
  poweredByProduct: RawProductLink | null;
}

export interface RawProductListRow {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  productRole: string;
  integrationCount: number;
  reviewCount: number;
  ratingOverallAvg: number | null;
  ratingOnboardingAvg: number | null;
  createdAt: string;
  updatedAt: string;
  productVendors: Array<{ isPrimary: boolean; vendor: RawVendorLink }>;
  productCategories: Array<{ category: RawTaxonomyLinkWithOrder }>;
}
export interface RawProductDetailRow extends RawProductListRow {
  description: string | null;
  website: string | null;
  toolIntegrationsUrl: string | null;
  apiDocsUrl: string | null;
  hasApiDocs: boolean;
  usefulness: unknown;
  productAudiences: Array<{ audience: RawTaxonomyLink }>;
  productPhases: Array<{ phase: RawTaxonomyLink }>;
  sourceIntegrations: RawIntegrationListRow[];
  targetIntegrations: RawIntegrationListRow[];
}

export interface RawPublicReviewRow {
  id: string;
  ratingOverall: number;
  ratingOnboarding: number;
  title: string;
  body: string;
  roleAtCompany: string | null;
  yearsUsing: number | null;
  wouldRecommend: string | null;
  verifiedWorkEmail: boolean;
  createdAt: string;
}

export interface RawVendorListRow {
  id: string;
  slug: string;
  companyName: string;
  logoUrl: string | null;
  verified: boolean;
  headquarters: string | null;
  foundedYear: number | null;
  createdAt: string;
  updatedAt: string;
  productCount: number;
  integrationCount: number;
}
export interface RawVendorDetailRow extends RawVendorListRow {
  description: string | null;
  website: string | null;
  linkedinUrl: string | null;
  xUrl: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  youtubeUrl: string | null;
  githubOrg: string | null;
  productVendors: Array<{ isPrimary: boolean; product: RawProductListRow }>;
}

export interface RawTaxonomyTermRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  displayOrder: number | null;
  productCount: number;
}

// ---------------------------------------------------------------------------
// Coalescing / conversion helpers (AECI-115 fail-loud preserved)
// ---------------------------------------------------------------------------

const VALID_MECHANISM_KINDS = new Set<IntegrationMechanismKind>([
  'native',
  'iPaaS',
  'marketplace-app',
  'api',
  'webhook',
  'partner',
]);

export function toMechanismKind(
  raw: string | null,
  integrationId: string,
): IntegrationMechanismKind | null {
  if (raw === null) return null;
  if ((VALID_MECHANISM_KINDS as Set<string>).has(raw)) return raw as IntegrationMechanismKind;
  throw new Error(
    `Data integrity: integration ${integrationId} has unknown mechanism_kind "${raw}"`,
  );
}

export function coerceDirection(raw: string | null): 'one-way' | 'bidirectional' | null {
  if (raw === 'one-way' || raw === 'bidirectional') return raw;
  return null;
}

function toProductRole(raw: string, productId: string): ProductRole {
  if (raw === 'application' || raw === 'connector' || raw === 'hybrid') return raw;
  throw new Error(`Data integrity: product ${productId} has unknown product_role "${raw}"`);
}

function toProductLink(raw: RawProductLink): ProductLink {
  return { id: raw.id, name: raw.name, slug: raw.slug, logo_url: raw.logoUrl };
}
function toVendorLink(raw: RawVendorLink): VendorLink {
  return { id: raw.id, name: raw.companyName, slug: raw.slug, logo_url: raw.logoUrl };
}
function synthesizeIntegrationName(
  rawName: string | null,
  source: RawProductLink,
  target: RawProductLink,
): string {
  if (rawName && rawName.length > 0) return rawName;
  return `${source.name} → ${target.name}`;
}

export function toUsefulness(raw: unknown): ProductUsefulness | null {
  if (raw == null) return null;
  const parsed = ProductUsefulnessSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function toIntegrationListItem(raw: RawIntegrationListRow): IntegrationListItem {
  return {
    id: raw.id,
    name: synthesizeIntegrationName(raw.name, raw.sourceProduct, raw.targetProduct),
    mechanism_kind: toMechanismKind(raw.mechanismKind, raw.id),
    mechanism_name: raw.mechanismName,
    direction: coerceDirection(raw.direction),
    source: toProductLink(raw.sourceProduct),
    target: toProductLink(raw.targetProduct),
    created_at: raw.createdAt,
    updated_at: raw.updatedAt,
  };
}

export function toIntegrationDetail(raw: RawIntegrationDetailRow): IntegrationDetail {
  return {
    ...toIntegrationListItem(raw),
    description: raw.description,
    listing_url: raw.listingUrl,
    docs_url: raw.docsUrl,
    mechanism_url: raw.mechanismUrl,
    built_by_vendor: raw.builtByVendor ? toVendorLink(raw.builtByVendor) : null,
    powered_by_product: raw.poweredByProduct ? toProductLink(raw.poweredByProduct) : null,
    pricing_model: raw.pricingModel,
    maturity: raw.maturity,
  };
}

function pickPrimaryCategory(
  rows: Array<{ category: RawTaxonomyLinkWithOrder }>,
): { id: string; name: string; slug: string } | null {
  if (rows.length === 0) return null;
  let best = rows[0]!.category;
  for (let i = 1; i < rows.length; i++) {
    const candidate = rows[i]!.category;
    const candidateOrder = candidate.displayOrder ?? Number.POSITIVE_INFINITY;
    const bestOrder = best.displayOrder ?? Number.POSITIVE_INFINITY;
    if (
      candidateOrder < bestOrder ||
      (candidateOrder === bestOrder && candidate.name.localeCompare(best.name) < 0)
    ) {
      best = candidate;
    }
  }
  return { id: best.id, name: best.name, slug: best.slug };
}

export function pickPrimaryVendor(
  rows: Array<{ isPrimary: boolean; vendor: RawVendorLink }>,
): VendorLink | null {
  if (rows.length === 0) return null;
  const primary = rows.find((r) => r.isPrimary) ?? rows[0]!;
  return toVendorLink(primary.vendor);
}

export function toProductListItem(raw: RawProductListRow): ProductListItem {
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    logo_url: raw.logoUrl,
    product_role: toProductRole(raw.productRole, raw.id),
    vendor: pickPrimaryVendor(raw.productVendors),
    primary_category: pickPrimaryCategory(raw.productCategories),
    integration_count: raw.integrationCount,
    review_count: raw.reviewCount,
    rating_overall_avg: raw.ratingOverallAvg,
    rating_onboarding_avg: raw.ratingOnboardingAvg,
    created_at: raw.createdAt,
    updated_at: raw.updatedAt,
  };
}

const VALID_WOULD_RECOMMEND = new Set<PublicReview['would_recommend']>(['yes', 'no', 'maybe']);

export function toPublicReview(raw: RawPublicReviewRow): PublicReview {
  const wouldRecommend = raw.wouldRecommend as PublicReview['would_recommend'] | null;
  return {
    id: raw.id,
    rating_overall: raw.ratingOverall,
    rating_onboarding: raw.ratingOnboarding,
    title: raw.title,
    body: raw.body,
    role_at_company: raw.roleAtCompany,
    years_using: raw.yearsUsing,
    would_recommend: VALID_WOULD_RECOMMEND.has(wouldRecommend) ? wouldRecommend : null,
    verified_work_email: raw.verifiedWorkEmail,
    created_at: raw.createdAt,
  };
}

export function toProductDetail(
  raw: RawProductDetailRow,
  relatedProducts: RawProductListRow[],
  reviews: RawPublicReviewRow[] = [],
): ProductDetail {
  const base = toProductListItem(raw);
  // ≥5 gate (§5.5): averages withheld until ≥5 approved reviews.
  const ratingsVisible = base.review_count >= 5;
  return {
    ...base,
    rating_overall_avg: ratingsVisible ? base.rating_overall_avg : null,
    rating_onboarding_avg: ratingsVisible ? base.rating_onboarding_avg : null,
    description: raw.description,
    website: raw.website,
    tool_integrations_url: raw.toolIntegrationsUrl,
    api_docs_url: raw.apiDocsUrl,
    has_api_docs: raw.hasApiDocs,
    categories: raw.productCategories.map((r) => ({
      id: r.category.id,
      name: r.category.name,
      slug: r.category.slug,
    })),
    audiences: raw.productAudiences.map((r) => r.audience),
    phases: raw.productPhases.map((r) => r.phase),
    usefulness: toUsefulness(raw.usefulness),
    integrations_as_source: raw.sourceIntegrations.map(toIntegrationListItem),
    integrations_as_target: raw.targetIntegrations.map(toIntegrationListItem),
    related_products: relatedProducts.map(toProductListItem),
    reviews: reviews.map(toPublicReview),
  };
}

export function toVendorListItem(raw: RawVendorListRow): VendorListItem {
  return {
    id: raw.id,
    slug: raw.slug,
    company_name: raw.companyName,
    logo_url: raw.logoUrl,
    verified: raw.verified,
    headquarters: raw.headquarters,
    founded_year: raw.foundedYear,
    product_count: raw.productCount,
    integration_count: raw.integrationCount,
    review_count: 0, // No vendor review aggregate in Stage 1 (placeholder per schema).
    created_at: raw.createdAt,
    updated_at: raw.updatedAt,
  };
}

export function toVendorDetail(raw: RawVendorDetailRow): VendorDetail {
  return {
    ...toVendorListItem(raw),
    description: raw.description,
    website: raw.website,
    linkedin_url: raw.linkedinUrl,
    x_url: raw.xUrl,
    facebook_url: raw.facebookUrl,
    instagram_url: raw.instagramUrl,
    youtube_url: raw.youtubeUrl,
    github_url: raw.githubOrg ? `https://github.com/${encodeURIComponent(raw.githubOrg)}` : null,
    products: raw.productVendors.map((r) => toProductListItem(r.product)),
  };
}

export function toTaxonomyTermWithCount(raw: RawTaxonomyTermRow): TaxonomyTermWithCount {
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    description: raw.description,
    display_order: raw.displayOrder ?? 0,
    product_count: raw.productCount,
  };
}

// ---------------------------------------------------------------------------
// Product `where` builder (shared by the list + facets endpoints)
// ---------------------------------------------------------------------------

export type ProductFacetDimension = 'category' | 'audience' | 'phase';

export type ProductFilterParams = {
  search?: string;
  category_id?: string[];
  audience_id?: string[];
  phase_id?: string[];
  vendor_id?: string;
  product_role?: string;
  has_api_docs?: boolean;
};

/**
 * Build the Drizzle `where` (a single `SQL` or undefined) for the products list.
 * Taxonomy multi-select matches OR-within-dimension via an `id IN (subquery)`
 * over the join table (AECI-223); dimensions AND across. `excludeDimension`
 * powers disjunctive faceting. `db` is needed to build the correlated subqueries.
 */
export function buildProductsWhere(
  db: Db,
  query: ProductFilterParams,
  excludeDimension?: ProductFacetDimension,
): SQL | undefined {
  const clauses: SQL[] = [];
  if (query.search) clauses.push(like(products.name, `%${query.search}%`));
  if (query.category_id?.length && excludeDimension !== 'category') {
    clauses.push(
      inArray(
        products.id,
        db
          .select({ id: productCategories.productId })
          .from(productCategories)
          .where(inArray(productCategories.categoryId, query.category_id)),
      ),
    );
  }
  if (query.audience_id?.length && excludeDimension !== 'audience') {
    clauses.push(
      inArray(
        products.id,
        db
          .select({ id: productAudiences.productId })
          .from(productAudiences)
          .where(inArray(productAudiences.audienceId, query.audience_id)),
      ),
    );
  }
  if (query.phase_id?.length && excludeDimension !== 'phase') {
    clauses.push(
      inArray(
        products.id,
        db
          .select({ id: productPhases.productId })
          .from(productPhases)
          .where(inArray(productPhases.phaseId, query.phase_id)),
      ),
    );
  }
  if (query.vendor_id) {
    clauses.push(
      inArray(
        products.id,
        db
          .select({ id: productVendors.productId })
          .from(productVendors)
          .where(eq(productVendors.vendorId, query.vendor_id)),
      ),
    );
  }
  if (query.product_role) clauses.push(eq(products.productRole, query.product_role));
  if (query.has_api_docs !== undefined) clauses.push(eq(products.hasApiDocs, query.has_api_docs));

  // `like` on SQLite is case-insensitive for ASCII by default — matches the old
  // Prisma `mode: 'insensitive'` intent for the product-name search.
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : and(...clauses);
}

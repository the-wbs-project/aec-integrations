/**
 * Phase 2.8 (AECI-54) Prisma select shapes and mappers.
 *
 * Two responsibilities live here:
 *
 *   1. **Select shapes** — `productListSelect`, `vendorListSelect`,
 *      `integrationListSelect`, and their `detail` variants. Co-locating these
 *      with the mappers keeps the "what we fetch" and "how we shape it" tied
 *      together and ensures every detail response hydrates per the
 *      `docs/API_CONTRACTS.md` §3.4 table (no chain-fetching).
 *
 *   2. **Mappers** — `toProductListItem`, `toProductDetail`, etc. Convert the
 *      Prisma row (with `Decimal`, `Date`, nullable columns the public schema
 *      requires to be non-null) into the public `*ListItem` / `*Detail` shape
 *      from `@aeci/shared`. Server-side coalescing rules for the three known
 *      DB↔Zod nullability gaps land here:
 *
 *        - `Integration.name` null → `"${source.name} → ${target.name}"`
 *        - `Integration.mechanismKind` null → `'native'`
 *        - `Taxonomy*.displayOrder` null → `0`
 *
 * The `vendor` field on a `ProductListItem` resolves to the row's *primary*
 * vendor (`ProductVendor.isPrimary = true`). If no row is flagged primary, we
 * fall back to the first vendor link — the alternative (returning a sentinel
 * or filtering the row) would violate the schema and break the SSR client.
 */

import type {
  IntegrationDetail,
  IntegrationListItem,
  IntegrationMechanismKind,
  ProductDetail,
  ProductLink,
  ProductListItem,
  ProductRole,
  TaxonomyTermWithCount,
  VendorDetail,
  VendorLink,
  VendorListItem,
} from '@aeci/shared';

// ---------------------------------------------------------------------------
// Select shapes
// ---------------------------------------------------------------------------

/** Lean vendor display fields (`VendorLink`). */
const vendorLinkSelect = {
  id: true,
  companyName: true,
  slug: true,
  logoUrl: true,
} as const;

/** Lean product display fields (`ProductLink`). */
const productLinkSelect = {
  id: true,
  name: true,
  slug: true,
  logoUrl: true,
} as const;

/** Lean taxonomy term display fields (`LinkRef`). */
const taxonomyLinkSelect = {
  id: true,
  name: true,
  slug: true,
} as const;

/**
 * Variant of `taxonomyLinkSelect` for places that need to resolve a "primary"
 * taxonomy term from a list of joins — adds `displayOrder` so the mapper can
 * pick the lowest-display-order term (with a name tiebreak when display order
 * is null or tied).
 */
const taxonomyLinkWithOrderSelect = {
  ...taxonomyLinkSelect,
  displayOrder: true,
} as const;

/** Fields needed for `IntegrationListItem`. Source + target hydrate as `ProductLink`. */
export const integrationListSelect = {
  id: true,
  name: true,
  mechanismKind: true,
  mechanismName: true,
  direction: true,
  sourceProduct: { select: productLinkSelect },
  targetProduct: { select: productLinkSelect },
  createdAt: true,
  updatedAt: true,
} as const;

/** Detail variant adds the heavier hydration per `API_CONTRACTS.md` §3.4. */
export const integrationDetailSelect = {
  ...integrationListSelect,
  description: true,
  listingUrl: true,
  docsUrl: true,
  mechanismUrl: true,
  pricingModel: true,
  maturity: true,
  builtByVendor: { select: vendorLinkSelect },
  poweredByProduct: { select: productLinkSelect },
} as const;

/**
 * Fields needed for `ProductListItem`. The `vendor` field is hydrated by
 * fetching all `ProductVendor` rows with the vendor display columns and
 * ordering by `isPrimary desc` — the mapper picks index 0. The
 * `primary_category` field is resolved the same way: pull every linked
 * category with its `displayOrder`, then `pickPrimaryCategory()` returns the
 * one with the lowest order (name tiebreak).
 */
export const productListSelect = {
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
  productVendors: {
    select: {
      isPrimary: true,
      vendor: { select: vendorLinkSelect },
    },
    orderBy: { isPrimary: 'desc' as const },
  },
  productCategories: {
    select: {
      category: { select: taxonomyLinkWithOrderSelect },
    },
  },
} as const;

/**
 * Detail variant. Adds taxonomy join rows (mapped to `LinkRef[]`), both sides
 * of the integration graph as `IntegrationListItem[]`, and a related-products
 * roll-up. `related_products` ships a baseline implementation (same primary
 * category, exclude self, latest 6) — refining the algorithm is out of scope
 * for AECI-54, see comment on `selectRelatedProducts`. `productCategories`
 * inherits the order-aware shape from the spread; the detail mapper drops the
 * `displayOrder` field when shaping the `categories: LinkRef[]` array.
 */
export const productDetailSelect = {
  ...productListSelect,
  description: true,
  website: true,
  toolIntegrationsUrl: true,
  apiDocsUrl: true,
  hasApiDocs: true,
  productDisciplines: { select: { discipline: { select: taxonomyLinkSelect } } },
  productPhases: { select: { phase: { select: taxonomyLinkSelect } } },
  sourceIntegrations: { select: integrationListSelect },
  targetIntegrations: { select: integrationListSelect },
} as const;

/** Fields needed for `VendorListItem`. Counts come from join tables/aggregations
 *  (denormalized columns on `vendors` are not present in this PR's schema).
 *  The mapper computes counts from the `_count` Prisma helper. */
export const vendorListSelect = {
  id: true,
  slug: true,
  companyName: true,
  logoUrl: true,
  verified: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      productVendors: true,
      builtIntegrations: true,
    },
  },
} as const;

/** Detail variant — adds the descriptive editorial fields and the vendor's
 *  products as `ProductListItem[]`. */
export const vendorDetailSelect = {
  ...vendorListSelect,
  description: true,
  website: true,
  headquarters: true,
  foundedYear: true,
  productVendors: {
    select: {
      product: { select: productListSelect },
    },
    orderBy: { isPrimary: 'desc' as const },
  },
} as const;

/** Detail selection for a taxonomy term (category/discipline/phase). The
 *  `_count` arg differs per model and is supplied by the caller. */
export const taxonomyDetailScalarSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  displayOrder: true,
} as const;

// ---------------------------------------------------------------------------
// Row shape types (what Prisma actually returns for the selects above)
// ---------------------------------------------------------------------------

type DecimalLike = { toNumber(): number } | number | null | undefined;

type RawProductVendor = {
  isPrimary: boolean;
  vendor: {
    id: string;
    companyName: string;
    slug: string;
    logoUrl: string | null;
  };
};

export type RawProductListRow = {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  productRole: string;
  integrationCount: number;
  reviewCount: number;
  ratingOverallAvg: DecimalLike;
  ratingOnboardingAvg: DecimalLike;
  createdAt: Date | string;
  updatedAt: Date | string;
  productVendors: RawProductVendor[];
  productCategories: Array<{ category: RawTaxonomyLinkWithOrder }>;
};

export type RawProductDetailRow = RawProductListRow & {
  description: string | null;
  website: string | null;
  toolIntegrationsUrl: string | null;
  apiDocsUrl: string | null;
  hasApiDocs: boolean;
  productDisciplines: Array<{ discipline: RawTaxonomyLink }>;
  productPhases: Array<{ phase: RawTaxonomyLink }>;
  sourceIntegrations: RawIntegrationListRow[];
  targetIntegrations: RawIntegrationListRow[];
};

type RawTaxonomyLink = { id: string; name: string; slug: string };
type RawTaxonomyLinkWithOrder = RawTaxonomyLink & { displayOrder: number | null };

type RawProductLink = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
};

type RawVendorLink = {
  id: string;
  companyName: string;
  slug: string;
  logoUrl: string | null;
};

export type RawIntegrationListRow = {
  id: string;
  name: string | null;
  mechanismKind: string | null;
  mechanismName: string | null;
  direction: string | null;
  sourceProduct: RawProductLink;
  targetProduct: RawProductLink;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type RawIntegrationDetailRow = RawIntegrationListRow & {
  description: string | null;
  listingUrl: string | null;
  docsUrl: string | null;
  mechanismUrl: string | null;
  pricingModel: string | null;
  maturity: string | null;
  builtByVendor: RawVendorLink | null;
  poweredByProduct: RawProductLink | null;
};

export type RawVendorListRow = {
  id: string;
  slug: string;
  companyName: string;
  logoUrl: string | null;
  verified: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
  _count: { productVendors: number; builtIntegrations: number };
};

export type RawVendorDetailRow = RawVendorListRow & {
  description: string | null;
  website: string | null;
  headquarters: string | null;
  foundedYear: number | null;
  productVendors: Array<{ product: RawProductListRow }>;
};

export type RawTaxonomyTermRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  displayOrder: number | null;
  _count: { productCategories?: number; productDisciplines?: number; productPhases?: number };
};

export type RawTaxonomyDetailRow = RawTaxonomyTermRow & {
  productCategories?: Array<{ product: RawProductListRow }>;
  productDisciplines?: Array<{ product: RawProductListRow }>;
  productPhases?: Array<{ product: RawProductListRow }>;
};

// ---------------------------------------------------------------------------
// Coalescing / conversion helpers
// ---------------------------------------------------------------------------

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toNumberOrNull(value: DecimalLike): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  return value.toNumber();
}

const MECHANISM_KIND_FALLBACK: IntegrationMechanismKind = 'native';
const VALID_MECHANISM_KINDS = new Set<IntegrationMechanismKind>([
  'native',
  'iPaaS',
  'marketplace-app',
  'api',
  'webhook',
  'partner',
]);

function coerceMechanismKind(raw: string | null): IntegrationMechanismKind {
  if (raw && (VALID_MECHANISM_KINDS as Set<string>).has(raw)) {
    return raw as IntegrationMechanismKind;
  }
  return MECHANISM_KIND_FALLBACK;
}

function coerceDirection(raw: string | null): 'one-way' | 'bidirectional' | null {
  if (raw === 'one-way' || raw === 'bidirectional') return raw;
  return null;
}

function coerceProductRole(raw: string): ProductRole {
  if (raw === 'application' || raw === 'connector' || raw === 'hybrid') return raw;
  // Defensive: unknown DB value falls back to 'application' — schema mandates
  // a non-nullable enum here.
  return 'application';
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

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function toIntegrationListItem(raw: RawIntegrationListRow): IntegrationListItem {
  return {
    id: raw.id,
    name: synthesizeIntegrationName(raw.name, raw.sourceProduct, raw.targetProduct),
    mechanism_kind: coerceMechanismKind(raw.mechanismKind),
    mechanism_name: raw.mechanismName,
    direction: coerceDirection(raw.direction),
    source: toProductLink(raw.sourceProduct),
    target: toProductLink(raw.targetProduct),
    created_at: toIso(raw.createdAt),
    updated_at: toIso(raw.updatedAt),
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

/**
 * Resolves the "primary" linked category for a product. Strategy: lowest
 * `displayOrder` wins (most prominently surfaced in editorial taxonomy);
 * null `displayOrder` is treated as `Infinity` (least prominent); ties break
 * alphabetically by name for determinism.
 *
 * Returns `null` when the product has no category joins — the public schema
 * makes `primary_category` nullable specifically for this case.
 */
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

function pickPrimaryVendor(rows: RawProductVendor[]): VendorLink | null {
  if (rows.length === 0) return null;
  // `orderBy: { isPrimary: 'desc' }` puts the primary row first; fall back to
  // index 0 anyway so the mapper is independent of caller ordering.
  const primary = rows.find((r) => r.isPrimary) ?? rows[0];
  return toVendorLink(primary.vendor);
}

/**
 * Sentinel VendorLink used when a product has zero vendor links. The schema
 * requires a non-null `vendor` object; this preserves the contract while
 * making the data gap obvious in dashboards (the literal slug/id makes the
 * row searchable). In practice every Phase 2 seed product carries at least
 * one ProductVendor row, so this branch is defensive.
 */
const VENDOR_FALLBACK: VendorLink = {
  id: '00000000-0000-0000-0000-000000000000',
  name: 'Unknown vendor',
  slug: 'unknown',
  logo_url: null,
};

export function toProductListItem(raw: RawProductListRow): ProductListItem {
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    logo_url: raw.logoUrl,
    product_role: coerceProductRole(raw.productRole),
    vendor: pickPrimaryVendor(raw.productVendors) ?? VENDOR_FALLBACK,
    primary_category: pickPrimaryCategory(raw.productCategories),
    integration_count: raw.integrationCount,
    review_count: raw.reviewCount,
    rating_overall_avg: toNumberOrNull(raw.ratingOverallAvg),
    rating_onboarding_avg: toNumberOrNull(raw.ratingOnboardingAvg),
    created_at: toIso(raw.createdAt),
    updated_at: toIso(raw.updatedAt),
  };
}

export function toProductDetail(
  raw: RawProductDetailRow,
  relatedProducts: RawProductListRow[],
): ProductDetail {
  return {
    ...toProductListItem(raw),
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
    disciplines: raw.productDisciplines.map((r) => r.discipline),
    phases: raw.productPhases.map((r) => r.phase),
    integrations_as_source: raw.sourceIntegrations.map(toIntegrationListItem),
    integrations_as_target: raw.targetIntegrations.map(toIntegrationListItem),
    related_products: relatedProducts.map(toProductListItem),
  };
}

export function toVendorListItem(raw: RawVendorListRow): VendorListItem {
  return {
    id: raw.id,
    slug: raw.slug,
    company_name: raw.companyName,
    logo_url: raw.logoUrl,
    verified: raw.verified,
    product_count: raw._count.productVendors,
    integration_count: raw._count.builtIntegrations,
    review_count: 0, // No reviews join in Phase 2 vendor list shape; placeholder per schema until Phase 5 wires review aggregates.
    created_at: toIso(raw.createdAt),
    updated_at: toIso(raw.updatedAt),
  };
}

export function toVendorDetail(raw: RawVendorDetailRow): VendorDetail {
  return {
    ...toVendorListItem(raw),
    description: raw.description,
    website: raw.website,
    headquarters: raw.headquarters,
    founded_year: raw.foundedYear,
    products: raw.productVendors.map((r) => toProductListItem(r.product)),
  };
}

type TaxonomyCountKey = 'productCategories' | 'productDisciplines' | 'productPhases';

export function toTaxonomyTermWithCount(
  raw: RawTaxonomyTermRow,
  countKey: TaxonomyCountKey,
): TaxonomyTermWithCount {
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    description: raw.description,
    display_order: raw.displayOrder ?? 0,
    product_count: raw._count[countKey] ?? 0,
  };
}

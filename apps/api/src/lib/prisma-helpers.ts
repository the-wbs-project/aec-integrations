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
 *      Prisma row (with `Decimal`, `Date`, nullable columns) into the public
 *      `*ListItem` / `*Detail` shape from `@aeci/shared`. Server-side coalescing
 *      rules for the known DB↔Zod gaps land here:
 *
 *        - `Integration.name` null → `"${source.name} → ${target.name}"`
 *        - `Taxonomy*.displayOrder` null → `0`
 *
 * AECI-115 — fail-loud, not fail-silent. We no longer fabricate data to satisfy
 * a non-null contract. Legitimately-absent values surface as `null` (the public
 * schema now permits it) and the SSR layer renders an empty state:
 *
 *        - missing primary vendor → `vendor: null` (no `/vendors/unknown` sentinel)
 *        - `Integration.mechanismKind` null → `mechanism_kind: null` (passthrough)
 *
 * Genuinely-corrupt values — an out-of-enum `product_role` (the column is
 * `NOT NULL` + CHECK, so a hit means schema drift) or an out-of-enum *non-null*
 * `mechanism_kind` — `throw` a plain `Error`. The API error middleware forwards
 * non-`ApiError` throwables to Datadog (`errors.ts:125-140`), so the data gap is
 * surfaced loudly as a logged 500 instead of a silently-coerced value.
 *
 * The `vendor` field on a `ProductListItem` resolves to the row's *primary*
 * vendor (`ProductVendor.isPrimary = true`), falling back to the first vendor
 * link when none is flagged primary, or `null` when there are no links at all.
 */

import type { Prisma } from '@prisma/client/edge';

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

/** Lean vendor display fields (`VendorLink`). Exported so the Algolia product
 *  transform (`algolia-transforms.ts`, AECI-137) reuses the exact vendor select
 *  `pickPrimaryVendor` expects, keeping the two in lockstep. */
export const vendorLinkSelect = {
  id: true,
  companyName: true,
  slug: true,
  logoUrl: true,
} as const satisfies Prisma.VendorSelect;

/** Lean product display fields (`ProductLink`). */
const productLinkSelect = {
  id: true,
  name: true,
  slug: true,
  logoUrl: true,
} as const satisfies Prisma.ProductSelect;

/** Lean taxonomy term display fields (`LinkRef`). */
const taxonomyLinkSelect = {
  id: true,
  name: true,
  slug: true,
} as const satisfies Prisma.TaxonomyCategorySelect;

/**
 * Variant of `taxonomyLinkSelect` for places that need to resolve a "primary"
 * taxonomy term from a list of joins — adds `displayOrder` so the mapper can
 * pick the lowest-display-order term (with a name tiebreak when display order
 * is null or tied).
 */
const taxonomyLinkWithOrderSelect = {
  ...taxonomyLinkSelect,
  displayOrder: true,
} as const satisfies Prisma.TaxonomyCategorySelect;

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
} as const satisfies Prisma.IntegrationSelect;

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
} as const satisfies Prisma.IntegrationSelect;

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
} as const satisfies Prisma.ProductSelect;

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
  productAudiences: { select: { audience: { select: taxonomyLinkSelect } } },
  productPhases: { select: { phase: { select: taxonomyLinkSelect } } },
  sourceIntegrations: { select: integrationListSelect },
  targetIntegrations: { select: integrationListSelect },
} as const satisfies Prisma.ProductSelect;

/** Fields needed for `VendorListItem`. Counts come from join tables/aggregations
 *  (denormalized columns on `vendors` are not present in this PR's schema).
 *  The mapper computes counts from the `_count` Prisma helper.
 *  `headquarters` and `foundedYear` live on the list shape so `/vendors` index
 *  rows can show them without a follow-up fetch (AECI-59 acceptance criteria). */
export const vendorListSelect = {
  id: true,
  slug: true,
  companyName: true,
  logoUrl: true,
  verified: true,
  headquarters: true,
  foundedYear: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      productVendors: true,
      builtIntegrations: true,
    },
  },
} as const satisfies Prisma.VendorSelect;

/** Detail variant — adds the descriptive editorial fields and the vendor's
 *  products as `ProductListItem[]`. `headquarters` / `foundedYear` inherit
 *  from the list shape. */
export const vendorDetailSelect = {
  ...vendorListSelect,
  description: true,
  website: true,
  productVendors: {
    select: {
      product: { select: productListSelect },
    },
    orderBy: { isPrimary: 'desc' as const },
  },
} as const satisfies Prisma.VendorSelect;

/**
 * Per-model taxonomy *term* selects, used by the list endpoints
 * (`/api/categories`, `/api/taxonomy`). The scalar shape is shared across
 * category / audience / phase, but the `_count` relation differs per model —
 * so each model bakes its own `_count` into its own `as const` select. The
 * scalar fields are written out inline on each, rather than spread from a
 * shared const: spreading a shared scalar object into a scalar-plus-`_count`
 * select defeats Prisma's `select` narrowing (the query widens back to the full
 * model), so the small repetition is deliberate. Deriving the row types from
 * these via `*GetPayload` (below) keeps the list-route queries, the row types,
 * and the mapper in lockstep — drop a field here and the build breaks, not just
 * the dev-only Zod check — and lets the list handlers run cast-free.
 *
 * The *detail* endpoints go through the shared `createTaxonomyDetailHandler`
 * factory (`routes/taxonomy-detail.ts`, AECI-120), which builds its `select`
 * dynamically from a computed relation key — a shape that can't be expressed as
 * a per-model `as const` select. It spreads `taxonomyDetailScalarSelect` (below)
 * and decodes the row with a single `as RawTaxonomyDetailRow` cast: the same
 * loose-delegate exception AECI-114 left in place for `promote.ts`.
 */
export const categoryTermSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  displayOrder: true,
  _count: { select: { productCategories: true } },
} as const satisfies Prisma.TaxonomyCategorySelect;

export const audienceTermSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  displayOrder: true,
  _count: { select: { productAudiences: true } },
} as const satisfies Prisma.TaxonomyAudienceSelect;

export const phaseTermSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  displayOrder: true,
  _count: { select: { productPhases: true } },
} as const satisfies Prisma.TaxonomyPhaseSelect;

/**
 * Scalar-only taxonomy term select. Spread by the shared taxonomy *detail*
 * handler factory (`routes/taxonomy-detail.ts`, AECI-120), which appends a
 * dynamic `_count` + relation keyed off the resource. See the per-model term
 * select doc above for why the detail path can't use an `as const` select.
 */
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

export type RawProductListRow = Prisma.ProductGetPayload<{ select: typeof productListSelect }>;
export type RawProductDetailRow = Prisma.ProductGetPayload<{ select: typeof productDetailSelect }>;

// Nested helper-param types, derived by indexing into the parent payload so a
// nested-select change can never desync a separately-declared leaf type.
type RawProductVendor = RawProductListRow['productVendors'][number];
type RawTaxonomyLinkWithOrder = RawProductListRow['productCategories'][number]['category'];

// Leaf link types reused across several parents — derive from the leaf select
// const directly. Kept non-null; the parent payload supplies any `| null`.
type RawProductLink = Prisma.ProductGetPayload<{ select: typeof productLinkSelect }>;
type RawVendorLink = Prisma.VendorGetPayload<{ select: typeof vendorLinkSelect }>;

export type RawIntegrationListRow = Prisma.IntegrationGetPayload<{
  select: typeof integrationListSelect;
}>;
export type RawIntegrationDetailRow = Prisma.IntegrationGetPayload<{
  select: typeof integrationDetailSelect;
}>;

export type RawVendorListRow = Prisma.VendorGetPayload<{ select: typeof vendorListSelect }>;
export type RawVendorDetailRow = Prisma.VendorGetPayload<{ select: typeof vendorDetailSelect }>;

// Per-model term rows are inferred at the list-handler call sites straight from
// the `*TermSelect` consts above (cast-free). The detail factory's dynamic
// select can't be expressed per-model, so its row keeps the hand-written union
// shape below: `_count` keys are optional because the factory selects exactly
// one per call, and `toTaxonomyTermWithCount` accepts the union for all three.
export type RawTaxonomyTermRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  displayOrder: number | null;
  _count: { productCategories?: number; productAudiences?: number; productPhases?: number };
};

export type RawTaxonomyDetailRow = RawTaxonomyTermRow & {
  productCategories?: Array<{ product: RawProductListRow }>;
  productAudiences?: Array<{ product: RawProductListRow }>;
  productPhases?: Array<{ product: RawProductListRow }>;
};

// ---------------------------------------------------------------------------
// Coalescing / conversion helpers
// ---------------------------------------------------------------------------

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function toNumberOrNull(value: DecimalLike): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  return value.toNumber();
}

const VALID_MECHANISM_KINDS = new Set<IntegrationMechanismKind>([
  'native',
  'iPaaS',
  'marketplace-app',
  'api',
  'webhook',
  'partner',
]);

/**
 * `mechanism_kind` is a nullable column (AECI-115). `null` passes through as
 * `null` (the public schema permits it; the UI renders an empty state). A
 * *non-null* value outside the enum is a data-integrity violation — the DB CHECK
 * should make it unreachable — so we throw rather than silently coercing to
 * `'native'`. The throw is a plain `Error`, which the API error middleware
 * forwards to Datadog as a logged 500.
 */
export function toMechanismKind(
  raw: string | null,
  integrationId: string,
): IntegrationMechanismKind | null {
  if (raw === null) return null;
  if ((VALID_MECHANISM_KINDS as Set<string>).has(raw)) {
    return raw as IntegrationMechanismKind;
  }
  throw new Error(
    `Data integrity: integration ${integrationId} has unknown mechanism_kind "${raw}"`,
  );
}

export function coerceDirection(raw: string | null): 'one-way' | 'bidirectional' | null {
  if (raw === 'one-way' || raw === 'bidirectional') return raw;
  return null;
}

/**
 * `product_role` is `NOT NULL DEFAULT 'application'` + CHECK, so an out-of-enum
 * value can only mean schema drift / corruption (AECI-115). Fail loud — throw a
 * plain `Error` (surfaced to Datadog as a logged 500) instead of silently
 * coercing to `'application'`.
 */
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

/**
 * Resolves a product's primary vendor, or `null` when the product carries no
 * `ProductVendor` rows. AECI-115: a missing vendor surfaces as `null` (the
 * public schema permits it and the SSR layer renders an empty state) rather
 * than fabricating a `/vendors/unknown` sentinel. `product_vendors` has no DB
 * constraint forcing ≥1 link, so this is a legitimate absence, not corruption.
 */
export function pickPrimaryVendor(rows: RawProductVendor[]): VendorLink | null {
  if (rows.length === 0) return null;
  // `orderBy: { isPrimary: 'desc' }` puts the primary row first; fall back to
  // index 0 anyway so the mapper is independent of caller ordering.
  const primary = rows.find((r) => r.isPrimary) ?? rows[0];
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
    audiences: raw.productAudiences.map((r) => r.audience),
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
    headquarters: raw.headquarters,
    founded_year: raw.foundedYear,
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
    products: raw.productVendors.map((r) => toProductListItem(r.product)),
  };
}

export type TaxonomyCountKey = 'productCategories' | 'productAudiences' | 'productPhases';

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

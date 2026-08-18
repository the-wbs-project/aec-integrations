# AEC Integrations — API Contracts

**Referenced by:** `STAGE_1_SPEC.md` §6, §14
**Version:** 1.0
**Date:** May 2026

---

## 1. Purpose

Defines the shape of every API endpoint exposed by the AEC Integrations API Worker. Source of truth for request and response types, error codes, and validation rules.

The API Worker is consumed only through the SSR Worker — directly via the Cloudflare service binding for SSR data loaders, and via the SSR Worker's same-origin `/api/*` passthrough for hydrated client reads (index lists, and detail/browse fetches on a client-navigation `TransferState` miss; AECI-151 / ADR 0001). The API Worker has no public ingress on its own hostname. This is an internal contract, not a separately-published public API (no OpenAPI, no versioning).

---

## 2. Contract approach

Shared TypeScript types in `packages/shared/`, with Zod schemas at API boundaries for runtime validation.

- TypeScript types are the static contract — the compiler enforces it across Worker and frontend
- Zod schemas validate incoming requests at runtime
- Response shapes are typed but not runtime-validated (we trust our own server)
- No OpenAPI spec — overkill for an internal API with one consumer

### 2.1 Why this approach

- Single source of truth: the Zod schema generates the TypeScript type via `z.infer<>`
- Zero spec drift: there is no separate spec to maintain
- Runtime safety on inputs only — outputs are trusted
- TypeScript autocomplete in both Worker and frontend
- Easy to evolve — change the schema, types propagate

### 2.2 Package layout

```
packages/shared/
├── src/
│   ├── api/
│   │   ├── common.ts          # LinkRef, VendorLink, ProductLink, PageQuery,
│   │   │                      # paginatedResponseSchema, ApiError, SortOrder
│   │   ├── products.ts        # ProductListItem / ProductDetail / ProductsListQuery / ProductsListResponse
│   │   ├── vendors.ts         # VendorListItem / VendorDetail / VendorsListQuery / VendorsListResponse
│   │   ├── integrations.ts    # IntegrationListItem / ProductIntegrationItem / IntegrationDetail / ContextDirection / IntegrationsListQuery / IntegrationsListResponse
│   │   ├── taxonomy.ts        # TaxonomyTermWithCount, Category/Audience/Phase Detail, TaxonomyResponse
│   │   ├── page-views.ts      # PageViewPayload (POST /api/page-views)
│   │   ├── landing.ts         # Subscribe / Feedback capture (POST /api/subscribe, /api/feedback)
│   │   ├── reviews.ts         # (Phase 5)
│   │   ├── requests.ts        # (Phase 6 — claim and correction)
│   │   ├── stats.ts           # (Phase 4)
│   │   ├── admin.ts           # (Phase 6+)
│   │   └── vendor.ts          # (Stage 2 — vendor portal, /api/vendor/*)
│   └── errors/
│       └── codes.ts           # Machine-readable error code constants
└── package.json
```

---

## 3. Common types

### 3.1 Pagination

All Phase 2 list endpoints return paginated responses with a consistent page-based shape, per `STAGE_1_PHASE_2_SPEC.md` §7.3. The canonical schema lives in `packages/shared/src/api/common.ts`.

```typescript
import { z } from 'zod';

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(24),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;

export type PaginatedResponse<T> = {
  data: T[];
  page: number;
  perPage: number;
  total: number;
};

// Runtime schema builder — wrap any item schema into a paginated response.
export const paginatedResponseSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.object({
    data: z.array(itemSchema),
    page: z.number().int().min(1),
    perPage: z.number().int().min(1).max(100),
    total: z.number().int().min(0),
  });
```

> **Note:** later endpoint sections (§6.6 Reviews, §6.10 Admin) still describe the older `PaginationQuerySchema` (offset/limit) pending phase-specific realignment. New work uses `PageQuerySchema`.

### 3.2 Sorting

Each Phase 2 list endpoint exposes a **combined sort key** — a single enum that encodes both the field and (implicitly) the direction. The API Worker resolves the direction per the rule below; the public query carries no separate `order` field.

```typescript
// Per-entity sort enums live alongside their endpoint schemas
// (`packages/shared/src/api/products.ts` etc.).
export const ProductSortSchema = z
  .enum(['created', 'name', 'updated', 'rating', 'reviews'])
  .default('created');

export const VendorSortSchema = z
  .enum(['created', 'name', 'updated'])
  .default('created');

export const IntegrationSortSchema = z
  .enum(['name', 'created'])
  .default('name');
```

**Default-direction rule** (Phase 2 Spec §7.4):

| Sort key | Direction |
|---|---|
| `created` | DESC |
| `updated` | DESC |
| `name` | ASC |
| `rating` | DESC |
| `reviews` | DESC |

Per-entity defaults (Phase 2 Spec §7.4):

- `/api/products`, `/api/vendors` → `created` (i.e. created DESC, "newest first")
- `/api/integrations` → `name` (alphabetical; groups by source product since names render as `"Source → Target"`)

`rating` ("Highest rated") and `reviews` ("Most reviewed") are **products-only** sorts (the `/products` index dropdown). For `rating`, products whose rating is withheld by the §5.5 gate (`review_count < 5`) sort **last** — the orderBy nulls the sort key below the threshold so a single 5★ review can't outrank a well-reviewed 4.8★ product. The §5.5 gate that nulls `rating_overall_avg` / `rating_onboarding_avg` is applied on **both** the list and detail mappers (`toProductListItem` / `toProductDetail`), so a sub-5 product never emits a misleading average and the card / table / detail surfaces stay consistent. The shared threshold constant is `RATING_VISIBILITY_MIN_REVIEWS` (`@aeci/shared`); the `rating` sort reuses it in its `CASE` guard.

`SortOrderSchema = z.enum(['asc', 'desc'])` is retained in `common.ts` for server-side helpers, but does not appear in any Phase 2 public query.

### 3.3 Error response

All error responses use this exact shape.

```typescript
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),                // machine-readable error code
    message: z.string(),             // human-readable, locale-appropriate
    field: z.string().optional(),    // for validation errors
    details: z.unknown().optional(), // structured context
  }),
  trace_id: z.string(),              // Datadog trace ID
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
```

### 3.4 Hydration depth

Per `STAGE_1_PHASE_2_SPEC.md` §7.2, detail responses embed the **display fields** of related entities — they don't return only IDs and they don't expect callers to chain-fetch. The baseline hydration primitive is `LinkRef`; richer refs add a logo where the page renders one.

```typescript
export const LinkRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
});

// VendorLink extends LinkRef with logo_url + verified (the AECi-verified-vendor-
// account bit, mirrored from vendors.verified — required, since the column is
// NOT NULL DEFAULT false; powers the AECI-523 verified badge on the detail
// surfaces). ProductLink extends LinkRef with logo_url only.
export const VendorLinkSchema = LinkRefSchema.extend({
  logo_url: z.string().url().nullable(),
  verified: z.boolean(),
});

export const ProductLinkSchema = LinkRefSchema.extend({
  logo_url: z.string().url().nullable(),
});
```

Per-detail hydration rules:

| Detail response | Field | Embedded shape |
|---|---|---|
| `ProductDetail` | `vendor` | `VendorLink` |
| `ProductDetail` | `categories` / `audiences` / `phases` / `trades` | `LinkRef[]` — `trades` (AECI-541) is **sparse by design**: most products carry zero trade tags, so `[]` is the common, correct value, not missing data (`STAGE_1_SPEC.md` §5.5a). |
| `ProductDetail` | `integrations_as_source` / `integrations_as_target` | `ProductIntegrationItem[]` (= `IntegrationListItem` + `context_direction`) |
| `ProductDetail` | `integrations_as_connector` | `IntegrationListItem[]` — edges this product **powers** as the mechanism (`powered_by_product_id`), not as an endpoint (Stage 1.5 Addendum B). Bare list item **by design**: the page product is neither endpoint, so `context_direction` has no frame to be relative to. |
| `ProductDetail` | `related_products` | `ProductListItem[]` |
| `VendorDetail` | `products` | `ProductListItem[]` |
| `IntegrationDetail` | `source` / `target` | `ProductLink` |
| `IntegrationDetail` | `built_by_vendor` | `VendorLink \| null` |
| `IntegrationDetail` | `powered_by_product` | `ProductLink \| null` |
| `CategoryDetail` / `AudienceDetail` / `PhaseDetail` / `TradeDetail` | `products` | `ProductListItem[]` |

Each list endpoint returns the lean `*ListItem` shape; the corresponding `*Detail` shape (returned only by the `:slug` / `:id` endpoint) extends it with the heavier hydration.

Not every `*Detail` field is a hydrated relation. `ProductDetail.usefulness` (`ProductUsefulness | null`, see §5.1) is **embedded narrative jsonb** — "how teams use it" value text grouped by audience/phase term — not a link to another entity, so it is absent from the table above.

---

## 4. Error codes

Machine-readable codes are stable identifiers. Messages are localized.

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Request body or query failed schema validation |
| `MALFORMED_REQUEST` | 400 | Request body could not be parsed |
| `UNAUTHENTICATED` | 401 | No session, or session expired |
| `PAYLOAD_TOO_LARGE` | 413 | Request body exceeds the endpoint's hard size ceiling (`POST /api/promote`, AECI-563) |
| `FORBIDDEN` | 403 | Authenticated but not authorized for this action |
| `NOT_FOUND` | 404 | Resource does not exist |
| `REVIEW_DUPLICATE` | 409 | User already reviewed this product |
| `REVIEW_BANNED` | 403 | User is banned and cannot submit reviews |
| `ENTITLEMENT_REQUIRED` | 403 | The vendor's entitlement tier does not hold the capability this write requires (AECI-610; `details: { capability, tier, fields? }`). **403, not 402** — 402 Payment Required would leak a billing model into a contract that must stay payer-model-agnostic, and this table has no 402 row. Reads are never gated |
| `SLUG_CONFLICT` | 409 | Slug collision detected on entity creation |
| `GRANT_CONFLICT` | 409 | Vendor-claim grant would violate role/vendor exclusivity — the claimant account is a site `admin`, or is already linked to a different vendor (AECI-519; `details.reason` ∈ `already_admin` \| `other_vendor`) |
| `INVALID_STATE_TRANSITION` | 422 | Attempted workflow transition is not allowed from current state |
| `RATE_LIMITED` | 429 | Rate limit exceeded |
| `DEPENDENCY_FAILURE` | 503 | Upstream dependency (Supabase, Algolia, Linear) failed |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

### 4.1 HTTP status code conventions

- `400` — validation errors, malformed requests
- `401` — not authenticated
- `403` — authenticated but not authorized, banned, or lacking the entitlement a write requires
- `404` — resource doesn't exist or is not visible to caller
- `409` — conflict (duplicate, slug collision, vendor-claim grant exclusivity)
- `413` — request body over the endpoint's hard ceiling
- `422` — semantically valid but business rule violation
- `429` — rate limited (with `Retry-After` header)
- `500` — unexpected server error (auto-alerts Datadog)
- `503` — dependency failure (distinguishes from generic 500s)

### 4.2 Error throwing pattern

```typescript
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public field?: string,
    public details?: unknown
  ) { super(message); }
}

// Usage in any endpoint handler
throw new ApiError(409, 'REVIEW_DUPLICATE', 'You already reviewed this product');
```

Centralized error middleware:
- Catches `ApiError` instances and returns the structured response
- Catches `ZodError` and converts to `VALIDATION_FAILED` with field info
- Catches all other errors as `INTERNAL_ERROR` (logs full stack to Datadog)
- Adds `trace_id` to every response from the active Datadog span

### 4.3 Localization

Stage 1 ships English messages only. Architecture supports future localization via either:

- Server-side: Worker reads `Accept-Language` header, returns translated message
- Client-side: Frontend looks up message from error code via `@angular/localize`

Default to client-side localization. Stage 1 server returns English; frontend can override based on error code if needed for non-English locales added later.

---

## 5. Entity types

Canonical types for the three core entities. Phase 2 splits each entity into a **lean list item** (returned by list endpoints) and a **hydrated detail** (returned only by the `:slug` or `:id` endpoint). The list-item shape is also the shape embedded in other entities' detail responses — see §3.4 for the hydration table.

All schemas below live in `packages/shared/src/api/` and are the source of truth.

### 5.1 Product

```typescript
export const ProductListItemSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  logo_url: z.string().url().nullable(),
  product_role: z.enum(['application', 'connector', 'hybrid']),
  vendor: VendorLinkSchema.nullable(), // null when the product has no ProductVendor link (AECI-115)
  integration_count: z.number().int().min(0),
  review_count: z.number().int().min(0),
  rating_overall_avg: z.number().nullable(),
  rating_onboarding_avg: z.number().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

// `usefulness` is narrative value ("how teams use it"), NOT a taxonomy facet. Each
// group elaborates one audience or phase term by `slug`/`name` (same field types as
// LinkRef, but it carries NO `id` — it is slug-based, not a hydrated LinkRef; do not
// "fix" this by extending LinkRefSchema). `points` holds >= 1 bullet, in display order.
export const UsefulnessGroupSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  points: z.array(z.string().min(1)).min(1),
});

export const ProductUsefulnessSchema = z.object({
  audiences: z.array(UsefulnessGroupSchema),
  phases: z.array(UsefulnessGroupSchema),
});

export const ProductDetailSchema = ProductListItemSchema.extend({
  description: z.string().nullable(),
  website: z.string().url().nullable(),
  tool_integrations_url: z.string().url().nullable(),
  api_docs_url: z.string().url().nullable(),
  has_api_docs: z.boolean(),
  categories: z.array(LinkRefSchema),
  audiences: z.array(LinkRefSchema),
  phases: z.array(LinkRefSchema),
  // The fourth facet (§5.5a / AECI-541). SPARSE BY DESIGN — a product is tagged only
  // when it has trade-SPECIFIC value, so `[]` is the common case (horizontal platforms
  // get none). Required, not optional: an absent key is a bug, an empty array is data.
  trades: z.array(LinkRefSchema),
  // Narrative value grouped by audience/phase, distinct from the `audiences`/`phases`
  // facet LinkRef[] above. `null` when the source has nothing for either facet;
  // otherwise either facet array may be empty.
  usefulness: ProductUsefulnessSchema.nullable(),
  // ProductIntegrationItem = IntegrationListItem + `context_direction` (see §5.3).
  integrations_as_source: z.array(ProductIntegrationItemSchema),
  integrations_as_target: z.array(ProductIntegrationItemSchema),
  // Edges this product POWERS as the connector/mechanism, not as an endpoint
  // (Stage 1.5 Addendum B, §12). Bare IntegrationListItem — no `context_direction`,
  // because the page product is neither `source` nor `target`. Flat list; the hub
  // grouping ("Connects Procore with: …") is a client-side presentation concern.
  integrations_as_connector: z.array(IntegrationListItemSchema),
  related_products: z.array(ProductListItemSchema),
});
```

### 5.2 Vendor

```typescript
export const VendorListItemSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  company_name: z.string().min(1),
  logo_url: z.string().url().nullable(),
  verified: z.boolean(),
  headquarters: z.string().nullable(),
  founded_year: z.number().int().nullable(),
  product_count: z.number().int().min(0),
  integration_count: z.number().int().min(0),
  review_count: z.number().int().min(0),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const VendorDetailSchema = VendorListItemSchema.extend({
  description: z.string().nullable(),
  website: z.string().url().nullable(),
  linkedin_url: z.string().url().nullable(),
  x_url: z.string().url().nullable(),
  facebook_url: z.string().url().nullable(),
  instagram_url: z.string().url().nullable(),
  youtube_url: z.string().url().nullable(),
  products: z.array(ProductListItemSchema),
});
```

The public sort key `name` on `/api/vendors` maps to the `company_name` column server-side (vendors have no plain `name` column).

`linkedin_url`, `x_url`, `facebook_url`, `instagram_url`, and `youtube_url` are returned verbatim from their `vendors.*` columns (the review app curates full canonical URLs and forwards them via `POST /api/promote`). All are nullable; the detail hero renders an icon for each only when its value is present.

### 5.3 Integration

```typescript
export const IntegrationListItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  mechanism_kind: z
    .enum(['native', 'iPaaS', 'marketplace-app', 'api', 'webhook', 'partner'])
    .nullable(), // null when the column is unset (AECI-115); an out-of-enum non-null value is rejected (500) server-side
  mechanism_name: z.string().nullable(),
  direction: z.enum(['one-way', 'bidirectional']).nullable(), // the stored connector-level direction, verbatim
  source: ProductLinkSchema,
  target: ProductLinkSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

// Product-detail embed (`ProductDetail.integrations_as_*`). Adds the effective,
// claims-aware direction relative to the page's product (Stage 1.5 §3.2 / §7.1):
// `effectiveContextDirection` prefers the aggregate of the mechanism's claim
// directions (the same signal the pair page surfaces) and falls back to the
// stored `direction`, both framed to this product; `null` (em-dash) only when
// there is neither. **Refuted claims are excluded** — once every vendor that
// voted denies a flow it stops steering the arrow (STAGE_2_ATTESTATIONS_SPEC.md
// §4.3 / AECI-605); a `conflict` claim still counts, since disputed is not
// withdrawn. Precomputed server-side so the product-detail table can never
// contradict the pair page. Only this embed carries it — the bare
// `IntegrationListItem` used by `/api/integrations` and the home rail has no
// single context product. `ContextDirectionSchema` = `['outbound','inbound','both']`.
export const ProductIntegrationItemSchema = IntegrationListItemSchema.extend({
  context_direction: ContextDirectionSchema.nullable(),
});

export const IntegrationDetailSchema = IntegrationListItemSchema.extend({
  description: z.string().nullable(),
  listing_url: z.string().url().nullable(),
  docs_url: z.string().url().nullable(),
  mechanism_url: z.string().url().nullable(),
  built_by_vendor: VendorLinkSchema.nullable(),
  powered_by_product: ProductLinkSchema.nullable(),
  pricing_model: z.string().nullable(),
  maturity: z.string().nullable(),
});
```

### 5.4 Review

```typescript
export type Review = {
  id: string;
  product_id: string;
  reviewer: ReviewerRef | null;      // null if anonymized
  rating_overall: number;
  rating_onboarding: number;
  title: string;
  body: string;
  role_at_company: string | null;
  years_using: number | null;
  would_recommend: 'yes' | 'no' | 'maybe' | null;
  verified_work_email: boolean;
  locale: string;
  created_at: string;
};

export type ReviewerRef = {
  display_name: string | null;        // may be redacted
  role_at_company: string | null;
};
```

---

## 6. Endpoint contracts

### 6.1 Products

#### `GET /api/products`

List products with filters. Default sort `created` (DESC) per §3.2 / Phase 2 Spec §7.4.

The **four** taxonomy dimensions (`category_id` / `audience_id` / `phase_id` / `trade_id`) accept a **comma-separated UUID list** for multi-select faceting (AECI-223) — **OR within a dimension, AND across dimensions** — decoded to `string[]` by `uuidList`. The param names are unchanged, so a single id (a detail-page taxonomy chip link, or a browse page's locked `{kind}_id`) is just a one-element list. `vendor_id` stays a single UUID (a non-faceted scope).

```typescript
export const ProductsListQuerySchema = PageQuerySchema.extend({
  sort: ProductSortSchema,                         // default 'created'
  search: z.string().optional(),
  category_id: uuidList.optional(),
  audience_id: uuidList.optional(),
  phase_id: uuidList.optional(),
  trade_id: uuidList.optional(),                   // AECI-541 (trades facet, §5.5a)
  vendor_id: z.string().uuid().optional(),
  product_role: ProductRoleSchema.optional(),
  has_api_docs: z.coerce.boolean().optional(),
});

export type ProductsListQuery = z.infer<typeof ProductsListQuerySchema>;
export const ProductsListResponseSchema = paginatedResponseSchema(ProductListItemSchema);
export type ProductsListResponse = z.infer<typeof ProductsListResponseSchema>;
```

#### `GET /api/products/facets`

Scoped facet counts for the API-backed filter sidebar (AECI-143) on `/products` and the taxonomy browse pages — driven by the existing `/api` filter params, not Algolia, so these pages stay edge-cacheable. Takes the **same filter params** as `GET /api/products` minus the pagination/sort triple (`page`, `perPage`, `sort`); deriving the query with `.omit(...)` keeps the two shapes from drifting. For each taxonomy dimension (category / audience / phase / trade) it returns the product count per term under the *other* active filters (disjunctive faceting — a dimension's own filter is excluded from its own counts). Server-side Drizzle/D1 aggregation. `Cache-Control: private, no-store` like the list/detail siblings.

```typescript
export const ProductFacetsQuerySchema = ProductsListQuerySchema.omit({
  page: true,
  perPage: true,
  sort: true,
});
export type ProductFacetsQuery = z.infer<typeof ProductFacetsQuerySchema>;

// One `TaxonomyTermWithCount[]` per dimension; here `product_count` is the
// SCOPED count (reflecting the other active filters), ordered by `display_order`
// then name — same per-term shape the flat taxonomy list endpoints return.
export const ProductFacetsResponseSchema = z.object({
  categories: z.array(TaxonomyTermWithCountSchema),
  audiences: z.array(TaxonomyTermWithCountSchema),
  phases: z.array(TaxonomyTermWithCountSchema),
  trades: z.array(TaxonomyTermWithCountSchema),    // AECI-541
});
export type ProductFacetsResponse = z.infer<typeof ProductFacetsResponseSchema>;
```

#### `GET /api/products/:slug`

Get full product detail by slug. Hydration per §3.4.

```typescript
export type ProductDetail = z.infer<typeof ProductDetailSchema>;
```

Errors: `NOT_FOUND` if no product matches the slug.

#### `GET /api/products/:slug/reviews`

List approved reviews for a product. The canonical shape lives in **§6.6** (the
`PublicReview` / `ProductReviewsResponse` contract implemented by AECI-199). The
ratings summary is **not** on this list — it is embedded in `ProductDetail`
(§6.6), where the ≥5 averages gate applies.

> **Superseded shape.** An earlier draft of this section defined a
> `ListReviewsQuerySchema` / `ListReviewsResponse` with an inline
> `aggregate { … score_visible }`. That shape was never implemented and is
> dropped: the standalone list returns a plain `PaginatedResponse<PublicReview>`
> (no aggregate), and the summary + ≥5 gate live on `ProductDetail`. See
> `STAGE_1_PHASE_5_SPEC.md` §5.4–§5.5.

### 6.2 Vendors

#### `GET /api/vendors`

Default sort `created` (DESC). The public `name` key maps to `company_name` server-side.

```typescript
export const VendorsListQuerySchema = PageQuerySchema.extend({
  sort: VendorSortSchema,                          // default 'created'
  search: z.string().optional(),
  verified: z.coerce.boolean().optional(),
});

export const VendorsListResponseSchema = paginatedResponseSchema(VendorListItemSchema);
export type VendorsListResponse = z.infer<typeof VendorsListResponseSchema>;
```

#### `GET /api/vendors/:slug`

```typescript
export type VendorDetail = z.infer<typeof VendorDetailSchema>;
```

Errors: `NOT_FOUND`.

### 6.3 Integrations

#### `GET /api/integrations`

Default sort `name` (ASC). Filter fields use the camelCase names from the Phase 2 Spec example query.

```typescript
export const IntegrationsListQuerySchema = PageQuerySchema.extend({
  sort: IntegrationSortSchema,                     // default 'name'
  search: z.string().optional(),
  sourceProductId: z.string().uuid().optional(),
  targetProductId: z.string().uuid().optional(),
  mechanism_kind: z.enum(['native', 'iPaaS', 'marketplace-app', 'api', 'webhook', 'partner']).optional(),
  direction: z.enum(['one-way', 'bidirectional']).optional(),
});

export const IntegrationsListResponseSchema = paginatedResponseSchema(IntegrationListItemSchema);
export type IntegrationsListResponse = z.infer<typeof IntegrationsListResponseSchema>;
```

#### `GET /api/integrations/:id`

```typescript
export type IntegrationDetail = z.infer<typeof IntegrationDetailSchema>;
```

> The standalone `/integrations/:id` **page** is retired in Stage 1.5 (AECI-294) — the SSR Worker 301-redirects it to the product-PAIR page. The `GET /api/integrations/:id` **endpoint** stays (the sitemap generator + the 301 handler read it to resolve a pair's two product slugs).

#### `GET /api/products/:slug/integrations/:otherSlug` (Stage 1.5 · AECI-294 / AECI-300)

The **product-PAIR read**. Consolidates every integration between two products into one context-oriented view (Stage 1.5 §7–§8). `:slug` is the **context** product; `:otherSlug` the other. Query resolves the unordered pair (matches integrations in either source/target orientation). Layer B (AECI-300) hydrates each mechanism's `data_object` claims + attestations and fills the `sync_headline`.

**Query params (AECI-303 / `STAGE_2_ATTESTATIONS_SPEC.md` §9):**

| Param | Value | Default |
|---|---|---|
| `context_version` | a `product_versions.label` of the **context** product | latest |
| `other_version` | a `product_versions.label` of the **other** product | latest |

Labels, not ids — unique per product via `product_versions_label_key`, so a natural key, and the point of the feature is a link somebody sends a colleague. Exposing labels also lets the response omit both `id` and `sort_key`, which is what structurally stops the browser re-deriving an ordering (§8.2).

**An unknown, renamed, over-long (>60 char) or empty label DEGRADES to latest — it never 404s.** The pair exists; only the selection is stale, and a 404 would render the NotFound shell for a valid page. What the server actually resolved comes back in `version_diff.selected`, so the UI shows what was served rather than what the URL asked for. Matching is exact and **case-sensitive** (the unique index carries no `NOCASE` collation, so a case-insensitive match could be ambiguous — and ambiguity here silently shows a different diff).

```typescript
// packages/shared/src/api/product-pairs.ts
// ContextDirectionSchema is defined in `./integrations` (shared with the
// product-detail table's `ProductIntegrationItem.context_direction`, §5.3) and
// imported here; conceptually it is `z.enum(['outbound', 'inbound', 'both'])`.

// The claim's computed agreement (§3.4 — computeAgreement, never stored). Only
// `unverified` is reachable in Stage 1.5 (AECi-only attestations, AECi-never-red).
// `confirmed` requires TWO DISTINCT vendor identities; one vendor affirming alone
// is `single_source` (STAGE_2_ATTESTATIONS_SPEC.md §4.2 — AECI-605).
export const AgreementStateSchema = z.enum([
  'unverified', 'single_source', 'confirmed', 'conflict',
]);

// One LIVE attestation behind a claim (§3.3), for the annotated provenance (§8).
// Retracted rows are filtered out by the read path, so they never appear here.
export const PairClaimAttestationSchema = z.object({
  source: z.enum(['aeci', 'vendor_a', 'vendor_b']),   // only `aeci` written in 1.5
  attestor: z.enum(['aeci', 'context', 'other']),     // the slot, framed context-relative (§4.3)
  asserted: z.boolean(),
  note: z.string().nullable(),
  introduced_at: z.string().nullable(),               // coarse ISO date stamps — NOT retraction
  deprecated_at: z.string().nullable(),
  // AECI-303: the PRECISE stamps, as the vendor's own release LABEL — the same value
  // the selectors put in the URL. `.optional()` and OMITTED when there is no stamp,
  // deliberately asymmetric with the nullable dates above: absent is the one spelling
  // of "unstamped", so a promote-written attestation serialises exactly as before.
  introduced_version: z.string().optional(),
  deprecated_version: z.string().optional(),
});

// One data_object claim on a mechanism (Layer B — §8). `direction` is already
// translated to the context product's frame (§3.2); `agreement` is computed.
export const ProductPairClaimSchema = z.object({
  // AECI-303: the join key for the per-claim timeline read below. `.optional()` so a
  // new SSR Worker against an older API hides the affordance rather than requesting
  // a timeline it cannot match up.
  id: z.string().uuid().optional(),
  data_object_slug: z.string(),
  data_object_name: z.string(),
  direction: ContextDirectionSchema,
  agreement: AgreementStateSchema,
  attestations: z.array(PairClaimAttestationSchema),
  // AECI-303: added / removed / unchanged for the selected version pair. ABSENT when
  // no comparison applies — every claim on every pair whose `version_diff` is null.
  version_status: z.enum(['added', 'removed', 'unchanged']).optional(),
});

export const ProductPairMechanismSchema = z.object({
  id: z.string().uuid(),
  mechanism_kind: IntegrationMechanismKindSchema.nullable(),
  mechanism_name: z.string().nullable(),
  direction: ContextDirectionSchema.nullable(),   // the stored one-way/bidirectional, translated context-relative (§3.2)
  description: z.string().nullable(),
  listing_url: z.string().url().nullable(),
  docs_url: z.string().url().nullable(),
  built_by_vendor: VendorLinkSchema.nullable(),
  powered_by_product: ProductLinkSchema.nullable(),
  claims: z.array(ProductPairClaimSchema).default([]),   // Layer B: [] for an unseeded mechanism
});

export const SyncHeadlineSchema = z.object({
  total: z.number().int().min(0),      // distinct claims on the pair (all mechanisms/directions)
  confirmed: z.number().int().min(0),  // TWO distinct vendors affirm — always 0 in Stage 1.5
  // Exactly one vendor affirms, counterparty silent. Reported separately, never
  // folded into `confirmed` (§8.1(4)). `.default(0)` so an SSR Worker running this
  // schema still parses a response from an API Worker that predates the field.
  single_source: z.number().int().min(0).default(0),
});

export const ProductPairResponseSchema = z.object({
  context_product: ProductListItemSchema,   // both products hydrate as ProductListItem (vendor + review recap)
  other_product: ProductListItemSchema,
  mechanisms: z.array(ProductPairMechanismSchema),
  sync_headline: SyncHeadlineSchema,
  // The page-header maintenance marker (AECI-616), folded across all mechanisms by
  // `computePairMaintenance`. `maintained_by` is 'vendor' if ANY mechanism is; the
  // date is the max WITHIN that branch only, so an AECi review date is never
  // attributed to a vendor. Same `.default(...)` deploy-skew reasoning as
  // `single_source` above.
  maintenance: MaintenanceSchema.default({ maintained_by: 'aeci', last_reviewed_at: null }),
  // AECI-303 (§9): the two version selectors, or NULL when the diff does not apply.
  version_diff: PairVersionDiffSchema.nullable().default(null),
});

// AECI-303 — the selectors' state. `null` on the response above is the WHOLE
// browser-side suppression rule: no selectors, no markers, no summary.
export const PairVersionSchema = z.object({
  label: z.string(),
  released_at: z.string().nullable(),   // display only — NEVER an ordering input (§8.2)
});

export const PairVersionDiffSchema = z.object({
  // Ascending by `compareProductVersions` (the API's `VERSION_ORDER` is the same rule
  // in SQL), so "latest" is always the LAST element and the browser never re-derives it.
  context_versions: z.array(PairVersionSchema).default([]),
  other_versions: z.array(PairVersionSchema).default([]),
  // What the server RESOLVED (labels), which is not always what the URL asked for.
  selected: z.object({ context: z.string().nullable(), other: z.string().nullable() }),
  // The pair the diff is measured against — each side stepped back ONE release,
  // independently. `null` when neither side has a predecessor (the earliest pair),
  // where every present claim reads `unchanged`.
  previous: z.object({ context: z.string().nullable(), other: z.string().nullable() })
    .nullable().default(null),
  // Is the RESOLVED selection latest × latest? Drives the pair resolver's `noindex`,
  // so it is about the resolution and not the request: a degraded label serves
  // canonical content and stays indexable.
  is_default: z.boolean(),
  counts: z.object({ added: z.number().int().min(0), removed: z.number().int().min(0) })
    .default({ added: 0, removed: 0 }),
  // §9.3's entitlement seam as DATA, not a code branch (`STAGE_2_SPEC.md` §2.2).
  diff_access: z.enum(['full', 'latest_only']).default('full'),
});

// packages/shared/src/api/common.ts — shared by ProductDetail, VendorDetail, and the
// pair response. `last_reviewed_at` is null for almost every record: nothing was
// backfilled, and bare attribution is the honest default (AECI-616 / §13).
export const MaintenanceSchema = z.object({
  maintained_by: z.enum(['aeci', 'vendor']).default('aeci'),
  last_reviewed_at: z.string().nullable().default(null),
});
export type ProductPairResponse = z.infer<typeof ProductPairResponseSchema>;
```

- **`direction`** (mechanism) is the integration row's stored `one-way`/`bidirectional` translated to the **context product's** frame: `one-way` → `outbound` when the context product is the integration's `source`, else `inbound`; `bidirectional` → `both`; `null` → `null` (§3.2, applied at the mechanism level).
- **`claims[]`** (Layer B — §8) are the `data_object` flows on each mechanism. `direction` is the **claim-level** stored `a_to_b`/`b_to_a`/`both` translated to the context frame (§3.2 — distinct from the mechanism translation), and `agreement` is `computeAgreement(attestations)` (§3.4, `packages/shared/src/agreement.ts`) — always `unverified` in 1.5. Ordered by the `data_object`'s `display_order`. A `data_object` moving through two mechanisms is **two claims** (§3.1), never de-duplicated.
- **`attestations[]`** carry only **live** rows: the read config filters `retracted_at IS NULL` (`liveAttestationsWhere`, `apps/api/src/lib/drizzle-helpers.ts`), so a withdrawn assertion neither votes nor renders. `deprecated_at` is a *version stamp* and never gates the read. `attestor` is the slot translated to the page's frame by `attestorForContext` (`vendor_a` = endpoint A = the integration's `source_product`): the browser attributes a `single_source` claim by looking the name up on `context_product.vendor` / `other_product.vendor`. The raw `attested_by_vendor_id` is **not** exposed — it feeds the §4.2 distinct-identity dedupe server-side only.
- **`sync_headline`** = `computeSyncHeadline` over every claim on the pair (§3.5): `total` is the distinct claim count; `confirmed` (two distinct vendors) and `single_source` (one vendor, counterparty silent) are both `0` in Stage 1.5 and are **never summed**. `{ total: 0, confirmed: 0, single_source: 0 }` for an unseeded/empty pair. **Claims whose `version_status` is `removed` are excluded from all three counts** (AECI-303): they still render, struck through, but "N data objects sync" must not count a flow that has stopped. Filtered at the single `computeSyncHeadline` call site in `toProductPairResponse`, not inside the shared engine.
- **`version_diff`** (AECI-303 / §9) is **non-`null` only when a pair has BOTH at least one product release AND at least one live version-stamped attestation.** Both facts are server-side only, which is why the decision is not left to the browser: that one null is the entire suppression rule, and it makes "latest × latest renders identically to today for claims with no version data" structural rather than a rendering discipline. Promote does not ingest versions (§11) and the only writer is the Verified-vendor API, so today this is `null` for the whole catalog.
- **Presence and the diff apply UNIFORMLY, including at latest × latest.** A claim is present at (vA, vB) when, for each attesting side, `introduced_version <= selected` and (`deprecated_version` is null **or** `selected < deprecated_version`); **a claim with no version stamps is always present.** A claim present at neither the selected nor the previous pair is **dropped from the response entirely** — otherwise a pair with a long release history would render every flow it ever had. Ordering and every comparison key off `sort_key` through `compareProductVersions` (`@aeci/shared/version-diff`), never the label and never the nullable `released_at`; `sort_key` is packed per-product, so comparing it *across* the two products is meaningless.
- **Errors / status:** `NOT_FOUND` when either slug is unknown **or the two slugs are equal**. A valid-but-unconnected pair (both products exist, no integration between them) is a **200** with `mechanisms: []`. A bad `context_version` / `other_version` is **not** an error — see the degrade rule above.
- SSR caching (pair page): detail TTL, `Cache-Tag: route:detail,pair:{min}__{max},product:{slug}×2` (see `CACHE_STRATEGY.md`). The selector params are in the route's `cacheKeyParams` (`CACHE_STRATEGY.md` §4a), and a non-default selection is `noindex` with the canonical pointing at the default pair URL (§7.2).

#### `GET /api/products/:slug/integrations/:otherSlug/timeline` (Stage 2 · AECI-303)

The pair's **per-claim attestation history** (§9.1), read off the append-only rows: §2.1's supersession is retract-then-insert, never an in-place `UPDATE`, precisely so this read has something to show.

```typescript
// packages/shared/src/api/product-pairs.ts
export const ClaimTimelineEntrySchema = z.object({
  attestor: z.enum(['aeci', 'context', 'other']),   // framed context-relative, as on the pair read
  asserted: z.boolean(),
  note: z.string().nullable(),
  introduced_version: z.string().optional(),        // version labels, omitted when unstamped
  deprecated_version: z.string().optional(),
  created_at: z.string(),                           // the append-only ordering key (oldest first)
  retracted_at: z.string().nullable(),              // non-null = SUPERSEDED — what makes this history
});

export const PairTimelineResponseSchema = z.object({
  claims: z.array(z.object({
    claim_id: z.string().uuid(),                    // joins to ProductPairClaim.id
    entries: z.array(ClaimTimelineEntrySchema),
  })).default([]),
  diff_access: z.enum(['full', 'latest_only']).default('full'),
});
```

- **This is the ONE read in the system that returns retracted rows.** Every other read applies `liveAttestationsWhere`, so a withdrawn assertion neither votes nor renders as current. Its read config (`integrationTimelineConfig`) is deliberately separate for that reason, and `computeAgreement` must never be called on its output.
- **Pair-scoped, not claim-scoped**, so one browser fetch serves every provenance popover on the page. Entries are ordered `created_at` then `id` (a total order, so the render is stable regardless of D1 row order). A claim with no attestations is omitted — the browser's "does this claim have a history?" test is the absence of an entry for its id.
- **Why it is a separate, lazy endpoint rather than inline on the pair response.** History is the gateable depth (§9.3), and the pair page is stored in a shared, URL-keyed edge cache — baking gated content into it would break §9.1a the moment AECI-304 makes the gate visitor-dependent. `/api/*` responses are `private, no-store`, which is a legal home for content that may vary per reader. It is also the only unbounded payload in the system, since the append-only log grows forever. Fetched from the browser on the first popover open; **never during SSR**.
- Gated ⇒ `{ claims: [], diff_access: 'latest_only' }`. The latest state is already rendered in full on the free page, so withholding *history* is exactly what `STAGE_2_SPEC.md` §8.1(4) permits and no more.
- **Errors / status:** identical to the pair read — `NOT_FOUND` on an unknown slug or two equal slugs; a valid-but-unconnected pair is a 200 with `claims: []`. No new error codes.

### 6.4 Taxonomy

#### `GET /api/categories`, `/api/audiences`, `/api/phases`, `/api/trades`

```typescript
export const CategoriesListResponseSchema = z.object({
  data: z.array(TaxonomyTermWithCountSchema),
});
```

Not paginated — the taxonomy is small by design (Phase 2 Spec §3.1).

**`/api/trades` is not publication-gated.** Every term is returned with its `product_count`, including terms below the `TRADE_PUBLISH_MIN_PRODUCTS = 1` floor — i.e. the zero-product terms, which after the AECI-547 backfill is 27 of the 34; the gate is applied per-surface by the consumer (`STAGE_1_SPEC.md` §5.5a, `TRADES_VOCABULARY.md` §6). Keeping the gate out of the API avoids splitting the vocabulary into two response shapes.

#### `GET /api/categories/:slug`, `/api/audiences/:slug`, `/api/phases/:slug`, `/api/trades/:slug`

```typescript
export const TaxonomyTermWithCountSchema = LinkRefSchema.extend({
  description: z.string().nullable(),
  display_order: z.number().int(),
  product_count: z.number().int().min(0),
});

// Each detail extends the term with the products carrying that term.
// Kept as three distinct schemas (not aliases) so future divergence is cheap.
export const CategoryDetailSchema = TaxonomyTermWithCountSchema.extend({
  products: z.array(ProductListItemSchema),
});
// `AudienceDetailSchema` / `PhaseDetailSchema` / `TradeDetailSchema` follow the same shape.
```

#### `GET /api/taxonomy`

```typescript
export const TaxonomyResponseSchema = z.object({
  categories: z.array(TaxonomyTermWithCountSchema),
  audiences: z.array(TaxonomyTermWithCountSchema),
  phases: z.array(TaxonomyTermWithCountSchema),
  trades: z.array(TaxonomyTermWithCountSchema),    // AECI-541
});
```

Used by the SSR Worker to populate nav, footer, and the `/categories` flat list.

### 6.5 Stats

#### `GET /api/stats/home`

Reads from `stats_cache` table. Never aggregates live. Pre-launch the cache is
sparse (until the daily compute job, §10, first runs), so a missing/empty cache
yields a valid **200 with empty defaults**, never a 500: the two single-card
fields are `null`, the scalars are `0`, and the lists are `[]`. The same fallback
applies per-field if a cached value has drifted from its schema.

`Cache-Control: private, no-store` (per `CACHE_STRATEGY.md` §4 — API responses are
never edge-cached; daily-freshness edge caching is owned by the SSR home route).

The coverage counts (`total_products` / `total_vendors` / `total_reviews` /
`total_contributing_firms`) feed the home credibility strip (AECI-271 + AECI-284,
§4.1 section 2). Products and vendors count every row (the DB holds only promoted
rows — the promote pipeline is the gate); `total_reviews` counts only `approved`
reviews; `total_contributing_firms` is the distinct count of the free-text
`reviewer_firm` (normalized `lower(trim(...))`, non-blank) among `approved`
reviews (AECI-284). All are plain scalars with a valid empty (`0`); the strip
suppresses each at `0` (no "0 reviews", no "0 contributing firms").

```typescript
export type HomeStatsResponse = {
  total_integrations: number;
  integrations_added_30d: number;
  total_products: number;                // coverage counts (AECI-271)
  total_vendors: number;
  total_reviews: number;                 // approved reviews only
  total_contributing_firms: number;      // distinct firms among approved reviews (AECI-284)
  most_integrated_product: {
    product: ProductRef;
    integration_count: number;
  } | null;                              // null when the cache key is absent
  most_active_category: {
    category: TaxonomyRef;
    integration_count: number;
  } | null;                              // null when the cache key is absent
  recent_integrations: Integration[];   // last 10
  trending_products: Product[];          // top 5, each ≥ TRENDING_MIN_VIEWS (3) page-views in 7d (AECI-280 floor)
  recently_added_products: Product[];   // last 10
};
```

### 6.6 Reviews

#### `POST /api/reviews`

Submit a review. Requires authentication.

```typescript
export const SubmitReviewSchema = z.object({
  product_id: z.string().uuid(),
  rating_overall: z.number().int().min(1).max(5),
  rating_onboarding: z.number().int().min(1).max(5),
  title: z.string().min(5).max(100),
  body: z.string().min(50).max(2000),
  role_at_company: z.enum(['practitioner', 'manager', 'IT', 'exec', 'other']).optional(),
  years_using: z.number().int().min(0).max(50).optional(),
  would_recommend: z.enum(['yes', 'no', 'maybe']).optional(),
  reviewer_firm: z.string().max(100).optional(), // AECI-284: trimmed server-side, null if blank
});

export type SubmitReviewResponse = {
  id: string;
  status: 'pending';
  message: string;            // user-facing acknowledgment, localized
};
```

Errors:
- `UNAUTHENTICATED` if no session
- `REVIEW_BANNED` if user is banned
- `REVIEW_DUPLICATE` if user already has a review for this product
- `NOT_FOUND` if product doesn't exist
- `VALIDATION_FAILED` for bad input

#### `GET /api/products/:slug/reviews`

Public, paginated, **approved-only**, **newest-first** review list for a product (added for Phase 5; see `STAGE_1_PHASE_5_SPEC.md` §5.4). No PII (no reviewer id/email). Source of truth: `packages/shared/src/api/reviews.ts`; implemented in `apps/api/src/routes/product-reviews.ts` (AECI-199).

```typescript
// page/perPage only — order is fixed newest-first server-side, so no sort param.
export const ProductReviewsQuerySchema = PageQuerySchema;

export const PublicReviewSchema = z.object({
  id: z.string().uuid(),
  rating_overall: z.number().int().min(1).max(5),
  rating_onboarding: z.number().int().min(1).max(5),
  title: z.string(),
  body: z.string(),
  role_at_company: z.string().nullable(),
  years_using: z.number().int().nullable(),
  would_recommend: z.enum(['yes', 'no', 'maybe']).nullable(),
  verified_work_email: z.boolean(),
  created_at: z.string().datetime(),
});
export type PublicReview = z.infer<typeof PublicReviewSchema>;

// Plain paginated list — NO aggregate block. The ratings summary lives on ProductDetail.
export type ProductReviewsResponse = PaginatedResponse<PublicReview>;
```

Errors: `NOT_FOUND` (unknown product slug — distinct from a known product with zero approved reviews, which is an empty page). API response is `Cache-Control: private, no-store` like its `GET /api/products/:slug` sibling; edge-cacheability + the `product:<slug>` Cache-Tag are an SSR-layer concern (the public product page bakes page 1 in), and review approval/rejection (Phase 5.13) purges that tag.

**Maintenance marker (AECI-616 / `STAGE_2_ATTESTATIONS_SPEC.md` §13).** `GET /api/products/:slug` and `GET /api/vendors/:slug` both carry a `maintenance: { maintained_by, last_reviewed_at }` object (the `MaintenanceSchema` above), feeding the `aec-maintenance-marker` chip in each page header. Detail-only — the marker never renders on a card, so `ProductListItem` / `VendorListItem` do not carry it. `last_reviewed_at` is `null` on almost every record and that renders bare attribution with no date; it is **never** derived from `updated_at` / `created_at` / `promoted_at`, and no migration backfills it.

**`ProductDetail` reviews embed (§5.4–§5.5).** `GET /api/products/:slug` additionally carries:

- `review_count`, `rating_overall_avg`, `rating_onboarding_avg` — the denormalized summary columns (already on `ProductListItem`).
- `reviews: PublicReview[]` — the **first page** of approved reviews (newest-first, same shape/order as page 1 of the list endpoint) so the product page renders reviews server-side without a client round-trip.
- **≥5 averages gate:** when `review_count < 5`, both `rating_overall_avg` and `rating_onboarding_avg` are **`null`** (a single-review average is statistically misleading — §5.5). The UI infers state from `review_count`: `0` → "Be the first to review", `1–4` → reviews shown / averages hidden, `5+` → averages shown. The gate is applied on **both** `ProductListItem` (`toProductListItem`) and `ProductDetail` — list/grid/search cards render the gated overall rating (`RatingSummary`, AECI trust-audit P0), so a sub-5 average never reaches a card. `review_count` itself is always truthful (a card may show "N reviews" without an average). The gate also covers the denormalized Algolia `rating_overall_avg`'s consumer defensively: the `RatingSummary` card component re-checks `review_count >= RATING_VISIBILITY_MIN_REVIEWS`, so it is source-agnostic.

### 6.7 Vendor requests

Source of truth: `packages/shared/src/api/requests.ts` (the Zod schemas the API validates with, shared with the Signal Forms client — ADR 0009). Implemented in AECI-128 (`apps/api/src/routes/requests.ts`). The request target is addressed by `(target_type, slug)` from the route and resolved to `vendor_requests.target_id` server-side — the client never holds a UUID. `target_type` is `product | vendor` only (no `integration`; Stage 1 claim/correction covers products + vendors). Rows are inserted `status:'open'`, `domain_match:'pending'`, `linear_issue_id:null` for the Phase 6 moderation pipeline (n8n/Linear/admin, including duplicate detection) to pick up.

#### `POST /api/requests/claim`

```typescript
export const ClaimRequestSchema = ClaimFormSchema.extend({
  target_type: z.enum(['product', 'vendor']),
  slug: z.string().min(1),
});
// ClaimFormSchema = { submitter_name (1–200), submitter_email (email, ≤200),
//                     submitter_role (1–100), body (20–2000) }
```

#### `POST /api/requests/correction`

```typescript
export const CorrectionRequestSchema = CorrectionFormSchema.extend({
  target_type: z.enum(['product', 'vendor']),
  slug: z.string().min(1),
});
// CorrectionFormSchema = { body (20–2000),
//                          source_url ('' or a valid URL ≤500),
//                          submitter_email (email, ≤200) }
```

Both return `RequestSubmitResponse` (`{ request_id: string; message: string }`) with HTTP `201`. Errors: `VALIDATION_FAILED` (400), `NOT_FOUND` (404 — `(target_type, slug)` did not resolve), `MALFORMED_REQUEST` (400 — body is not JSON).

### 6.8 Account

All three are auth-gated (`requireAuth`, AUTH_AND_RLS §4). `GET`/`PATCH` are an
AECI-202 / Phase 5.11 addition to this section; shapes live in
`packages/shared/src/api/account.ts`.

#### `GET /api/account`

Read the authenticated user's identity for `/account`. `email` is read-only —
sourced from the verified session JWT, never stored as a request field.

```typescript
export interface AccountProfileResponse {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  pending_reviews: number | null;
}
```

`role` (AECI-259) is the caller's own `profiles.role`, re-read from D1 by
`requireAuth()` on every request (AUTH_AND_RLS §4.5) — never a client claim. The
web client reads it to decide whether to surface admin affordances.

`pending_reviews` (AECI-617) is the moderation-queue count — the same aggregate
`GET /api/admin/summary` serves — and is non-null **only** for `role === 'admin'`;
a non-admin gets `null` and the `reviews` table is never counted. It rides along
here so the header's "More" menu resolves "am I an admin, and how many reviews are
waiting?" in ONE round trip. The former `/api/account` → `/api/admin/summary`
chain paid two JWKS verifies and two `profiles` reads, and the second hop's
latency was the visible lag before the Admin section appeared. `GET
/api/admin/summary` is unchanged and remains the `/admin` SSR resolver's gate and
the in-shell badge feed.

Errors: `UNAUTHENTICATED`.

#### `PATCH /api/account`

Update the editable profile fields (today: `display_name`). Audited
(`profile.updated`). Returns the updated `AccountProfileResponse` — including
`role` and the admin-only `pending_reviews`, on the same rules as `GET`.

```typescript
export const UpdateAccountSchema = z.object({
  display_name: z.string().trim().min(1).max(80).nullable(),
});
```

Errors: `UNAUTHENTICATED`, `VALIDATION_FAILED`.

#### `DELETE /api/account`

Delete the authenticated user's account (GDPR right-to-erasure, `AUTH_AND_RLS.md`
§8). In one transaction: anonymizes reviews (sets `reviewer_id = null`), nulls
every other inbound reference to the profile, deletes the profile, then deletes
the Supabase `auth.users` row (raw SQL, same transaction — see AUTH_AND_RLS §8 for
why not the Admin API). Audited `account.deleted` (no PII). A Resend confirmation
email is sent fire-and-forget after erasure (AECI-240 / Phase 7.5, fail-open — the
deletion never depends on it); recipient is captured from the session before the
`auth.users` row is removed. See `docs/email.md`.

```typescript
export interface DeleteAccountResponse {
  message: string;
}
```

Errors: `UNAUTHENTICATED`.

#### `GET /api/account/reviews`

List the authenticated user's **own** reviews for the `/account` page (AECI-225 /
Phase 5.11). Scope is server-set to `reviewer_id = session.userId` (the verified
token `sub`) — never a client-supplied id. Unlike the public
`GET /api/products/:slug/reviews` (approved-only, no PII), this returns the
caller's reviews in **every** status (`pending` / `approved` / `rejected`) plus
`rejection_reason`, so the author can see where each one stands. It carries no
admin-only signals (`reviewer_email`, `toxicity_score`, `locale`, moderation
columns). Shapes live in `packages/shared/src/api/account.ts`.

Query is `AccountReviewsQuerySchema` (page-based: `page` / `perPage`); order is
fixed newest-first (`created_at desc`, `id asc` tiebreak), so there is no `sort`
param. `Cache-Control: private, no-store`.

An optional `product_id` (UUID) **narrows** the caller's list to a single
product (AECI-260) — it never widens scope (reviewer scope stays server-set to
`session.userId`; a present `reviewer_id` is still ignored). It powers the cheap
"have I already reviewed this product?" check behind the personalized review CTA
and the review-form guard (`STAGE_1_PHASE_5_SPEC.md` §5.5): a non-empty result
(`total >= 1`) means a blocking review exists. A malformed `product_id` is a
`VALIDATION_FAILED` `400`. (Caveat: the endpoint applies no `status` filter, so
the result equals the server's *non-archived* duplicate rule only because no
review-archival flow exists yet — revisit the filter if one is added.)

```typescript
export const AccountReviewSchema = z.object({
  id: z.string().uuid(),
  product: LinkRefSchema,                       // { id, name, slug }
  rating_overall: z.number().int().min(1).max(5),
  rating_onboarding: z.number().int().min(1).max(5),
  title: z.string(),
  status: ReviewStatusSchema,                   // 'pending' | 'approved' | 'rejected'
  rejection_reason: z.string().nullable(),      // non-null only when rejected
  created_at: z.string().datetime(),
});
// Response: PaginatedResponse<AccountReview> ({ data, page, perPage, total }).
```

Errors: `UNAUTHENTICATED`.

> **Pagination note.** AECI-225's issue text said "cursor pagination", but this
> endpoint is **page-based** to stay consistent with every other list endpoint
> (Phase 2 Spec §7.3) — the codebase has no cursor infrastructure and a user's
> own-reviews list is inherently small. Documented here as the intentional
> deviation from the issue wording.

#### `POST /api/auth/profile/ensure`

Idempotent profile-ensure called by the SSR `/auth/callback` handler after the PKCE code exchange (AECI-195, `STAGE_1_PHASE_5_SPEC.md` §4.2). Requires a verified Supabase user JWT (`Authorization: Bearer`); the profile id is always the token's `sub` — no request body.

Under ADR 0016 the authoritative `profiles` row lives in **D1** and there is **no** `handle_new_user` trigger, so this endpoint is the **primary** profile creator (split-identity seam #1 — `AUTH_AND_RLS.md` §3.1), not a backstop. `INSERT … ON CONFLICT DO NOTHING … RETURNING` makes it idempotent and race-correct: only the insert that actually created the row returns an id (`created: true`) and writes the `profile.created` audit row; a concurrent loser or a re-run returns `created: false` with no audit. All other columns take schema defaults, including `role='reviewer'`.

**The conflict path never overwrites an existing row** — the insert supplies only `id`. That is the no-clobber guarantee the vendor-claim grant depends on (AECI-527/AECI-519, `STAGE_2_VENDOR_PORTAL_SPEC.md` §2): a grant that lands *before* the claimant's first sign-in survives it, so `role='vendor_admin'`, `vendor_id`, `display_name`, and `theme_preference` are all preserved.

```typescript
export type EnsureProfileResponse = {
  created: boolean; // false = row already existed (the normal case)
};
```

Errors: `UNAUTHENTICATED`.

### 6.9 Tracking

#### `POST /api/page-views`

Lean fire-and-forget capture hook for pageviews per Phase 2 Spec §7.1. Returns `204` with no body. The shape was simplified from the earlier `TrackPageviewSchema` draft (path / product_id / vendor_id / session_id / referrer) to match the Phase 2 contract.

```typescript
export const PageViewPayloadSchema = z.object({
  route: z.string().min(1),
  path: z.string().min(1).max(2048).optional(),      // AECI-585 — concrete path
  navigation: z.enum(['spa', 'arrival']).optional(), // AECI-585
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
  ref_source: z.string().max(64).optional(),         // AECI-243 campaign attribution
  ref_token: z.string().max(255).optional(),
});

export type PageViewPayload = z.infer<typeof PageViewPayloadSchema>;
```

**Phase 4 (AECI-177) wires the write.** The handler validates the body synchronously (so a malformed body still surfaces `400`), returns `204` immediately, and inserts one `page_views` row via `ctx.waitUntil()` — the write never blocks the response (§14.2). A capture failure is logged to Datadog (`warn`) and swallowed; the endpoint still returns `204`. User-blocking errors are never raised.

**Enrichment** (DATABASE_SCHEMA §9.1 columns): `cf_country`, `cf_colo`, `cf_asn`, `cf_as_organization`, `cf_bot_score` from Cloudflare request context; `user_agent_hash` = SHA-256 of the `User-Agent` (the raw UA is **never** stored); `locale` = the served locale (`en-US` today); and the entity columns resolved from `(entity_type, entity_id)` — `entity_id` is the entity's own UUID (the SSR resolvers attach `entity.id`), existence-checked before storing so a stale/spoofed id becomes null rather than an FK error. **No raw IP is ever persisted** (§14.2 privacy).

**AECI-585 (`ADMIN_PANEL_SPEC.md` §7.3) widened what a row records**, and every part of it is write-time-only — nothing here is recoverable from a row that lacks it:

- **`entity_type` now covers the four taxonomy facets**, not just `product` / `vendor`. `category` / `audience` / `phase` / `trade` land in `taxonomy_kind` + `taxonomy_id`. The SSR resolvers always sent them; the handler used to drop them, so ~600 rows could say a facet page was viewed but not which term. The kind is stored **only** alongside a confirmed id — a dangling kind would inflate every per-facet count with unattributable rows. An unrecognized `entity_type` is ignored, not an error.
- **`path`** is the concrete URL path, stored in `concrete_path` beside the `route` pattern in `path`. Optional: the API falls back to `route`, which is correct for every writer whose route is already concrete (the browser tracker, an SSR cache HIT). Only a writer sending a *pattern* owes an explicit `path`. Locale prefix stripped, no query or hash — the same privacy rule that keeps the full URL out of `referrer` (§9.7) applies here.
- **`navigation`** distinguishes a full-document `'arrival'` from an in-app `'spa'` hop. Never inferred: an omitted flag stores as null. It exists because the same-origin `Referer` on an SPA hop classifies as `Direct`, making `Direct` — the largest bucket in every digest — a mix of true arrivals and in-app clicks. A value outside the enum is a `400`, like any other schema violation.
- **`user_id` / `session_id` / `profile_role` were dropped** (§13 D7). They were never written; see `DATABASE_SCHEMA.md` §9.1 for why they were dropped rather than filled.

**CF context forwarding contract.** The browser POST reaches the SSR Worker first, and `request.cf` does **not** survive the SSR→API service binding, so the SSR Worker forwards the CF fields on trusted headers (`@aeci/shared` `PAGE_VIEW_CF_HEADERS`):

| Header | Source (`request.cf`) | `page_views` column |
|---|---|---|
| `x-aeci-cf-country` | `cf.country` | `cf_country` |
| `x-aeci-cf-colo` | `cf.colo` | `cf_colo` |
| `x-aeci-cf-asn` | `cf.asn` | `cf_asn` |
| `x-aeci-cf-as-organization` | `cf.asOrganization` | `cf_as_organization` |
| `x-aeci-cf-bot-score` | `cf.botManagement.score` | `cf_bot_score` |

`x-aeci-cf-as-organization` (AECI-585 / §13 D10) reuses the header name `LANDING_CF_HEADERS` already carries it under, deliberately: both proxies read the same `request.cf` field onto the same wire name, so the two enrichment paths cannot drift apart on it. It is a **read-side label only** — it never feeds `is_bot` at ingest.

The SSR Worker is the **sole writer** of these headers: on the `/api/page-views` proxy path it strips any client-supplied copies (anti-spoof) before setting them from `request.cf`. The API Worker treats them as trusted because it has no public ingress (service-binding only); it falls back to a directly-present `request.cf` for local/test runs.

**Two writers, de-duped.** The browser `PageViewTracker` (AECI-151) is the canonical per-view counter; the SSR Worker's `firePageView` is a supplementary write that adds CF/bot context on full-document renders. They don't double-count — the client tracker skips the initial navigation (the SSR Worker already counted the landing arrival) and only counts subsequent in-app navigations. The SSR path undercounts because true edge-cache hits bypass the SSR Worker (§14.2, accepted). Both writers carry the same `PAGE_VIEW_CF_HEADERS` enrichment.

That split is exactly what `navigation` records, and each writer states its own half as a fact rather than a guess: the tracker sends `'spa'` because it fires only on in-app navigation, and `firePageView` stamps `'arrival'` because every write through it is a full-document load. `firePageView` also stamps `path` from the request URL, so a resolver-attached payload carrying a route *pattern* gains the concrete path without any resolver changing — both fields are set at that one choke point and override whatever the caller passed, since the request URL is the authority on where the visitor is.

**Public routes only (AECI-575).** Both writers skip the operator-only prefixes in `@aeci/shared` `UNTRACKED_ROUTE_PREFIXES` — `/admin` and `/account`, matched on an exact prefix boundary via `isUntrackedRoute()`, so nested admin routes are covered without enumeration and `/administrators` is not. Recording them would mean the admin console writes a row into the table it reads, from the operator's own ISP (`ADMIN_PANEL_SPEC.md` §9.6; on 2026-08-10 that was 67 of 92 "human" views). The exclusion is enforced at the **writers**, not at this endpoint — a `route` of `/admin/reviews` posted directly is still accepted and inserted — because the rule belongs where nothing is sent at all; the read side (the daily digest) applies the same prefix list, which is also what neutralizes rows written before this shipped and anything a stale client emits. This is an exclusion list, not a consent concept: `page_views` ingest stays consent-independent by design.

**Bot-score sampling** is a deferred §14.2 policy: the `PAGE_VIEWS_MIN_BOT_SCORE` env knob (unset everywhere today → capture all) drops views below the floor when set. Nothing is hardcoded to drop.

**No audit log.** §26.1 scopes `appendAuditLog()` to *state-changing* domain writes; `page_views` is a read-analytics log, so no audit row is written.

### 6.10 Admin endpoints

All require `role === 'admin'`, enforced by the `requireAdmin()` Worker middleware (`apps/api/src/lib/authz.ts`, Phase 5.5) — verifies the JWT, loads `profiles.role`, rejects non-admins (`403`) and missing token/profile (`401`) before the handler. RLS is defense-in-depth for the PostgREST surface.

#### `GET /api/admin/summary`

The admin shell's badge feed (AECI-203 / Phase 5.12). Read-only aggregate counts; a bare object (no pagination envelope). Phase 5.12 ships only the pending-review count (`STAGE_1_SPEC.md` §22.1); Phase 6 extends it with request counts. A 200 also serves as the SSR `/admin` gate signal — the resolver maps a `401`/`403` to a `404` render (don't reveal the surface).

```typescript
export const AdminSummaryResponseSchema = z.object({
  pending_reviews: z.number().int().nonnegative(),
});
export type AdminSummaryResponse = z.infer<typeof AdminSummaryResponseSchema>;
```

Source of truth: `packages/shared/src/api/admin.ts`. Implemented in `apps/api/src/routes/admin-summary.ts` (a Drizzle/D1 count of `reviews` where `status = 'pending'`). Read-only — no audit log.

**Callers (AECI-617).** This endpoint serves the `/admin` SSR resolver (its 200/403 IS the gate) and the in-shell badge. It is **no longer** the header's badge feed: `AdminStatus` used to chain `GET /api/account` → here, paying a second JWKS verify and a second `profiles` read whose latency showed as lag before the "More" menu's Admin section appeared. The same count now rides on `GET /api/account` as `pending_reviews` (§6.8), so the header needs one round trip. Both surfaces seed the same client-side `AdminSummaryStore`, so the number stays consistent.

#### `GET /api/admin/reviews`

```typescript
export const ListPendingReviewsQuerySchema = PaginationQuerySchema.extend({
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  sort: z.enum(['created_at', 'queue_age']).default('queue_age'),
});

export type AdminReview = Review & {
  status: 'pending' | 'approved' | 'rejected';
  toxicity_score: number | null;   // from the toxicity scorer (Claude), 0–100
  product: ProductRef;
  reviewer_email: string | null;   // visible to admins only; null on anonymized reviews
  reviewer_firm: string | null;    // AECI-284: free-text firm, admin-only moderation context
};

export type ListPendingReviewsResponse = PaginatedResponse<AdminReview>;
```

#### `PATCH /api/admin/reviews/:id`

```typescript
export const ModerateReviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  rejection_reason: z.string().max(500).optional(),
});

// AECI-218 (Phase 6.11): the response is an ENVELOPE — the moderated review plus
// an advisory repeat-offender prompt. `repeat_offender` is non-null ONLY on the
// reject that brings the reviewer's total rejected-review count to ≥ 3 (their
// "3rd review rejected", §22.3); null on approve / 1st–2nd rejection / anonymized
// reviews (`reviewer_id IS NULL`). It is informational — the admin decides whether
// to ban via `PATCH /api/admin/reviewers/:id`. `reviewer_id` is the ban target.
export const RepeatOffenderPromptSchema = z.object({
  reviewer_id: z.string().uuid(),
  reviewer_email: z.string().nullable(),
  rejected_count: z.number().int(),
});

export const ModerateReviewResponseSchema = z.object({
  review: AdminReviewSchema,
  repeat_offender: RepeatOffenderPromptSchema.nullable(),
});
export type ModerateReviewResponse = z.infer<typeof ModerateReviewResponseSchema>;
```

Errors: `NOT_FOUND`, `INVALID_STATE_TRANSITION` if review is not in `pending` status.

#### `GET /api/admin/requests`

Lists vendor requests (claims and corrections). Implemented in AECI-216 (Phase 6.9).
Source of truth: `packages/shared/src/api/admin-requests.ts` (Zod), `apps/api/src/routes/admin-requests.ts` (handlers).

```typescript
// PageQuerySchema (page/perPage), not the older offset/limit PaginationQuerySchema
// — this section was the "pending realignment" the §6 note flags.
export const ListVendorRequestsQuerySchema = PageQuerySchema.extend({
  kind: z.enum(['claim', 'correction']).optional(),
  status: z.enum(['open', 'resolved', 'rejected']).default('open'),
});

export const AdminVendorRequestSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['claim', 'correction']),
  // `in_review` (set by the inbound Linear webhook, §6.11) is a valid row status
  // even though it is NOT a `status` filter value above — such rows are not
  // reachable by any filter (known gap; the default `open` view excludes them).
  status: z.enum(['open', 'in_review', 'resolved', 'rejected']),
  target_type: z.enum(['product', 'vendor']),
  target_id: z.string().uuid(),
  // Hydrated link to the target product/vendor (id/name/slug), resolved from
  // `(target_type, target_id)` against the products OR vendors table (AECI-217).
  // `null` when the referenced row is missing (deleted/un-promoted). The
  // `target_type` discriminator stays on the row so the UI picks `/products`
  // vs `/vendors`.
  target: LinkRefSchema.nullable(),
  submitter_email: z.string(),
  submitter_name: z.string().nullable(),
  submitter_role: z.string().nullable(),
  // Surfaced VERBATIM from the DB (`pending|match|no_match|manual_review`). This
  // deviates from §7.1's yes/no framing; computing it is a 6.8 (AECI-215)
  // concern, so until that lands every row reads `pending`.
  domain_match: z.string(),
  body: z.string(),
  source_url: z.string().nullable(),
  // COMPUTED at read time (no column): an OPEN sibling request shares the same
  // `(kind, target_type, target_id)` or `(submitter_email, target_type,
  // target_id)` (Phase 6 Spec §7.2). Informational only.
  is_duplicate: z.boolean(),
  // COMPUTED at read time on the LIST path only (AECI-527): does a Supabase
  // `auth.users` row already exist for `submitter_email`? `true` → approving the
  // claim LINKS that account; `false` → it PROVISIONS one. `null` = unknown —
  // `kind='correction'`, absent Supabase admin creds, a failed GoTrue lookup, or
  // the single-row PATCH confirmation. Informational; never gates a decision.
  // See STAGE_2_VENDOR_PORTAL_SPEC.md §2.
  has_auth_account: z.boolean().nullable(),
  linear_issue_id: z.string().nullable(),
  // AECI-261: the linked Linear issue's web permalink (`issue.url`), persisted on
  // creation and the inbound webhook so /admin/requests renders a real link. Null
  // when unlinked or for rows linked before this column existed (no backfill).
  linear_issue_url: z.string().nullable(),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable(),
  resolved_by: z.string().uuid().nullable(),
});
export type AdminVendorRequest = z.infer<typeof AdminVendorRequestSchema>;

export type ListVendorRequestsResponse = PaginatedResponse<AdminVendorRequest>;
```

The target is the loose-polymorphic `(target_type, target_id)` pair — no FK. The
list/PATCH handlers hydrate it into `target` (a `LinkRef`) by resolving `target_id`
against the products OR vendors table (AECI-217), since detail pages are slug-only
(no by-id route). A `null` `target` means the referenced row is gone; the
`/admin/requests` UI falls back to a non-linked label.

#### `PATCH /api/admin/requests/:id`

Resolve or reject an open (or in-review) request.

```typescript
export const ModerateRequestSchema = z.object({
  action: z.enum(['resolve', 'reject']),
  // Optional for BOTH actions (unlike `ModerateReviewSchema`) — `vendor_requests`
  // has no rejection-reason column, so the reason is recorded in the
  // `workflow_transitions.reason` + audit-log metadata, never stored on the row.
  reason: z.string().max(500).optional(),
});

export type ModerateRequestResponse = AdminVendorRequest;
```

`resolve` → `status='resolved'`; `reject` → `status='rejected'`; both set
`resolved_by`/`resolved_at`, append an `audit_log` + a `workflow_transitions` row,
and (post-commit, best-effort) push the change to the linked Linear issue (§6.5).

Errors: `NOT_FOUND` (unknown id); `INVALID_STATE_TRANSITION` if the request is
not `open`/`in_review` (already terminal, or a concurrent action moved it).

#### `GET /api/admin/claims` (Stage 2 — AECI-521)

The **claim-review queue**: pending vendor **claims** enriched with the reviewer-assist
verification signals a human weighs before granting (`STAGE_2_VENDOR_PORTAL_SPEC.md` §5 —
**no auto-grant**). Clones `GET /api/admin/requests` (same paginated envelope, same read-time
`is_duplicate` + `has_auth_account` computation) but is **claims-only** and **read-only** (no
audit). Behind `requireAdmin()`. Source of truth: `packages/shared/src/api/admin-claims.ts`,
`apps/api/src/routes/admin-claims.ts`.

```typescript
export const ListVendorClaimsQuerySchema = PageQuerySchema.extend({
  status: z.enum(['open', 'resolved', 'rejected']).default('open'), // no `kind` — claims only
});

// Each item is an `AdminClaim` = `AdminVendorRequest` (§6.7 shape: id, kind, status,
// target_type/target_id/target, submitter_*, domain_match, body, source_url, is_duplicate,
// has_auth_account, linear_*, created_at, resolved_*) PLUS three claim-only signals:
export const AdminClaimSchema = AdminVendorRequestSchema.extend({
  duplicate_of_request_id: z.string().uuid().nullable(), // the Phase-6 duplicate chain
  existing_seats: z.array(z.object({                     // active vendor_admin seats on the vendor
    display_name: z.string().nullable(),
    work_email_verified: z.boolean(),
    created_at: z.string(),
  })).nullable(),                                         // null = signal unavailable, [] = none
  related_requests: z.array(z.object({                   // prior requests from the same email
    id: z.string().uuid(),
    kind: z.enum(['claim', 'correction']),
    status: z.enum(['open', 'in_review', 'resolved', 'rejected']),
    target_type: z.enum(['product', 'vendor']),
    created_at: z.string(),
  })).nullable(),                                         // null = signal unavailable, [] = none
});

export const ListVendorClaimsResponseSchema = paginatedResponseSchema(AdminClaimSchema);
// { data: AdminClaim[], page, perPage, total }
```

Signals: `domain_match` (stored verbatim), `has_auth_account` (tri-state via the GoTrue
`fetchAuthAccountsByEmail` seam — `null` when creds absent / lookup fails), `existing_seats`
(one grouped `profiles` scan over the page's target vendors; a `product` claim resolves to its
primary vendor), `related_requests` (other `vendor_requests` sharing the `submitter_email`,
excluding self) + `duplicate_of_request_id`. The LinkedIn/person search link is **built
client-side** (a link only — no claimant data leaves AECi; real enrichment is deferred, §11).
**Graceful degrade:** the two enrichment queries are fail-soft — a failure sets that field to
`null` ("unavailable") while the row and the rest of the signals still return. No errors beyond
the shared `requireAdmin()` 401/403.

#### `PATCH /api/admin/claims/:id` (Stage 2 — AECI-519)

Approve (grant a verified vendor account) or reject a vendor **claim**. A sibling
of `PATCH /api/admin/requests/:id`, not a replacement: a claim moderates here so
`approve` runs the grant batch (`STAGE_2_VENDOR_PORTAL_SPEC.md` §3) instead of a
plain resolve. **Corrections still moderate through `/api/admin/requests/:id`** —
this endpoint 422s a non-claim request. Behind `requireAdmin()`. Source of truth:
`packages/shared/src/api/admin-claims.ts`, `apps/api/src/routes/admin-claims.ts`.
The `/admin/claims` LIST + reviewer UI is AECI-521; the claim-decision email
*sender* shipped in AECI-528 — the real `lib/email.ts` `sendClaimDecisionEmail`
is injected into the post-commit seam at the route registration (`index.ts`),
fail-open like every send.

```typescript
export const ClaimEntitlementSchema = z.object({
  // The offline PO/invoice arrangement — the launch entitlement record. Stored in
  // the grant's audit_log metadata, NEVER a new column (AECI-515 formalizes the
  // real model later). `amount` is free-form (currency-agnostic).
  payer: z.string().max(200).optional(),
  amount: z.string().max(100).optional(),
  terms: z.string().max(500).optional(),
  arranged_by: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
});

export const ModerateClaimSchema = z.object({
  action: z.enum(['approve', 'reject']),
  reason: z.string().max(500).optional(),     // internal transition + audit note only; never emailed to the claimant (the claim-rejected email is deliberately neutral, AECI-528)
  entitlement: ClaimEntitlementSchema.optional(), // approve only
});

export const ModerateClaimResponseSchema = z.object({
  request: AdminVendorRequestSchema,          // the moderated claim row
  grant: z.object({                           // null on reject
    user_id: z.string().uuid(),
    vendor_id: z.string().uuid(),
    verified: z.boolean(),
    identity_outcome: z.enum(['linked', 'invited']), // linked existing vs provisioned
    seat_created: z.boolean(),                // a new profiles row was written
  }).nullable(),
});
```

`approve`: resolve the claimant's auth-user id (link or provision — AECI-527), then
in one atomic `db.batch` upsert the `profiles` seat (`role='vendor_admin'`,
`vendor_id`; no-clobber), flip `vendors.verified=true` (+ `updated_at`; guarded so a
second seat doesn't re-flip), resolve the request, advance the `vendor_claim`
workflow, and audit (`vendor_claim.granted`, with the entitlement in metadata).
Post-commit (best-effort): enqueue a Cache-Tag purge for the vendor **and its
products** (`{ tags: ['vendor:<slug>', 'product:<slug>'…, 'index:products'], source:
'moderation' }`) and fire the claim-approved email. A `target_type='product'` claim
grants the product's **primary** vendor. Re-granting an already-granted claim is a
**200 no-op** (no duplicate audit).

`reject`: resolve the request to `rejected`, advance the workflow, audit
(`vendor_claim.rejected`); no vendor mutation, no purge, no identity resolution;
fire the claim-rejected email.

Errors:
- `GRANT_CONFLICT` (409) — the claimant account is a site `admin`, or already
  linked to a **different** vendor; `details.reason` ∈ `already_admin` | `other_vendor`;
  nothing is written. (A second seat on the **same** vendor is allowed, not a conflict.)
- `DEPENDENCY_FAILURE` (503) — claimant identity resolution is unavailable
  (`SUPABASE_SERVICE_ROLE_KEY` absent — local dev and PR previews only, since
  AECI-530 CI-pushes it on staging/demo/production) or upstream GoTrue errored; the
  grant refuses rather than half-grant.
- `INVALID_STATE_TRANSITION` (422) — the request is not a claim, is already terminal
  (and not an exact re-grant), or a claimed product has no vendor.
- `NOT_FOUND` (404) — unknown request id, or the resolved vendor is missing.

#### `GET /api/admin/reviewers`

Lists the currently-banned reviewers (newest ban first). Implemented in AECI-218
(Phase 6.11). The ban *action* is triggered from the review-queue's 3rd-rejection
prompt; this list is the home for **unbanning**. `reviewer_email` is admin-only
(read from `auth.users.email` via the same privileged `$queryRaw` the moderation
queue uses) and degrades to `null` on a lookup failure. Source of truth:
`packages/shared/src/api/admin-reviewers.ts`, `apps/api/src/routes/admin-reviewers.ts`.

```typescript
export const ListBannedReviewersQuerySchema = PageQuerySchema; // page/perPage

export const BannedReviewerSchema = z.object({
  reviewer_id: z.string().uuid(), // = profile id = auth.users.id = reviews.reviewer_id
  reviewer_email: z.string().nullable(),
  banned_at: z.string().datetime(),
  ban_reason: z.string().nullable(),
});

export type ListBannedReviewersResponse = PaginatedResponse<BannedReviewer>;
```

#### `PATCH /api/admin/reviewers/:id`

Ban or unban a reviewer (a `profiles` row); `:id` is the profile id. Sets/clears
`profiles.banned_at` + `profiles.ban_reason` (§22.3). Ban *enforcement* (rejecting a
banned user's `POST /api/reviews`) already shipped in Phase 5 (AECI-197) — this is
the *management* half.

```typescript
export const BanReviewerSchema = z.object({
  action: z.enum(['ban', 'unban']),
  // Required (non-empty) when action === 'ban' — enforced by a cross-field refine
  // (mirrors ModerateReviewSchema). Stored on `profiles.ban_reason`; cleared on unban.
  reason: z.string().max(500).optional(),
});

export const BanReviewerResponseSchema = z.object({
  reviewer_id: z.string().uuid(),
  banned_at: z.string().datetime().nullable(), // null after unban
  ban_reason: z.string().nullable(),
});
export type BanReviewerResponse = z.infer<typeof BanReviewerResponseSchema>;
```

`ban` sets `banned_at = now()` + `ban_reason`; `unban` clears both. Both append an
`audit_log` (`reviewer.banned` / `reviewer.unbanned` — or `vendor_admin.banned` /
`.unbanned` for a vendor seat, see below — with before/after state) + a
`workflow_transitions` row on a long-lived **reversible** `reviewer_ban` workflow
(`active ↔ banned`; no terminal `final_outcome`). No cache invalidation — a ban
changes no cacheable page (a banned reviewer's approved reviews stay visible, flagged
internally only, §22.3).

**Stage 2 (AECI-524):** the ban `UPDATE` is role-agnostic (the `FORBIDDEN` guardrail
exempts only admin accounts and self), so this same endpoint bans a **`vendor_admin`
seat** — a banned seat then fails every `/api/vendor/*` call via the per-request ban
check (`AUTH_AND_RLS.md` §4.2). The request/response contract is unchanged; only the
audit `action` and the `aeci.moderation.ban` `role:` tag become role-aware. The ban is
**per-seat** — it never touches the vendor's other seats or `vendors.verified`
(`STAGE_2_VENDOR_PORTAL_SPEC.md` §7). The `reviewer_id` field name is retained; for a
vendor seat it is simply the seat's profile id.

Errors: `NOT_FOUND` (unknown profile id); `INVALID_STATE_TRANSITION` (422) when
banning an already-banned reviewer, unbanning one who isn't banned, or a concurrent
flip; `FORBIDDEN` (403) when the target is an admin account or the acting admin
themselves (a banned admin would lock themselves out of `requireAdmin()`).

---

#### Admin panel reads (AECI-574 / Phase 8.3 P1.1, extended by AECI-577 / P1.3, AECI-579 / P1.5, AECI-580 / P1.6, and AECI-586 / P5.1)

Eight `GET`s serving the operator console (`docs/ADMIN_PANEL_SPEC.md` §5–§6).
Source of truth: `packages/shared/src/api/admin-panel.ts` (Zod), and
`apps/api/src/routes/admin-{overview,metrics,traffic,page-views,catalog,system,audience,feedback}.ts` +
`lib/admin-{analytics,catalog,status,audience}.ts` (handlers). They register on the
same `authAdmin` sub-router behind `requireAdmin()` — no new gate.

**Every `page_views` read carries the §13 D12 floor.** `/admin/*` and `/account`
rows are excluded *beneath* the caller's filters, historical rows included, via
`inWindow()` in `lib/admin-analytics.ts` — the single choke point every query in
that module derives its base predicate from. It is not a query parameter and
cannot be turned off. It is also deliberately silent: unlike the ASN filter it is
not a heuristic over real visitors, so there is no false-positive class to
disclose and no "N excluded" figure to report.

**Conventions that apply to all six.** Read-only: **no `audit_log` row** (reads
emit nothing, §26.1 as scoped by ADR 0022). **No `Cache-Tag`, no edge caching** —
`json()` sets `private, no-store` and `/admin/*` is absent from
`ROUTE_CACHE_PATTERNS` in `server-runtime.ts`, which `server.spec.ts` asserts; a
cached admin response is a visitor-state leak (panel spec §9.2). Response shapes
are Zod-validated in dev/preview/staging via `validateResponseInDev`.

##### The honesty envelope

Every response carries its window and the biases that apply to it, as
**machine-readable notes** — the UI localizes prose from `code` + `params`;
`message` is an untranslated operator fallback (curl / logs), matching the
`label` fallback on breakdown rows.

```typescript
export const AdminWindowSchema = z.object({
  from: z.string().datetime(),   // INCLUSIVE, UTC
  to: z.string().datetime(),     // EXCLUSIVE, UTC
  timezone: z.literal('UTC'),    // the only timezone this API speaks (§9.5)
  days: z.number().int().positive(),
});

export const AdminNoteCodeSchema = z.enum([
  'partial_day',                       // window overlaps the current UTC day
  'bot_classification_incomplete',     // N rows have is_bot IS NULL → counted HUMAN
  'referrer_source_incomplete',        // N human rows have no referrer_source
  'direct_is_mixed_bucket',            // Direct mixes SPA hops with real arrivals
  'visitor_definition_approximate',    // §9.8 (user_agent_hash, cf_asn)
  'catalog_series_is_additions_only',  // catalog.* are events, never net totals (§4)
  'catalog_series_starts_at',          // window predates the audit log
  'internal_filter_unavailable',
  'internal_filter_applied',
  'requires_recompute',                // an expensive status item was omitted
  'algolia_credentials_absent',
  // AECI-579 / P1.5 — catalog coverage
  'funnel_is_promoted_cohort_only',    // every product reads 'promoted' (§13 D6)
  'trade_facet_sparse_by_design',      // untagged trades are not a backlog
  'api_docs_flag_inconsistent',        // has_api_docs set with no api_docs_url
  // AECI-580 / P1.6 — system status
  'cron_liveness_unavailable',         // N of 8 crons have no last-run record
  'orphan_sweep_not_persisted',        // the sweep's result is stored nowhere
  // AECI-586 / P5.1 — audience
  'utm_attribution_incomplete',        // N of M signups in the window carry no utm_source
  'audience_history_is_current_state', // a resubscribe erases the churn it is computed from
]);

export const AdminNoteSchema = z.object({
  code: AdminNoteCodeSchema,
  severity: z.enum(['info', 'warn']),
  message: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
```

The bias flags are **derived by querying the window**, never keyed to a hardcoded
date: `bot_classification_incomplete` fires because the window actually contains
`is_bot IS NULL` rows. It duly retired itself when AECI-582 backfilled those rows
on 2026-08-13 — no code change, and no stale date left behind asserting a bias
that no longer exists. It stays in the contract because a future ingest gap would
re-open the same hole, and callers should keep handling the code.

##### `ANALYTICS_INTERNAL_ASNS` — both numbers, never one (§13 D10)

Every traffic count is an `AdminCount` whose `total` is **always the unfiltered
figure**. The read-time ASN filter only ever adds a second number beside it, so a
filtered figure can never be reported as *the* figure.

```typescript
export const AdminCountSchema = z.object({
  total: z.number().int().nonnegative(),                     // ALWAYS unfiltered
  excluding_internal: z.number().int().nonnegative().nullable(), // null when unavailable
});

export const AdminInternalFilterSchema = z.object({
  available: z.boolean(),  // ANALYTICS_INTERNAL_ASNS parses to ≥1 ASN
  applied: z.boolean(),    // available AND requested for this query
  asns: z.array(z.number().int().positive()),
});
```

The var ships **unset** on every tier (`docs/environments.md`); absent → the
filter is unavailable, `excluding_internal` is null everywhere, and the UI hides
the toggle. It is a `WHERE` clause only — it never touches `is_bot` and never runs
at ingest (`apps/api/src/lib/internal-asns.ts`).

#### `GET /api/admin/overview`

The §5.1 bundle in one round trip.

```typescript
export const AdminOverviewQuerySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // default: prior COMPLETE UTC day
  recompute: z.enum(['0', '1']).default('0').transform((v) => v === '1'),
});

export const AdminOverviewResponseSchema = z.object({
  window: AdminWindowSchema,
  generated_at: z.string().datetime(),
  source: AdminMetricSourceSchema,   // 'live' | 'snapshot' | 'mixed'
  recomputed: z.boolean(),
  notes: z.array(AdminNoteSchema),
  internal_filter: AdminInternalFilterSchema,
  traffic: z.object({
    page_views_human: AdminCountSchema,
    page_views_bot: AdminCountSchema,
    unique_visitors: AdminCountSchema,      // DISTINCT (user_agent_hash, cf_asn)
    delta_day: AdminDeltaSchema,            // human views, day over day
    delta_7d: AdminDeltaSchema,             // 7 days ending here vs the 7 before
    series_30d: z.array(AdminTrafficPointSchema),   // zero-filled { day, human, bot }
    top_sources: z.array(AdminSourceCountSchema),
    top_products: z.array(AdminProductViewsSchema), // { name, slug, views }
  }),
  audience: z.object({
    new_sign_ins: AdminDeltaSchema,
    total_users: z.number().int().nonnegative(),
    active_subscribers: z.number().int().nonnegative(), // unsubscribed_at IS NULL
  }),
  catalog: AdminOverviewCatalogSchema,      // products/integrations/vendors/claims/attestations
  status: AdminStatusStripSchema,
});

// Structured, not prose — the semantics are the digest's, the strings are the UI's.
export const AdminDeltaSchema = z.object({
  current: z.number().int(),
  prior: z.number().int(),
  diff: z.number().int(),
  pct: z.number().nullable(),   // null when prior === 0 (the email omits it too)
});
```

**Digest parity is structural.** The handler *calls* `collectAnalyticsMetrics`
(`lib/analytics-digest.ts`) rather than re-implementing it, and deltas come from
the exported `computeDelta` that `deltaText` itself uses. The default window is
the digest's own (`windowsForDay(dailyWindows(now).dayLabel)`), so
`GET /api/admin/overview` with no params reports exactly what the 05:00 email
reported. `admin-overview.spec.ts` asserts this against a seeded fixture.

**Status strip and `?recompute=1` (§13 D8).** The first three items are cheap
D1/env reads and are always present. The last two need the network — the
data-quality suite HTTP-probes logo URLs, and drift queries three Algolia indexes
— so the default response returns them as `null` plus a `requires_recompute`
note, and `?recompute=1` runs them live:

| Field | Source | Default | `?recompute=1` |
|---|---|---|---|
| `version` | `COMMIT_SHA` / `DEPLOYED_AT` / `ENV` | ✅ | ✅ |
| `stats_freshness` | `MAX(stats_cache.computed_at)`, stale > 48 h | ✅ | ✅ |
| `moderation` | pending reviews + open `vendor_requests` | ✅ | ✅ |
| `data_quality` | all ten §23.1 checks (`runDataQualityChecks`) | `null` | ✅ |
| `algolia_drift` | `findAlgoliaIndexDrift` per index | `null` | ✅ |

`?recompute=1` is still a **pure read**: both jobs are already read-only, so it
writes nothing, sends no email, and carries no `audit_log` obligation — which is
what keeps "all endpoints are GET, read-only" unconditionally true. The
side-effecting `POST /api/admin/jobs/:job/run` stays deferred and is not built.
Data-quality check #10 *is* the Algolia drift check, so the drift runner is
invoked once and its result feeds both. No Algolia credentials → `algolia_drift`
is `null` + an `algolia_credentials_absent` note (never a fabricated zero); a
drift call that throws leaves `algolia_drift` null and surfaces the reason on the
`algolia_index_drift` check instead.

Errors: `VALIDATION_FAILED` (400) for a `day` that matches `YYYY-MM-DD` but is not
a real calendar date.

#### `GET /api/admin/metrics/timeseries`

One metric, day-bucketed. Reads the `metrics_daily` snapshot per day and falls
back to live aggregation for any day it does not cover (P2.1 / AECI-581) — a
storage swap behind an unchanged shape, which is why the metric keys are §7.1's
`namespace.metric` strings verbatim.

```typescript
export const AdminMetricKeySchema = z.enum([
  'traffic.page_views_human',      // page_views, is_bot IS NOT 1 (the digest predicate)
  'traffic.page_views_bot',        // page_views, is_bot = 1
  'traffic.unique_visitors',       // DISTINCT (user_agent_hash, cf_asn) per day, HUMANS only
  'catalog.products_created',      // audit_log action='product.created'
  'catalog.integrations_created',
  'catalog.vendors_created',
  'catalog.claims_created',
  'accounts.sign_ins_new',         // profiles.created_at
]);

export const ADMIN_METRICS_MAX_DAYS = 400;   // = §7.4 page_views retention

export const AdminTimeseriesQuerySchema = z.object({
  metric: AdminMetricKeySchema,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),   // INCLUSIVE UTC date
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),     // INCLUSIVE UTC date (from === to is legal)
  interval: z.enum(['day']).default('day'),
  exclude_internal: z.enum(['0', '1']).default('0').transform((v) => v === '1'),
});

export const AdminTimeseriesResponseSchema = z.object({
  metric: AdminMetricKeySchema,
  interval: z.enum(['day']),
  window: AdminWindowSchema,
  generated_at: z.string().datetime(),
  source: z.enum(['live', 'snapshot', 'mixed']),
  notes: z.array(AdminNoteSchema),
  internal_filter: AdminInternalFilterSchema,
  // { day, value, value_excluding_internal, reconstructed }
  points: z.array(AdminTimeseriesPointSchema),
  total: AdminCountSchema,
});
```

`source` says where the numbers came from: `snapshot` when every day in the window
was captured by the 00:15 cron, `live` when none was, `mixed` otherwise. **`mixed`
is the normal case, not an edge** — the cron captures the prior COMPLETE UTC day,
so any window reaching today has an uncovered day by construction.

`points[].reconstructed` is a separate axis, and it is about *exactness* rather
than storage: `true` means that day predates the snapshot and was reconstructed
from the audit log afterwards, so it can only ever be approximate (§4). It is
per-point because a window can span the boundary and a response-level flag could
not say which days it applied to. When any point carries it, the response also
carries a `series_partly_reconstructed` note with `reconstructed_days` and
`reconstructed_through` — prose for the UI, which renders it without a chart
change.

**`exclude_internal=1` forces live aggregation for the whole window.**
`metrics_daily` stores only the unfiltered figure — `ANALYTICS_INTERNAL_ASNS`
(§13 D10) is read-time configuration, and baking the current list into a stored
row would rot silently the moment it changed. `page_views`' 400-day retention means
live always works for the filterable metrics, so this costs nothing but is worth
knowing when reading `source`.

`from`/`to` are **inclusive calendar dates**; the response's `window` reports the
resulting half-open `[from, to)` instants so the boundary is never inferred. The
series is **zero-filled** across every day in the window — a chart never has to
tell "no data" from "no key". `total` is the sum of the series.

One consequence worth stating, because it looks like a bug otherwise:
`traffic.unique_visitors` **does not sum meaningfully**. Each bucket is its own
`COUNT(DISTINCT …)`, so a visitor active on three days is counted three times in
`total`. `total` is reported as the sum anyway because that is the only figure
that agrees with the chart the caller is drawing; the window-distinct figure is
`/api/admin/overview`'s `unique_visitors`, which is explicitly scoped to one day.

`catalog.*` count **additions**, never net totals: §4 shows totals are
unrecoverable (827 `integration.created` events back 496 live rows after the
2026-07-25 reset), so every `catalog.*` response carries
`catalog_series_is_additions_only`. `exclude_internal` applies only to `traffic.*`
— there is no ASN on a catalog or profile row — and a request that asks anyway
gets `value_excluding_internal: null` plus an `internal_filter_unavailable` note
naming the metric.

Errors: `VALIDATION_FAILED` (400) for an unknown `metric`, a non-existent date, a
reversed range (`to < from`), or a window longer than `ADMIN_METRICS_MAX_DAYS`.

#### `GET /api/admin/traffic/breakdown`

Grouped `page_views` counts over a window. Pagination is over **groups** and uses
`PageQuerySchema` + the standard paginated envelope, so the list shape matches
`/api/admin/requests`.

```typescript
export const AdminTrafficBreakdownQuerySchema = PageQuerySchema.extend({
  dimension: z.enum(['source', 'country', 'path', 'product', 'bot']),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  traffic: z.enum(['human', 'bot', 'all']).default('human'),
  exclude_internal: z.enum(['0', '1']).default('0').transform((v) => v === '1'),
});

export const AdminBreakdownRowSchema = z.object({
  key: z.string().nullable(),         // null = the unattributed / unknown bucket
  label: z.string().min(1),           // ASCII fallback; UI localizes when key is null
  ref: LinkRefSchema.nullable(),      // hydrated only for dimension=product
  views: z.number().int().nonnegative(),
  views_excluding_internal: z.number().int().nonnegative().nullable(),
});

export const AdminTrafficBreakdownResponseSchema =
  paginatedResponseSchema(AdminBreakdownRowSchema).extend({
    dimension: AdminBreakdownDimensionSchema,
    traffic: AdminTrafficPopulationSchema,
    window: AdminWindowSchema,
    generated_at: z.string().datetime(),
    source: AdminMetricSourceSchema,   // 'live' | 'snapshot' | 'mixed'
    notes: z.array(AdminNoteSchema),
    internal_filter: AdminInternalFilterSchema,
    window_total: AdminCountSchema,
  });
```

`total` is the **distinct-group count**. `window_total` is the population's total
for the whole window — the same figure for every dimension — so a row's share is
computable without a second request; for `dimension=product` the groups therefore
sum to less than it (most views are not product pages), which is deliberate.

**NULL groups are shown, not dropped** (`key: null`): a row with no
`referrer_source` or `cf_country` gets its own bucket, so the groups reconcile
against `window_total`. Dropping them is how a source breakdown quietly starts
claiming attribution it does not have.

Ordering is views desc, then **named groups before the NULL bucket**, then the key
— a total order, so pagination cannot repeat or skip a group. `traffic` defaults
to `human` (matching §5.2); `dimension=bot` forces the bot population regardless,
since grouping human rows by `bot_name` returns one empty bucket.

Errors: `VALIDATION_FAILED` (400) for an unknown `dimension`, a bad/reversed date
range, an over-long window, or `perPage > 100`.

#### `GET /api/admin/system` (AECI-580 / Phase 8.3 P1.6)

The §5.6 bundle — deploy identity, cron liveness, the ten data-quality checks,
Algolia state, and the D1 footprint — in one round trip. Same conventions as the
three above (read-only, no `audit_log`, no `Cache-Tag`, `private, no-store`).
Handler: `apps/api/src/routes/admin-system.ts`.

```typescript
export const AdminSystemQuerySchema = z.object({
  recompute: z.enum(['0', '1']).default('0').transform((v) => v === '1'),
});

export const AdminSystemResponseSchema = z.object({
  window: undefined,                            // NOT windowed — a point-in-time read
  generated_at: z.string().datetime(),
  source: z.enum(['live']),
  recomputed: z.boolean(),
  notes: z.array(AdminNoteSchema),
  version: AdminVersionStatusSchema,            // the API Worker's — see below
  crons: z.array(AdminCronRunSchema),           // ALWAYS all eleven
  data_quality: AdminDataQualityStatusSchema.nullable(),   // null unless ?recompute=1
  algolia: z.object({
    watermark: AdminAlgoliaWatermarkSchema.nullable(),     // null = the sync never ran
    drift: AdminAlgoliaDriftStatusSchema.nullable(),       // null unless ?recompute=1
    orphan_sweep: AdminOrphanSweepStatusSchema.nullable(), // AECI-583 persists it in the 09:00 run — see below
  }),
  database: z.object({
    size_bytes: z.number().int().nonnegative().nullable(), // D1 meta.size_after
    tables: z.array(z.object({ table: z.string(), rows: z.number().int().nonnegative() })),
  }),
  stats_freshness: AdminStatsFreshnessSchema,
});
```

*(`window` is listed as absent deliberately: unlike the other three endpoints this
is a point-in-time system read, not a windowed aggregation, so it carries no
`AdminWindow`.)*

##### Two version endpoints, and why this one is only half the answer

`version` is the **API Worker's** `COMMIT_SHA` / `DEPLOYED_AT` / `ENV` — byte-for-byte
what `GET /api/version` returns, since it is the same Worker reading the same vars.
The SSR Worker's SHA is **not reachable from here**: `apps/web` forwards `/api/*`
untouched, so `/api/version` can only ever report the API Worker. That is exactly
why `apps/web` serves its own unproxied `GET /_version` (AECI-92).

The UI therefore fetches **both** and compares them; a mismatch means one of the
two deploys is stale, and it renders as a visible warning. Rendering one and
calling it "the version" defeats the point of the endpoint pair. `/api/version`
itself is not called by the panel — the bundle already carries those values.

##### Cron liveness is honest about not knowing (§7.2 / AECI-583)

```typescript
export const AdminCronJobSchema = z.enum([
  'metrics-snapshot',    // 15 0 * * *   (AECI-581)
  'retention-prune',     // 0 3 * * *    (AECI-584)
  'data-quality',        // 0 4 * * *
  'analytics-digest',    // 0 5 * * *
  'moderation-snapshot', // 0 6 * * *
  'home-stats',          // 0 7 * * *
  'algolia-sync',        // 0 8 * * *
  'algolia-drift',       // 0 9 * * *
  'request-reconcile',   // */15 * * * *
  'waf-poll',            // 0 * * * *
]);

export const AdminCronRunSchema = z.object({
  job: AdminCronJobSchema,
  schedule: z.string().min(1),                       // byte-equal to wrangler.jsonc
  source: z.enum(['job_runs', 'derived', 'unknown']),
  last_run_at: z.string().datetime().nullable(),
  last_outcome: z.enum(['ok', 'failed', 'skipped']).nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  derived_from: z.string().nullable(),               // e.g. 'stats_cache.computed_at'
  run_state: z.enum(['complete', 'in_flight']).nullable(),   // AECI-583
});
```

`source` is the load-bearing field:

| `source` | meaning |
|---|---|
| `job_runs` | read from the §7.2 table — **the normal case since AECI-583**: the row the cron wrote on entry and completed on exit |
| `derived` | inferred from a D1 side effect named in `derived_from`. Proves the job **ran**; says nothing about whether it **succeeded**, so `last_outcome` stays null. Now only the fallback for a job that has not run since run recording shipped — `home-stats` (`MAX(stats_cache.computed_at)`) and `algolia-sync` (the `algolia_sync_watermark` row's stamp) |
| `unknown` | no record anywhere in D1 — the job has never run, or was added since |

**An unfinished run can never report an outcome.** When the row has no
`finished_at`, `run_state` is `'in_flight'` and both `last_outcome` and
`duration_ms` are null **regardless of what is stored in the column**. That is
enforced on the read side rather than trusted from the writer, so an interrupted
run — an isolate reclaimed mid-flight — renders as *In flight*, never as a pass.

`run_state` exists rather than a `last_outcome: 'running'` because `last_outcome`
mirrors the stored column, and inventing a wire value with no storage counterpart
would have the API assert an outcome for a run that has none. It is null on
`derived` and `unknown` rows, where the question does not apply. There is no
`'stalled'` member: that needs a per-job threshold, and Datadog's no-data monitors
remain the alerting authority for a job that stops finishing.

Everything crossing the `job_runs` boundary is treated as untrusted — another
process wrote it. Timestamps are normalized through `Date` (an unparseable one
drops the row to `derived`/`unknown` rather than shipping a value that fails
`z.string().datetime()`), and an unrecognized stored `outcome` reads as null.

All ten rows are always present: omitting a job would read as "not configured", a
different and wrong claim. The schedule strings come from
`apps/api/src/lib/cron-schedules.ts`, which `scheduled.ts` also `switch`es on, so
the screen and the dispatcher cannot drift; `ADMIN_CRON_JOB` in the same file maps
the dispatcher's internal ids onto the `AdminCronJob` vocabulary above.

##### `?recompute=1` (§13 D8) — same semantics as `/overview`

Since AECI-583 the two items behave differently on the default view, and the reason
is where the answer can be **read** from, not what it costs to compute:

- **`data_quality` is served from storage.** The 04:00 cron persists its whole
  result set in `job_runs.detail` (§7.2), so the default response replays the last
  **completed** run. `AdminDataQualityStatusSchema` carries `source:
  'job_runs' | 'live'` and `computed_at` (the run's `finished_at`, never the
  response's own `generated_at`) so the UI cannot present a stored result as a
  fresh one. Still `null` where nothing has been stored yet.
- **`algolia.drift` stays `null` by default.** The 09:00 run does store its drift
  rows, but serving them here would put two differently-aged drift numbers on one
  screen. Left to the recompute.

`?recompute=1` runs the ten §23.1 checks and the drift count live, tagged
`source: 'live'`. Still a **pure read** — writes nothing (including no `job_runs`
row), sends nothing, no `audit_log` obligation; what makes it opt-in is network cost
(check #9 HTTP-probes a sample of logo URLs, drift costs three Algolia queries), not
mutation.

A stored payload that does not parse yields `data_quality: null` plus a
`stored_result_unreadable` note — omitted entirely rather than partially reported,
because filtering to the checks that happen to parse would present a partial suite
as a complete one and understate `failing`.

Both endpoints share one implementation (`apps/api/src/lib/admin-status.ts`
`runExpensiveStatusItems`), so the System screen and the Overview status strip
cannot report different results for the same check. The drift runner is invoked
**once** per request and memoized at the promise — check #10 of the ten *is* the
drift check, so running it twice would double the Algolia round trips to report
one number.

A check that finds nothing comes back `count: 0` with an empty `sample` — the UI
renders that as *passing*. `skipped: true` (no Algolia credentials) is **not** a
failure; `error` (the check threw) is distinct from both.

Note codes specific to this endpoint:

| code | severity | means |
|---|---|---|
| `cron_liveness_unavailable` | `warn` | `params.unknown` of `params.total` crons have no `job_runs` row yet — they have not run since run recording shipped, or were added since. Self-clearing as the rows arrive |
| `stored_result_unreadable` | `warn` | a stored `job_runs.detail` did not parse, so that item is omitted. `params.job` names which cron's payload (AECI-583) |
| `orphan_sweep_not_persisted` | `info` | **No longer emitted (AECI-583).** Retained in the enum because removing a code is a breaking change, and so an older cached response still renders localized prose |

##### `algolia.orphan_sweep`

Read from the last 09:00 drift run's `job_runs.detail` (AECI-583); it was
permanently `null` in P1.6 because the sweep reported only to Datadog.

```typescript
export const AdminOrphanSweepStatusSchema = z.object({
  ran_at: z.string().datetime().nullable(),   // the storing run's finished_at
  ok: z.boolean(),                            // false when any index errored
  total_orphans: z.number().int().nonnegative(),
  total_deleted: z.number().int().nonnegative(),
  capped: z.number().int().nonnegative(),     // indexes the safety cap refused — the --force signal
  indexes: z.array(AdminOrphanSweepIndexSchema),
});
```

`ok` is a field rather than the reason the object is null because a sweep that
completed with one index erroring still produced counts worth showing. `null` means
**no completed run has stored one** — a fresh environment, or a tier where the drift
cron skips for want of Algolia credentials. Null is never "clean". The per-index
`orphan_ids` are deliberately not carried: unbounded, and already in the Datadog log.

##### The D1 footprint

`database.tables` enumerates the **live** user tables from `sqlite_master` at
request time (excluding `sqlite_%`, `_cf_%`, and `d1_migrations` — the same
predicate `apps/datatool/src/introspect.ts` uses), then counts them in a single
`UNION ALL`, name-ordered. Runtime introspection rather than a hardcoded list, so a
table added by a migration appears without a code change.

`size_bytes` comes from D1's own `meta.size_after` (there is no supported
`PRAGMA page_count` on D1). It is `null` — rendered "unknown" — wherever that field
is unavailable, notably the better-sqlite3 test harness. It is never approximated
from the row counts.
#### `GET /api/admin/catalog/coverage`

The §5.5 catalog readout (AECI-579 / Phase 8.3 P1.5): coverage gaps, the promotion
funnel, the `research_status` distribution, taxonomy usage per facet, and the
Stage 1.5 claim/attestation spine. Handler `apps/api/src/routes/admin-catalog.ts`
over `lib/admin-catalog.ts`; same `authAdmin` sub-router, same `requireAdmin()`,
same read-only conventions as the three above.

```typescript
export const AdminCatalogCoverageQuerySchema = z.object({
  // Rows per gap list. 0 = exact counts with empty samples.
  sample: z.coerce.number().int().min(0).max(50).default(10),
});

export const AdminCatalogCoverageResponseSchema = z.object({
  generated_at: z.string().datetime(),
  source: z.enum(['live']),
  notes: z.array(AdminNoteSchema),
  sample_limit: z.number().int().nonnegative(),   // the `sample` actually applied
  totals: z.object({ products, integrations, vendors, claims, attestations }),
  funnel: AdminPromotionFunnelSchema,
  research_status: z.array(AdminResearchStatusCountSchema),
  gaps: z.array(AdminCoverageGapSchema),
  taxonomy: z.array(AdminTaxonomyFacetUsageSchema),
  claim_coverage: AdminClaimCoverageSchema,
});
```

**There is no `window`.** Unlike the three endpoints above, coverage describes
*current state*: "how many products have no logo" has no time range, and attaching
one would be the false precision §1.1 forbids. The rest of the envelope
(`generated_at` / `source` / `notes`) is unchanged.

**The catalog time series lives elsewhere.** §5.5's "counts over time" and
"additions per day" are served by `GET /api/admin/metrics/timeseries` with the
`catalog.*` metric keys — which already carry `catalog_series_is_additions_only`
and `catalog_series_starts_at`. This endpoint deliberately does **not** duplicate
that series; the UI calls both.

##### Gaps — exact counts, capped samples

```typescript
export const AdminCoverageGapSchema = z.object({
  key: z.enum([
    'products_without_vendor', 'products_without_logo', 'products_without_description',
    'products_without_api_docs', 'products_without_category', 'products_without_audience',
    'products_without_phase', 'products_without_trade',
  ]),
  total: z.number().int().nonnegative(),      // EXACT
  universe: z.number().int().nonnegative(),   // total products
  sample: z.array(LinkRefSchema),             // name-ordered, capped at `sample`
  sample_truncated: z.boolean(),
});
```

The count is the truth; the sample is where the work starts. `universe` travels
with every gap so a consumer can render "171 of 171" — which is the production
shape for `products_without_logo` and is a **worklist, not an error**.

Predicates: `without_vendor` is `NOT EXISTS` against `product_vendors` (the same
predicate as the `products_without_vendor` data-quality check); `without_description`
treats whitespace as absent; `without_api_docs` keys off `api_docs_url IS NULL` —
the artifact, not the `has_api_docs` flag — and a flag/URL disagreement is reported
separately as `api_docs_flag_inconsistent`. Sample rows link to the **AECi product
page**: D1 stores no curation-tool key (ADR 0021), so a per-row deep link into the
review app is not constructible.

##### Funnel — expect one populated stage

```typescript
export const AdminPromotionFunnelSchema = z.object({
  stages: z.array(z.object({
    status: z.enum(['pending', 'ready', 'promoted', 'retracted', 'rejected']),
    count: z.number().int().nonnegative(),
  })),                                  // zero-filled, pipeline order
  total: z.number().int().nonnegative(),
  promoted_cohort_only: z.boolean(),    // DERIVED: every row reads 'promoted'
});
```

`promoted_cohort_only` is computed from the rows, never hardcoded, so it retires
itself if a real un-promote path ever lands. It is true today for the reason
`ADMIN_PANEL_SPEC.md` §13 D6 gives: promote is D1's only INSERT path into
`products` and sets `'promoted'` on both branches, nothing writes `'ready'`, and
retraction hard-deletes. When true the response carries
`funnel_is_promoted_cohort_only` — without it a 171/0/0/0/0 funnel reads as a bug.

##### Taxonomy usage

```typescript
export const AdminTaxonomyFacetUsageSchema = z.object({
  facet: z.enum(['category', 'audience', 'phase', 'trade', 'data_object']),
  counts_what: z.enum(['products', 'claims']),   // data_object counts CLAIMS
  terms_total: z.number().int().nonnegative(),
  terms_used: z.number().int().nonnegative(),    // count > 0
  publish_floor: z.number().int().positive().nullable(),   // trades only
  terms_published: z.number().int().nonnegative().nullable(),
  terms: z.array(z.object({ id, slug, name, count, published: z.boolean().nullable() })),
});
```

Terms are **uncapped** — the five vocabularies total ~122 rows. `data_object` is
the odd facet out: data objects are referenced by claims, not products, so its
`count` is a claim count and `counts_what` says so rather than leaving a consumer
to assume. Trades carry the publication gate via `isPublishedTrade` /
`TRADE_PUBLISH_MIN_PRODUCTS` from `@aeci/shared` (`TRADES_VOCABULARY.md` §6 — one
copy of the floor); `published` is `null` on the other four facets, which is not
the same as `false`.

##### Claim coverage

Counts for integrations with/without at least one claim and claims with/without an
**active** attestation — `retracted_at IS NULL`, the shared `liveAttestationsWhere`,
matching `attestations_active_idx` (whose predicate moved onto that column in
AECI-603). Deliberately **not** `deprecated_at`: that is a *version stamp*
(`STAGE_1_5_SPEC.md` §3.3), so gating on it would drop a vendor's live assertion from
coverage the moment they recorded which release deprecated the flow. Corrected in
AECI-608 — the read had kept the pre-migration predicate, inert only while every
attestation in D1 was still `source='aeci'`. Plus a capped sample of claimless
integrations. Sample rows carry both endpoints
(`integrations.name` is nullable) so the consumer can build the pair URL
`/products/:sourceSlug/integrations/:targetSlug`.

##### Notes this endpoint can raise

`funnel_is_promoted_cohort_only` · `trade_facet_sparse_by_design` (the
`product_trades` join is sparse by design per `TRADES_VOCABULARY.md` §1.1, so an
untagged product is not a defect the way a missing logo is) ·
`api_docs_flag_inconsistent`.

Errors: `VALIDATION_FAILED` (400) for `sample` outside `0…50` or non-numeric.

#### `GET /api/admin/page-views`

The §5.2 Activity feed: individual visits, newest first. Pagination is over
**rows** and uses `PageQuerySchema` + the standard paginated envelope, so the
list shape matches `/api/admin/requests`.

```typescript
export const AdminPageViewsQuerySchema = PageQuerySchema.extend({
  from: utcDate,                                        // inclusive
  to: utcDate,                                          // inclusive
  traffic: AdminTrafficPopulationSchema.default('human'),
  source: z.string().min(1).max(64).optional(),         // exact, or '__none__'
  country: z.string().min(1).max(8).optional(),         // exact, or '__none__'
  path_contains: z.string().min(1).max(200).optional(),
  exclude_internal: z.enum(['0', '1']).default('0').transform((v) => v === '1'),
});

export const AdminPageViewRowSchema = z.object({
  id: z.number().int().positive(),
  created_at: z.string().datetime(),
  is_bot: z.boolean().nullable(),          // null = never classified → reads HUMAN
  bot_name: z.string().nullable(),
  visitor_hash: z.string().nullable(),     // FIRST 8 CHARS ONLY (§9.7)
  cf_asn: z.number().int().positive().nullable(),
  cf_country: z.string().nullable(),
  cf_colo: z.string().nullable(),
  path: z.string().min(1),                 // the stored `path` — see the note below
  entity_type: z.enum(['product', 'vendor']).nullable(),
  entity: LinkRefSchema.nullable(),
  referrer_source: z.string().nullable(),  // null = UNKNOWN, not Direct
  referrer: z.string().nullable(),         // external HOST only
});

export const AdminPageViewsResponseSchema =
  paginatedResponseSchema(AdminPageViewRowSchema).extend({
    traffic: AdminTrafficPopulationSchema,
    window: AdminWindowSchema,
    generated_at: z.string().datetime(),
    source: AdminMetricSourceSchema,
    notes: z.array(AdminNoteSchema),
    internal_filter: AdminInternalFilterSchema,  // `applied` = ROWS were filtered
    window_total: AdminCountSchema,              // every filter EXCEPT exclude_internal
    window_visitors: AdminCountSchema,           // §9.8 distinct (hash, ASN) pairs
  });
```

**`ADMIN_PAGE_VIEW_NULL_FILTER` (`'__none__'`) selects the NULL bucket.** Breakdown
surfaces NULL groups as `key: null` rather than dropping them; a query string
cannot carry a null, and those rows are a real population (every row before
August 2026 has a NULL `referrer_source`), so the sentinel makes them selectable
rather than merely visible. It is not a value either column can legitimately hold.

**`path_contains` matches literally.** `%` and `_` are escaped server-side and the
`LIKE` carries an explicit `ESCAPE '\'`, so operator input is never a pattern
language.

**The internal-ASN filter behaves differently here, deliberately.** §13 D10
constraint 2 is "show both numbers, never substitute"; on a count endpoint that
falls out of `AdminCount` for free, but on a row feed `exclude_internal=1` removes
rows, so computing the counts the same way would leave the operator a smaller
number with nothing to compare it against. The handler therefore resolves the
filter **twice**: `window_total` and `window_visitors` are computed both ways
**unconditionally** whenever `ANALYTICS_INTERNAL_ASNS` is set, toggle or no
toggle, while `exclude_internal` governs only the row list. `/api/admin/overview`
sets the same precedent (it always asks). Two consequences:

- `internal_filter.applied` means **"the row list was filtered"** on this endpoint,
  not "the second count was computed".
- Both counts honour `source` / `country` / `path_contains`, so they reconcile
  with `total`: toggle off → `total === window_total.total`; toggle on →
  `total === window_total.excluding_internal`.

With the var unset (the shipped default on every tier) `excluding_internal` is
null on both counts and the UI hides the toggle entirely.

**Privacy is enforced by the contract, not by the UI.** `visitor_hash` is
`substr(user_agent_hash, 1, 8)` computed in SQL, so the full hash never crosses
the wire. `user_id`, `session_id` and `profile_role` cannot be selected — §13 D7
settled that the three are *dropped* rather than filled, and AECI-585 dropped them
(migration `0014`); no session identifier will be introduced.

**`path` is what the writer stored, and this endpoint does not yet read the
AECI-585 columns.** For a detail or browse page rendered through SSR that is the
route pattern (`/products/:slug`), which is why `entity` carries the real name for
product and vendor rows. AECI-585 added `concrete_path`, `taxonomy_kind` and
`taxonomy_id` at **ingest** — so a taxonomy row written after it *can* say which
term was viewed — but this contract is unchanged: `entity_type` is still
`product | vendor`, and a taxonomy row still hydrates to `null` and renders as the
bare pattern. Surfacing the new columns here (a six-value `entity_type`, taxonomy
name hydration, the concrete path in the feed) is a follow-up, tracked separately
from AECI-585, whose scope was ingest only.

Ordering is `created_at DESC, id DESC`. `page_views.id` is an autoincrement
integer PK, so the pair is a strict total order and pagination can neither repeat
nor skip a row when several visits share a timestamp.

`notes` always includes `visitor_definition_approximate` (§9.8 travels with the
number) and, when the window earns them, `bot_classification_incomplete`,
`referrer_source_incomplete`, `direct_is_mixed_bucket`, and `partial_day`.

Errors: `VALIDATION_FAILED` (400) for a missing/bad/reversed date range, a window
longer than `ADMIN_METRICS_MAX_DAYS`, or `perPage > 100`.

#### `GET /api/admin/audience` (AECI-586 / Phase 8.3 P5.1)

The §5.4 bundle: lifetime subscriber stocks, the day-bucketed growth/churn
series, the UTM and signup-geography breakdowns, and the feedback counts.

```typescript
export const ADMIN_AUDIENCE_MAX_BREAKDOWN = 50;
export const ADMIN_AUDIENCE_DEFAULT_BREAKDOWN = 8;

export const AdminAudienceQuerySchema = z.object({
  from: utcDate,                                  // inclusive
  to: utcDate,                                    // inclusive
  breakdown_limit: z.coerce.number().int().min(1)
    .max(ADMIN_AUDIENCE_MAX_BREAKDOWN).default(ADMIN_AUDIENCE_DEFAULT_BREAKDOWN),
});

export const AdminAudienceBreakdownRowSchema = z.object({
  key: z.string().nullable(),      // null = the unattributed bucket, surfaced not dropped
  label: z.string().min(1),        // untranslated operator fallback; UI keys off `key === null`
  subscribers: z.number().int().nonnegative(),
});

export const AdminAudienceResponseSchema = z.object({
  window: AdminWindowSchema,
  generated_at: z.string().datetime(),
  source: z.literal('live'),       // NOT AdminMetricSourceSchema — see below
  notes: z.array(AdminNoteSchema),
  breakdown_limit: z.number().int().positive(),

  // Lifetime, windowless.
  subscribers: z.object({
    active: …,                     // unsubscribed_at IS NULL
    unsubscribed: …,               // unsubscribed_at IS NOT NULL (a suppression record)
    total_ever: …,                 // = active + unsubscribed; one row per email, ever
    churn_rate: z.number().min(0).max(1).nullable(),   // NULL when total_ever === 0
  }),

  // Zero-filled across every day in the window.
  series: z.array(z.object({
    day: …, signups: …, unsubscribes: …, active_cumulative: …,
  })),
  window_totals: z.object({
    signups: …, unsubscribes: …,
    net: z.number().int(),                              // signups − unsubscribes; MAY BE NEGATIVE
    active_at_start: …, active_at_end: …,
    churn_rate: z.number().min(0).nullable(),           // NULL when active_at_start === 0
  }),

  utm: { source: rows, medium: rows, campaign: rows },
  geography: { country: rows, region: rows, city: rows, asn: rows },
  feedback: { total_ever: …, in_window: … },            // rows are the endpoint below
});
```

**Why this series is derived live and does not read `metrics_daily`.**
`ADMIN_PANEL_SPEC.md` §7.1 snapshots `audience.subscribers_active` /
`_unsubscribed` / `feedback_total` daily and anticipated this endpoint reading
them. It does not, for two reasons that apply only to this table. **It does not
need to**: `unsubscribed_at` is a soft delete (§6.13 / AECI-537) and nothing
hard-deletes a `mailing_list` row, so the population on any past day is exactly
`created_at <= D AND (unsubscribed_at IS NULL OR unsubscribed_at > D)` — the
property §4 shows the *catalog* stocks lack, and the reason a snapshot was needed
there. **And it would cost**: stocks are never backfilled, so those series begin
at the first cron run (2026-08-13) while `mailing_list` reaches back to the first
signup, and `/metrics/timeseries` zero-fills — which is right for a flow and wrong
for a stock, since an uncaptured day would report *zero subscribers* rather than
unknown. `source` is therefore the literal `'live'`: `'snapshot'` and `'mixed'`
are unreachable here by design, and a three-value enum would imply a storage swap
that is not coming. The snapshot rows stay written; they are the only durable
record of a pre-resubscribe state.

**Both `churn_rate` fields are `null`, never `0`, on an empty denominator.** A
rate over nobody is undefined, and `0%` would be a clean bill of health nobody
measured — §5.1's "`null` renders as *Not measured*, never as zero" applied to a
ratio. `mailing_list` holds zero rows today (§3), so this is the first thing any
caller sees. The two rates answer different questions and are not interchangeable:
`subscribers.churn_rate` is "what fraction of everyone who ever joined has left",
`window_totals.churn_rate` is "what fraction of the opening population left during
this window".

**`active_cumulative` is exact, not sampled.** It carries forward from
`active_at_start`, so `active_at_start + Σ(signups − unsubscribes) ===
active_at_end` holds by construction — a row can only enter the population through
`created_at` and leave through `unsubscribed_at`, and both are bucketed here.

**The breakdowns group signups *inside the window***, so a row's share is
`subscribers / window_totals.signups` with no second request. NULL groups are
surfaced with `key: null` rather than dropped — an organic signup carries no
`utm_source`, and hiding it is how an attribution breakdown starts claiming
attribution it does not have. Ordering is count desc, then named groups before the
NULL bucket, then the key, the same total order `/traffic/breakdown` uses. The
`asn` dimension is labelled from `as_organization` where present and `AS<number>`
otherwise: an ASN cannot label itself.

`notes` carries `utm_attribution_incomplete` when signups in the window lack a
`utm_source` (`params: { missing, total }`), `audience_history_is_current_state`
whenever the list is non-empty, and `partial_day` when the window reaches into the
current UTC day. **Neither of the first two fires on an empty list**: 0 of 0
signups is not incomplete, and there is no history to caveat.

Errors: `VALIDATION_FAILED` (400) for a missing/bad/reversed date range, a window
longer than `ADMIN_METRICS_MAX_DAYS`, or a `breakdown_limit` outside `[1, 50]`.

#### `GET /api/admin/feedback` (AECI-586 / Phase 8.3 P5.1)

The feedback inbox, paginated. **This is the first read surface the `feedback`
table has ever had** — it is written by `POST /api/feedback` (§6.13) and forwarded
as a fire-and-forget operator email, and that email has been the only way anyone
has seen a submission. Nothing here re-shapes an existing view; the column set
simply is the row.

```typescript
export const AdminFeedbackQuerySchema = PageQuerySchema;   // page / perPage ≤ 100

export const AdminFeedbackRowSchema = z.object({
  id: z.number().int().positive(),
  created_at: z.string().datetime(),
  features: z.string().nullable(),     // free text; null when only `tools` was given
  tools: z.string().nullable(),
  email: z.string().nullable(),        // IN FULL — see below
  subscribed: z.boolean(),             // the mailing-list opt-in on the form
  country: …, city: …, region: …, timezone: …, referrer: z.string().nullable(),
});

export const AdminFeedbackResponseSchema =
  paginatedResponseSchema(AdminFeedbackRowSchema)
    .extend({ generated_at: …, source: z.literal('live'), notes: z.array(AdminNoteSchema) });
```

No window filter, deliberately: an inbox is read end to end rather than measured,
and the windowed count already rides on `/api/admin/audience` as
`feedback.in_window`. `total` is every row in the table, since the endpoint takes
no filters.

Ordering is `created_at DESC, id DESC`. `feedback.id` is an autoincrement integer
PK, so the pair is a strict total order and a page boundary is stable even for two
submissions stamped in the same millisecond.

**`email` crosses in full rather than truncated, and that is the opposite of
`/api/admin/page-views` on purpose.** A page view observes someone who never
identified themself, so §9.7 requires a truncated pseudonymous hash. This is
contact information a person volunteered *in order to be replied to*; redacting it
would defeat the field's only purpose. `/api/admin/requests` returns
`submitter_email` whole on the same reasoning.

`referrer` is a URL a submitter's browser supplied. It is data, not a destination —
the UI renders it as text and never as a link.

Errors: `VALIDATION_FAILED` (400) for `perPage > 100`, `perPage < 1`, or `page < 1`.

### 6.11 Webhooks

#### `POST /api/webhooks/linear`

Receives Linear issue state change webhooks. Verified via HMAC signature in `Linear-Signature` header against the signing secret configured when creating the webhook in Linear.

The shape below reflects Linear's documented webhook payload. Validate this against a real Linear payload captured during webhook setup (webhook.site or similar) before depending on field names.

```typescript
export const LinearWebhookSchema = z.object({
  action: z.enum(['create', 'update', 'remove']),
  type: z.string(),                         // 'Issue', 'Comment', etc.
  data: z.object({
    id: z.string(),
    title: z.string().optional(),
    state: z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),                     // 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
    }).optional(),
    assignee: z.object({
      id: z.string(),
      name: z.string(),
    }).nullable().optional(),
    project: z.object({
      id: z.string(),
      name: z.string(),
    }).nullable().optional(),
  }),
  url: z.string(),                          // permalink to the issue
  createdAt: z.string(),
  organizationId: z.string(),
  webhookTimestamp: z.number(),
});
```

Worker writes corresponding `workflow_transitions` entries (see `STAGE_1_SPEC.md` §26).

### 6.12 Promotion (review-app push)

#### `POST /api/promote` → `202` + `GET /api/promote/jobs/:id`

Push-based Airtable → app-DB (Cloudflare D1) promotion. The review application sends one
product plus its dependencies (vendors, taxonomy, integrations); the Worker
upserts the whole bundle in a single atomic `db.batch([...])` and hands back the
created/updated IDs so the review app can persist the mapping and re-push edits. This is
the live curator → app-DB path; the pull-based CLI
`scripts/airtable-to-supabase-bulk-migrate.ts` was **retired** (AECI-278).

**Asynchronous since AECI-563 (ADR 0021).** `POST /api/promote` validates
synchronously, starts the `PROMOTE_WORKFLOW` Cloudflare Workflow, and returns
**`202 { jobId, status: 'queued' }`** plus a `Location: /api/promote/jobs/{jobId}`
header. The plan-then-batch ingest (`routes/promote.ts` `runPromoteIngest`) runs inside
one non-retried step of that Workflow, and `GET /api/promote/jobs/:id` serves
`{ jobId, status, result?, error? }`. This exists because the synchronous shape coupled a
committed write to the caller's connection: a client timeout left the batch committed
(product live) while the response carrying the assigned IDs was lost, which — with no
`external_id` column — was unrecoverable (AECI-561). Full caller-facing contract:
`docs/REVIEW_APP_PROMOTE_API.md` §2.1.

**Auth:** `Authorization: Bearer <REVIEW_APP_TOKEN>` (a Wrangler secret, compared
constant-time) on **both** endpoints. Missing/invalid → `401 UNAUTHENTICATED`. This is
machine-to-machine auth, not a user session.

**Two independent idempotency keys:**

- **`jobId`** (optional, top-level, `^[A-Za-z0-9_-]{8,100}$`) scopes one promote
  *attempt*. It becomes the Workflow **instance id**, so `create({ id })`'s duplicate
  guard means a replayed kick-off attaches to the existing instance and returns the same
  `jobId` — it can never start a second instance and therefore never commits twice.
  Since AECI-571 that is enforced in **D1** as well as at instance creation: the ingest's
  atomic batch carries a `promote_jobs` row keyed by the job id, so even an internal
  engine replay of an already-committed step rolls back and returns the recorded ID map.
  The guarantee therefore also outlives the 30-day instance retention.
  Absent → server-generated (pollable, but no replay protection).
- **`supabaseId`** scopes one *row*, as before: present **and still resolvable** →
  **updated** by that ID; absent → **created** and its new ID is returned. The review app
  holds the mapping; there is no `external_id` column. Slugs are server-generated (never
  sent by the client) and stay stable across updates. A `supabaseId` whose row is **gone**
  (retracted, pruned, deleted) also takes the **create** branch (AECI-568) — the alternative
  is a no-op `UPDATE … WHERE id = <gone>` reported as `updated` with an empty slug, which
  the review app then writes back over the real one. Each fallback is reported post-commit
  as `aeci.api.promote.stale_id{kind}`.

**Errors split across the two surfaces.** Synchronous: `400 MALFORMED_REQUEST` /
`400 VALIDATION_FAILED` / `401 UNAUTHENTICATED` / `413 PAYLOAD_TOO_LARGE` (body > 8 MiB, or
oversize with no `PROMOTE_KV` to stage into) / `503 DEPENDENCY_FAILURE` (no
`PROMOTE_WORKFLOW` binding) / `500 INTERNAL_ERROR`. On the job: `SLUG_CONFLICT` (AECI-98)
and `INTERNAL_ERROR` now arrive as `{ status: 'errored', error: { code, message } }` — the
Workflow throws `NonRetryableError(message, code)` and the poll maps the error `name` back
to the `ApiErrorCode`. A poll for an unknown/expired job → `404 NOT_FOUND`.

Schemas live in `packages/shared/src/api/promote.ts` (`PromotePayloadSchema`,
`PromoteResponse`). Intra-payload links use a client-local `ref`; cross-request
links use `supabaseId`.

`product` is **optional**: a vendor-only or integration-only push (e.g. "I edited
just the vendor on review and want it live") omits it. The payload must contain at
least one of `vendors`, `product`, or `integrations`.

```typescript
// Request (abridged — see promote.ts for all optional fields)
export const PromotePayloadSchema = z.object({
  jobId: PromoteJobIdSchema.optional(),                   // kick-off idempotency key (AECI-563)
  vendors: z.array(PromoteVendorSchema).default([]),      // { ref, supabaseId?, companyName, isPrimary?, ... }
  product: PromoteProductSchema.optional(),               // { ref, supabaseId?, name, productRole, categories[], audiences[], phases[], trades[], extensionOf[], ... }
  //  product.trades[]: trade slugs/names/aliases (AECI-542) — resolved FIND-ONLY
  //    against the seeded closed vocabulary; a miss → skipped[] kind 'trade'.
  integrations: z.array(PromoteIntegrationSchema).default([]),
  //  integrations[i].sourceProduct / targetProduct: { ref: <product.ref> } | { supabaseId }
  //  (a { ref } endpoint requires `product`; without it, reference products by supabaseId)
  //  integrations[i].claims[]: Stage 1.5 data-object claims (AECI-291) —
  //    { dataObject: slug|name, direction: 'a_to_b'|'b_to_a'|'both',
  //      attestations: { source: 'aeci'|'vendor_a'|'vendor_b', asserted, introducedAt?, deprecatedAt?, note? }[] }
  //    `dataObject` resolves find-only against the seeded vocabulary; a miss → skipped[] kind 'claim'.
});

// Kick-off response (202) + poll response (200) — AECI-563
export interface PromoteKickoffResponse { jobId: string; status: 'queued' }
export type PromoteJobStatus = 'queued' | 'running' | 'complete' | 'errored';
export interface PromoteJobResponse {
  jobId: string;
  status: PromoteJobStatus;
  // Present exactly when complete: the full PromoteResponse below (the former 200 body).
  result?: PromoteResponse;
  // Present exactly when errored: the code the synchronous call used to return.
  error?: { code: string; message: string };
}

// The ID map — now delivered as `PromoteJobResponse.result`.
// `product` is null for a vendor-only / integration-only push.
export interface PromoteResponse {
  vendors: { ref: string; id: string; slug: string; operation: 'created' | 'updated' }[];
  product: { ref: string; id: string; slug: string; operation: 'created' | 'updated' } | null;
  // sourceSlug/targetSlug (the two products' slugs) are optional — populated by the
  // claims ingest (AECI-297) so pair-page purge needs no DB read.
  // poweredBySlug is the connector product that powers the edge, when the payload
  // named one (Stage 1.5 Addendum B) — it purges the connector's own product page,
  // which no other tag rule reaches. All three are optional; tolerate absence.
  integrations: {
    ref: string;
    id: string;
    operation: 'created' | 'updated';
    sourceSlug?: string;
    targetSlug?: string;
    poweredBySlug?: string;
  }[];
  taxonomy: {
    categories: { slug: string; id: string; operation: 'created' | 'reused' }[];
    audiences: { slug: string; id: string; operation: 'created' | 'reused' }[];
    phases: { slug: string; id: string; operation: 'created' | 'reused' }[];
    // Always present; always `reused` — the trade vocabulary is closed (AECI-542).
    trades: { slug: string; id: string; operation: 'reused' }[];
  };
  skipped: {
    ref: string;
    kind: 'integration' | 'extension' | 'usefulness' | 'claim' | 'trade' | 'vendor' | 'product';
    reason: string;
  }[];
  // AECI-604: the inverse of `skipped` — existing vendor-owned claims/attestations
  // this promote deliberately left alive. `ref` is the enclosing integration's;
  // entries are aggregated per (ref, kind, reason). Always present, `[]` for the
  // ordinary promote of an unclaimed product. Never an error condition.
  preserved: { ref: string; kind: 'claim' | 'attestation'; reason: string; count: number }[];
}
```

**Integration rule (product-driven, from AECI-83):** an integration is written
only when both endpoints resolve — one is the product in this bundle (`ref`), the
other must already be promoted (`supabaseId`). Integrations whose other endpoint
isn't promoted yet land in `skipped[]` rather than failing the promote. Every
create/update writes an `audit_log` row in the same transaction (§26).

**Claimed-vendor block (Stage 2, AECI-520).** A vendor is **claimed** once AECi
has granted it a vendor-portal seat — at least one `profiles` row with
`role = 'vendor_admin'` AND `vendor_id = <vendor>`. From that point its row and
every product it owns are vendor-owned: the vendor edits them through
`/api/vendor/*` (§6.14), and this endpoint writes the very same columns, so a
routine push would silently revert their work. Therefore:

- A claimed vendor's row is **not updated** — reported as `skipped[] { kind: 'vendor' }`.
- An existing product that a claimed vendor owns today, **or** that this payload
  would join to one, is blocked **wholesale** (all columns, plus its
  `product_vendors` / taxonomy / extension join rewrites and its `usefulness`) —
  reported as `skipped[] { kind: 'product' }`. Wholesale means AECi's own
  curation columns on that row (`name`, `promotion_status`, `research_*`,
  `priority_*`, `admin_notes`) also stop updating through promote — accepted at
  launch given the concierge model's low volume and human in the loop.
- Integrations in the same payload with an endpoint on **that** blocked product
  cascade-skip (matched by both `ref` and `supabaseId` — the payload's
  `superRefine` only constrains the `ref` form). The cascade is scoped to this
  payload's product: an integration whose *far* endpoint is some other claimed
  vendor's product still writes, because integrations are AECi-curated and are
  not vendor-editable, so no vendor-owned content is at stake.
- **Creation is never blocked** — nothing vendor-owned exists yet.
- Unrelated vendors and integrations in the same payload still promote.
- "Claimed" requires an **active** seat. Banning a vendor's only admin un-claims
  it, so promote can write again — moderation returns control to AECi instead of
  freezing a record nobody can then correct (the banned seat also fails every
  `/api/vendor/*` call). Ban is per-seat, so a vendor with another active seat
  stays claimed.

Blocked entities are **omitted** from `vendors[]` / `product` rather than marked
with a new `operation`, which is what keeps them out of the cache purge, IndexNow,
Google Indexing, and the Algolia sync (all four iterate the result arrays). So
`product: null` now means either "no product was sent" or "the product was
blocked"; the two are told apart by a `skipped[]` entry whose `ref` matches the
product's, which only ever appears when a product *was* sent. Seat existence is
the signal (rather than `vendors.verified`) precisely because it cannot be set
from Airtable.

**`verified` is accepted and ignored (AECI-520).** `vendors.verified` is the paid
entitlement bit: it is set by the claim→account grant
(`STAGE_2_VENDOR_PORTAL_SPEC.md` §3) and cleared only by a deliberate entitlement
action. It stays in `PromoteVendorSchema` so an existing review-app build keeps
validating, but the server no longer writes it — previously an ordinary push
could silently un-verify a paying vendor.

**Claims (Stage 1.5, AECI-291 contract / AECI-297 ingest):** each integration may
carry a nested `claims[]` of data-object assertions (`STAGE_1_5_SPEC.md` §5/§6.2). A
claim rides with its integration (same withhold rule), and its `dataObject` resolves
**find-only** (slug or alias) against the seeded `data_object` vocabulary — an
unmatched value lands in `skipped[]` with `kind: 'claim'`, never a 500. The ingest
matches by the identity `(integration_id, data_object_id, direction)` — the
`claims_identity_key` index — emits `claim.*` / `attestation.*` audit rows in the same
`db.batch`, and populates each integration result's `sourceSlug`/`targetSlug` so the
promote derivers can purge the `pair:{min}__{max}` tag and ping the canonical pair URL
without a DB read.

**Replace-by-ORIGIN, since AECI-604** (`STAGE_2_ATTESTATIONS_SPEC.md` §3;
`apps/api/src/lib/promote-claims.ts` owns the rule). The former replace-by-integration
— clear the integration's claims, re-insert to match the payload, attestations
cascading through `attestations.claim_id ON DELETE CASCADE` — destroyed vendor
attestations the moment AECI-301 shipped, and churned every claim id on every promote.
Now: an identity match **reuses** the row (id stable, vendor attestations intact); only
`origin = 'aeci'` claims the payload dropped are deleted (`claim.deleted`); only
`source = 'aeci'` attestations are replaced; and a dropped AECi claim a vendor still
attests is **converted** to `origin = 'vendor'` with `created_by_vendor_id` set
(`claim.converted`) rather than deleted. Promote may write only `source: 'aeci'` — a
`vendor_a`/`vendor_b` in a payload lands in `skipped[]` with `kind: 'claim'`, because
inserting it would collide on the `attestations_slot_key` partial unique index and roll
back the whole batch. What survived is reported in `preserved[]`.

**Trades (AECI-542):** the product may carry an optional `trades[]` of trade slugs,
names, **or aliases** (`STAGE_1_SPEC.md` §5.5a, `docs/TRADES_VOCABULARY.md`). Unlike
`categories` / `audiences` / `phases`, which are find-**or-create**d by canonical slug,
a trade resolves **find-only** against the seeded closed vocabulary by `slug` → `name`
→ `alias`, case-insensitively. An unmatched value is dropped and reported in `skipped[]`
with `kind: 'trade'` and `ref` = the product's `ref` — never auto-created (a typo minting
`paving-contractors` alongside `paving-asphalt` would split a trade page's products
across two permanent URLs), and never a 500. `product_trades` is a full-replace join set
written in the same `db.batch` as the product mutation and its `audit_log` row; because
no term is ever created, no `trade.*` audit row exists and every echoed result is
`operation: 'reused'`. The key is **optional** — omitting it (or sending `[]`) clears the
product's trades, like every other join set. Trades are sparse by design: only products
with trade-*specific* value carry them.

**Trades (AECI-542):** the product may carry an optional `trades[]` of trade slugs,
names, **or aliases** (`STAGE_1_SPEC.md` §5.5a, `docs/TRADES_VOCABULARY.md`). Unlike
`categories` / `audiences` / `phases`, which are find-**or-create**d by canonical slug,
a trade resolves **find-only** against the seeded closed vocabulary by `slug` → `name`
→ `alias`, case-insensitively. An unmatched value is dropped and reported in `skipped[]`
with `kind: 'trade'` and `ref` = the product's `ref` — never auto-created (a typo minting
`paving-contractors` alongside `paving-asphalt` would split a trade page's products
across two permanent URLs), and never a 500. `product_trades` is a full-replace join set
written in the same `db.batch` as the product mutation and its `audit_log` row; because
no term is ever created, no `trade.*` audit row exists and every echoed result is
`operation: 'reused'`. The key is **optional** — omitting it (or sending `[]`) clears the
product's trades, like every other join set. Trades are sparse by design: only products
with trade-*specific* value carry them.

Errors: `MALFORMED_REQUEST` (bad JSON), `VALIDATION_FAILED` (schema / duplicate
`ref` / bad enum), `UNAUTHENTICATED` (token). Full integration guide for the
review app: `docs/REVIEW_APP_PROMOTE_API.md`.

### 6.13 Landing capture (mailing list + feedback)

Two lead-capture write hooks shipped in **AECI-257** (ADR 0016). Schemas live in `@aeci/shared` (`api/landing.ts`). Both persist to D1 (`mailing_list` / `feedback` — `apps/api/src/db/schema.ts`) and, like `page_views`, are **write-once analytics, not domain state**, so they are exempt from the §26.1 audit-in-batch invariant (no `audit_log` row). The geo / attribution fields are derived from `request.cf` by the **caller** and carried to the API Worker out of band (in the request body, or — for the app island — on trusted headers; see below), because `request.cf` does not survive a service binding (the same constraint `POST /api/page-views` works around).

**Caller (post-cutover): the shared mailing-list signup band** (`apps/web/.../shared/mailing-list-signup`, mounted on the home closing-CTA plus the directory + detail pages; §4.1, section 9; AECI-269 build child 6 / **AECI-275**, extracted into the shared band in **AECI-327**) — a progressively-enhanced browser island POSTing through the SSR Worker's `/api/*` passthrough. The browser can't read `request.cf`, so the SSR proxy forwards the geo on **trusted `LANDING_CF_HEADERS`** (`@aeci/shared`, `api/landing.ts`) — `x-aeci-cf-{country,city,region,timezone,as-organization,asn,metro-code}` — exactly the way `POST /api/page-views` forwards `PAGE_VIEW_CF_HEADERS`. UTM / referrer still ride the body (the island reads them from the live URL + `document.referrer`). The **pre-launch `apps/landing` Worker was the original second caller** (it forwarded the CF-derived geo IN THE BODY over the `env.API` binding); it was **retired at the apex cutover (AECI-247/277)**. The body-geo path is retained on the handlers (it's the fallback below), so any body-only caller still works. **AECI-536** adds a second in-app caller — the dedicated `/updates` signup page (`apps/web/.../app/updates/updates.ts`) — which reuses the same `LandingApi.subscribe` transport + `buildAttribution`, so it rides the identical SSR-proxy geo-forwarding path; only its form UI (visible label + success-panel swap) is bespoke.

The handlers read a header when present and fall back to the body value otherwise (`readLandingCfFromHeaders`, `apps/api/src/routes/landing-forms.ts`). The headers are trusted because the API Worker has no public ingress (service-binding only) and the SSR proxy is the sole writer: it strips any client-supplied copies first (anti-spoof), then sets fresh values from `request.cf` (`withForwardedLandingCf`, `apps/web/src/server-runtime.ts`). Every geo / attribution field is `nullish`, so the API Worker still accepts a body (or a header set) without them.

**Operator notification (AECI-247/277).** Retiring `apps/landing` moved its operator "new signup / new feedback" Resend email into these handlers: `POST /api/subscribe` (on a real insert — never the idempotent no-op) and `POST /api/feedback` fire a fire-and-forget notification to `ADMIN_ALERT_EMAIL` via `ctx.waitUntil` (`sendLandingSignupNotification` / `sendLandingFeedbackNotification`, `apps/api/src/lib/email.ts`). Fail-open: an absent `RESEND_API_KEY` / `EMAIL_FROM` / `ADMIN_ALERT_EMAIL` is a silent skip and never affects the response.

**Subscriber welcome (AECI-327).** On the same real insert **or reactivation**, `POST /api/subscribe` also fires a second fire-and-forget send — the subscriber's `mailing-list-welcome` first-touch email to `payload.email` (`sendMailingListWelcomeEmail`, `apps/api/src/lib/email.ts`) — so a fresh signup (or a resubscribe after opt-out) schedules two `ctx.waitUntil` sends (operator alert + subscriber welcome), the still-active idempotent no-op none. The welcome email carries the subscriber's `unsubscribe_token`, which builds its tokenized `/unsubscribe?token=…` in-body link and RFC 8058 one-click `List-Unsubscribe-Post` header (AECI-537; see `POST /api/unsubscribe` below and `docs/email.md`). Same fail-open contract: an absent `RESEND_API_KEY` / `EMAIL_FROM`, or an unresolved recipient, is a silent skip.

#### `POST /api/subscribe`

Mailing-list signup. `email` is required and unique (`mailing_list_email_key`); the rest is best-effort attribution. Idempotent: returns `created: false` when the email is already on the list **and still active**. A fresh row is assigned an opaque `unsubscribe_token` (`crypto.randomUUID()`) used by the welcome-email opt-out link (AECI-537). If the email is on the list but previously **unsubscribed** (`unsubscribed_at` set), the handler **reactivates** it — clears `unsubscribed_at`, keeps the existing token, and re-welcomes — returning `created: true` (status `200`, since no new row was created). Only a genuine new insert returns `201`.

> **The reactivation path is lossy, and the admin panel says so.** Clearing
> `unsubscribed_at` and keeping the original `created_at` means the row no longer
> records that the subscriber ever left. `GET /api/admin/audience` derives its
> churn series from those two columns, so a churn-then-return reads as
> never-churned; that is disclosed as `audience_history_is_current_state` rather
> than silently absorbed. `metrics_daily`'s `audience.subscribers_active` stock
> (AECI-581) is the only durable record of the state before a reactivation
> rewrote it.

```typescript
export const SubscribeSubmitSchema = z.object({
  email: z.string().trim().email().max(200),
  as_organization: z.string().max(255).nullish(),
  asn: z.number().int().nullish(),
  metro_code: z.number().int().nullish(),
  utm_source: z.string().max(255).nullish(),
  utm_medium: z.string().max(255).nullish(),
  utm_campaign: z.string().max(255).nullish(),
  // + shared geo (all nullish): country, city, region, timezone, referrer
});
```

#### `POST /api/feedback`

Free-text product feedback. At least one of `features` / `tools` must be present (mirrors the form's own guard). `email` is optional; when present it must be valid, and `subscribed` is the mailing-list opt-in flag. No unique constraint, so it always returns `created: true`.

> **Since AECI-586 this table has a read surface** — `GET /api/admin/feedback`
> (§6.10) and the `/admin/audience` screen. Before that, the operator email fired
> from this handler was the only way anyone ever saw a submission, so a lost or
> filtered alert meant a lost submission. The email is unchanged and still sends;
> the panel is the durable second path, not a replacement.

```typescript
export const FeedbackSubmitSchema = z
  .object({
    features: z.string().max(5000).nullish(),
    tools: z.string().max(5000).nullish(),
    email: z.string().trim().email().max(200).nullish(),
    subscribed: z.boolean().default(false),
    // + shared geo (all nullish): country, city, region, timezone, referrer
  })
  .refine((d) => Boolean(d.features) || Boolean(d.tools), {
    message: 'Provide at least one of features or tools.',
    path: ['features'],
  });
```

**Response (both):** `LandingSubmitResult` — `{ created: boolean }`. `created` is `false` only for a subscribe no-op on an already-listed, still-active email; feedback always returns `true`.

#### `POST /api/unsubscribe` (AECI-537)

Mailing-list opt-out, keyed on the opaque per-subscriber `unsubscribe_token`. **Soft-delete**: the matched `mailing_list` row's `unsubscribed_at` is set (a suppression record, so the subscriber is never re-emailed) rather than deleted. Idempotent — `unsubscribed_at = COALESCE(unsubscribed_at, now)` preserves the first opt-out time on a repeat. Like subscribe / feedback / `page_views`, it is **write-once lead-capture** and exempt from the §26.1 audit-in-batch invariant (no `audit_log` row); reached only over the service binding (no public ingress; the SSR `/api/*` passthrough forwards it byte-for-byte, no geo needed).

**Two callers, one handler.** The token is read from the **`?token=` query first, then the JSON body**:

- the `/unsubscribe` page POSTs `{ token }` as JSON;
- the RFC 8058 one-click header (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`) makes the mail client POST a form body to `…/api/unsubscribe?token=…` — we read the query token and ignore the body.

```typescript
export const UnsubscribeSubmitSchema = z.object({ token: z.string().trim().min(1).max(100) });
```

**Response:** `UnsubscribeResult` — `{ ok: boolean }`, always HTTP `200`. `ok: true` = the token matched a subscriber who is now suppressed (idempotent — already-unsubscribed also returns `true`). `ok: false` = the token matched no one (an invalid or expired link). Tokens are unguessable, so `false` leaks no membership. A best-effort `aeci.mailing_list.unsubscribe` count is emitted on success.

---

### 6.14 Vendor portal endpoints

Stage 2 (AECI-520). All require `role === 'vendor_admin'` **and** a non-null `profiles.vendor_id`, enforced by the `requireVendor()` Worker middleware (`apps/api/src/lib/authz.ts`) — verifies the JWT, loads the D1 profile, and rejects in this order: missing token/profile `401`; `banned_at` set `403`; wrong role `403`; null `vendor_id` `403`. A site **`admin` is rejected too** — there is no impersonation at launch, admins act on vendor data through `/api/admin/*` so the audit trail names the real actor.

Source of truth: `packages/shared/src/api/vendor.ts` + `product-versions.ts` + `vendor-attestations.ts` + `vendor-notifications.ts` (Zod), `apps/api/src/routes/vendor.ts` + `vendor-product-versions.ts` + `vendor-attestations.ts` + `vendor-notifications.ts` + `vendor-data-objects.ts` (handlers), with the shared guard seam in `apps/api/src/routes/vendor-shared.ts` and the two-slot authority seam in `apps/api/src/lib/attestation-authority.ts`; `STAGE_2_VENDOR_PORTAL_SPEC.md` §4 and `STAGE_2_ATTESTATIONS_SPEC.md` §5 / §7.2 / §8.3.

**Two invariants govern this whole surface.**

1. **Scoping.** There is no RLS on app tables (ADR 0016), so the guard plus a `WHERE vendor_id = <session vendor>` filter in every query *is* the authorization. No vendor id crosses the wire; every client-supplied id — the product on `PATCH /api/vendor/products/:id` and its versions, the integration or claim on the attestation routes — has its ownership proven against `product_vendors` **before** anything is read or written, and a miss returns **`404`, not `403`** — a non-owner must not learn the resource exists.
2. **The allow-list is the guard-rail.** Zod strips unknown keys, so any column absent from an `Update*Schema` is unwritable by a vendor: `slug`, `name` / `company_name`, `verified`, `promotion_status`, `admin_notes`, `research_*`, `priority_*`, `score_*`, the VQS fields, `usefulness`, `source_url`, and every denormalized count/average stay AECi-owned. Adding a field there grants a write.

Every editable field is `.nullable().optional()`: an **absent** key leaves the column untouched, an explicit **`null`** clears it. Taxonomy arrays are set-replacement — absent leaves the facet alone, `[]` clears it. URLs must be `http://` or `https://` (§7.1); a plain `.url()` would accept `javascript:`.

Writes go through one `db.batch([...])` carrying the `UPDATE`, any taxonomy join rewrite, and the `audit_log` row (§26.1). Audit rows use `action: 'vendor.updated'` / `'product.updated'` with `actor_type: 'user'` (a `vendor_admin` maps to `user` — the `audit_log_actor_type_check` CHECK has no `vendor` value, and it stays that way deliberately rather than because a migration was unavailable; see `AUTH_AND_RLS.md` §4.4) and are distinguished by `metadata.source = 'vendor-portal'`. Post-commit, the write enqueues a `vendor:{slug}` / `product:{slug}` Cache-Tag purge with `source: 'vendor'`.

**Search freshness.** Vendor edits do **not** trigger a per-write Algolia reindex. They reach search on the nightly watermark sync (≤24h) while SSR repaints immediately via the purge (`STAGE_2_SPEC.md` §8.3(5)). Dashboard copy must not promise "live in search".

#### `GET /api/vendor/me`

The dashboard payload — one round-trip renders the surface: the caller's vendor, the products it owns (via `product_vendors`, with their taxonomy assignment), the `vendor_requests` targeting the vendor or any of those products, and how many seats share the account. The seat **roster** is a separate call because it needs the Supabase email lookup.

```typescript
export const VendorMeResponseSchema = z.object({
  vendor: VendorAccountSchema,          // incl. `verified` as READ-ONLY state
  products: z.array(VendorProductSchema),
  requests: z.array(VendorRequestSummarySchema),
  seat_count: z.number().int().min(1),
});
```

`VendorRequestSummary` deliberately omits `submitter_email` and the free-text `body` — a correction may be filed by a member of the public.

Errors: `NOT_FOUND` if the granted seat's vendor row has since been deleted.

#### `GET /api/vendor/seats`

The vendor's seat roster. A bare object, never paginated — seats are granted by hand, so the list is bounded. Multi-seat is **flat**: every seat is equal, there is no owner/admin distinction, and self-serve invite/revoke is deferred (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11), so this is read-only.

```typescript
export const VendorSeatSchema = z.object({
  user_id: z.string().uuid(),
  display_name: z.string().nullable(),
  email: z.string().nullable(),   // from Supabase auth.users; null without the
                                  // service-role key (local dev / PR preview)
  banned: z.boolean(),            // per-seat ban never touches vendors.verified
  created_at: z.string().datetime(),
});
export const ListVendorSeatsResponseSchema = z.object({ seats: z.array(VendorSeatSchema) });
```

#### `GET /api/vendor/notifications`

The in-portal notification list (AECI-302 / `STAGE_2_ATTESTATIONS_SPEC.md` §7.2) — the daily §7 detector sweep's nudges to this vendor. **Not verified-gated**: `vendors.verified` gates authoring, not reading, so an unverified vendor sees its own (probably empty) list rather than a `403` it cannot act on — the same reasoning as the version list.

**There is no notifications table.** The sweep records every successful send in `audit_log` (`action: 'notification.sent'`, `entity_type: 'claim'`, `entity_id: <claim id>`) as its anti-nag suppression ledger, and this endpoint reads those same rows (§7.3 — "no separate store"). Two consequences for consumers:

1. **Every field is a snapshot taken at send time**, not a live read. Nothing is re-joined, which is what makes the list cheap — and what keeps a year-old notification legible after the claim it names has been re-curated or deleted.
2. **Ops-routed rows are invisible here.** The `aeci-denied` correction signal and the ops half of `open-conflict` are written with `metadata.vendorId = null`, which can never equal a caller's vendor id. The isolation is structural, not a clause a handler must remember.

Window and shape: the last **90 days** (deliberately wider than the 30-day suppression window, so a vendor can see the nudge currently suppressing a repeat), newest first, capped at **50** rows. No pagination contract at launch.

```typescript
export const VendorNotificationSchema = z.object({
  id: z.string().uuid(),                   // the audit_log row id — a stable list key
  detector: z.enum(ATTESTATION_DETECTORS), // silent-counterparty | open-conflict
                                           // | stale-version | aeci-denied
  claim_id: z.string().uuid(),
  integration_id: z.string().uuid(),
  data_object: NotificationProductRefSchema.nullable(),        // { slug, name }
  counterpart_product: NotificationProductRefSchema.nullable(),
  pair_path: z.string().nullable(),        // /products/{context}/integrations/{other}
  created_at: z.string(),
});
export const ListVendorNotificationsResponseSchema = z.object({
  notifications: z.array(VendorNotificationSchema),
});
```

`pair_path` is rebuilt from the stored slugs through the same alphabetical rule the pair route canonicalises to (`orderedPairSlugs`), so it always matches the indexable URL. A row whose stored snapshot cannot be read (a future detector id, a later schema) is **skipped rather than surfaced or thrown** — these rows outlive the code that wrote them.

Errors: none beyond the guard's. An empty ledger is `200 { "notifications": [] }`.

#### `PATCH /api/vendor/profile`

Edits the caller's own vendor row. The path carries **no** vendor id, so cross-vendor access is structurally impossible.

```typescript
export const UpdateVendorProfileSchema = z
  .object({
    description: longText.nullable().optional(),
    website: editableUrl.nullable().optional(),
    headquarters: shortText.nullable().optional(),
    founded_year: z.number().int().min(1800).max(2100).nullable().optional(),
    public_private: z.enum(['public', 'private']).nullable().optional(),
    parent_company: shortText.nullable().optional(),
    contact_email: z.string().trim().toLowerCase().email().max(200).nullable().optional(),
    phone_number: shortText.nullable().optional(),
    logo_url: editableUrl.nullable().optional(),
    // profile URLs: linkedin_url, x_url, facebook_url, instagram_url,
    // youtube_url, crunchbase_url, wiki_url  ·  plus github_org (shortText)
  })
  .superRefine(/* at least one field must be present */);

export const UpdateVendorProfileResponseSchema = z.object({ vendor: VendorAccountSchema });
```

`source_url` is excluded on purpose: it records where AECi's own research came from, so letting the subject of that research rewrite it would defeat it.

Errors: `VALIDATION_FAILED` (empty body, or a body whose only keys are non-allow-listed — Zod strips them, so the vendor gets a clear 400 rather than a silent no-op 200), `MALFORMED_REQUEST`, `NOT_FOUND`.

#### `PATCH /api/vendor/products/:id`

Edits one product the caller's vendor owns. `name`/`slug` are **not** editable — a rename breaks the URL, the Algolia record, and every inbound link, so it stays a correction request.

```typescript
export const UpdateVendorProductSchema = z
  .object({
    description: longText.nullable().optional(),
    website: editableUrl.nullable().optional(),
    tool_integrations_url: editableUrl.nullable().optional(),
    api_docs_url: editableUrl.nullable().optional(),
    logo_url: editableUrl.nullable().optional(),

    category_slugs: termSlugList.optional(),   // max 10, [a-z0-9-]+
    audience_slugs: termSlugList.optional(),
    phase_slugs: termSlugList.optional(),
  })
  .superRefine(/* at least one field must be present */);

export const UpdateVendorProductResponseSchema = z.object({ product: VendorProductSchema });
```

**Taxonomy guard-rail:** a vendor may only **assign terms that already exist**. Minting a term is an AECi curation act, so an unknown slug is a `VALIDATION_FAILED` keyed to the field rather than a silent drop — and nothing is partially applied, because terms are resolved before the batch opens.

Errors: `NOT_FOUND` (unknown id **or** a product owned by another vendor — deliberately indistinguishable), `VALIDATION_FAILED` (empty body, unknown taxonomy slug, malformed URL/slug), `MALFORMED_REQUEST`.

#### Product versions — `/api/vendor/products/:id/versions`

Stage 2 (AECI-607, `STAGE_2_ATTESTATIONS_SPEC.md` §8.3). A product's vendor-declared releases: the entity the version-diff timeline (AECI-303) selects on. Zod in `packages/shared/src/api/product-versions.ts`, handlers in `apps/api/src/routes/vendor-product-versions.ts`.

**These four endpoints are the only WRITE surface, and the only place `ProductVersion` (with its `id` and `sort_key`) is exposed.** AECI-303's public read is the **pair response** — `version_diff.context_versions` / `other_versions` on `GET /api/products/:slug/integrations/:otherSlug` (§6.3) — carrying `PairVersion` (`label` + `released_at` only). There is deliberately **no** public `GET /api/products/:slug/versions`: the selectors are unconditionally part of the pair page, so a second fetch would be pure cost, and withholding `sort_key` from the browser is what structurally stops it re-deriving an ordering the label cannot express (§8.2). The shared `VERSION_ORDER` (`apps/api/src/lib/drizzle-helpers.ts`) is the one SQL `ORDER BY` behind both reads.

| Method | Path | Gate | Success |
|---|---|---|---|
| `GET` | `/api/vendor/products/:id/versions` | ownership | `200 { versions }` |
| `POST` | `/api/vendor/products/:id/versions` | ownership **+ verified** | `201 { version }` |
| `PATCH` | `/api/vendor/products/:id/versions/:versionId` | ownership **+ verified** | `200 { version }` |
| `DELETE` | `/api/vendor/products/:id/versions/:versionId` | ownership **+ verified** | `204` (no body) |

**Two gates, and the order is load-bearing.** Ownership is proven first and a miss is a **`404`** (the §6.14 non-disclosure rule); only then is `vendors.verified` checked, and a miss there is a **`403`**. Reversed, an unverified caller probing another vendor's product would get a `403` — which still discloses nothing by itself, but the fixed order also keeps a *verified* non-owner on the 404 path. **`GET` is not verified-gated**: authoring is the Verified-vendor capability (`STAGE_2_ATTESTATIONS_SPEC.md` §1), so the dashboard renders a read-only tab and explains why rather than 403-ing a vendor out of its own data. The 403 copy points at the claim/verification flow and **never at ranking, placement, or search** — verification gates capability only.

`:versionId` must belong to `:id`; a mismatch is a `404`, so a version id cannot be probed across products.

```typescript
export const ProductVersionSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
  label: z.string().min(1),          // free text: '2026.1', 'v5.2', 'R2024 SP1'
  released_at: z.string().nullable(), // YYYY-MM-DD
  sunset_at: z.string().nullable(),
  sort_key: z.number().int(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const ListProductVersionsResponseSchema = z.object({
  versions: z.array(ProductVersionSchema),   // ordered by sort_key; never paginated
});

export const CreateProductVersionSchema = z.object({
  label: versionLabel,                        // trim, 1..60
  released_at: isoDate.nullable().optional(), // /^\d{4}-\d{2}-\d{2}$/
  sunset_at: isoDate.nullable().optional(),
  sort_key: sortKey.optional(),               // omitted → derived from label
});

export const UpdateProductVersionSchema = z
  .object({
    label: versionLabel.optional(),
    released_at: isoDate.nullable().optional(),
    sunset_at: isoDate.nullable().optional(),
    sort_key: sortKey.nullable().optional(),  // number sets it; null re-derives
  })
  .superRefine(/* at least one field must be present */);

export const ProductVersionResponseSchema = z.object({ version: ProductVersionSchema });
```

**`sort_key` is the ordering, and the label never is.** Version labels do not sort lexically (`'2026.10' < '2026.9'`), so the list comes back ordered by `sort_key`, then `created_at`, then `id` — the tiebreak deliberately never falls back to the label. `deriveVersionSortKey` (`@aeci/shared/version-sort`) packs the first three numeric runs of the label into one integer on create; the optional `sort_key` is the vendor's override for labels that derive 0 (`'LTS'`, `'Fall release'`).

**On `PATCH`, `sort_key` never re-derives itself.** Changing `label` alone leaves the key exactly where it was — a silent re-derive would discard a deliberate override the moment a vendor fixed a typo. Explicit `null` is the "recompute from the (new) label" instruction; a number sets it outright. This is the one field on the whole `/api/vendor/*` surface where `null` means *recompute* rather than *clear*.

**Dates are date-only** (`YYYY-MM-DD`). A timezone-bearing instant is rejected, so a value the UI renders as a day cannot arrive as one.

Writes go through one `db.batch([...])` carrying the mutation and its `audit_log` row (§26.1), with actions `product_version.created` / `.updated` / `.deleted`, `entity_type: 'product_version'`, and `metadata.source = 'vendor-portal'` plus `vendorId` / `productId`. Post-commit the write enqueues a **`product:{slug}`** purge and nothing else: the pair page embeds `product:{slug}` for both of its endpoints (`CACHE_STRATEGY.md` §2), so that one tag also drops every pair page the product appears on, while `index:products` is omitted because versions never render on the catalog. `products.updated_at` is deliberately **not** bumped — versions do not feed the Algolia record.

**Promote does not ingest versions** at launch; this surface is the only writer (`STAGE_2_ATTESTATIONS_SPEC.md` §8.3 / §11).

Errors: `NOT_FOUND` (unknown product/version, a product owned by another vendor, or a version on a different product — all deliberately indistinguishable), `FORBIDDEN` (owner, but not verified), `VALIDATION_FAILED` (empty body, a `label` already used on this product, a non-date stamp, an out-of-range `sort_key`), `MALFORMED_REQUEST`.

#### Attestations — `/api/vendor/integrations` + `/api/vendor/claims` + `/api/vendor/data-objects`

Stage 2 (AECI-301, `STAGE_2_ATTESTATIONS_SPEC.md` §5). The surface a Verified vendor writes its own integration claims through — the first code that can produce a `vendor_a` / `vendor_b` attestation, and therefore the first that can move a claim off `unverified`. Zod in `packages/shared/src/api/vendor-attestations.ts`, handlers in `apps/api/src/routes/vendor-attestations.ts`.

> **⚠️ "Claim" means three different things in this document.** Here it is a **data-flow claim** — "this `data_object` flows in this `direction` through this integration" (`STAGE_1_5_SPEC.md` §3.1). It is **not** the public correction/claim *request* of §6.7, and **not** the vendor-account *claim* an admin grants in §6.10.

| Method | Path | Gate | Success |
|---|---|---|---|
| `GET` | `/api/vendor/integrations` | authority | `200 { integrations }` |
| `POST` | `/api/vendor/claims` | authority **+ verified** | `201 { claim }` |
| `PUT` | `/api/vendor/claims/:claimId/attestation` | authority **+ verified** | `200 { claim }` |
| `DELETE` | `/api/vendor/claims/:claimId/attestation` | authority **+ verified** | `204` (no body) |
| `GET` | `/api/vendor/data-objects` | guard only — **no authority, no verified** | `200 { data_objects }` |

**Authority is the §6.14 ownership rule, one grain up.** `PATCH /api/vendor/products/:id` asks "do you own this product"; these ask "do you own an *endpoint* of this integration", because an integration has **two** vendor-writable slots — `vendor_a` for endpoint A (`integrations.source_product_id`), `vendor_b` for endpoint B. `resolveAttestationSlots` / `resolveClaimAuthority` (`apps/api/src/lib/attestation-authority.ts`) are the single implementation; no handler re-derives the table. A caller owning neither endpoint gets **`404`**, and it is indistinguishable from a resource that does not exist — collapsed into one join result rather than two branches that must be kept identical, so the endpoint cannot be walked as an existence oracle. See `AUTH_AND_RLS.md` §4.2a.

**Nothing on the wire carries a slot or a vendor id.** Which slot the caller fills is derived from `product_vendors`; a `slot` key in a request body is stripped by Zod. On the READ it appears as `slots` — "which one is yours".

**A vendor owning both endpoints writes both slots.** `product_vendors` is many-to-many, so one company can hold both. Every write fills every slot the caller owns, so its position cannot self-contradict and `DELETE` genuinely clears. It makes no difference to a reader: `confirmed` requires two **distinct** `attested_by_vendor_id` values, so one company is one voter and still renders `single_source`.

**Direction is caller-relative on the wire, canonical in the DB.** The vendor sends `inbound` / `outbound` / `both` relative to its own product; `claims.direction` stores `a_to_b` / `b_to_a` / `both` relative to the integration row's own endpoints (`STAGE_1_5_SPEC.md` §3.2). `claimDirectionForContext` / `claimDirectionFromContext` (`@aeci/shared`) are the two halves. A caller owning both endpoints is framed from endpoint A.

**`GET` is not verified-gated**, matching the product-version list: authoring is the Verified capability, reading your own surface is not, so the dashboard renders a read-only tab and explains what verification unlocks.

```typescript
export const VendorClaimSchema = z.object({
  id: z.string().uuid(),
  integration_id: z.string().uuid(),
  data_object_slug: z.string(),
  data_object_name: z.string(),
  direction: ContextDirectionSchema,        // caller-relative: inbound|outbound|both
  agreement: z.enum(AGREEMENT_STATES),      // computed + echoed, never sent
  origin: ClaimOriginSchema,                // 'aeci' | 'vendor'
  mine: z.array(VendorOwnAttestationSchema),        // 0..2 — one per owned slot
  counterparty: CounterpartyAttestationSchema.nullable(),  // { asserted, note }
});

export const VendorIntegrationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  mechanism_kind: IntegrationMechanismKindSchema.nullable(),
  mechanism_name: z.string().nullable(),
  context_product: ProductLinkSchema,   // the caller's endpoint (A when it owns A)
  other_product: ProductLinkSchema,
  slots: z.array(VendorAttestationSlotSchema).min(1),   // 'vendor_a' | 'vendor_b'
  claims: z.array(VendorClaimSchema),
});

export const ListVendorIntegrationsResponseSchema = z.object({
  integrations: z.array(VendorIntegrationSchema),   // never paginated
});

export const CreateVendorClaimSchema = z.object({
  integration_id: z.string().uuid(),
  data_object: dataObjectRef,                 // trim, 1..100 — slug OR alias
  direction: ContextDirectionSchema,
  note: attestationNote.nullable().optional(), // trim, max 2000
  introduced_version_id: versionId.nullable().optional(),
  deprecated_version_id: versionId.nullable().optional(),
});

export const UpsertVendorAttestationSchema = z.object({
  asserted: z.boolean(),                       // required — a PUT states a position
  note: attestationNote.nullable().optional(),
  introduced_version_id: versionId.nullable().optional(),
  deprecated_version_id: versionId.nullable().optional(),
});

export const VendorClaimResponseSchema = z.object({ claim: VendorClaimSchema });

// GET /api/vendor/data-objects (AECI-606) — the closed picker vocabulary.
// No `aliases` (resolver metadata; a client-side matcher would drift from
// `lib/data-object-vocabulary.ts`), no `id` (nothing on the surface takes one),
// no `display_order` (the array arrives ordered).
export const DataObjectOptionSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});

export const ListDataObjectsResponseSchema = z.object({
  data_objects: z.array(DataObjectOptionSchema),
});
```

**`GET /api/vendor/integrations`** returns every integration touching a product the caller owns, with each claim's live attestations resolved into `mine` / `counterparty`, its computed `agreement`, and the slot(s) that are the caller's. Unpaginated — the set is bounded by the vendor's own catalog. Retracted attestations never appear (`retracted_at IS NULL`, the same filter the public pair page applies). Claims are ordered by the `data_object` vocabulary's `display_order`. A vendor whose products carry no integrations gets `200 { integrations: [] }`, not a 404.

**`POST /api/vendor/claims`** creates the claim **and** the caller's affirming attestation in one batch. There is no `asserted` field — creating a claim *is* affirming it; recording a denial means `PUT` on a claim that already exists. `origin` is set to `'vendor'` with `created_by_vendor_id` (§2.2), never from the request.

**`data_object` is find-only.** The slug or alias resolves against the frozen, closed `taxonomy_data_objects` vocabulary (`docs/DATA_OBJECT_VOCABULARY.md`) — a vendor cannot mint a term any more than promote can. Unlike promote, which lands a miss in `skipped[]` because it is a batch job, an unmatched term here is a **`VALIDATION_FAILED` naming the field**. Both callers share one matcher (`apps/api/src/lib/data-object-vocabulary.ts`).

**`GET /api/vendor/data-objects`** (AECI-606) serves that closed vocabulary to the dashboard, so the §6 picker offers the list rather than a text input and a vendor never submits a term the resolver will reject. Ordered by `display_order` then `slug`, **NULLs last** — the same ordering the claim lists use, so the picker's rows and the tab's lanes agree. Never paginated: a frozen 20-term list.

It is the **one `/api/vendor/*` route with no `vendor_id` filter**, and that is a contract rather than an omission: `taxonomy_data_objects` is AECi-curated, has no `vendor_id` column and no vendor-owned rows, so the filter would be *vacuous*. Every caller gets a byte-identical body by construction, and a spec pins that sameness so a later "restore the missing scope filter" edit fails loudly instead of reading as a fix. `AUTH_AND_RLS.md` §4.4 carries the matching carve-out. Not verified-gated either — 403-ing the vocabulary would leave the read-only tab unable to label its own claims.

**`aliases` is deliberately absent from the wire.** The picker submits a canonical slug, which always resolves, so alias matching buys nothing here; shipping them would invite a client-side match that reimplements `safeSlugify`, and a second matcher is the drift `lib/data-object-vocabulary.ts` was extracted to eliminate. They are resolver metadata ("ITB", "P6", "AP"), not translatable copy. `id` is absent because nothing on the surface takes one, and `display_order` because the array arrives ordered. An unseeded vocabulary is `200 { data_objects: [] }`, never a 500 — the dashboard degrades the add affordance rather than losing the tab. *Errors: none beyond the guard's.*

**A duplicate claim identity is a `400` carrying `details.claim_id`.** `claims_identity_key` is `(integration_id, data_object_id, direction)`, so the collision is narrow — claims anchor to the *mechanism row*, and two mechanisms moving the same data object between the same products are two independent claims. The existing id is returned so the UI can pivot to `PUT` rather than dead-ending.

**`PUT` replaces; it does not patch.** Supersession is **retract-then-insert** (§2.1), never an `UPDATE` — the old row keeps its `id` and gains `retracted_at`, because AECI-303's version-diff timeline reads the append-only history. There is therefore no prior row to leave a field alone on: an omitted `note` or version stamp lands as `null`. The retract clears whatever holds a slot the caller owns (the partial unique index makes that last-write-wins); `DELETE` retracts only the caller's **own** rows, so withdrawing your position never withdraws someone else's.

**`DELETE` with nothing of the caller's to retract is a `404`**, not an idempotent 204 — §26.1 wants no audit row without a state change.

**Version stamps stay inside the attesting side's own endpoint** (`STAGE_2_ATTESTATIONS_SPEC.md` §8.2). A `introduced_version_id` / `deprecated_version_id` belonging to a product the caller does not own on this integration is a `VALIDATION_FAILED` naming the field, and an unknown id answers identically so the response cannot probe another product's release history. For a caller owning both endpoints, the stamp lands only on the slot whose endpoint owns that version.

Writes go through one `db.batch([...])` carrying every mutation and its `audit_log` rows (§26.1), with actions `claim.created` / `attestation.created` / `attestation.retracted`, `entity_type` `claim` / `attestation`, and `metadata.source = 'vendor-portal'` plus `vendorId`, `claimId`, `integrationId` and the resolved `slot`. One audit row is emitted **per attestation row**, so a both-endpoints write produces two. Post-commit the write enqueues **`pair:{min}__{max}`** (via `pairCacheTag` — the identical tag the pair page emits, keep them in lockstep) plus **`product:{slug}`** for both endpoints, whose detail pages carry the claims-aware direction column. `index:products` is omitted: claims never render on the catalog.

**No Algolia reindex.** Claims do not feed the index; vendor edits reach search on the nightly watermark sync (`STAGE_2_SPEC.md` §8.3(5)). Dashboard copy must not promise "live in search".

Errors: `NOT_FOUND` (unknown claim/integration, or one whose endpoints the caller does not own — deliberately indistinguishable; also a `DELETE` with nothing to retract), `FORBIDDEN` (endpoint owner, but not verified — copy points at the claim/verification flow and never at ranking, placement, or search), `VALIDATION_FAILED` (unknown `data_object`, a duplicate claim identity, a version outside the caller's endpoint, a missing stance on `PUT`), `MALFORMED_REQUEST`.

---

## 7. Validation rules

### 7.1 General

- All input strings trimmed before validation
- Email addresses lowercased before storage
- UUIDs validated as v4 format
- URLs validated as `http://` or `https://` only
- Slugs validated as `[a-z0-9-]+` only

### 7.2 String length defaults

When schemas don't specify, defaults apply:
- Short text fields: max 200 chars
- Long text fields: max 2000 chars
- Identifiers and slugs: max 100 chars

### 7.3 Numeric ranges

- Ratings: 1–5 integer only
- Years: 0–50 integer (covers reviewer experience)
- Pagination limit: 1–100, default 20

---

## 8. Implementation notes

### 8.1 Zod parsing pattern

```typescript
import { z } from 'zod';
import { SubmitReviewSchema } from '@aeci/shared/api/reviews';

// In endpoint handler
const body = await request.json();
const parsed = SubmitReviewSchema.safeParse(body);
if (!parsed.success) {
  throw new ApiError(
    400,
    'VALIDATION_FAILED',
    'Invalid review submission',
    parsed.error.issues[0]?.path.join('.'),
    parsed.error.flatten()
  );
}
const data = parsed.data;
// Continue with type-safe data
```

### 8.2 Response helpers

```typescript
export function jsonResponse<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function errorResponse(error: ApiError, traceId: string): Response {
  return jsonResponse({
    error: {
      code: error.code,
      message: error.message,
      field: error.field,
      details: error.details,
    },
    trace_id: traceId,
  }, error.status);
}
```

### 8.3 Service binding consumption

The SSR Worker imports types from `@aeci/shared` and consumes the API via service binding:

```typescript
// In SSR Worker
import type { GetProductResponse } from '@aeci/shared/api/products';

const apiResponse = await env.API.fetch(
  new Request('https://api/products/procore')
);
const product: GetProductResponse = await apiResponse.json();
```

Type safety is preserved end-to-end without any code generation step.

---

## 9. Versioning

This is an internal API. Breaking changes are coordinated between the API Worker and SSR Worker by:

1. Updating the shared package
2. Updating both Worker codebases in the same PR
3. Both deploy together

No URL versioning (`/api/v1/`) at Stage 1. If external consumers appear in Stage 2+, version then.

---

## 10. Future considerations

- **GraphQL or tRPC** — worth evaluating if endpoint count grows past ~40 or if the SSR Worker starts making many round-trip requests per page
- **OpenAPI generation** — possible to auto-generate from Zod schemas via `zod-to-openapi` if external consumers need it
- **Rate limiting beyond WAF** — application-level limits per authenticated user (see `STAGE_1_SPEC.md` §15)
- **Subscription/streaming endpoints** — for live updates in Stage 2+ vendor portal (Server-Sent Events or WebSockets)

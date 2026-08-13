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
│   │   └── admin.ts           # (Phase 6+)
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

// VendorLink and ProductLink extend LinkRef with logo_url.
export const VendorLinkSchema = LinkRefSchema.extend({
  logo_url: z.string().url().nullable(),
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
| `SLUG_CONFLICT` | 409 | Slug collision detected on entity creation |
| `INVALID_STATE_TRANSITION` | 422 | Attempted workflow transition is not allowed from current state |
| `RATE_LIMITED` | 429 | Rate limit exceeded |
| `DEPENDENCY_FAILURE` | 503 | Upstream dependency (Supabase, Algolia, Linear) failed |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

### 4.1 HTTP status code conventions

- `400` — validation errors, malformed requests
- `401` — not authenticated
- `403` — authenticated but not authorized, or banned
- `404` — resource doesn't exist or is not visible to caller
- `409` — conflict (duplicate, slug collision)
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
// there is neither. Precomputed server-side so the product-detail table can never
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

```typescript
// packages/shared/src/api/product-pairs.ts
// ContextDirectionSchema is defined in `./integrations` (shared with the
// product-detail table's `ProductIntegrationItem.context_direction`, §5.3) and
// imported here; conceptually it is `z.enum(['outbound', 'inbound', 'both'])`.

// The claim's computed agreement (§3.4 — computeAgreement, never stored). Only
// `unverified` is reachable in Stage 1.5 (AECi-only attestations, AECi-never-red).
export const AgreementStateSchema = z.enum(['unverified', 'confirmed', 'conflict']);

// One attestation behind a claim (§3.3), for the AECi-annotated provenance (§8).
export const PairClaimAttestationSchema = z.object({
  source: z.enum(['aeci', 'vendor_a', 'vendor_b']),   // only `aeci` written in 1.5
  asserted: z.boolean(),
  note: z.string().nullable(),
  introduced_at: z.string().nullable(),               // dormant version stamps (Stage 2)
  deprecated_at: z.string().nullable(),
});

// One data_object claim on a mechanism (Layer B — §8). `direction` is already
// translated to the context product's frame (§3.2); `agreement` is computed.
export const ProductPairClaimSchema = z.object({
  data_object_slug: z.string(),
  data_object_name: z.string(),
  direction: ContextDirectionSchema,
  agreement: AgreementStateSchema,
  attestations: z.array(PairClaimAttestationSchema),
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
  confirmed: z.number().int().min(0),  // vendor-confirmed — always 0 in Stage 1.5
});

export const ProductPairResponseSchema = z.object({
  context_product: ProductListItemSchema,   // both products hydrate as ProductListItem (vendor + review recap)
  other_product: ProductListItemSchema,
  mechanisms: z.array(ProductPairMechanismSchema),
  sync_headline: SyncHeadlineSchema,
});
export type ProductPairResponse = z.infer<typeof ProductPairResponseSchema>;
```

- **`direction`** (mechanism) is the integration row's stored `one-way`/`bidirectional` translated to the **context product's** frame: `one-way` → `outbound` when the context product is the integration's `source`, else `inbound`; `bidirectional` → `both`; `null` → `null` (§3.2, applied at the mechanism level).
- **`claims[]`** (Layer B — §8) are the `data_object` flows on each mechanism. `direction` is the **claim-level** stored `a_to_b`/`b_to_a`/`both` translated to the context frame (§3.2 — distinct from the mechanism translation), and `agreement` is `computeAgreement(attestations)` (§3.4, `packages/shared/src/agreement.ts`) — always `unverified` in 1.5. Ordered by the `data_object`'s `display_order`. A `data_object` moving through two mechanisms is **two claims** (§3.1), never de-duplicated.
- **`sync_headline`** = `computeSyncHeadline` over every claim on the pair (§3.5): `total` is the distinct claim count, `confirmed` is always `0` in Stage 1.5. `{ total: 0, confirmed: 0 }` for an unseeded/empty pair.
- **Errors / status:** `NOT_FOUND` when either slug is unknown **or the two slugs are equal**. A valid-but-unconnected pair (both products exist, no integration between them) is a **200** with `mechanisms: []`.
- SSR caching (pair page): detail TTL, `Cache-Tag: route:detail,pair:{min}__{max},product:{slug}×2` (see `CACHE_STRATEGY.md`).

### 6.4 Taxonomy

#### `GET /api/categories`, `/api/audiences`, `/api/phases`, `/api/trades`

```typescript
export const CategoriesListResponseSchema = z.object({
  data: z.array(TaxonomyTermWithCountSchema),
});
```

Not paginated — the taxonomy is small by design (Phase 2 Spec §3.1).

**`/api/trades` is not publication-gated.** Every term is returned with its `product_count`, including terms below the `TRADE_PUBLISH_MIN_PRODUCTS = 3` floor; the gate is applied per-surface by the consumer (`STAGE_1_SPEC.md` §5.5a, `TRADES_VOCABULARY.md` §6). Keeping the gate out of the API avoids splitting the vocabulary into two response shapes.

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
}
```

Errors: `UNAUTHENTICATED`.

#### `PATCH /api/account`

Update the editable profile fields (today: `display_name`). Audited
(`profile.updated`). Returns the updated `AccountProfileResponse`.

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

Defensive/idempotent profile-ensure called by the SSR `/auth/callback` handler after the PKCE code exchange (AECI-195, `STAGE_1_PHASE_5_SPEC.md` §4.2). Requires a verified Supabase user JWT (`Authorization: Bearer`); the profile id is always the token's `sub` — no request body. Inserts the `profiles` row only if the `handle_new_user` trigger somehow missed it (`INSERT … ON CONFLICT DO NOTHING`; all other columns take schema defaults, including `role='reviewer'`). Writes an audit row (`profile.created`) only when a row was actually created.

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
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
});

export type PageViewPayload = z.infer<typeof PageViewPayloadSchema>;
```

**Phase 4 (AECI-177) wires the write.** The handler validates the body synchronously (so a malformed body still surfaces `400`), returns `204` immediately, and inserts one `page_views` row via `ctx.waitUntil()` — the write never blocks the response (§14.2). The `page_views` table already exists in the D1 schema (`apps/api/src/db/schema.ts`), so there is no migration. A capture failure is logged to Datadog (`warn`) and swallowed; the endpoint still returns `204`. User-blocking errors are never raised.

**Enrichment** (DATABASE_SCHEMA §9.1 columns): `cf_country`, `cf_colo`, `cf_asn`, `cf_bot_score` from Cloudflare request context; `user_agent_hash` = SHA-256 of the `User-Agent` (the raw UA is **never** stored); `locale` = the served locale (`en-US` today); and `product_id` / `vendor_id` resolved from `(entity_type, entity_id)` — `entity_id` is the entity's own UUID (the SSR resolvers attach `entity.id`), existence-checked before storing so a stale/spoofed id becomes null rather than an FK error. `user_id` / `profile_role` stay null until Phase 5 wires the authenticated session. **No raw IP is ever persisted** (§14.2 privacy).

**CF context forwarding contract.** The browser POST reaches the SSR Worker first, and `request.cf` does **not** survive the SSR→API service binding, so the SSR Worker forwards the four CF fields on trusted headers (`@aeci/shared` `PAGE_VIEW_CF_HEADERS`):

| Header | Source (`request.cf`) | `page_views` column |
|---|---|---|
| `x-aeci-cf-country` | `cf.country` | `cf_country` |
| `x-aeci-cf-colo` | `cf.colo` | `cf_colo` |
| `x-aeci-cf-asn` | `cf.asn` | `cf_asn` |
| `x-aeci-cf-bot-score` | `cf.botManagement.score` | `cf_bot_score` |

The SSR Worker is the **sole writer** of these headers: on the `/api/page-views` proxy path it strips any client-supplied copies (anti-spoof) before setting them from `request.cf`. The API Worker treats them as trusted because it has no public ingress (service-binding only); it falls back to a directly-present `request.cf` for local/test runs.

**Two writers, de-duped.** The browser `PageViewTracker` (AECI-151) is the canonical per-view counter; the SSR Worker's `firePageView` is a supplementary write that adds CF/bot context on full-document renders. They don't double-count — the client tracker skips the initial navigation (the SSR Worker already counted the landing arrival) and only counts subsequent in-app navigations. The SSR path undercounts because true edge-cache hits bypass the SSR Worker (§14.2, accepted). Both writers carry the same `PAGE_VIEW_CF_HEADERS` enrichment.

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
`audit_log` (`reviewer.banned` / `reviewer.unbanned`, with before/after state) + a
`workflow_transitions` row on a long-lived **reversible** `reviewer_ban` workflow
(`active ↔ banned`; no terminal `final_outcome`). No cache invalidation — a ban
changes no cacheable page (a banned reviewer's approved reviews stay visible, flagged
internally only, §22.3).

Errors: `NOT_FOUND` (unknown profile id); `INVALID_STATE_TRANSITION` (422) when
banning an already-banned reviewer, unbanning one who isn't banned, or a concurrent
flip; `FORBIDDEN` (403) when the target is an admin account or the acting admin
themselves (a banned admin would lock themselves out of `requireAdmin()`).

---

#### Admin panel reads (AECI-574 / Phase 8.3 P1.1, extended by AECI-577 / P1.3, AECI-579 / P1.5, and AECI-580 / P1.6)

Six `GET`s serving the operator console (`docs/ADMIN_PANEL_SPEC.md` §5–§6).
Source of truth: `packages/shared/src/api/admin-panel.ts` (Zod), and
`apps/api/src/routes/admin-{overview,metrics,traffic,page-views,catalog,system}.ts` +
`lib/admin-{analytics,catalog,status}.ts` (handlers). They register on the same
`authAdmin` sub-router behind `requireAdmin()` — no new gate.

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
`is_bot IS NULL` rows, so it retires itself when AECI-582 runs the backfill.

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
  source: z.enum(['live']),          // P2.1 adds 'snapshot'
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

One metric, day-bucketed. **Live aggregation** today; P2.1 (AECI-581) serves the
same contract from `metrics_daily` with `source: 'snapshot'`, which is why the
metric keys are already §7.1's `namespace.metric` strings.

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
  source: z.enum(['live']),
  notes: z.array(AdminNoteSchema),
  internal_filter: AdminInternalFilterSchema,
  points: z.array(AdminTimeseriesPointSchema), // { day, value, value_excluding_internal }
  total: AdminCountSchema,
});
```

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
    source: z.enum(['live']),
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
  crons: z.array(AdminCronRunSchema),           // ALWAYS all eight
  data_quality: AdminDataQualityStatusSchema.nullable(),   // null unless ?recompute=1
  algolia: z.object({
    watermark: AdminAlgoliaWatermarkSchema.nullable(),     // null = the sync never ran
    drift: AdminAlgoliaDriftStatusSchema.nullable(),       // null unless ?recompute=1
    orphan_sweep: z.null(),                                // never persisted — see below
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
});
```

`source` is the load-bearing field. **`job_runs` does not exist yet**, so a cron's
outcome and duration live only as Datadog metrics:

| `source` | meaning | today |
|---|---|---|
| `job_runs` | read from the §7.2 table | **unreachable** — declared so AECI-583 is additive, not a reshape |
| `derived` | inferred from a D1 side effect named in `derived_from`. Proves the job **ran**; says nothing about whether it **succeeded** | only `home-stats` (`MAX(stats_cache.computed_at)`) and `algolia-sync` (the `algolia_sync_watermark` row's stamp), and only once that artifact exists |
| `unknown` | no record anywhere in D1 | the other six |

`last_outcome` and `duration_ms` are therefore **null on every row** in P1.6. The
response never emits `'ok'`, and the UI renders `unknown` as *Unknown* rather than
as a passing state — a status screen that reports "fine" because it has no data is
worse than one that reports nothing. All eight rows are always present: omitting a
job would read as "not configured", a different and wrong claim.

The schedule strings come from `apps/api/src/lib/cron-schedules.ts`, which
`scheduled.ts` also `switch`es on, so the screen and the dispatcher cannot drift.

##### `?recompute=1` (§13 D8) — same semantics as `/overview`

Default: `data_quality` and `algolia.drift` are `null` with a `requires_recompute`
note. `?recompute=1` runs the ten §23.1 checks and the drift count live. Still a
**pure read** — writes nothing, sends nothing, no `audit_log` obligation; what
makes them opt-in is network cost (check #9 HTTP-probes a sample of logo URLs,
drift costs three Algolia queries), not mutation.

Both endpoints share one implementation (`apps/api/src/lib/admin-status.ts`
`runExpensiveStatusItems`), so the System screen and the Overview status strip
cannot report different results for the same check. The drift runner is invoked
**once** per request and memoized at the promise — check #10 of the ten *is* the
drift check, so running it twice would double the Algolia round trips to report
one number.

A check that finds nothing comes back `count: 0` with an empty `sample` — the UI
renders that as *passing*. `skipped: true` (no Algolia credentials) is **not** a
failure; `error` (the check threw) is distinct from both.

Two note codes are specific to this endpoint:

| code | severity | means |
|---|---|---|
| `cron_liveness_unavailable` | `warn` | `params.unknown` of `params.total` crons have no last-run record in D1 |
| `orphan_sweep_not_persisted` | `info` | the Algolia orphan sweep runs inside the 09:00 drift cron and reports only to Datadog — its result is stored nowhere, so `algolia.orphan_sweep` is always `null` |

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
**active** attestation (`deprecated_at IS NULL`, matching `attestations_active_idx`),
plus a capped sample of claimless integrations. Sample rows carry both endpoints
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
  path: z.string().min(1),                 // route PATTERN until AECI-585
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
the wire. `user_id`, `session_id` and `profile_role` are never selected — §13 D7
settled that the three are *dropped* (AECI-585), not filled, and that no session
identifier will be introduced.

Ordering is `created_at DESC, id DESC`. `page_views.id` is an autoincrement
integer PK, so the pair is a strict total order and pagination can neither repeat
nor skip a row when several visits share a timestamp.

`notes` always includes `visitor_definition_approximate` (§9.8 travels with the
number) and, when the window earns them, `bot_classification_incomplete`,
`referrer_source_incomplete`, `direct_is_mixed_bucket`, and `partial_day`.

Errors: `VALIDATION_FAILED` (400) for a missing/bad/reversed date range, a window
longer than `ADMIN_METRICS_MAX_DAYS`, or `perPage > 100`.

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

- **`jobId`** (optional, top-level, `^[A-Za-z0-9_][A-Za-z0-9_-]{7,99}$`) scopes one promote
  *attempt*. It becomes the Workflow **instance id**, so `create({ id })`'s duplicate
  guard means a replayed kick-off attaches to the existing instance and returns the same
  `jobId` — it can never start a second instance and therefore never commits twice.
  Absent → server-generated (pollable, but no replay protection).
- **`supabaseId`** scopes one *row*, as before: present → **updated** by that ID; absent
  → **created** and its new ID is returned. The review app holds the mapping; there is no
  `external_id` column. Slugs are server-generated (never sent by the client) and stay
  stable across updates.

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
  skipped: { ref: string; kind: 'integration' | 'extension' | 'usefulness' | 'claim' | 'trade'; reason: string }[];
}
```

**Integration rule (product-driven, from AECI-83):** an integration is written
only when both endpoints resolve — one is the product in this bundle (`ref`), the
other must already be promoted (`supabaseId`). Integrations whose other endpoint
isn't promoted yet land in `skipped[]` rather than failing the promote. Every
create/update writes an `audit_log` row in the same transaction (§26).

**Claims (Stage 1.5, AECI-291 contract / AECI-297 ingest):** each integration may
carry a nested `claims[]` of data-object assertions (`STAGE_1_5_SPEC.md` §5/§6.2). A
claim rides with its integration (same withhold rule), and its `dataObject` resolves
**find-only** (slug or alias) against the seeded `data_object` vocabulary — an
unmatched value lands in `skipped[]` with `kind: 'claim'`, never a 500. The ingest
upserts by the identity `(integration_id, data_object_id, direction)` via
replace-by-integration (an integration's claims are cleared and re-inserted to match
the payload exactly, attestations cascading), emits `claim.*` / `attestation.*`
audit rows in the same `db.batch`, and populates each integration result's
`sourceSlug`/`targetSlug` so the promote derivers can purge the `pair:{min}__{max}`
tag and ping the canonical pair URL without a DB read.

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

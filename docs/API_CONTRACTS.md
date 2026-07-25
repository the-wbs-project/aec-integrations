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
| `ProductDetail` | `categories` / `audiences` / `phases` | `LinkRef[]` |
| `ProductDetail` | `integrations_as_source` / `integrations_as_target` | `ProductIntegrationItem[]` (= `IntegrationListItem` + `context_direction`) |
| `ProductDetail` | `related_products` | `ProductListItem[]` |
| `VendorDetail` | `products` | `ProductListItem[]` |
| `IntegrationDetail` | `source` / `target` | `ProductLink` |
| `IntegrationDetail` | `built_by_vendor` | `VendorLink \| null` |
| `IntegrationDetail` | `powered_by_product` | `ProductLink \| null` |
| `CategoryDetail` / `AudienceDetail` / `PhaseDetail` | `products` | `ProductListItem[]` |

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
| `FORBIDDEN` | 403 | Authenticated but not authorized for this action |
| `NOT_FOUND` | 404 | Resource does not exist |
| `REVIEW_DUPLICATE` | 409 | User already reviewed this product |
| `REVIEW_BANNED` | 403 | User is banned and cannot submit reviews |
| `SLUG_CONFLICT` | 409 | Slug collision detected on entity creation |
| `GRANT_CONFLICT` | 409 | Vendor-claim grant would violate role/vendor exclusivity — the claimant account is a site `admin`, or is already linked to a different vendor (AECI-519; `details.reason` ∈ `already_admin` \| `other_vendor`) |
| `INVALID_STATE_TRANSITION` | 422 | Attempted workflow transition is not allowed from current state |
| `RATE_LIMITED` | 429 | Rate limit exceeded |
| `DEPENDENCY_FAILURE` | 503 | Upstream dependency (Supabase, Algolia, Linear) failed |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

### 4.1 HTTP status code conventions

- `400` — validation errors, malformed requests
- `401` — not authenticated
- `403` — authenticated but not authorized, or banned
- `404` — resource doesn't exist or is not visible to caller
- `409` — conflict (duplicate, slug collision, vendor-claim grant exclusivity)
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
  // Narrative value grouped by audience/phase, distinct from the `audiences`/`phases`
  // facet LinkRef[] above. `null` when the source has nothing for either facet;
  // otherwise either facet array may be empty.
  usefulness: ProductUsefulnessSchema.nullable(),
  // ProductIntegrationItem = IntegrationListItem + `context_direction` (see §5.3).
  integrations_as_source: z.array(ProductIntegrationItemSchema),
  integrations_as_target: z.array(ProductIntegrationItemSchema),
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

```typescript
export const ProductsListQuerySchema = PageQuerySchema.extend({
  sort: ProductSortSchema,                         // default 'created'
  search: z.string().optional(),
  category_id: z.string().uuid().optional(),
  audience_id: z.string().uuid().optional(),
  phase_id: z.string().uuid().optional(),
  vendor_id: z.string().uuid().optional(),
  product_role: z.enum(['application', 'connector', 'hybrid']).optional(),
  has_api_docs: z.coerce.boolean().optional(),
});

export type ProductsListQuery = z.infer<typeof ProductsListQuerySchema>;
export const ProductsListResponseSchema = paginatedResponseSchema(ProductListItemSchema);
export type ProductsListResponse = z.infer<typeof ProductsListResponseSchema>;
```

#### `GET /api/products/facets`

Scoped facet counts for the API-backed filter sidebar (AECI-143) on `/products` and the taxonomy browse pages — driven by the existing `/api` filter params, not Algolia, so these pages stay edge-cacheable. Takes the **same filter params** as `GET /api/products` minus the pagination/sort triple (`page`, `perPage`, `sort`); deriving the query with `.omit(...)` keeps the two shapes from drifting. For each taxonomy dimension (category / audience / phase) it returns the product count per term under the *other* active filters (disjunctive faceting — a dimension's own filter is excluded from its own counts). Server-side Drizzle/D1 aggregation. `Cache-Control: private, no-store` like the list/detail siblings.

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

#### `GET /api/categories`, `/api/audiences`, `/api/phases`

```typescript
export const CategoriesListResponseSchema = z.object({
  data: z.array(TaxonomyTermWithCountSchema),
});
```

Not paginated — the taxonomy is small by design (Phase 2 Spec §3.1).

#### `GET /api/categories/:slug`, `/api/audiences/:slug`, `/api/phases/:slug`

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
// `AudienceDetailSchema` / `PhaseDetailSchema` follow the same shape.
```

#### `GET /api/taxonomy`

```typescript
export const TaxonomyResponseSchema = z.object({
  categories: z.array(TaxonomyTermWithCountSchema),
  audiences: z.array(TaxonomyTermWithCountSchema),
  phases: z.array(TaxonomyTermWithCountSchema),
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
  reason: z.string().max(500).optional(),     // transition + audit; on reject also echoed to the claimant (claim-rejected email, AECI-528)
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
  (`SUPABASE_SERVICE_ROLE_KEY` absent — AECI-530) or upstream GoTrue errored; the
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
`audit_log` (`reviewer.banned` / `reviewer.unbanned`, with before/after state) + a
`workflow_transitions` row on a long-lived **reversible** `reviewer_ban` workflow
(`active ↔ banned`; no terminal `final_outcome`). No cache invalidation — a ban
changes no cacheable page (a banned reviewer's approved reviews stay visible, flagged
internally only, §22.3).

Errors: `NOT_FOUND` (unknown profile id); `INVALID_STATE_TRANSITION` (422) when
banning an already-banned reviewer, unbanning one who isn't banned, or a concurrent
flip; `FORBIDDEN` (403) when the target is an admin account or the acting admin
themselves (a banned admin would lock themselves out of `requireAdmin()`).

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

#### `POST /api/promote`

Push-based Airtable → app-DB (Cloudflare D1) promotion. The review application sends one
product plus its dependencies (vendors, taxonomy, integrations); the Worker
upserts the whole bundle in a single atomic `db.batch([...])` and returns the created/updated
IDs so the review app can persist the mapping and re-push edits. This is the live
curator → app-DB path; the pull-based CLI `scripts/airtable-to-supabase-bulk-migrate.ts`
was **retired** (AECI-278).

**Auth:** `Authorization: Bearer <REVIEW_APP_TOKEN>` (a Wrangler secret, compared
constant-time). Missing/invalid → `401 UNAUTHENTICATED`. This is machine-to-
machine auth, not a user session.

**Idempotency:** the review app holds the IDs — there is no `external_id` column
on Supabase. An entity carrying `supabaseId` is **updated** by that ID; absent →
**created** and its new ID is returned. Slugs are server-generated (never sent by
the client) and stay stable across updates.

Schemas live in `packages/shared/src/api/promote.ts` (`PromotePayloadSchema`,
`PromoteResponse`). Intra-payload links use a client-local `ref`; cross-request
links use `supabaseId`.

`product` is **optional**: a vendor-only or integration-only push (e.g. "I edited
just the vendor on review and want it live") omits it. The payload must contain at
least one of `vendors`, `product`, or `integrations`.

```typescript
// Request (abridged — see promote.ts for all optional fields)
export const PromotePayloadSchema = z.object({
  vendors: z.array(PromoteVendorSchema).default([]),      // { ref, supabaseId?, companyName, isPrimary?, ... }
  product: PromoteProductSchema.optional(),               // { ref, supabaseId?, name, productRole, categories[], audiences[], phases[], extensionOf[], ... }
  integrations: z.array(PromoteIntegrationSchema).default([]),
  //  integrations[i].sourceProduct / targetProduct: { ref: <product.ref> } | { supabaseId }
  //  (a { ref } endpoint requires `product`; without it, reference products by supabaseId)
  //  integrations[i].claims[]: Stage 1.5 data-object claims (AECI-291) —
  //    { dataObject: slug|name, direction: 'a_to_b'|'b_to_a'|'both',
  //      attestations: { source: 'aeci'|'vendor_a'|'vendor_b', asserted, introducedAt?, deprecatedAt?, note? }[] }
  //    `dataObject` resolves find-only against the seeded vocabulary; a miss → skipped[] kind 'claim'.
});

// Response — `product` is null for a vendor-only / integration-only push
export interface PromoteResponse {
  vendors: { ref: string; id: string; slug: string; operation: 'created' | 'updated' }[];
  product: { ref: string; id: string; slug: string; operation: 'created' | 'updated' } | null;
  // sourceSlug/targetSlug (the two products' slugs) are optional — populated by the
  // claims ingest (AECI-297) so pair-page purge needs no DB read.
  integrations: {
    ref: string;
    id: string;
    operation: 'created' | 'updated';
    sourceSlug?: string;
    targetSlug?: string;
  }[];
  taxonomy: {
    categories: { slug: string; id: string; operation: 'created' | 'reused' }[];
    audiences: { slug: string; id: string; operation: 'created' | 'reused' }[];
    phases: { slug: string; id: string; operation: 'created' | 'reused' }[];
  };
  skipped: {
    ref: string;
    kind: 'integration' | 'extension' | 'usefulness' | 'claim' | 'vendor' | 'product';
    reason: string;
  }[];
}
```

**Integration rule (product-driven, from AECI-83):** an integration is written
only when both endpoints resolve — one is the product in this bundle (`ref`), the
other must already be promoted (`supabaseId`). Integrations whose other endpoint
isn't promoted yet land in `skipped[]` rather than failing the request. Every
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
upserts by the identity `(integration_id, data_object_id, direction)` via
replace-by-integration (an integration's claims are cleared and re-inserted to match
the payload exactly, attestations cascading), emits `claim.*` / `attestation.*`
audit rows in the same `db.batch`, and populates each integration result's
`sourceSlug`/`targetSlug` so the promote derivers can purge the `pair:{min}__{max}`
tag and ping the canonical pair URL without a DB read.

Errors: `MALFORMED_REQUEST` (bad JSON), `VALIDATION_FAILED` (schema / duplicate
`ref` / bad enum), `UNAUTHENTICATED` (token). Full integration guide for the
review app: `docs/REVIEW_APP_PROMOTE_API.md`.

### 6.13 Landing capture (mailing list + feedback)

Two lead-capture write hooks shipped in **AECI-257** (ADR 0016). Schemas live in `@aeci/shared` (`api/landing.ts`). Both persist to D1 (`mailing_list` / `feedback` — `apps/api/src/db/schema.ts`) and, like `page_views`, are **write-once analytics, not domain state**, so they are exempt from the §26.1 audit-in-batch invariant (no `audit_log` row). The geo / attribution fields are derived from `request.cf` by the **caller** and carried to the API Worker out of band (in the request body, or — for the app island — on trusted headers; see below), because `request.cf` does not survive a service binding (the same constraint `POST /api/page-views` works around).

**Caller (post-cutover): the shared mailing-list signup band** (`apps/web/.../shared/mailing-list-signup`, mounted on the home closing-CTA plus the directory + detail pages; §4.1, section 9; AECI-269 build child 6 / **AECI-275**, extracted into the shared band in **AECI-327**) — a progressively-enhanced browser island POSTing through the SSR Worker's `/api/*` passthrough. The browser can't read `request.cf`, so the SSR proxy forwards the geo on **trusted `LANDING_CF_HEADERS`** (`@aeci/shared`, `api/landing.ts`) — `x-aeci-cf-{country,city,region,timezone,as-organization,asn,metro-code}` — exactly the way `POST /api/page-views` forwards `PAGE_VIEW_CF_HEADERS`. UTM / referrer still ride the body (the island reads them from the live URL + `document.referrer`). The **pre-launch `apps/landing` Worker was the original second caller** (it forwarded the CF-derived geo IN THE BODY over the `env.API` binding); it was **retired at the apex cutover (AECI-247/277)**. The body-geo path is retained on the handlers (it's the fallback below), so any body-only caller still works.

The handlers read a header when present and fall back to the body value otherwise (`readLandingCfFromHeaders`, `apps/api/src/routes/landing-forms.ts`). The headers are trusted because the API Worker has no public ingress (service-binding only) and the SSR proxy is the sole writer: it strips any client-supplied copies first (anti-spoof), then sets fresh values from `request.cf` (`withForwardedLandingCf`, `apps/web/src/server-runtime.ts`). Every geo / attribution field is `nullish`, so the API Worker still accepts a body (or a header set) without them.

**Operator notification (AECI-247/277).** Retiring `apps/landing` moved its operator "new signup / new feedback" Resend email into these handlers: `POST /api/subscribe` (on a real insert — never the idempotent no-op) and `POST /api/feedback` fire a fire-and-forget notification to `ADMIN_ALERT_EMAIL` via `ctx.waitUntil` (`sendLandingSignupNotification` / `sendLandingFeedbackNotification`, `apps/api/src/lib/email.ts`). Fail-open: an absent `RESEND_API_KEY` / `EMAIL_FROM` / `ADMIN_ALERT_EMAIL` is a silent skip and never affects the response.

**Subscriber welcome (AECI-327).** On the same real insert, `POST /api/subscribe` also fires a second fire-and-forget send — the subscriber's `mailing-list-welcome` first-touch email to `payload.email` (`sendMailingListWelcomeEmail`, `apps/api/src/lib/email.ts`) — so a fresh signup schedules two `ctx.waitUntil` sends (operator alert + subscriber welcome), the idempotent no-op none. Same fail-open contract: an absent `RESEND_API_KEY` / `EMAIL_FROM`, or an unresolved recipient, is a silent skip.

#### `POST /api/subscribe`

Mailing-list signup. `email` is required and unique (`mailing_list_email_key`); the rest is best-effort attribution. Idempotent: returns `created: false` when the email is already on the list (`ON CONFLICT DO NOTHING` no-op).

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

**Response (both):** `LandingSubmitResult` — `{ created: boolean }`. `created` is `false` only for a subscribe no-op on an already-listed email; feedback always returns `true`.

---

### 6.14 Vendor portal endpoints

Stage 2 (AECI-520). All require `role === 'vendor_admin'` **and** a non-null `profiles.vendor_id`, enforced by the `requireVendor()` Worker middleware (`apps/api/src/lib/authz.ts`) — verifies the JWT, loads the D1 profile, and rejects in this order: missing token/profile `401`; `banned_at` set `403`; wrong role `403`; null `vendor_id` `403`. A site **`admin` is rejected too** — there is no impersonation at launch, admins act on vendor data through `/api/admin/*` so the audit trail names the real actor.

Source of truth: `packages/shared/src/api/vendor.ts` (Zod), `apps/api/src/routes/vendor.ts` (handlers), `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.

**Two invariants govern this whole surface.**

1. **Scoping.** There is no RLS on app tables (ADR 0016), so the guard plus a `WHERE vendor_id = <session vendor>` filter in every query *is* the authorization. No vendor id crosses the wire; the only client-supplied id (`PATCH /api/vendor/products/:id`) has its ownership proven against `product_vendors` **before** anything is read or written, and a miss returns **`404`, not `403`** — a non-owner must not learn the product exists.
2. **The allow-list is the guard-rail.** Zod strips unknown keys, so any column absent from an `Update*Schema` is unwritable by a vendor: `slug`, `name` / `company_name`, `verified`, `promotion_status`, `admin_notes`, `research_*`, `priority_*`, `score_*`, the VQS fields, `usefulness`, `source_url`, and every denormalized count/average stay AECi-owned. Adding a field there grants a write.

Every editable field is `.nullable().optional()`: an **absent** key leaves the column untouched, an explicit **`null`** clears it. Taxonomy arrays are set-replacement — absent leaves the facet alone, `[]` clears it. URLs must be `http://` or `https://` (§7.1); a plain `.url()` would accept `javascript:`.

Writes go through one `db.batch([...])` carrying the `UPDATE`, any taxonomy join rewrite, and the `audit_log` row (§26.1). Audit rows use `action: 'vendor.updated'` / `'product.updated'` with `actor_type: 'user'` (a `vendor_admin` maps to `user` — the `audit_log_actor_type_check` CHECK has no `vendor` value and this epic ships no migration) and are distinguished by `metadata.source = 'vendor-portal'`. Post-commit, the write enqueues a `vendor:{slug}` / `product:{slug}` Cache-Tag purge with `source: 'vendor'`.

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

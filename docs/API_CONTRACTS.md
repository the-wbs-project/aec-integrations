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
│   │   ├── integrations.ts    # IntegrationListItem / IntegrationDetail / IntegrationsListQuery / IntegrationsListResponse
│   │   ├── taxonomy.ts        # TaxonomyTermWithCount, Category/Audience/Phase Detail, TaxonomyResponse
│   │   ├── page-views.ts      # PageViewPayload (POST /api/page-views)
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
  .enum(['created', 'name', 'updated'])
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

Per-entity defaults (Phase 2 Spec §7.4):

- `/api/products`, `/api/vendors` → `created` (i.e. created DESC, "newest first")
- `/api/integrations` → `name` (alphabetical; groups by source product since names render as `"Source → Target"`)

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
| `ProductDetail` | `integrations_as_source` / `integrations_as_target` | `IntegrationListItem[]` |
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
  integrations_as_source: z.array(IntegrationListItemSchema),
  integrations_as_target: z.array(IntegrationListItemSchema),
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
  products: z.array(ProductListItemSchema),
});
```

The public sort key `name` on `/api/vendors` maps to the `company_name` column server-side (vendors have no plain `name` column).

### 5.3 Integration

```typescript
export const IntegrationListItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  mechanism_kind: z
    .enum(['native', 'iPaaS', 'marketplace-app', 'api', 'webhook', 'partner'])
    .nullable(), // null when the column is unset (AECI-115); an out-of-enum non-null value is rejected (500) server-side
  mechanism_name: z.string().nullable(),
  direction: z.enum(['one-way', 'bidirectional']).nullable(),
  source: ProductLinkSchema,
  target: ProductLinkSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
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

Scoped facet counts for the API-backed filter sidebar (AECI-143) on `/products` and the taxonomy browse pages — driven by the existing `/api` filter params, not Algolia, so these pages stay edge-cacheable. Takes the **same filter params** as `GET /api/products` minus the pagination/sort triple (`page`, `perPage`, `sort`); deriving the query with `.omit(...)` keeps the two shapes from drifting. For each taxonomy dimension (category / audience / phase) it returns the product count per term under the *other* active filters (disjunctive faceting — a dimension's own filter is excluded from its own counts). Server-side Prisma aggregation. `Cache-Control: private, no-store` like the list/detail siblings.

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

List approved reviews for a product.

```typescript
export const ListReviewsQuerySchema = PaginationQuerySchema.extend({
  sort: z.enum(['created_at', 'rating_overall']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type ListReviewsResponse = PaginatedResponse<Review> & {
  aggregate: {
    rating_overall_avg: number | null;
    rating_onboarding_avg: number | null;
    count: number;
    score_visible: boolean;            // false until count >= 5
  };
};
```

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

Reads from `stats_cache` table. Never aggregates live.

```typescript
export type HomeStatsResponse = {
  total_integrations: number;
  integrations_added_30d: number;
  most_integrated_product: {
    product: ProductRef;
    integration_count: number;
  };
  most_active_category: {
    category: TaxonomyRef;
    integration_count: number;
  };
  recent_integrations: Integration[];   // last 10
  trending_products: Product[];          // top 5
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

#### `DELETE /api/account`

Delete the authenticated user's account. Anonymizes reviews (sets `reviewer_id = null`), deletes profile, deletes Supabase auth user.

```typescript
export type DeleteAccountResponse = {
  message: string;
};
```

Errors: `UNAUTHENTICATED`.

### 6.9 Tracking

#### `POST /api/page-views`

Lean fire-and-forget capture hook for client-side pageviews per Phase 2 Spec §7.1. Returns `204` with no body. In Phase 2 the handler is a no-op; Phase 4 wires it to the `page_views` table once that table lands. The shape was simplified from the earlier `TrackPageviewSchema` draft (path / product_id / vendor_id / session_id / referrer) to match the Phase 2 contract.

```typescript
export const PageViewPayloadSchema = z.object({
  route: z.string().min(1),
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
});

export type PageViewPayload = z.infer<typeof PageViewPayloadSchema>;
```

User-blocking errors are never raised.

### 6.10 Admin endpoints

All require `role === 'admin'` via Supabase RLS.

#### `GET /api/admin/reviews`

```typescript
export const ListPendingReviewsQuerySchema = PaginationQuerySchema.extend({
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  sort: z.enum(['created_at', 'queue_age']).default('queue_age'),
});

export type AdminReview = Review & {
  status: 'pending' | 'approved' | 'rejected';
  toxicity_score: number | null;   // from Perspective API
  product: ProductRef;
  reviewer_email: string;          // visible to admins only
};

export type ListPendingReviewsResponse = PaginatedResponse<AdminReview>;
```

#### `PATCH /api/admin/reviews/:id`

```typescript
export const ModerateReviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  rejection_reason: z.string().max(500).optional(),
});

export type ModerateReviewResponse = AdminReview;
```

Errors: `NOT_FOUND`, `INVALID_STATE_TRANSITION` if review is not in `pending` status.

#### `GET /api/admin/requests`

Lists vendor requests (claims and corrections).

```typescript
export const ListVendorRequestsQuerySchema = PaginationQuerySchema.extend({
  kind: z.enum(['claim', 'correction']).optional(),
  status: z.enum(['open', 'resolved', 'rejected']).default('open'),
});
```

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

Push-based Airtable → Supabase promotion. The review application sends one
product plus its dependencies (vendors, taxonomy, integrations); the Worker
upserts the whole bundle in a single transaction and returns the created/updated
IDs so the review app can persist the mapping and re-push edits. Supersedes the
pull-based CLI `scripts/airtable-to-supabase-bulk-migrate.ts` (deprecated).

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
});

// Response — `product` is null for a vendor-only / integration-only push
export interface PromoteResponse {
  vendors: { ref: string; id: string; slug: string; operation: 'created' | 'updated' }[];
  product: { ref: string; id: string; slug: string; operation: 'created' | 'updated' } | null;
  integrations: { ref: string; id: string; operation: 'created' | 'updated' }[];
  taxonomy: {
    categories: { slug: string; id: string; operation: 'created' | 'reused' }[];
    audiences: { slug: string; id: string; operation: 'created' | 'reused' }[];
    phases: { slug: string; id: string; operation: 'created' | 'reused' }[];
  };
  skipped: { ref: string; kind: 'integration' | 'extension'; reason: string }[];
}
```

**Integration rule (product-driven, from AECI-83):** an integration is written
only when both endpoints resolve — one is the product in this bundle (`ref`), the
other must already be promoted (`supabaseId`). Integrations whose other endpoint
isn't promoted yet land in `skipped[]` rather than failing the request. Every
create/update writes an `audit_log` row in the same transaction (§26).

Errors: `MALFORMED_REQUEST` (bad JSON), `VALIDATION_FAILED` (schema / duplicate
`ref` / bad enum), `UNAUTHENTICATED` (token). Full integration guide for the
review app: `docs/REVIEW_APP_PROMOTE_API.md`.

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

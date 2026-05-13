# AEC Integrations — API Contracts

**Referenced by:** `STAGE_1_SPEC.md` §6, §14
**Version:** 1.0
**Date:** May 2026

---

## 1. Purpose

Defines the shape of every API endpoint exposed by the AEC Integrations API Worker. Source of truth for request and response types, error codes, and validation rules.

The API Worker is consumed only by the SSR Worker via Cloudflare service binding. It is not publicly addressable. This is an internal contract, not a public API.

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
│   │   ├── common.ts          # Shared types: PaginatedResponse, ApiError, etc.
│   │   ├── products.ts        # Product endpoint schemas
│   │   ├── vendors.ts         # Vendor endpoint schemas
│   │   ├── integrations.ts    # Integration endpoint schemas
│   │   ├── reviews.ts         # Review endpoint schemas
│   │   ├── requests.ts        # Claim and correction schemas
│   │   ├── stats.ts           # Stats endpoint schemas
│   │   └── admin.ts           # Admin endpoint schemas
│   ├── errors/
│   │   └── codes.ts           # Error code constants
│   └── entities/
│       ├── product.ts         # Product entity type
│       ├── vendor.ts          # Vendor entity type
│       └── integration.ts     # Integration entity type
└── package.json
```

---

## 3. Common types

### 3.1 Pagination

All list endpoints return paginated responses with a consistent shape.

```typescript
import { z } from 'zod';

export const PaginationQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export type PaginatedResponse<T> = {
  data: T[];
  total: number;
  offset: number;
  limit: number;
};
```

### 3.2 Sorting

```typescript
export const SortSchema = z.object({
  sort: z.string().optional(),    // field name
  order: z.enum(['asc', 'desc']).default('asc'),
});
```

Allowed sort fields are per-endpoint and enforced via a separate enum schema.

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

Canonical types for the three core entities. These are used both as response shapes and as the basis for transformation to Algolia records.

### 5.1 Product

```typescript
export type Product = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  website: string | null;
  tool_integrations_url: string | null;
  api_docs_url: string | null;
  has_api_docs: boolean;
  product_role: 'application' | 'connector' | 'hybrid';
  logo_url: string | null;

  vendor: VendorRef;
  categories: TaxonomyRef[];
  disciplines: TaxonomyRef[];
  phases: TaxonomyRef[];

  integration_count: number;
  review_count: number;
  rating_overall_avg: number | null;
  rating_onboarding_avg: number | null;

  created_at: string;
  updated_at: string;
};

export type VendorRef = {
  id: string;
  slug: string;
  company_name: string;
};

export type TaxonomyRef = {
  id: string;
  name: string;
  slug: string;
};
```

### 5.2 Vendor

```typescript
export type Vendor = {
  id: string;
  slug: string;
  company_name: string;
  description: string | null;
  website: string | null;
  headquarters: string | null;
  founded_year: number | null;
  logo_url: string | null;
  verified: boolean;

  product_count: number;
  integration_count: number;
  review_count: number;

  created_at: string;
  updated_at: string;
};
```

### 5.3 Integration

```typescript
export type Integration = {
  id: string;
  name: string;

  source: ProductRef;
  target: ProductRef;

  mechanism_kind: 'native' | 'iPaaS' | 'marketplace-app' | 'api' | 'webhook' | 'partner';
  mechanism_name: string | null;
  direction: 'one-way' | 'bidirectional' | null;

  description: string | null;
  listing_url: string | null;
  docs_url: string | null;
  mechanism_url: string | null;

  built_by_vendor: VendorRef | null;
  powered_by_product: ProductRef | null;

  pricing_model: string | null;
  maturity: string | null;

  created_at: string;
  updated_at: string;
};

export type ProductRef = {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
};
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

List products with filters.

```typescript
export const ListProductsQuerySchema = PaginationQuerySchema.extend({
  search: z.string().optional(),
  category_id: z.string().uuid().optional(),
  discipline_id: z.string().uuid().optional(),
  phase_id: z.string().uuid().optional(),
  vendor_id: z.string().uuid().optional(),
  product_role: z.enum(['application', 'connector', 'hybrid']).optional(),
  has_api_docs: z.coerce.boolean().optional(),
  sort: z.enum(['name', 'integration_count', 'review_count', 'created_at']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export type ListProductsQuery = z.infer<typeof ListProductsQuerySchema>;
export type ListProductsResponse = PaginatedResponse<Product>;
```

#### `GET /api/products/:slug`

Get full product detail by slug.

```typescript
export type GetProductResponse = Product & {
  integrations_as_source: Integration[];
  integrations_as_target: Integration[];
  related_products: Product[];        // by category and integration overlap
};
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

```typescript
export const ListVendorsQuerySchema = PaginationQuerySchema.extend({
  search: z.string().optional(),
  verified: z.coerce.boolean().optional(),
  sort: z.enum(['company_name', 'product_count', 'integration_count', 'created_at']).default('company_name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export type ListVendorsResponse = PaginatedResponse<Vendor>;
```

#### `GET /api/vendors/:slug`

```typescript
export type GetVendorResponse = Vendor & {
  products: Product[];
};
```

Errors: `NOT_FOUND`.

### 6.3 Integrations

#### `GET /api/integrations`

```typescript
export const ListIntegrationsQuerySchema = PaginationQuerySchema.extend({
  search: z.string().optional(),
  source_product_id: z.string().uuid().optional(),
  target_product_id: z.string().uuid().optional(),
  mechanism_kind: z.enum(['native', 'iPaaS', 'marketplace-app', 'api', 'webhook', 'partner']).optional(),
  direction: z.enum(['one-way', 'bidirectional']).optional(),
  sort: z.enum(['name', 'mechanism_kind', 'created_at']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export type ListIntegrationsResponse = PaginatedResponse<Integration>;
```

#### `GET /api/integrations/:id`

```typescript
export type GetIntegrationResponse = Integration;
```

### 6.4 Taxonomy

#### `GET /api/taxonomy/categories`

```typescript
export type ListCategoriesResponse = {
  data: (TaxonomyRef & { product_count: number })[];
};
```

Same shape for `/disciplines` and `/phases`.

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

#### `POST /api/requests/claim`

```typescript
export const ClaimRequestSchema = z.object({
  vendor_id: z.string().uuid(),
  submitter_name: z.string().min(1).max(200),
  submitter_email: z.string().email(),
  submitter_role: z.string().min(1).max(100),
  phone: z.string().max(50).optional(),
  notes: z.string().max(2000).optional(),
});

export type ClaimRequestResponse = {
  request_id: string;
  message: string;
};
```

#### `POST /api/requests/correction`

```typescript
export const CorrectionRequestSchema = z.object({
  entity_type: z.enum(['product', 'vendor', 'integration']),
  entity_id: z.string().uuid(),
  what_is_wrong: z.string().min(10).max(2000),
  what_should_it_say: z.string().min(10).max(2000),
  submitter_email: z.string().email(),
  source: z.string().max(500).optional(),
});

export type CorrectionRequestResponse = {
  request_id: string;
  message: string;
};
```

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

#### `POST /api/track/pageview`

Lean endpoint for client-side pageview tracking. Server-side enrichment is done by the SSR Worker on page render; this endpoint exists for client-side SPA navigation events.

```typescript
export const TrackPageviewSchema = z.object({
  path: z.string(),
  product_id: z.string().uuid().optional(),
  vendor_id: z.string().uuid().optional(),
  session_id: z.string(),
  referrer: z.string().optional(),
});

export type TrackPageviewResponse = { ok: true };
```

Fire-and-forget; user-blocking errors are never raised.

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

const apiResponse = await env.API_WORKER.fetch(
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

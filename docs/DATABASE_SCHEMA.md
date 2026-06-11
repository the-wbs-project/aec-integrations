# AEC Integrations — Database Schema

**Referenced by:** `STAGE_1_SPEC.md` §5, §22, §26
**Version:** 1.0
**Date:** May 2026
**Database:** Supabase (PostgreSQL 17)
**ORM:** Prisma (via `@prisma/extension-accelerate`) — typed client only; migrations run through Supabase CLI (see `docs/migrations.md`).

---

## 1. Purpose

Source of truth for the Supabase database schema. Every table, column, index, constraint, and relationship lives here.

Migrations are managed by the **Supabase CLI**. Migration files in `supabase/migrations/` are the executable form of this document. When this document and the migrations disagree, the migrations are right — but every migration should be reflected back into this document in the same PR. The workflow for writing and applying migrations lives in `docs/migrations.md`.

---

## 1a. Prisma client setup (Worker runtime)

Workers talk to Supabase through Prisma Accelerate (HTTPS), not a TCP pooler. The validated reference implementation is the production API Worker `apps/api/src/prisma.ts`; the original `prisma-test` probe that proved the pattern is archived (frozen) at `spikes/prisma-test/` and cited below only where a pattern has no live equivalent yet.

**Required dependencies (runtime):**

- `@prisma/client`
- `@prisma/extension-accelerate`

**Required dependencies (dev):**

- `prisma` (CLI)

**Forbidden dependencies:**

- `@prisma/adapter-pg-worker` — do not install. The adapter pattern requires `nodejs_compat` and a TCP pooler; we use Accelerate over HTTPS instead.

**Imports:**

```ts
import { PrismaClient } from "@prisma/client/edge";
import { withAccelerate } from "@prisma/extension-accelerate";
```

Importing `PrismaClient` from `@prisma/client` (without `/edge`) silently produces a client that does not work on Workers — flag it in review.

**Per-request instantiation.** Do not cache the client in Worker module scope. Construct it per request via the `getPrisma(env)` factory, and inject that factory into handlers. Modeled on `apps/api/src/prisma.ts` (the factory) + `apps/api/src/routes/health.ts` (the injection site):

```ts
// apps/api/src/prisma.ts — per-request client factory
export function getPrisma(env: Env) {
  return new PrismaClient({ datasourceUrl: env.DATABASE_URL })
    .$extends(withAccelerate());
}

export type AcceleratedPrisma = ReturnType<typeof getPrisma>;

// apps/api/src/routes/health.ts — handlers are factories that inject the client
type PrismaFactory = (env: Env) => AcceleratedPrisma;

export function createHealthHandler(prismaFor: PrismaFactory = getPrisma) {
  return async (c: Context<{ Bindings: Env }>) => {
    const prisma = prismaFor(c.env);
    // ... use prisma
  };
}
```

Handlers never import a module-level client. Each handler is a factory that takes `prismaFor: PrismaFactory = getPrisma` and calls it per request: the default wires up the real client in production, while tests pass a stub factory (`createHealthHandler(() => mockPrisma)`). This default-param injection is what makes handlers testable without a live database (`TESTING_STRATEGY.md` §6.3).

**Two URLs:**

| Variable | Form | Used by | Bound where |
|---|---|---|---|
| `DATABASE_URL` | `prisma://accelerate.prisma-data.net/?api_key=...` | Worker runtime | Worker secret (`wrangler secret put DATABASE_URL`) + local `.dev.vars` |
| `DIRECT_URL` | `postgresql://...supabase.com:6543/postgres?pgbouncer=true` (Supabase pooler) | Supabase CLI (`supabase db push / pull / diff`); also `prisma db pull` if schema introspection is needed | CI env + local `.dev.vars` |

The two-URL split is declared in the Prisma schema (`apps/api/prisma/schema.prisma:22-25`). Workers never see `DIRECT_URL`.

For running the Worker **locally**, `DATABASE_URL` must still be a `prisma://` Accelerate URL (a direct `postgresql://` value throws `P6001`). How to obtain and set it for local `.dev.vars` is in `docs/environments.md` → "Local dev: running the API Worker (Prisma Accelerate)" (Option 1: the shared dev-DB value, same as the `DATABASE_URL_STAGING` secret).

**`wrangler.jsonc` rationale.** No `nodejs_compat` flag is needed for the database — Accelerate is HTTPS. Add `nodejs_compat` only for unrelated Node-API needs. See the canonical comment at `apps/api/wrangler.jsonc:12-13`.

**BigInt JSON serialization.** Prisma returns `BigInt` for `BigInt` columns; `JSON.stringify` throws on them. Use the replacer pattern at `apps/api/src/http.ts:21`:

```ts
JSON.stringify(data, (_key, value) =>
  typeof value === "bigint" ? value.toString() : value,
);
```

Centralize this in a shared `json()` helper in the API Worker.

**Prisma error → HTTP status mapping.** Validated mapping in the frozen probe `spikes/prisma-test/src/index.ts:136-157` (no live equivalent yet — see the note below):

| Prisma error substring | HTTP status |
|---|---|
| `Unique constraint failed` | 409 Conflict |
| `Record to update not found` | 404 Not Found |
| `Record to delete does not exist` | 404 Not Found |
| (other) | 500 Internal Server Error |

String matching is fragile; the production API Worker should switch to Prisma's typed error classes (`PrismaClientKnownRequestError` + `code`) once the centralized error middleware lands (`API_CONTRACTS.md` §8).

**Build ordering.** `prisma generate` must run before any Worker build/deploy so the client matches the current schema. Mirror the script wiring at `apps/api/package.json:5-11`.

**Prisma as query-builder only.** `schema.prisma` is downstream of `supabase/migrations/`; refresh it via `pnpm db:pull` after every applied migration. The full contract (workflow, why `db:pull` targets the local container, what to never run) lives in `docs/prisma.md`.

---

## 2. Current state

**Supabase is empty for AECi Stage 1 purposes.** The production data currently lives in Airtable (base `appy81IdGJY6Fngf9`) as the staging/research layer. Stage 1 builds out the Supabase schema and migrates curated data from Airtable to Supabase as a one-way promotion.

Migration approach is documented in Section 10.

### 2a. Pre-AECI landing-page tables

The `public` schema on the production Supabase project (`aeci-production`, formerly the sole dev/landing DB) carries two tables that predate the AECI Stage 1 schema and are **out of scope for everything in this document**:

| Table | Owner | Purpose |
| --- | --- | --- |
| `public.feedback` | `apps/landing/` | Lead-capture feedback form (`apps/landing/src/services/feedback.ts`). Write-only from `anon` via PostgREST. |
| `public.mailing_list` | `apps/landing/` | Pre-launch mailing-list signups (`apps/landing/src/services/subscribe.ts`). Write-only from `anon` via PostgREST. |

These tables are captured in `supabase/migrations/20260101000000_landing_baseline.sql` so they reproduce on a fresh `pnpm db:reset` (and on the empty `aeci-development` project once it's bootstrapped). No AECI Stage 1 code reads or writes them. Treat them as the landing app's private surface that happens to share a Postgres instance with us.

---

## 3. Schema overview

Tables grouped by domain:

**Core entities** (the directory):
- `vendors` — companies that make AEC software
- `products` — software products sold by vendors
- `integrations` — directional connections between two products
- `taxonomy_categories` — closed vocabulary: product categories (e.g. "BIM Authoring")
- `taxonomy_audiences` — closed vocabulary: AEC audiences (e.g. "Architecture")
- `taxonomy_phases` — closed vocabulary: project phases (e.g. "Design Development")

**Join tables**:
- `product_categories` — product ↔ category many-to-many
- `product_audiences` — product ↔ audience many-to-many
- `product_phases` — product ↔ phase many-to-many
- `product_vendors` — product ↔ vendor many-to-many (typically 1:1, but supports white-label cases)
- `product_extensions` — product ↔ host product (for plugins/add-ons)

**User and content**:
- `profiles` — extends `auth.users` with role and metadata
- `reviews` — user-submitted product reviews

**Operations and workflow**:
- `vendor_requests` — incoming claim and correction requests
- `workflow_instances` — multi-step process tracking
- `workflow_transitions` — state transitions for workflows
- `audit_log` — every state-changing event

**Analytics and caching**:
- `page_views` — server-side page view log with CF enrichment
- `stats_cache` — daily-computed home page stats

**Future-ready**:
- `translations` — multi-language content (empty at launch)

---

## 4. Core entity tables

### 4.1 `vendors`

Company-level signals. Carries HQ, funding, social presence.

```sql
create table vendors (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  company_name text not null,
  description text,
  website text,
  headquarters text,
  founded_year integer,
  public_private text check (public_private in ('public', 'private')),
  parent_company text,

  -- Social and verification
  linkedin_url text,
  x_url text,
  facebook_url text,
  instagram_url text,
  youtube_url text,
  crunchbase_url text,
  wiki_url text,
  source_url text,
  github_org text,
  phone_number text,
  contact_email text,

  -- Brandfetch / logo (mirrors products.logo_url)
  logo_url text,

  -- Operational
  verified boolean not null default false, -- true after vendor claims (Stage 2+)
  promotion_status text not null default 'pending' check (promotion_status in ('pending', 'ready', 'promoted', 'retracted', 'rejected')),
  admin_notes text,

  -- Vendor quality score (computed)
  vqs_credibility numeric(4,2),
  vqs_momentum numeric(4,2),
  vqs_fit numeric(4,2),
  vqs_total numeric(4,2),
  vqs_computed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index vendors_slug_idx on vendors(slug);
create index vendors_company_name_idx on vendors(company_name);
create index vendors_promotion_status_idx on vendors(promotion_status);
create index vendors_verified_idx on vendors(verified);
```

### 4.2 `products`

Software products. The primary entity practitioners search and browse.

```sql
create table products (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text,
  website text,

  -- Documentation and integrations
  tool_integrations_url text,
  api_docs_url text,
  has_api_docs boolean not null default false,
  tool_integration_check_notes text,

  -- Narrative content
  usefulness jsonb, -- slug-based {audiences,phases} narrative; shape in API_CONTRACTS §5.1

  -- Classification
  product_role text not null default 'application' check (product_role in ('application', 'connector', 'hybrid')),

  -- Brandfetch / logo
  logo_url text, -- typically a Brandfetch CDN URL

  -- Aggregates (denormalized, kept in sync by app code via recomputeProductCounts(); triggers deferred to Phase 2 — see §11.2)
  integration_count integer not null default 0,
  review_count integer not null default 0,
  rating_overall_avg numeric(3,2),
  rating_onboarding_avg numeric(3,2),

  -- Research and curation lifecycle
  research_status text not null default 'pending' check (research_status in ('pending', 'in_progress', 'done', 'blocked')),
  research_notes text,
  promotion_status text not null default 'pending' check (promotion_status in ('pending', 'ready', 'promoted', 'retracted', 'rejected')),

  -- Scoring
  priority_tier text check (priority_tier in ('tier_1', 'tier_2', 'tier_3', 'tier_4', 'tier_5')),
  priority_score numeric(5,2),
  score_computed_at timestamptz,

  -- Search demand signals (from SearchAPI)
  google_trends_index integer check (google_trends_index between 0 and 100),
  search_volume_monthly integer,
  search_checked_at timestamptz,

  -- Reddit signals
  reddit_mentions_24mo integer,
  reddit_checked_at timestamptz,

  -- Operational
  admin_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index products_slug_idx on products(slug);
create index products_name_idx on products(name);
create index products_promotion_status_idx on products(promotion_status);
create index products_research_status_idx on products(research_status);
create index products_priority_tier_idx on products(priority_tier);
create index products_product_role_idx on products(product_role);
create index products_updated_at_idx on products(updated_at desc);
```

`usefulness` is a nullable `jsonb` column holding narrative "how teams use it" value, grouped by audience and by project phase. Its stored shape mirrors the public `ProductUsefulness` contract (`API_CONTRACTS.md` §5.1) — `{ audiences: [{ slug, name, points[] }], phases: [{ slug, name, points[] }] }` — where each `slug` references a `taxonomy_audiences` / `taxonomy_phases` slug. It is `null` when the source has no usefulness for either facet; otherwise either facet array may be empty. The column is written by promote (`REVIEW_APP_PROMOTE_API.md` §3.3), which resolves each group to an existing taxonomy term and stores the canonical `{ slug, name }` denormalized — so a later taxonomy rename leaves already-promoted labels stale until the product is re-promoted. Not indexed: it is read with the row, never filtered on.

### 4.3 `integrations`

Directional link between two products. Source → Target with mechanism metadata.

```sql
create table integrations (
  id uuid primary key default gen_random_uuid(),
  name text,

  source_product_id uuid not null references products(id) on delete cascade,
  target_product_id uuid not null references products(id) on delete cascade,
  constraint source_target_differ check (source_product_id <> target_product_id),

  -- Mechanism
  mechanism_kind text check (mechanism_kind in ('native', 'iPaaS', 'marketplace-app', 'api', 'webhook', 'partner')),
  mechanism_name text,
  direction text check (direction in ('one-way', 'bidirectional')),

  -- Attribution
  built_by_vendor_id uuid references vendors(id),
  powered_by_product_id uuid references products(id),

  -- Content
  description text,
  listing_url text,
  docs_url text,
  website text,
  mechanism_url text,
  pricing_model text,
  maturity text,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index integrations_source_idx on integrations(source_product_id);
create index integrations_target_idx on integrations(target_product_id);
create index integrations_mechanism_kind_idx on integrations(mechanism_kind);
create index integrations_built_by_idx on integrations(built_by_vendor_id) where built_by_vendor_id is not null;
create index integrations_powered_by_idx on integrations(powered_by_product_id) where powered_by_product_id is not null;
```

---

## 5. Taxonomy tables

Closed vocabularies. **Code-managed reference data** — the vocabulary lives in version-controlled `supabase/reference-data/taxonomy.sql` (idempotent upserts), applied to every environment. Not Airtable-owned and not seeded by the §13 promotion flow. No public write paths. See `docs/adr/0008-taxonomy-reference-data.md`.

### 5.1 `taxonomy_categories`

```sql
create table taxonomy_categories (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text,
  display_order integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index taxonomy_categories_slug_idx on taxonomy_categories(slug);
```

### 5.2 `taxonomy_audiences`

```sql
create table taxonomy_audiences (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text,
  display_order integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index taxonomy_audiences_slug_idx on taxonomy_audiences(slug);
```

### 5.3 `taxonomy_phases`

```sql
create table taxonomy_phases (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text,
  display_order integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index taxonomy_phases_slug_idx on taxonomy_phases(slug);
```

---

## 6. Join tables

### 6.1 `product_categories`

```sql
create table product_categories (
  product_id uuid not null references products(id) on delete cascade,
  category_id uuid not null references taxonomy_categories(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (product_id, category_id)
);

create index product_categories_category_idx on product_categories(category_id);
```

### 6.2 `product_audiences`

```sql
create table product_audiences (
  product_id uuid not null references products(id) on delete cascade,
  audience_id uuid not null references taxonomy_audiences(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (product_id, audience_id)
);

create index product_audiences_audience_idx on product_audiences(audience_id);
```

### 6.3 `product_phases`

```sql
create table product_phases (
  product_id uuid not null references products(id) on delete cascade,
  phase_id uuid not null references taxonomy_phases(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (product_id, phase_id)
);

create index product_phases_phase_idx on product_phases(phase_id);
```

### 6.4 `product_vendors`

Most products have one vendor, but the model supports many-to-many for white-label or co-developed products.

```sql
create table product_vendors (
  product_id uuid not null references products(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  is_primary boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (product_id, vendor_id)
);

create index product_vendors_vendor_idx on product_vendors(vendor_id);
```

### 6.5 `product_extensions`

For plug-ins and add-ons that extend a host product (e.g. SketchUp extensions, Revit add-ins).

```sql
create table product_extensions (
  product_id uuid not null references products(id) on delete cascade, -- the extension
  host_product_id uuid not null references products(id) on delete cascade, -- the host
  constraint product_extensions_differ check (product_id <> host_product_id),
  created_at timestamptz not null default now(),
  primary key (product_id, host_product_id)
);

create index product_extensions_host_idx on product_extensions(host_product_id);
```

---

## 7. User and content tables

### 7.1 `profiles`

Extends `auth.users`. Lifecycle is kept in sync by two triggers on
`auth.users` (not a cross-schema FK — see `docs/AUTH_AND_RLS.md` §8.1
for the rationale): `on_auth_user_created` inserts a profile on signup,
`on_auth_user_deleted` removes it on auth delete.

```sql
create table profiles (
  -- Same UUID as auth.users.id, kept in sync by triggers (AECI-69).
  -- No cross-schema FK — see docs/AUTH_AND_RLS.md §8.1.
  id uuid primary key,
  display_name text,
  role text not null default 'reviewer' check (role in ('reviewer', 'admin', 'vendor_admin')),
  vendor_id uuid references vendors(id), -- null for Stage 1, used in Stage 2 vendor portal
  work_email_verified boolean not null default false,
  trust_tier text not null default 'standard' check (trust_tier in ('standard', 'verified', 'trusted')),

  -- Theme preference (defaults to system preference)
  theme_preference text not null default 'system' check (theme_preference in ('system', 'light', 'dark')),

  -- Moderation flags
  banned_at timestamptz,
  ban_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_role_idx on profiles(role);
create index profiles_vendor_idx on profiles(vendor_id) where vendor_id is not null;
create index profiles_banned_idx on profiles(banned_at) where banned_at is not null;
```

**Trigger:** create a profile row automatically when a user signs up via Supabase Auth.

```sql
create or replace function public.handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

**SECURITY DEFINER convention:** Every `SECURITY DEFINER` function must include an explicit `SET search_path` to prevent search-path injection attacks. For functions in the `public` schema use `SET search_path = public, pg_temp`; for functions in the `auth` schema that reference `public.profiles` use `SET search_path = public, auth`. See `AUTH_AND_RLS.md` §6.1 for the auth-schema helper pattern.

### 7.2 `reviews`

User-submitted reviews of products. Dual rating (overall + onboarding) per the split-review model.

```sql
create table reviews (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  reviewer_id uuid references profiles(id) on delete set null, -- null after anonymization

  rating_overall smallint not null check (rating_overall between 1 and 5),
  rating_onboarding smallint not null check (rating_onboarding between 1 and 5),

  title text not null,
  body text not null,
  role_at_company text check (role_at_company in ('practitioner', 'manager', 'IT', 'exec', 'other')),
  years_using smallint check (years_using between 0 and 50),
  would_recommend text check (would_recommend in ('yes', 'no', 'maybe')),

  -- Moderation
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'archived')),
  rejection_reason text,
  moderated_at timestamptz,
  moderated_by uuid references profiles(id),
  toxicity_score smallint, -- from Perspective API, populated on submission

  -- Trust signals (Stage 3+ uses)
  verified_work_email boolean not null default false,

  -- Localization
  locale text not null default 'en-US',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index reviews_product_status_idx on reviews(product_id, status);
create index reviews_reviewer_idx on reviews(reviewer_id) where reviewer_id is not null;
create index reviews_status_created_idx on reviews(status, created_at desc);

-- Enforce one review per (product, reviewer) when reviewer is not null
create unique index reviews_unique_per_user_product
  on reviews(product_id, reviewer_id)
  where reviewer_id is not null and status <> 'archived';
```

---

## 8. Operations and workflow tables

### 8.1 `vendor_requests`

Mirror of Linear issues for claim and correction requests. Local audit trail.

Target is a **loose polymorphic FK** — `(target_type, target_id)` with a CHECK on
`target_type` and no hard FK on `target_id`. Application-level referential
checks live in the Phase 6 form submission handler. Rationale: keeps room for
Stage 2 to add claim/correction for additional entity types without another
migration. See Phase 2 Spec §5.2.

```sql
create table vendor_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('claim', 'correction')),

  -- Target (loose polymorphic; no hard FK on target_id)
  target_type text not null check (target_type in ('product', 'vendor')),
  target_id   uuid not null,

  -- Submitter
  submitter_email text not null,
  submitter_name  text,
  submitter_role  text,

  -- Domain-match outcome computed at submission time
  domain_match text not null default 'pending'
    check (domain_match in ('pending', 'match', 'no_match', 'manual_review')),

  -- Submission content
  body       text not null,
  source_url text,

  -- Status
  status text not null default 'open'
    check (status in ('open', 'in_review', 'resolved', 'rejected')),

  -- External system link
  linear_issue_id text,

  -- Lifecycle
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references profiles(id) on delete set null
);

create index vendor_requests_status_idx     on vendor_requests(status);
create index vendor_requests_target_idx     on vendor_requests(target_type, target_id);
create index vendor_requests_created_at_idx on vendor_requests(created_at desc);
```

### 8.2 `workflow_instances`

Multi-step process tracking with approval gates.

```sql
create table workflow_instances (
  id uuid primary key default gen_random_uuid(),
  workflow_type text not null check (workflow_type in ('vendor_claim', 'review_moderation', 'correction_request')),
  entity_id uuid not null, -- foreign key varies by workflow_type; not enforced at DB level

  current_state text not null,
  linear_issue_id text,

  initiated_by uuid references profiles(id),
  initiated_at timestamptz not null default now(),
  completed_at timestamptz,
  final_outcome text check (final_outcome in ('approved', 'rejected', 'cancelled', 'completed'))
);

create index workflow_instances_type_entity_idx on workflow_instances(workflow_type, entity_id);
create index workflow_instances_state_idx on workflow_instances(workflow_type, current_state) where completed_at is null;
create index workflow_instances_linear_idx on workflow_instances(linear_issue_id) where linear_issue_id is not null;
```

### 8.3 `workflow_transitions`

State changes for workflow instances. Append-only.

```sql
create table workflow_transitions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflow_instances(id) on delete cascade,

  from_state text,
  to_state text not null,
  actor_id uuid references profiles(id),
  reason text,
  metadata jsonb,

  created_at timestamptz not null default now()
);

create index workflow_transitions_workflow_idx on workflow_transitions(workflow_id, created_at);
```

### 8.4 `audit_log`

Every state-changing event in the platform. Append-only.

```sql
create table audit_log (
  id uuid primary key default gen_random_uuid(),

  actor_id uuid references profiles(id),
  actor_type text not null check (actor_type in ('user', 'admin', 'system', 'workflow')),

  action text not null, -- e.g. 'review.approved', 'product.updated', 'claim.submitted'
  entity_type text, -- 'review' | 'product' | 'vendor' | 'integration' | 'claim' | 'correction'
  entity_id uuid,

  before_state jsonb,
  after_state jsonb,
  metadata jsonb, -- workflow context: linear_issue_id, ip_address, user_agent, cf_country

  created_at timestamptz not null default now()
);

create index audit_log_entity_idx on audit_log(entity_type, entity_id, created_at desc);
create index audit_log_actor_idx on audit_log(actor_id, created_at desc) where actor_id is not null;
create index audit_log_action_idx on audit_log(action, created_at desc);
create index audit_log_created_at_idx on audit_log(created_at desc);
```

---

## 9. Analytics and caching tables

### 9.1 `page_views`

Server-side page view log with Cloudflare header enrichment. Privacy-respecting (no raw IPs, hashed user agents).

```sql
create table page_views (
  id bigserial primary key,
  path text not null,
  product_id uuid references products(id),
  vendor_id uuid references vendors(id),
  user_id uuid references profiles(id),
  session_id text,
  referrer text,

  -- Cloudflare-provided headers
  cf_country text,
  cf_colo text,
  cf_asn integer,
  cf_bot_score integer,

  -- Request metadata
  user_agent_hash text, -- SHA-256 hash, NOT raw
  locale text,

  -- Profile-derived (denormalized)
  profile_role text,

  created_at timestamptz not null default now()
);

create index page_views_path_idx on page_views(path, created_at);
create index page_views_product_idx on page_views(product_id, created_at) where product_id is not null;
create index page_views_country_idx on page_views(cf_country, created_at);
create index page_views_user_idx on page_views(user_id, created_at) where user_id is not null;
```

### 9.2 `stats_cache`

Daily-computed home page stats. Pages read from here, not live aggregations.

```sql
create table stats_cache (
  key text primary key,
  value jsonb not null,
  computed_at timestamptz not null default now()
);
```

Keys used (see `STAGE_1_SPEC.md` §10):
- `home.total_integrations`
- `home.integrations_added_30d`
- `home.most_integrated_product`
- `home.most_active_category`
- `home.recent_integrations`
- `home.trending_products`
- `home.recently_added_products`
- `category_counts`
- `audience_counts`
- `phase_counts`

---

## 10. Future-ready tables

### 10.1 `translations`

Multi-language content storage. Empty at launch; schema ready for additional locales (Stage 2+).

```sql
create table translations (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('product', 'vendor', 'category', 'audience', 'phase', 'integration')),
  entity_id uuid not null,
  locale text not null, -- BCP 47 e.g. 'es-ES', 'fr-FR'
  field text not null, -- 'description', 'name', etc.
  value text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (entity_type, entity_id, locale, field)
);

create index translations_lookup_idx on translations(entity_type, entity_id, locale);
```

---

## 11. Common patterns

### 11.1 `updated_at` triggers

Every table with an `updated_at` column has a trigger that bumps it on UPDATE.

```sql
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Applied per table:
create trigger products_updated_at before update on products
  for each row execute function set_updated_at();
-- (repeat for: vendors, integrations, taxonomy_*, profiles, reviews, translations)
```

### 11.2 Denormalized counts

`products.integration_count`, `products.review_count`, `products.rating_overall_avg`, and `products.rating_onboarding_avg` are denormalized for read performance. In Stage 1 they are maintained by **application code in the API Worker**: every write path that mutates `integrations` or `reviews` calls the shared `recomputeProductCounts()` helper (`apps/api/src/lib/product-counts.ts`) inside the same transaction. `review_count` and the rating averages count only reviews with `status = 'approved'` (the only publicly visible state — see §4.7, §12); the averages are NULL when a product has no approved reviews.

**Drift protection.** `findProductCountDrift()` and `scripts/reconcile-product-counts.ts` recompute the expected values from the source rows and flag any product whose stored columns disagree (run via `pnpm --filter @aeci/api db:reconcile-counts`; `--fix` repairs in place). A scheduled CI job (`.github/workflows/reconcile-counts.yml`) runs the check report-only against staging/prod daily and alerts on drift via Datadog. A unit test (`src/lib/product-counts.spec.ts`) and a `TEST_DATABASE_URL`-gated integration test (`src/integration/product-counts.spec.ts`) cover both the recompute and the drift check.

Database triggers on the source tables are **reserved for Phase 2** if write performance becomes an issue; Stage 1 deliberately keeps this at the application layer. (The `invalidateForEntity()` helper referenced by earlier drafts was never built and is superseded — cache invalidation now goes through the Cache-Tag strategy, a separate concern from count maintenance; see CLAUDE.md "Cache invalidation".)

### 11.3 Slug generation

Slugs are generated at insert time by application code, not at the database level. The unique constraint on `slug` columns enforces uniqueness. Slug collision resolution (append vendor name) is application logic.

---

## 12. RLS policies

Row-level security is enabled on every table. Policy definitions live in **`AUTH_AND_RLS.md`** — that document is the source of truth for who can read and write what.

High-level intent:
- Public read on directory tables (products, vendors, integrations, taxonomy, approved reviews)
- Authenticated insert on reviews
- Owners update own pending reviews
- Admin-only access to moderation, audit log, workflow, page_views, vendor_requests

---

## 13. Migration from Airtable

The data currently lives in Airtable (base `appy81IdGJY6Fngf9`). Migration to Supabase happens once during Phase 2.

> **Taxonomy is excluded from this flow.** As of `docs/adr/0008-taxonomy-reference-data.md`, the taxonomy vocabulary (categories/audiences/phases) is code-managed reference data in `supabase/reference-data/taxonomy.sql`, not Airtable content. This section governs **vendors, products, and integrations** only.

### 13.1 Promotion model

Airtable remains the **staging/research layer** for curators. Supabase is the **production read store**. Curators flip `promotion_status` to `'promoted'` in Airtable, triggering a one-way sync to Supabase.

```
Airtable (curator-edited)
   │
   │  promotion_status='promoted'
   ▼
Supabase (production read store)
   │
   ▼
Algolia (search index)
```

### 13.2 Initial bulk migration

One-time script: `scripts/airtable-to-supabase-bulk-migrate.ts`.

Phases:
1. Read all Airtable records with `promotion_status='promoted'` (or whatever the curator-designated "ready to launch" filter is at the time)
2. Generate UUIDs for each record (Airtable record IDs are not used as Supabase IDs)
3. Build a mapping table: Airtable rec ID → Supabase UUID
4. Taxonomy (categories, audiences, phases) is already present — seeded as code-managed reference data (ADR 0008), not migrated from Airtable. Resolve product links against the existing rows by slug.
5. Insert vendors
6. Insert products with vendor links via `product_vendors`
7. Insert join table rows for categories, audiences, phases
8. Insert integrations using the rec-ID-to-UUID mapping
9. Compute and persist denormalized counts on products
10. Verify counts match Airtable

### 13.3 Ongoing sync (post-launch)

After initial migration, ongoing Airtable → Supabase sync is curator-triggered:

- Curator promotes a new product/vendor/integration in Airtable
- A scheduled Worker (or manual trigger) reads newly-promoted records
- New rows inserted in Supabase
- Algolia indexed automatically via the write-event pipeline

Updates to already-promoted records are handled the same way — Airtable is the editorial canvas, Supabase mirrors the promoted state.

### 13.4 Curator-preserve fields

When syncing from Airtable, certain fields on Supabase records must not be overwritten by automated processes:

- `website`, `headquarters`, `crunchbase_url`, `wiki_url`, `linkedin_url`, `x_url`, `facebook_url`, `instagram_url`, `youtube_url` (vendor)
- Any field a human curator has manually corrected

The sync process flags discrepancies in `admin_notes` rather than overwriting curator-edited values.

---

## 14. Sample data and seeding

### 14.1 Local development

`apps/api/prisma/seed.ts` seeds a known dataset for local dev and CI:

- 20 vendors covering the major AEC software companies (Autodesk, Procore, Bentley, Trimble, etc.)
- 50 products linked to those vendors
- 100 integrations across the products
- 20 categories, 10 audiences, 8 phases
- Test users with various roles (reviewer, admin)
- 30 approved reviews across 10 products

This seed data is fixed and known — E2E tests assume it exists.

### 14.2 Staging

Staging gets a larger subset of real production data, refreshed weekly via a curator-approved snapshot. Personal data (emails, real names) is anonymized.

### 14.3 Production

Production starts empty at launch. Initial bulk migration from Airtable happens once during Phase 2 (Section 13.2).

---

## 15. Backups and retention

Backup policy is deferred to a dedicated operational document (`OPERATIONAL_RUNBOOKS.md`, pending). Defaults:

- Supabase automated daily backups (Pro tier and above)
- Audit log and page_views retention: indefinite for Stage 1 (see `STAGE_1_SPEC.md` §26.6 and §14.2)
- Reviews and core entities: no retention policy — preserve everything

---

## 16. Future considerations

- **Audit log partitioning** — when `audit_log` table exceeds ~10M rows, partition by month for query performance
- **Page views table** — same; or migrate to a columnar store (ClickHouse, BigQuery)
- **Soft delete on entities** — add `deleted_at` to vendors/products if hard deletion becomes destructive
- **Versioning on vendor data** — Stage 2 vendor portal will introduce edit history; consider a `vendor_versions` table or temporal tables
- **Materialized views** — for expensive aggregations (e.g. "integrations per category"), if `stats_cache` daily refresh isn't fresh enough

Not pursued in Stage 1.

---

## 17. Schema change process

Migrations are authored as raw SQL and applied via the Supabase CLI. The full workflow (when-to-migrate, naming, idempotency, local test loop, RLS interaction) lives in `docs/migrations.md` — this section is the short version specific to keeping the Prisma typed client in sync.

1. Create the migration file: `pnpm db:new <short_description>` produces `supabase/migrations/<utc-timestamp>_<name>.sql`.
2. Write the SQL by hand. Idempotent where cheap (see `docs/migrations.md` §3.4).
3. Update `apps/api/prisma/schema.prisma` so the model matches the new shape (Prisma still generates the typed client; the schema file is no longer the migration source but it MUST agree with the migrations).
4. Update this document with the new schema (table inventory, column intent, indexes).
5. Local test: `pnpm db:reset` (applies all migrations + seed against the local stack — including the GRANT/RLS migration), then `pnpm --filter @aeci/api test:integration`.
6. Verify zero drift against the linked dev project with `pnpm db:diff`.
7. Commit the migration file, `schema.prisma` change, and this document update together in the same PR.
8. PR review verifies all three agree.
9. On merge to `main`, CI applies the migration to staging via `supabase db push --linked` against the staging project, **before** the new Worker code is deployed (wiring is AECI-71; see `CICD_PLAN.md` §5).
10. Migration applied to production on production approval — same command, prod project (see `CICD_PLAN.md` §5).

Note: `prisma generate` must run before any Worker build/deploy so the generated client matches the current schema (see §1a). The Prisma CLI is no longer used for migrations — `prisma migrate dev` and `prisma migrate deploy` were retired in AECI-72.

---

## 18. Transactional writes with audit log

Every state-changing write must call `appendAuditLog()` (`STAGE_1_SPEC.md` §26, `CLAUDE.md` §"Datadog and audit logging"). Failure to log is a transactional failure — the mutation must not commit without its audit entry.

**Pattern.** Wrap the mutation and the audit insert in `prisma.$transaction([...])` so both succeed or both roll back:

```ts
const [updated, _audit] = await prisma.$transaction([
  prisma.product.update({ where: { id }, data: input }),
  prisma.auditLog.create({ data: appendAuditLogEntry(...) }),
]);
```

Prefer the **array form** for short writes — one HTTP round-trip via Accelerate.

Use the **interactive form** (`prisma.$transaction(async (tx) => { ... })`) only when later statements depend on earlier results inside the transaction. Accelerate supports interactive transactions but each statement is a separate HTTPS round-trip, so latency multiplies — avoid for hot paths.

**Cache invalidation runs after commit.** `invalidateForEntity()` must run *after* `$transaction()` resolves, never inside it. Wrap the call in `ctx.waitUntil()` so the response is not blocked on the purge:

```ts
ctx.waitUntil(invalidateForEntity(env, "product", id));
return json({ row: updated });
```

A failed purge must not roll back the write. Log it; surface it via Datadog.

**Reviewers:** see `CODE_REVIEW_CHECKLIST.md` "Data integrity and audit" for the corresponding check.

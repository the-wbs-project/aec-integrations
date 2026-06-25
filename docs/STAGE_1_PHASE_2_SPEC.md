# Stage 1 — Phase 2 Spec

**Status:** Approved — ready for issue breakdown
**Supersedes:** §16 Phase 2 of `STAGE_1_SPEC.md`
**Inherits from:** Phase 1 (AECI-16 through AECI-45)
**Companion docs:** `DATABASE_SCHEMA.md`, `AUTH_AND_RLS.md`, `API_CONTRACTS.md`, `DESIGN.md`, `PRODUCT.md`, `CICD_PLAN.md`, `TESTING_STRATEGY.md`

---

## 1. Goal

By the end of Phase 2 a visitor can land on a URL like `aecintegrations.com/products/procore` (or any product, vendor, integration, category, audience, or project phase) and see a real page rendered from real Supabase data, cached at the edge, with every entity reachable from every other through internal navigation. No search yet (Phase 3), no auth (Phase 5), no reviews (Phase 5), no stats (Phase 4).

This is the "lights on" milestone for the public directory.

---

## 2. Inputs from Phase 1

Phase 2 builds on the following ground truth, all landed in Phase 1:

- **Angular 21 zoneless SSR** in `apps/web/` (AECI-21) with hydration providers (AECI-22), `@angular/localize` (AECI-23), Tailwind v4 + Spartan preset (AECI-24), Spartan brain + Angular CDK (AECI-26), theme switcher (AECI-25, AECI-41), SSR cookie-stripping + URL-prefix locale dispatch (AECI-35), Cache-Control hygiene on the SSR worker (AECI-43), `allowedHosts` for prod (AECI-42)
- **API Worker** in `apps/api/` (AECI-28) talking to Supabase via per-request Prisma Accelerate, with baseline Prisma schema for vendors/products/integrations + taxonomy (AECI-39) and RLS policies (AECI-29, AECI-44), and `Cache-Control: private, no-store` on every API response (AECI-43)
- **Service binding** between SSR Worker and API Worker (AECI-30); SSR Worker calls API privately via `env.API.fetch(...)`, not the public internet
- **`packages/shared`** with Zod schemas for cross-app contracts (AECI-40)
- **CI/CD** via Wrangler + GitHub Actions (AECI-27), monorepo lint (AECI-45), test infra (AECI-33; Vitest + Playwright + axe + Lighthouse)
- **Datadog** Browser RUM + Worker logging (AECI-31)
- **Design system**: Impeccable skill installed (AECI-38), DESIGN.md + PRODUCT.md seeded, v0.dev → Angular workflow proven (AECI-19)
- **Layout shell**: header / footer / nav with i18n + theme (AECI-32)
- **End-to-end SSR + cache plumbing** validated by Hello World (AECI-36)

The non-negotiables baked into every Phase 1 task continue: zoneless, i18n-wrap every string, render correctly in light and dark, RLS-aware, no public API surface (the API Worker is not a separately-exposed/documented API product and has no public ingress on its own hostname — the SSR Worker reaches it via the service binding, and its same-origin `/api/*` passthrough is the sanctioned browser read path; see §7), per-request Prisma Accelerate.

---

## 3. Scope

### 3.1 In-scope

**Schema additions:**

- `vendor_requests` table (write target for "Claim" / "Suggest correction" CTAs that ship as placeholder buttons in Phase 2; the forms themselves land in Phase 6)

**Slug strategy + backfill:**

- Slug shape: flat globally-unique slugs (see §6)
- `slug` column populated for every existing product and vendor record
- Slug uniqueness constraint at the DB level
- Slugs are immutable by default; admin tooling (Phase 6) gets an explicit "rename + create 301" action for rare cases

**API contracts** (in `packages/shared/`, then implemented in `apps/api/`):

- `GET /api/products/:slug` — full product detail with hydrated relations
- `GET /api/products` — paginated index
- `GET /api/vendors/:slug` — full vendor detail with hydrated products
- `GET /api/vendors` — paginated index
- `GET /api/integrations/:id` — full integration detail with both product LinkRefs
- `GET /api/integrations` — paginated index, filterable by source/target
- `GET /api/categories/:slug` — category browse, products listed
- `GET /api/audiences/:slug` — audience browse
- `GET /api/phases/:slug` — phase browse
- `GET /api/taxonomy` — full taxonomy lists for nav/footer
- `POST /api/page-views` — fire-and-forget view-capture endpoint (returns 204; no-op write in Phase 2, Phase 4 wires the write)

**Pages:**

| Route | Renders |
|---|---|
| `/products/:slug` | Product detail (single page with sections) |
| `/products` | Product index (paginated, sort by `created DESC` default) |
| `/vendors/:slug` | Vendor detail (single page with sections) |
| `/vendors` | Vendor index (paginated, sort by `created DESC` default) |
| `/integrations/:id` | Integration detail |
| `/integrations` | Integration index (paginated, sort by `name` default, filter by source/target product) |
| `/categories/:slug` | Category browse — products in this category |
| `/audiences/:slug` | Audience browse |
| `/phases/:slug` | Project phase browse |
| `/categories` | Flat list of all categories |

All entity detail pages are **single pages with sections**. Section navigation is intra-page anchor links, not separate routes. Heavy sub-sections (e.g. a product with 50+ integrations) use Angular's deferred-loading primitives (`@defer`) within the same page, not separate routes.

**Caching** (see §8):

- Cache-Tag header vocabulary defined and implemented across every public route
- SSR Worker writes `Cache-Tag` headers on every cacheable response
- API responses remain `private, no-store` per AECI-43 — only the SSR HTML is cached
- Cache invalidation helper (Worker route + admin token) for tag-based purges
- Cache TTLs per route documented

**Cross-cutting:**

- SEO foundations: per-page `<title>`, `<meta description>`, canonical URL, `og:` tags, JSON-LD for product and vendor (integrations defer to Stage 2), sitemap.xml served from the SSR Worker
- 404 page for not-found slugs (typed, i18n-wrapped, theme-aware)
- Breadcrumbs on every detail page
- Internal-link graph: every detail page links to its related entities so a visitor can reach any entity from any other in ≤ 3 clicks

### 3.2 Explicitly out of scope (deferred)

- Search / faceted filter UI (Phase 3 — Algolia)
- Home page (Phase 4 — needs stats pipeline)
- Auth, accounts, reviews submission/display (Phase 5)
- Claim form / correction form UI (Phase 6 — only the empty CTA button + the `vendor_requests` table land here)
- Admin UI (Phase 6)
- `profiles`, `reviews`, `stats_cache`, `page_views` tables (Phases 4–5)
- View-count badges on detail pages (Phase 4)
- Compare tool, comments, Q&A (Stage 2)
- Integration JSON-LD (Stage 2, contingent on MCP exposure direction)
- Sub-route pattern (`/vendors/:slug/details`, etc.) — considered and rejected; single page with sections is the pattern

---

## 4. Page inventory deltas from original §16

The original §16 Phase 2 listed: product detail, vendor detail, integration detail, three browse pages. This spec adds:

| Addition | Why |
|---|---|
| `/products`, `/vendors`, `/integrations` index pages | Without search until Phase 3, these are the only way a visitor can browse the catalog at all. Cheap to build as paginated lists; high value. |
| `/categories` (flat list of all categories) | Lets a visitor see the taxonomy at a glance. ~30 entries. Effectively free since data is already there. |
| 404 page | Slug typos and stale links are inevitable. Phase 2 is when public URLs go live. |
| `sitemap.xml` | SEO foundation. Phase 2's whole milestone is invisible to search engines without it. |
| Per-page JSON-LD (product + vendor) | Turns each detail page into a structured data card for Google. |
| Tag-based cache invalidation Worker endpoint | The mechanism for cache purge that later phases will need. |
| `POST /api/page-views` (no-op in Phase 2) | Capture hook in place so Phase 4 doesn't have to retrofit it. |

---

## 5. Data model additions

Only `vendor_requests` lands in Phase 2.

**Why not the other four** (`profiles`, `reviews`, `stats_cache`, `page_views`):

- `profiles` + `reviews` — Phase 5 (auth). No reader in Phase 2.
- `stats_cache` — Phase 4 (home page). No reader in Phase 2.
- `page_views` — Phase 4. The capture endpoint exists in Phase 2 but is a no-op; Phase 4 lands the table and writes.

**Why `vendor_requests` ships now** even though the forms are Phase 6:

1. Claim and Correction CTA buttons appear on every product and vendor detail page from day one (placeholder routes in Phase 2; full forms in Phase 6).
2. RLS policy authoring is materially simpler when all admin-only tables are introduced together.
3. The schema can be reviewed once with all data-model decisions instead of revisiting it in Phase 6.

### 5.1 `vendor_requests` schema

Canonical column list for Phase 2 (mirrored in `DATABASE_SCHEMA.md` §8.1). Decisions baked in here:

```
vendor_requests
  id                 uuid pk
  kind               enum: claim | correction
  target_type        enum: product | vendor
  target_id          uuid  // loose FK, see §5.2
  submitter_email    text not null
  submitter_name     text
  submitter_role     text
  domain_match       enum: pending | match | no_match | manual_review
  body               text not null
  source_url         text                          // for corrections: where the discrepancy was observed
  status             enum: open | in_review | resolved | rejected
  linear_issue_id    text                          // populated when a Worker (Phase 6) creates the Linear issue
  created_at         timestamptz default now()
  resolved_at        timestamptz
  resolved_by        uuid references profiles(id) on delete set null
```

### 5.2 FK shape decision

**Decision: loose polymorphic FK** — `(target_type, target_id)` with a CHECK constraint enforcing `target_type IN ('product', 'vendor')`. No hard FK on `target_id`.

Rationale: polymorphic nullable columns (`product_id` + `vendor_id`) work for two target types but don't scale if Stage 2 adds claim/correction for integrations or vendor categories. Loose stays flexible. Cost: application-level referential checks. Worth it.

Application-level rule: on insert, verify `target_id` exists in the table referenced by `target_type`. Implemented in the Phase 6 form submission handler; Phase 2 only ships the table + RLS, no inserts yet from the public surface.

### 5.3 RLS

Admin-only read/write. PostgREST `GRANT` baseline excludes this table from `anon`. Per `AUTH_AND_RLS.md` §1, the table is added to the deny-by-default list explicitly. The Worker writes to it via the privileged Postgres role (Phase 6 form handlers).

---

## 6. Slug strategy

The schema in AECI-39 included a `slug` column on `products` and `vendors`. Phase 2 decides the *shape* of those slugs and backfills values.

### 6.1 Decision: flat, globally unique

URLs are `/products/{slug}` and `/vendors/{slug}`. Both are globally unique within their entity type.

| Pattern | Decision |
|---|---|
| `/products/{slug}` (flat) | **Chosen** |
| `/products/{vendor-slug}/{product-slug}` (nested) | Rejected — too brittle (vendor rename breaks every product URL), heavier internal-link burden |
| `/products/{slug}-{shortid}` (Stripe-style) | Rejected — ugly, SEO-hostile |

Collision handling: on collision at insert time, append a vendor-derived suffix (e.g. `procore` first, then `procore-by-asite` if a second vendor releases something named "Procore"). On further collision, append `-2`, `-3`, etc. Logic lives in `packages/shared/src/slug.ts`.

### 6.2 Slug immutability

Slugs are **immutable by default**. Renaming a product does not change its slug.

Admin tooling (Phase 6) gets an explicit "rename slug" action that creates a 301 redirect from the old slug to the new one. This is the documented escape hatch for rare cases (genuine vendor rebrand, typo in original slug). It is not a free-for-all rename.

Phase 2 ships only the immutability default; the rename action and redirect table are Phase 6.

### 6.3 Slug generator

In `packages/shared/src/slug.ts`:

- Lowercase, ASCII-fold (`Procoré` → `procore`)
- Replace non-alphanumeric runs with `-`
- Trim leading / trailing `-`
- Reject a fixed list of reserved words: `api`, `admin`, `products`, `vendors`, `integrations`, `categories`, `audiences`, `disciplines`, `phases`, `claim`, `correction`, `404`, `sitemap.xml`, `robots.txt`
- On collision, append vendor-slug suffix; on further collision, append `-2`, `-3`

### 6.4 Backfill / normalization

AECI-39 (baseline migration) shipped `products.slug` and `vendors.slug` as `NOT NULL` with a UNIQUE index, so there are no `slug IS NULL` rows to fill. The Phase 2.7 script in `apps/api/scripts/backfill-slugs.ts` is therefore a **slug-normalization pass**: it reads every product and vendor, recomputes `slugify(displayName)` via `packages/shared/src/slug.ts`, and writes the result back when the stored slug differs from the canonical form. Collisions are resolved through `disambiguateSlug` (vendor-suffix path, then numeric). Vendors are processed before products so a vendor's post-normalization slug is available when a product needs the vendor-suffix path.

Idempotent: rows already at canonical slugs are SKIPPED. Re-running on a clean DB produces zero writes. A `--dry-run` flag prints the planned writes without executing them. Reserved-word collisions (e.g. a product literally named "Admin") and empty-name inputs are logged as `ERRORED` and require a human rename + re-run.

Runs through the privileged Postgres role (Prisma Accelerate is configured with the service-role connection string), bypassing RLS by design.

```bash
pnpm --filter @aeci/api db:backfill-slugs -- --dry-run   # plan
pnpm --filter @aeci/api db:backfill-slugs                # apply
```

The accompanying migration `20260524100000_phase_2_slug_unique/migration.sql` is an idempotent guard that re-asserts the unique indexes via `CREATE UNIQUE INDEX IF NOT EXISTS`. The constraint already exists from baseline; the migration documents the §6.4 contract and survives a fresh DB build that for any reason skipped the baseline indexes.

### 6.5 Integrations: no slug

Integrations are accessed by record ID (`/integrations/:id`). The detail page title is `"{source} → {target}"`.

---

## 7. API contracts

All public endpoints expose only what the SSR Worker needs to render a page. **No public API surface** means the API Worker is not a separately-exposed, documented, or versioned API product (no OpenAPI, no codegen) and has no public ingress on its own hostname (`workers_dev:false`); the SSR Worker reaches it via `env.API.fetch(...)` (service binding). It does **not** mean browser code may never read `/api/*`: the SSR Worker re-proxies `/api/*` same-origin (ADR 0001 §Consequences), and hydrated client code uses it — the index pages fetch their lists via `httpResource`, and the detail/browse resolvers fetch on a client-navigation `TransferState` miss (AECI-151). Write routes carry per-endpoint auth; read GETs are public by construction.

Per `API_CONTRACTS.md` §2, contracts are TypeScript types + Zod schemas in `packages/shared/`. No OpenAPI, no codegen.

### 7.1 Endpoint shapes

```
GET /api/products
  query: ?page=1&perPage=24&sort=created|name|updated|rating|reviews   (default: created DESC)
  → { data: ProductListItem[], page, perPage, total }

GET /api/products/:slug
  → ProductDetail | 404

GET /api/vendors
  query: same as products (default sort: created DESC)
  → { data: VendorListItem[], page, perPage, total }

GET /api/vendors/:slug
  → VendorDetail | 404

GET /api/integrations
  query: ?page=1&perPage=24&sort=name|created (default: name ASC)
         &sourceProductId=&targetProductId=
  → { data: IntegrationListItem[], page, perPage, total }

GET /api/integrations/:id
  → IntegrationDetail | 404

GET /api/categories
  → { data: TaxonomyTermWithCount[] }   // count of products in each

GET /api/categories/:slug → CategoryDetail
GET /api/audiences/:slug → AudienceDetail
GET /api/phases/:slug → PhaseDetail
GET /api/taxonomy → { categories, audiences, phases }

POST /api/page-views
  body: { route: string, entity_type?: string, entity_id?: string }
  → 204 (Phase 2: no-op; Phase 4: writes to page_views)
```

### 7.2 Hydration depth

Each detail response hydrates relations the page actually displays. **Detail pages do not chain-fetch.** If the product detail page shows the vendor, the API embeds the vendor's display fields (name, slug, logo_url) — it doesn't return only the vendor ID.

Hydration rules per response shape are documented in `API_CONTRACTS.md` §3.

Not every `ProductDetail` field is a hydrated relation. `usefulness` (`ProductUsefulness | null`) is embedded **narrative** content — value text grouped by audience and by project phase — and is **distinct from** the `audiences`/`phases` taxonomy facets, which are `LinkRef[]` join-table links answering "who is this for?" / "which lifecycle stage?". A usefulness group is keyed by the same taxonomy `slug` (so the display can link a group back to its facet browse page), but the group's `points` are free-form prose stored on the product, not a taxonomy relation. `usefulness` is `null` when the source has no value for either facet. The canonical shape lives in `API_CONTRACTS.md` §5.1; the stored column in `DATABASE_SCHEMA.md` §4.2; the promote payload in `REVIEW_APP_PROMOTE_API.md` §3.3. The product detail page renders this section under the heading **"How teams use it"** (sentence case per `PRODUCT.md`).

### 7.3 Pagination

- Page-based (not cursor) for Phase 2. Catalog is small; simple is fine.
- `perPage` capped at 100 server-side.
- `total` is returned but expensive on large tables; we accept that for Stage 1.

### 7.4 Sort defaults

- `/products`, `/vendors`: **`created DESC`** ("newest first") — gives a sense of liveliness, surfaces fresh content
- `/integrations`: **`name ASC`** — since names are `"Source → Target"`, alphabetical groups by source product, which is useful for browsing

**Review-driven product sorts** (`/products` only): `rating` ("Highest rated") and `reviews` ("Most reviewed"), both **DESC**. For `rating`, products whose average is withheld by the §5.5 ≥5-review gate sort **last** (the orderBy nulls the sort key below the threshold, so a lone 5★ review can't top a well-reviewed 4.8★ product). Both are mostly inert until reviews accumulate post-launch, but ship now so the option is ready. Vendors do not expose these (no vendor rating field; no live `/vendors` list).

---

## 8. Edge caching with tags

### 8.1 Plan availability note

Cache-Tag purge is available on all Cloudflare plans as of April 2025. The Pro plan rate limits (token bucket) are adequate for Phase 2's expected purge volume.

### 8.2 Tag vocabulary

Cache-Tag values are comma-separated strings, ≤ 16 KB per response, no spaces.

| Tag | Attached to |
|---|---|
| `product:{slug}` | The product detail page for that slug |
| `vendor:{slug}` | The vendor detail page for that slug |
| `integration:{id}` | The integration detail page |
| `category:{slug}` | Category browse page |
| `audience:{slug}` | Audience browse page |
| `phase:{slug}` | Project phase browse page |
| `taxonomy` | Any page that displays the full taxonomy (nav, footer, /categories) |
| `index:products` / `index:categories` | The respective index pages. (AECI-165 removed the `/vendors` and `/integrations` index pages, so `index:vendors` / `index:integrations` are no longer emitted.) |
| `sitemap` | sitemap.xml |
| `route:detail` / `route:index` / `route:browse` | Coarse-grained tags for bulk invalidation in incidents |

Every cacheable response carries **at minimum**:

- One entity-specific tag (e.g. `product:procore`)
- One route-class tag (e.g. `route:detail`)
- Tags for every entity *embedded* in the response (a product page references its vendor → also tags `vendor:{vendor-slug}` so editing the vendor invalidates affected product pages)

### 8.3 TTLs (Cache-Control: `max-age` / `s-maxage`)

| Route class | `max-age` (browser) | `s-maxage` (edge) |
|---|---|---|
| Detail pages | 0 | 900 (15 min) |
| Browse pages (category / audience / phase) | 0 | 300 (5 min) |
| Index pages | 0 | 300 (5 min) |
| Taxonomy fetch (`/taxonomy`) | 0 | 3600 (1 hr) |
| sitemap.xml | 0 | 3600 |
| robots.txt | 86400 | 86400 |
| 404 | 0 | 60 |

Per AECI-43, API responses themselves remain `private, no-store`. Only SSR HTML is cached.

### 8.4 Invalidation mechanism

A `POST /admin/purge` endpoint on the SSR Worker:

- Authenticates via a long-lived admin token (Wrangler secret named `ADMIN_PURGE_TOKEN`)
- Body: `{ tags: string[] }`
- Calls Cloudflare's purge-by-tag API for the zone
- Batches and respects Pro plan rate limits (token bucket per account)
- Logs to Datadog

Auth: Wrangler secret in Phase 2. **Migrate to Cloudflare Access in Phase 6** when admin tooling expands and there are multiple admin endpoints behind the same auth boundary.

Callers in Phase 2:
- Manual incident response (curl)
- Future admin tooling (Phase 6) — direct call from admin Workers, not n8n

Phase 2 ships the endpoint plus a working manual purge. Automated callers (e.g. Supabase webhook on row update) are Phase 4+.

### 8.5 Cookie / cache hygiene

Already established in AECI-35 / AECI-41 (cookie stripping on cacheable routes). Phase 2 inherits this; no new work. Theme is applied client-side post-hydration so the cached HTML stays neutral.

### 8.6 SEO header set

In addition to caching headers, every cacheable response carries:

- `Vary: Accept-Language` (URL-prefix locale dispatch handles the actual variance, but the header tells well-behaved proxies)
- `Link: </sitemap.xml>; rel=sitemap`
- `Content-Security-Policy` — defined and first emitted in AECI-89 (the "existing from Phase 1" framing predated the actual implementation). The policy and its rationale live in `CACHE_STRATEGY.md` §7 and `apps/web/src/server/seo-headers.ts`.

---

## 9. SEO & metadata

### 9.1 Per-page metadata

Every page sets:

- `<title>` — page-specific, formatted as `"{entity name} — AEC Integrations"` for details, `"{Taxonomy term} tools — AEC Integrations"` for browse
- `<meta name="description">` — pulled from the entity's description, truncated to ~155 chars
- `<link rel="canonical">` — the canonical URL for this entity (no query params). The base is the **serving origin** (self-referential, multi-host), **not** a hardcoded apex: each host canonicalises to itself. `MetaService` builds it via `apps/web/src/app/core/canonical.ts` → `canonicalUrl()` (server: SSR `REQUEST` origin; client: `location.origin`; production apex only as the no-request fallback). See **ADR 0011** for the rationale (future-proofs the pre-launch `demo.aecintegrations.com` → apex/www promotion; non-prod hosts are Cloudflare-Access-gated so their self-canonicals never reach the public index). Exceptions: the 404 page self-references the requested URL, and the `/preview/*` design samples keep a fixed apex canonical.
- Open Graph: `og:title`, `og:description`, `og:url` (same serving-origin canonical as above), `og:type`, `og:image` (logo where available, otherwise default OG image)
- Twitter card equivalents

Implementation: a `MetaService` in `apps/web/src/app/core/` that pages call from their resolver. SSR sets the `<head>` tags before sending HTML; on an in-app client navigation the resolver re-applies them so the SPA's head (title/canonical/OG/JSON-LD) stays correct (idempotent upserts; AECI-151). `MetaService` is platform-agnostic — the platform decision lives in the resolver callers, not the service.

### 9.2 JSON-LD

- **Product detail**: `schema.org/SoftwareApplication` with `name`, `description`, `url`, `applicationCategory`, `applicationSubCategory`, `offers` (link to vendor site), `operatingSystem` if known
  - **`offers` is deferred to AECI-68.** Not emitted in the current implementation — it needs a vendor-site URL that `VendorLink` does not yet carry. `buildProductJsonLd` (`apps/web/src/app/core/meta.helpers.ts`) omits it until `VendorLink.website` lands (AECI-68), which will populate `offers.url`.
  - **`operatingSystem` is out of scope for Phase 2.** No product field carries OS data, so the `if known` condition is never satisfied and the field is not emitted. No tracking issue.
- **Vendor detail**: `schema.org/Organization` with `name`, `url`, `logo`, `foundingDate`, `address` (if HQ known)
- **Integration detail**: **No JSON-LD in Phase 2.** No clean schema.org type exists; revisit in Stage 2 once MCP exposure direction is clearer.

### 9.3 sitemap.xml

Served from the SSR Worker at `/sitemap.xml`. Generated on-request, cached 1hr per §8.3.

Contents:
- Every product slug
- Every vendor slug
- Every integration ID
- Every category, audience, phase slug
- Index pages

`<lastmod>` from the entity's `updated_at`. Priority defaults are fine.

### 9.4 robots.txt

Already exists from Phase 1. Phase 2 confirms it allows `/products`, `/vendors`, `/integrations`, `/categories`, `/audiences`, `/phases` and points to `/sitemap.xml`.

---

## 10. Internal-link graph

Every detail page links to its related entities. No detail page is a dead end.

| From | To |
|---|---|
| Product detail | Its vendor(s); each category, audience, phase; each integration as source or target (with the *other* product also linked); placeholder CTAs to Claim / Suggest Correction |
| Vendor detail | Each of its products; HQ (text); funding-stage badge if available |
| Integration detail | Source product, target product, built-by vendor (if set), powered-by product (if iPaaS), both products' vendors |
| Category browse | Each product in the category; back to `/categories` |
| Audience / phase browse | Same shape as category |
| Index pages | Each entity (paginated); pagination controls |

Visitor reachability: from any page, every other page is reachable in ≤ 3 hops. Validated as a Phase 2 acceptance check via a Playwright crawler.

---

## 11. UX & design

Defer to DESIGN.md and PRODUCT.md for token-level decisions and voice. Phase 2 page work uses the AECI-19 v0 → Angular workflow for each new page type.

### 11.1 Page templates

Three reusable Angular layout components (per `DESIGN.md` patterns):

- `DetailLayout` — left column hero (name, vendor, key facts) + right column metadata + body sections below
- `BrowseLayout` — header strip + filter sidebar (Phase 3 placeholder) + grid of cards
- `IndexLayout` — table-style listing with sort headers + pagination

Each detail page (product, vendor, integration) is a different *body content* projected into `DetailLayout`. Same for browses and indexes. Sections within a detail page use Angular's `@defer` for heavy content (e.g. a product with 50+ integrations).

### 11.2 New primitives

- `ProductCard`, `VendorCard`, `IntegrationCard` — used by index and browse pages
- `TaxonomyBadge` — pill component for category / audience / phase chips, color-coded per token (forest variants per DESIGN.md)
- `EntityTable` — generic sortable / paginated table for index pages

Each new component goes through `/impeccable craft` and is added to DESIGN.md's component definitions before merging.

### 11.3 i18n

Every visible string i18n-wrapped from day one (per AECI-23). English-only at launch but `xliff` extraction must work cleanly at the end of Phase 2 — that's an acceptance check.

### 11.4 Theme

Every component renders correctly in light and dark per AECI-25 / AECI-41 tokens. No hard-coded color literals. Lint rule (Phase 1) catches violations.

---

## 12. Performance budgets

- **Lighthouse mobile** ≥ 90 for Performance / Accessibility / Best Practices / SEO on every page type
- **TTFB** at the edge ≤ 100 ms on cache hit, ≤ 600 ms on cache miss
- **LCP** ≤ 2.5 s on cache miss
- **CLS** ≤ 0.1
- **Total JS** to the browser ≤ 200 KB gzipped on a detail page
- **Image budget**: vendor logos served via Brandfetch CDN with `loading="lazy"` and `width`/`height` set; no client-side image processing

These run in CI as Lighthouse checks per AECI-33's harness. Budget overruns block merge.

---

## 13. Testing strategy

### 13.1 Unit (Vitest)

- `packages/shared/src/slug.ts` — slug generator: ASCII fold, collision suffix, reserved-word reject
- `apps/api/src/services/product.ts` (and vendor, integration, taxonomy) — Prisma query shape, error mapping
- `apps/web/src/app/core/meta.service.ts` — title/description/OG composition

### 13.2 Integration (Vitest + Miniflare per `TESTING_STRATEGY.md` §6)

- API Worker: each endpoint with seeded fixtures, including 404 paths and pagination edges
- Service binding round-trip (SSR Worker → API Worker → mocked Prisma)

### 13.3 E2E (Playwright)

- Smoke: every page type renders, all internal links resolve, sitemap is valid XML, robots.txt is served, 404 page renders for a bogus slug
- Crawler: from `/`, can reach every page type in ≤ 3 hops (proves internal-link graph)
- Cache: hitting the same detail page twice serves cache on second request (assert `cf-cache-status` header)
- Cache invalidation: POST `/admin/purge` with a tag, request the matching page, assert `cf-cache-status: MISS` then `HIT`

### 13.4 Accessibility (axe)

Run axe against every page type in CI. Zero violations at level AA.

### 13.5 Lighthouse

Per §12, run in CI against a fixed seeded data set.

---

## 14. Observability

Datadog (per Phase 1) covers RUM + Worker logs. Phase 2 adds:

- Custom metric: `aeci.page.render.duration_ms` tagged by `route_class` (detail / browse / index) and `cache_status` (HIT / MISS)
- Custom metric: `aeci.api.query.duration_ms` tagged by endpoint
- Custom metric: `aeci.cache.purge` counter tagged by purge source (`manual` / `webhook`)
- Dashboards: one for "Phase 2 traffic" — top routes, cache hit rate per route, p95 render time per route class
- Alerts: cache hit rate < 70% sustained, p95 detail page render > 1.5 s sustained, Worker error rate > 1%

---

## 15. Acceptance criteria for Phase 2 completion

Phase 2 is **Done** when:

- [ ] Every page in §3.1 renders with real data from Supabase
- [ ] Every page passes Lighthouse mobile ≥ 90 across all four categories
- [ ] Every page passes axe with zero AA violations
- [ ] sitemap.xml is valid and contains every entity
- [ ] Crawler test confirms every entity reachable in ≤ 3 hops from `/`
- [ ] Cache-Tag headers present on every cacheable response per §8.2
- [ ] `POST /admin/purge` works end-to-end (verified manually + in test)
- [ ] `POST /api/page-views` returns 204 and is called by every detail page render (and, post-AECI-151, by every in-app client navigation via `PageViewTracker`, so the metric reflects all visitor arrivals, not just full-document loads)
- [ ] Slugs backfilled for 100% of existing products and vendors; uniqueness constraint in place
- [ ] `vendor_requests` table exists with RLS policies applied
- [ ] All API contracts in `packages/shared/`, all endpoints in `apps/api/` with tests
- [ ] CI runs unit + integration + E2E + a11y + Lighthouse and is green
- [ ] Datadog dashboard live and showing data
- [ ] `xliff` extraction succeeds with no missing translations marker
- [ ] No new console warnings or errors on any page type
- [ ] DESIGN.md updated with new component definitions
- [ ] No hard-coded color literals anywhere (lint clean)

---

## 16. Phase 2 build order (wave preview)

Issue breakdown follows in a sibling document. Rough wave structure:

**Wave 1 — Foundation, fully parallelizable**

- Slug generator in `packages/shared/`
- `vendor_requests` migration + RLS policies
- Cache-tag vocabulary (this section §8 lifted into `docs/CACHE_STRATEGY.md`)
- API contract Zod schemas for product / vendor / integration / taxonomy
- `MetaService` + JSON-LD helper in `apps/web/`
- `DetailLayout`, `BrowseLayout`, `IndexLayout` skeletons

**Wave 2 — Backend complete**

- Slug backfill script + run
- API endpoints (products, vendors, integrations, taxonomy, categories/audiences/phases) with tests
- `POST /api/page-views` endpoint (no-op write)
- `POST /admin/purge` endpoint + cache-tag write helper for SSR Worker

**Wave 3 — Pages, parallelizable**

- Product detail + product index
- Vendor detail + vendor index
- Integration detail + integration index
- Category / audience / phase browse + `/categories` flat list
- 404 page
- sitemap.xml endpoint

**Wave 4 — Cross-cutting hardening**

- Internal-link graph audit + crawler test
- Lighthouse / axe / a11y CI integration for Phase 2 routes
- Datadog dashboard + alerts
- Performance budget verification
- Final i18n xliff extraction check

---

## 17. Decisions baked in

The seven open questions from the spec draft are resolved:

1. **`vendor_requests` FK shape**: loose `(target_type, target_id)` with CHECK constraint
2. **Slug immutability**: immutable by default, admin tool (Phase 6) has explicit rename + 301 action
3. **Integration JSON-LD**: deferred to Stage 2
4. **`/categories` flat page**: ships in Phase 2
5. **`/admin/purge` auth**: Wrangler secret in Phase 2, migrate to Cloudflare Access in Phase 6
6. **`page_views` table**: deferred to Phase 4, but `POST /api/page-views` capture hook ships in Phase 2 (no-op write)
7. **Index sort defaults**: `/products` and `/vendors` → `created DESC`; `/integrations` → `name ASC`

---

## 18. Operational notes

### 18.1 No n8n in Phase 2

The original §16 Phase 2 planning had n8n as a potential caller of `/admin/purge`. Removed. Phase 2's purge callers are manual curl + future admin Workers only.

**Forward direction**: Phase 6 form-submit-to-Linear handler will be a Cloudflare Worker, not an n8n workflow. Pros: one less moving part, fully versioned in the repo, fully observable in Datadog. The Worker handles Linear API auth, retries, and idempotency directly. ~50-100 lines of code total. Confirmed for Phase 6 planning.

### 18.2 Estimated effort

Rough order-of-magnitude only, based on Phase 1 pace:

- Wave 1: 1 week (5 issues, each small-to-medium)
- Wave 2: 1 week (4 issues, mostly backend)
- Wave 3: 2 weeks (10 page issues, parallelizable but design iteration is the bottleneck)
- Wave 4: 1 week (4 hardening issues)

Total: ~5 weeks at Phase 1 cadence. Treat as a floor, not a ceiling.

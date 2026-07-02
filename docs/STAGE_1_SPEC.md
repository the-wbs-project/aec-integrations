# AEC Integrations — Stage 1 Specification

**Version:** 1.7
**Date:** May 2026
**Status:** Draft for build

---

## 1. Overview

Stage 1 is a public, read-only directory of AEC software products, vendors, and integrations, with basic review submission. The goal is to deliver a credible, data-rich, trustworthy launch from the existing seed data — not to build vendor management, paid features, or rich profiles.

**Primary user:** AEC practitioner evaluating software, looking to understand integration relationships between tools.

**Success criteria:**
- Practitioner can search the directory and find relevant products
- Practitioner can browse by category, audience, and project phase
- Practitioner can see integration relationships between products
- Practitioner can submit a review (auth-gated)
- Vendor can submit a claim or correction request
- Site feels alive, trustworthy, and data-rich on day one

**Out of scope for Stage 1:** vendor portal, self-serve claiming, paid tiers, rich media profiles, trust scoring, work email verification.

---

## 1a. Companion Documents

This spec is the master document. Detailed content for the following areas lives in dedicated companion documents, all in the repo root alongside this one.

| Document | Covers | Status |
|---|---|---|
| `DATABASE_SCHEMA.md` | All Supabase tables, columns, indexes, relationships, Airtable migration plan | Complete |
| `API_CONTRACTS.md` | Endpoint shapes, request/response types via Zod schemas, error codes, validation rules | Complete |
| `AUTH_AND_RLS.md` | Authorization model, role definitions, RLS policies per table (GRANTs/RLS/helpers ship as numbered migrations — AECI-87) | Complete |
| `CICD_PLAN.md` | GitHub Actions pipeline, environments, deployments, rollback, secrets | Complete |
| `TESTING_STRATEGY.md` | Test tools (Vitest, Playwright, axe-core, Lighthouse CI), coverage targets, flaky test policy | Complete |
| `UNIT_TESTING_GUIDE.md` | Unit-test conventions, fixture patterns, mocking guidance | Complete |
| `STAGE_1_5_SPEC.md` | **Stage 1.5 — Integration Redesign**: product-PAIR page + claim/attestation model (supersedes the integration portions of §3.1 / §4.4 / §7.5) | Complete |
| `DATA_OBJECT_VOCABULARY.md` | The frozen, closed `data_object` controlled vocabulary (+ generated `data-object-vocabulary.json` mirror) both apps seed from | Complete |
| `CODE_REVIEW_CHECKLIST.md` | Pre-merge review categories and severity rubric for humans and LLMs | Complete |
| `BRAND_GUIDELINES.md` | Canonical brand colors (light; dark variants documented but not shipped in Stage 1 — AECI-226), Bone reclassification, Clay restriction, visual principles | Complete |
| `SEARCH_RANKING.md` | Algolia ranking customization, tuning, feedback loops | Pending |
| `OPERATIONAL_RUNBOOKS.md` | Incident response, vendor dispute handling, recovery procedures | Pending (closer to launch) |
| `STACK_VALIDATION_TEST.md` | Foundation stack test plan and results | Complete |

When a section of this spec references one of these documents, the companion document is the source of truth for that area. This spec describes the architecture and intent; companion documents describe the implementation detail.

---

## 2. Stack

| Layer | Choice |
|---|---|
| Frontend | Angular 21+ with SSR, **zoneless** (`provideZonelessChangeDetection()` — no `zone.js`) |
| Styling | Tailwind CSS **v4** (`@tailwindcss/postcss`) with `@spartan-ng/brain/hlm-tailwind-preset.css` |
| Components | Spartan UI **brain primitives only** (signal-based) + Angular CDK. `helm` codegen is avoided (alpha-CLI instability; decision validated in stack-test) |
| Hydration | `provideClientHydration(withHttpTransferCacheOptions({ includePostRequests: false }))` — v22 incremental hydration is on by default and auto-enables event replay (no explicit `withEventReplay()`; AECI-130). See `apps/web/src/app/app.config.ts:13-30` |
| i18n | `@angular/localize` |
| Hosting | Cloudflare Workers (SSR Worker with `compatibility_flags: ["nodejs_compat"]` for `@angular/ssr` runtime polyfills) |
| Database | Cloudflare D1 (SQLite) — the application DB (ADR 0016); Supabase retained for **Auth only** |
| ORM | Drizzle (`drizzle-orm/d1`) over the API Worker's native `DB` binding — no Prisma, no Accelerate, no `nodejs_compat` for the DB path; see `DATABASE_SCHEMA.md` §1a |
| Search | Algolia + InstantSearch Angular |
| Auth | Supabase Auth (magic link + Google OAuth) |
| Email | Resend (transactional) + Microsoft 365 (mailboxes) |
| Issue tracking | Linear (with GitHub integration via API) |
| Design | Figma |
| AI development | Claude Code (manual, against Linear issues) |
| Vendor request routing | Linear via n8n native Linear node |
| Product analytics | PostHog |
| Performance, errors, logs | Datadog (RUM + APM + Logs) |
| Monorepo structure | `apps/web/`, `apps/api/`, `packages/shared/` |

---

## 2a. Design System & Theming

### 2a.1 Theming model

Stage 1 ships a single, **light-only** presentation — no theme toggle and no system-preference detection (AECI-226; this supersedes the earlier light/dark/system model). The dark theme is deferred to the Stage 2 vendor portal, where the semantic-token architecture (below) makes re-introduction a token-block + toggle change. The `profiles.theme_preference` column stays in the schema but is dormant in Stage 1 — its persistence was already scoped to Stage 2+.

**Principle: brand colors are accents, not surfaces.** Surfaces are neutral (white/near-black). Brand colors (Forest, Clay, Bone) layer on top as accents, badges, callouts, and highlights. This matches the modern product design pattern used by many leading product companies, while preserving brand identity through accent placement.

### 2a.2 Token system

All colors expressed as CSS custom properties on `:root`. Tailwind config reads from these tokens. (Stage 1 is light-only — see §2a.1; the semantic token names below are theme-agnostic, so a dark set can layer back on at Stage 2 without touching consumers.)

**Light theme:**

| Token | Value | Use |
|---|---|---|
| `--surface-base` | `#FFFFFF` | Page background |
| `--surface-raised` | `#FAFAFA` | Cards, panels |
| `--surface-sunken` | `#F4F4F5` | Inset areas, code blocks |
| `--surface-muted` | `#F4F4F5` | Interactive row hover / `focus-within` (index tables); shares the sunken value in light by design |
| `--border-default` | `#E4E4E7` | Standard borders |
| `--border-strong` | `#D4D4D8` | Emphasized borders |
| `--text-primary` | `#0A0A0A` | Body text |
| `--text-secondary` | `#52525B` | Supporting text |
| `--text-tertiary` | `#71717A` | Hints, placeholders, metadata (4.83:1 on white; never on sunken/muted surfaces — re-pointed from `#A1A1AA` in AECI-230, which measured 2.56:1) |
| `--accent-primary` | `#1E3A2F` | Forest — CTAs, links, primary brand |
| `--accent-primary-hover` | `#2E5C45` | Hover state |
| `--accent-primary-soft` | `#ECF1EE` | Forest wash — selected/active/verified-soft state fills; always paired with a border or selected affordance (AECI-230) |
| `--accent-secondary` | `#E89668` | Clay — decorative/fill only, carrying `--text-primary` (2.33:1 on white: below even the 3:1 large-text floor — AECI-230) |
| `--accent-secondary-deep` | `#A14D22` | Clay deep — text-capable clay: clay text, icons (5.83:1 on white); doubles as the warning hue (AECI-230) |
| `--accent-rating` | `#DAA520` | Goldenrod — gold-star fill for rating glyphs; decorative (`aria-hidden`), so its 2.24:1 on white is permitted (value carried by numeral + `aria-label`); empty stars use `--border-strong` in displays, `--text-tertiary` in the interactive review-form picker |
| `--accent-warm` | `#F5F2EA` | Bone — subtle warm-tinted sections, never primary surface |
| `--status-error` | `#B3261E` | Form/validation errors (6.54:1 on white); success = Forest, warning = Clay deep (AECI-230) |

> The Stage 1 dark token set was removed in AECI-226 (preserved in git history). It returns with the dark theme at Stage 2; the brand-approved dark Forest/Clay/Bone variants remain documented in `BRAND_GUIDELINES.md` §3.

### 2a.3 Brand identity preserved

Forest and Clay remain the brand colors. Brand-approved *dark* variants of Forest and Clay exist (the originals lack contrast against near-black surfaces) and are documented in `BRAND_GUIDELINES.md` §3 — but they are **not shipped in Stage 1**; they return with the dark theme at Stage 2.

Bone is reclassified from "the background" to "a warm-tinted accent surface." It still appears in marketing pages, About page hero, callout sections, and the home page hero / marketing bands — anywhere warmth and identity are desired. It is no longer the default page background.

### 2a.4 Contrast validation

- All text/background pairs verified for WCAG 2.1 AA contrast before launch
- Clay `#E89668` measures ~2.3:1 on white — below AA body text (4.5:1) **and** below the 3:1 floor for large text and meaning-bearing graphics. It is therefore decorative/fill only (fills carry `--text-primary` at 8.48:1, never white). The former "large text allowed" clause was mathematically false and was struck in AECI-230. Clay-colored text and icons use `--accent-secondary-deep` `#A14D22` (5.83:1). See `BRAND_GUIDELINES.md` §5.
- Star-rating glyphs use `--accent-rating` (Goldenrod `#DAA520`, ~2.24:1 on white). The sub-3:1 ratio is permitted because the glyphs are decorative (`aria-hidden`) — the value is carried by the adjacent numeral and the `aria-label`, never by color alone. Read-only displays pair the gold with `--border-strong` empties (a faint track); the interactive review-form picker uses `--text-tertiary` empties so the unselected control stays visible before a rating is chosen. See `BRAND_GUIDELINES.md` §5.1.
- `--text-tertiary` was re-pointed `#A1A1AA` → `#71717A` in AECI-230 (the old value measured 2.56:1 on white). Tertiary text is never placed on sunken/muted surfaces (4.40:1 there).
- Contrast verification is automated in CI via a token-pair check matrix

### 2a.5 Theme handling for vendor-supplied content

> Forward-looking (Stage 2+): vendor uploads ship with the vendor portal, by which point the dark theme has returned (§2a.1). The "both themes" requirements below apply from that point — they do not affect the light-only Stage 1 surface.

Vendor-uploaded content (logos, screenshots, embedded videos, custom brand presence) needs explicit theme strategy because user-uploaded content cannot be assumed to work in both themes.

**Site chrome vs vendor content:**

- Site chrome (header, footer, nav, cards, buttons, forms) follows the active theme
- Vendor-uploaded content renders inside neutral "media block" containers that read as vendor content rather than site content
- Media blocks have a subtle border and padding that visually separate them from chrome

**Logos:**

- Require two variants: one for light backgrounds, one for dark
- Brandfetch provides both variants for many vendors automatically
- For vendor-uploaded logos (Stage 2+), the upload form requires both variants before save
- Active variant selected based on current theme

**Screenshots and product UI imagery:**

- Displayed in a framed container with neutral background
- Small caption: "Shown in {vendor's theme}" — sets reader expectation
- No attempt to invert or recolor — vendor's content is presented as-is
- Framed container looks identical in both themes (neutral mid-tone surface, neutral border)

**Custom brand colors (Stage 4):**

- Vendors can specify a single accent color for their hero section
- Color validated against contrast rules for both themes on save
- If brand color fails contrast in either theme, vendor is prompted to provide a lighter/darker variant — same pattern AECi uses for its own Forest/Clay accents

**Embedded videos:**

- YouTube/Vimeo embeds use a neutral player frame, no theme conflict

**Rich text descriptions:**

- Vendor-authored text inherits site typography and theme
- No custom fonts, colors, or backgrounds permitted in body copy
- Communicated clearly in the vendor portal: "Your description uses our typography so it stays readable in both themes"

**Hero images (Stage 4):**

- Vendors upload a hero image displayed full-bleed in their profile
- Required to provide one image that works in both themes, or two theme-specific variants
- Overlay text uses high-contrast white with subtle drop shadow (works in both themes)

### 2a.6 Figma design system

A Figma file ("AEC Integrations — Design System") maintains canonical color styles, text styles, spacing tokens, and component library. Tokens in Figma mirror Tailwind config; changes in either system require updates to both. See Section 24 for Figma operational details.

---

## 3. Routes & Pages

### 3.1 Public routes

| Path | Description | Cache TTL |
|---|---|---|
| `/` | Home — search, stats cards, browse entry points | 15 min edge |
| `/products` | All products with faceted filters | 30 min edge |
| `/products/:slug` | Product detail page — Overview (default) | 1 hr edge / 5 min browser |
| `/products/:slug/integrations` | Product detail — Integrations tab | 1 hr edge / 5 min browser |
| `/products/:slug/reviews` | Product detail — Reviews tab | 1 hr edge / 5 min browser |
| `/products/:slug/details` | Product detail — Details tab | 1 hr edge / 5 min browser |
| `/vendors/:slug` | Vendor detail page | 1 hr edge / 5 min browser |
| `/products/:contextSlug/integrations/:otherSlug` | **Product-PAIR page** (Stage 1.5 — `STAGE_1_5_SPEC.md` §7) | 1 hr edge |
| `/integrations/:id` | Integration detail page — **superseded: 301 → pair page (Stage 1.5, `STAGE_1_5_SPEC.md` §7.2)** | 1 hr edge |
| `/categories` | All categories (flat taxonomy index) | 5 min edge |
| `/categories/:slug` | Browse by category | 30 min edge |
| `/audiences` | All audiences (flat taxonomy index) | 5 min edge |
| `/audiences/:slug` | Browse by audience | 30 min edge |
| `/phases` | All project phases (flat taxonomy index) | 5 min edge |
| `/phases/:slug` | Browse by project phase | 30 min edge |
| `/search` | Algolia-powered search results | No cache |
| `/about` | About AEC Integrations | 24 hr edge |
| `/contact` | Contact form | No cache |
| `/legal/terms` | Terms of Service | 24 hr edge |
| `/legal/privacy` | Privacy Policy | 24 hr edge |
| `/legal/review-guidelines` | Review Guidelines | 24 hr edge |
| `/legal/listing-accuracy` | Listing Accuracy Policy | 24 hr edge |

> **Removed index pages (AECI-165).** The `/vendors` and `/integrations` index/listing pages were removed after AECI-160 pulled Vendors / Integrations from the primary nav and footer (PO decision), which orphaned the two listings. Both paths now **301-redirect to `/products`** at the SSR Worker. The entity **detail** routes above (`/vendors/:slug`, `/vendors/:slug/{claim,correction}`, `/integrations/:id`) are unaffected — products link to vendors, and integrations are core.

### 3.2 Authenticated routes

| Path | Description |
|---|---|
| `/auth/login` | Magic link or Google OAuth login |
| `/auth/callback` | OAuth/magic link callback handler |
| `/account` | Minimal account page — review history, delete account |
| `/products/:slug/review` | Submit a review (auth required) |

### 3.3 Admin routes (Stage 1 limited)

| Path | Description |
|---|---|
| `/admin/reviews` | Moderate pending reviews |
| `/admin/claims` | View incoming vendor claim requests |
| `/admin/corrections` | View incoming correction requests |

Admin auth is a simple role check on the `profiles` table. No separate admin UI framework — reuse Spartan UI components.

---

## 4. Page Specifications

### 4.1 Home page (`/`) — the unified launch front door

> **This rewrite supersedes the directory-only §4.1** (the prior "hero + stats + browse + recent + trending" spec). It is the contract for **AECI-269** (unify the marketing landing page + app home into one launch front door) and the build children it blocks. The visual treatment, section rhythm, and `/impeccable shape` direction live in `docs/design/unified-home-direction.md` (**AECI-270**), which supersedes the *page contract* of `docs/design/home-direction.md` (AECI-181) while reusing its hero / stats / browse / trust treatments.

At go-live there is no separate marketing page: when the apex flips from the static `apps/landing` to the app (§11.2 / Phase 7.13, AECI-247), the app home **is** the marketing page. The home therefore carries **two jobs as one editorial publication** — the directory/utility job for the ready visitor (search, browse, live data) and the marketing/persuasion job for the cold visitor (why AECi, trust, how it works). The marketing content is **translated into the app's editorial voice + Faire tokens** (`PRODUCT.md` voice; `DESIGN.md` Anchor-Site Rule → Faire), **never pasted** from `apps/landing/public/index.html`, and it **reuses** the existing trust band + stats rather than duplicating them.

**Canonical positioning.** The home's one-liner is **"The independent directory of AEC software integrations. No vendor marketing, no pay-for-placement."** Three live expressions ladder up to it: the hero lede (`home-hero.ts`), the footer tagline (`site-footer.ts`), and the home `<meta>` description (`setHomeMeta`, `core/meta.service.ts`). No launch copy claims integrations are "verified" — nothing is dual-vendor-verified at Stage 1 (§1 out-of-scope; §4.2 verified-badge placeholder), which is why the prior footer "vendor-verified reviews" tagline was reconciled out.

**Canonical section order.** One column of stacked modules in the standard shell (`SiteHeader` above, `SiteFooter` below). The cold-visitor path (why → trust → how) interleaves with the ready-visitor path (search → browse → data) so the page reads as one publication, not two pages stacked:

| # | Section | At launch | Status / data source |
|---|---|:--:|---|
| 1 | **Hero + search** | ✓ | Existing `home-hero.ts`: positioning lede (cold visitor) + the reused `SearchAutocomplete` (ready visitor). |
| 2 | **Credibility strip** | ✓ | **NEW** (AECI-271, `home-credibility-strip.ts`). Coverage counts (products / vendors / integrations) + "independent · no pay-for-placement". Counts come from the cached `GET /api/stats/home` (`total_products` / `total_vendors` / `total_integrations`, added to the daily stats job §10 — never live-aggregated); `total_reviews` and `total_contributing_firms` join once meaningful. The independence line is static. Each metric is suppressed at 0 (no "0 reviews", no "0 contributing firms"); an all-zero cache renders a real empty state. Contributing firms (AECI-284) = distinct count of the free-text `reviews.reviewer_firm` (normalized, approved reviews only); the firm is captured optionally at review submission (§4.7) and GDPR-cleared with `reviewer_id` on account deletion. |
| 3 | **Why AECi (the problem)** | ✓ | **NEW** (AECI-272, `home-why.ts`), static. The broken-landscape narrative + three cited figures (≈19% of Google reviews AI-generated · $27K/yr typical paid visibility on a leading review site · 900+ tools in generic categories). Figures are static cited stats, not live data; each carries a per-figure "Source" link to a citable source (AECI-285 — Originality.AI · Vendr · Capterra; full research in `docs/design/home-why-market-figures.md`). |
| 4 | **What's different / trust** | ✓ | **NEW** (AECI-273, `home-differentiation.ts`), static. Reconciles the shipped three trust commitments (never sell rankings · always be transparent · never review products ourselves) with the landing's "three ideas" (reviewable integrations · separate product + onboarding ratings · no pay-for-placement): leads with the three ideas, folds the operator promise into the closing trust line. The reconciliation is fixed in `unified-home-direction.md`. (Built as a new component rather than reworking `home-trust-pillars.ts` in place, because that band is shared with `/about` and is left as the standalone "three trust commitments" there.) |
| 5 | **How it works** | ✓ | **NEW** (AECI-273, `home-how-it-works.ts`), static, compact. The dual-review + no-pay-for-placement method, framed as the operating model (not a claim of verified inventory): integrations are documented · practitioners review the product and onboarding separately · nothing is for sale. Earns the "reviews" framing the footer used to assert. |
| 6 | **Stats cards** | ✓ | Existing `home-stats-cards.ts`: total integrations (+30d) · most-integrated product · most-active category. `GET /api/stats/home`. |
| 7 | **Browse by category / audience / phase** | ✓ | Category + phase use the existing `browse-grid.ts` (count-chips). The **audience** facet is the dedicated "this is for you" recognition band `home-audience.ts` (**AECI-274**), which **replaces** the audience browse-grid instance (one coherent audience moment, not two): the landing's ten role callouts + a use-case lede, nine linking to `/audiences/:slug` and the non-mapping one (Technology directors) as plain text. Live `GET /api/taxonomy` (`TaxonomyResponse`, `product_count`). |
| 8 | **Recently added + trending** | ✓ | Existing `recent-integrations-section.ts` + `trending-products-section.ts`. `GET /api/stats/home`; proof the directory is alive. Trending falls back to recently-added (AECI-185 empty-state precedent). |
| 9 | **Closing CTA + capture** | ✓ | **NEW.** Email → `POST /api/subscribe`; suggest-a-tool / feedback → `POST /api/feedback` (both already shipped, AECI-257; see `API_CONTRACTS.md`). A **progressively-enhanced client island**: the SSR HTML is the static form, the POST targets the non-cached `/api/*`, so the route stays edge-cache-neutral. |
| 10 | **Footer** | ✓ | Existing `site-footer.ts`. |

**In scope at launch:** all ten sections, **plus the home OG share card** (the SEO child AECI-276 — a real rendered 1200×630 PNG; see §20.4). **Deferred:** the post-launch waitlist welcome-state banner (§11.2). No new design tokens — add to `DESIGN.md` (and `styles.css` + `BRAND_GUIDELINES.md` + §2a.2) in lockstep first if a band needs one.

**Non-negotiables.** Edge-cache-neutral SSR (the capture island is the only client-state surface, and it POSTs to the non-cached `/api/*`; the cacheable HTML stays visitor-state-neutral — §9); i18n `@@` ids on every string; **light theme only** (§2a, AECI-226); the **Faire** anchor (`DESIGN.md` Anchor-Site Rule); editorial voice (`PRODUCT.md` banned-words, sentence case, **no em dashes**); borders not shadows.

**Stats / live-data source:** a daily stats job on the **existing** scheduled API Worker (the AECI-139 cron→queue→consumer; runs in early UTC alongside the Algolia sync at `0 8 * * *` and drift at `0 9 * * *`) recomputes the home aggregates and writes the `stats_cache` table in the app database (D1, ADR 0016). The stats cards, credibility counts, recently-added, and trending modules read this cache via `GET /api/stats/home`, **not** live aggregations; the browse grids read the **live** `GET /api/taxonomy` so they purge on the `taxonomy` `Cache-Tag` independently of the stats pipeline (AECI-184).

### 4.2 Product page (`/products/:slug`)

**Header:**
- Product name + logo (Brandfetch hotlink)
- Vendor name (linked to vendor page)
- Categories, audiences, phases as badges
- Verified badge (placeholder — none verified in Stage 1)
- "Is this your product?" CTA → claim form modal

**Tabs:** Each tab is a separately addressable URL using route segments (see Section 4.2.1 for full URL strategy).

1. **Overview** (`/products/:slug` or `/products/:slug/overview`) — description, website link, key features, supported phases/audiences
2. **Integrations** (`/products/:slug/integrations`) — table of integrations grouped by source/target with mechanism badges
3. **Reviews** (`/products/:slug/reviews`) — individual reviews from review 1, aggregate score shown only at ≥5 reviews
4. **Details** (`/products/:slug/details`) — vendor info, API docs link, marketplace link, founded year, headquarters

**Right rail:**
- "Submit a review" CTA (auth-gated)
- Quick stats: integration count, review count, last updated
- Related products (same category, by integration overlap)

**Below the fold:**
- "Report an error" link → correction request form

### 4.2.1 Tab URL strategy

Product tabs use route segments, not query parameters. Each tab is its own indexable, linkable, server-rendered page.

**Rationale:**
- Direct linkability — sharing a specific tab's URL works
- SEO — each tab is a separate indexable page with its own content and meta tags
- Browser back/forward works intuitively between tabs
- SSR renders the active tab's content directly, no "tab 1 then JS replaces it"

**URL patterns:**

| Route | Tab |
|---|---|
| `/products/:slug` | Overview (default) |
| `/products/:slug/overview` | Overview (explicit, canonical alias of root) |
| `/products/:slug/integrations` | Integrations |
| `/products/:slug/reviews` | Reviews |
| `/products/:slug/details` | Details |

The canonical URL for the Overview tab is `/products/:slug` (no `/overview` suffix). The `/overview` variant 301-redirects to the canonical form to prevent duplicate-content issues.

**Per-tab caching:**

Each tab URL is cached independently at the edge with the same TTL as the main product page (1 hr edge / 5 min browser). Cache invalidation on product updates purges all four tab URLs.

**Per-tab meta tags:**

Each tab gets its own `<title>`, `<meta name="description">`, OpenGraph, and Schema.org JSON-LD. For example, the Reviews tab title includes review count and aggregate rating once available.

**Apply same pattern to vendor pages** if they get tabs in future stages. Currently the vendor page is single-view in Stage 1.

### 4.3 Vendor page (`/vendors/:slug`)

- Vendor header: name, logo, HQ, founded year, website
- Description (from Crunchbase/Wikipedia enrichment)
- Products grid — all products under this vendor with logos
- Aggregate stats: total products, total integrations across portfolio, total reviews
- "Is this your company?" CTA → claim form modal

### 4.4 Integration page (`/integrations/:id`)

> **Superseded by Stage 1.5 (Integration Redesign).** The single-row `source → target` page below is replaced by the context-oriented **product-PAIR page** (`/products/:contextSlug/integrations/:otherSlug`), which consolidates every mechanism between two products and renders the claim data-flow section. `/integrations/:id` 301-redirects to the pair page. See `STAGE_1_5_SPEC.md` §7 (pair page) and §8 (claim rendering). The fields below remain the per-mechanism content the pair page surfaces.

- Source product → Target product header (both linked)
- Mechanism kind badge (native, iPaaS, marketplace-app, api, webhook, partner)
- Mechanism name (e.g. "Zapier connector", "Procore App")
- Direction (one-way / bidirectional)
- Description
- Links: listing URL, docs URL, mechanism URL
- Built by (vendor) and Powered by (product) if applicable
- "Report an error" link

### 4.5 Category/Audience/Phase pages

Same layout pattern for all three:
- Header: name + description
- Filter sidebar: cross-filter by other taxonomies
- Product grid with sort options (alphabetical, most integrations, most reviewed)
- Pagination

### 4.6 Search results (`/search`)

- Algolia InstantSearch widgets:
  - Search box
  - Faceted filters: category, audience, phase, vendor, mechanism (for integrations)
  - Results split into tabs: Products / Vendors / Integrations
  - Sort options per tab
- Empty state: "No results — try a broader search or browse by category"

### 4.7 Review submission (`/products/:slug/review`)

**Flow:**
1. User clicks "Submit a review" on product page
2. If not authenticated, redirect to `/auth/login?return=/products/:slug/review`
3. Magic link or Google OAuth
4. Returned to review form
5. Form fields:
   - Overall rating (1–5 stars, required)
   - Onboarding rating (1–5 stars, required) — split as per the dual-review model
   - Title (required, max 100 chars)
   - Body (required, min 50 / max 2000 chars)
   - Role at company (optional dropdown: practitioner, manager, IT, exec, other)
   - Your firm (optional free text, max 100 chars — AECI-284; powers the home credibility strip's distinct contributing-firms count, never shown on the public review, GDPR-cleared on account deletion)
   - Years using product (optional)
   - Would recommend (yes/no/maybe)
6. Submit → review saved with `status='pending'`
7. Confirmation: "Thanks — your review will appear once moderated (usually within 24 hours)"

**Moderation queue:** admin reviews submission, approves/rejects. No public visibility until approved.

### 4.8 Claim & correction request modals

Both use the same form pattern, with different fields and Linear destinations:

**Claim request:**
- Vendor name (pre-filled)
- Your name
- Your work email
- Your role at the company
- Phone (optional)
- Anything we should know (textarea)

**Correction request:**
- What's wrong? (textarea, required)
- What should it say? (textarea, required)
- Your email (required for follow-up)
- Source for correction (URL or description)

Both submit to a Cloudflare Worker endpoint, which posts to an n8n webhook, which creates a Linear issue with all fields pre-filled.

---

## 5. Data Model

**The complete database schema lives in `DATABASE_SCHEMA.md`** — that document is the source of truth for all tables, columns, indexes, constraints, and the Airtable-to-Supabase migration plan.

Supabase is empty at the start of Stage 1. The production data currently lives in Airtable (base `appy81IdGJY6Fngf9`) as the staging/research layer. Phase 2 of the build (see Section 16) includes:

- Applying the full schema to a fresh Supabase project
- Migrating curator-promoted records from Airtable to Supabase
- Establishing the ongoing promotion pipeline

### 5.1 High-level domain map

The schema is organized into seven domains, all defined in `DATABASE_SCHEMA.md`:

| Domain | Tables |
|---|---|
| Core entities | `vendors`, `products`, `integrations` |
| Taxonomy | `taxonomy_categories`, `taxonomy_audiences`, `taxonomy_phases` |
| Joins | `product_categories`, `product_audiences`, `product_phases`, `product_vendors`, `product_extensions` |
| User and content | `profiles`, `reviews` |
| Operations and workflow | `vendor_requests`, `workflow_instances`, `workflow_transitions`, `audit_log` |
| Analytics and caching | `page_views`, `stats_cache` |
| Future-ready | `translations` |

### 5.2 Migration from Airtable

The Airtable base remains the **curator workspace**. Supabase is the **production read store**. Curators flip `promotion_status` in Airtable to trigger one-way sync to Supabase. Full migration approach is documented in `DATABASE_SCHEMA.md` §13.

### 5.3 RLS policies

Row-level security is enabled on every table. Policy definitions are maintained in **`AUTH_AND_RLS.md`** — the source of truth for the authorization model.

High-level intent:
- Public read on directory tables (products, vendors, integrations, taxonomy) and approved reviews
- Authenticated insert on reviews, with `reviewer_id` matching the auth UID
- Owners can update their own pending reviews
- Admin-only access to moderation tables, audit log, workflow tables, page_views, vendor_requests

### 5.4 GDPR compliance

**Account deletion flow:**
- User triggers delete from `/account`
- All reviews by that user have `reviewer_id` set to `null` (anonymized, content remains)
- `profiles` row deleted
- `auth.users` row deleted via Supabase Auth API
- Confirmation email sent via Resend

This satisfies right-to-erasure while preserving the directory's content integrity.

### 5.5 Taxonomy facets (Categories, Audiences, Phases)

The directory has **three independent taxonomy facets**. Each is a small, closed vocabulary with a stable `slug` (a permanent public URL), a display `name`, and a `display_order`. Tables and DDL: `DATABASE_SCHEMA.md` §5–§6. The vocabularies are **code-managed reference data** — `apps/api/seed/taxonomy.sql`, applied to every environment via idempotent upserts to D1 with `wrangler d1 execute` (ADR `docs/adr/0008-taxonomy-reference-data.md`), **not** Airtable content.

| Facet | Question it answers | Table | Browse route | Examples |
|---|---|---|---|---|
| **Category** | *What does this software do?* | `taxonomy_categories` | `/categories/:slug` | BIM Authoring, Estimating & Takeoff |
| **Audience** | *Who is this for?* | `taxonomy_audiences` | `/audiences/:slug` | Architecture, MEP Engineering, Project Manager, Estimator |
| **Phase** | *Which project-lifecycle stage?* | `taxonomy_phases` | `/phases/:slug` | Design, Pre-Construction, Closeout & Operations |

A product carries any number of terms from each facet (the `product_categories` / `product_audiences` / `product_phases` join tables). The aggregate vocabulary is exposed at `GET /api/taxonomy → { categories, audiences, phases }` and per-term browse pages at `GET /api/{categories|audiences|phases}/:slug`.

**The Audience facet (AECI-121).** Audience answers "who is this for?" and deliberately holds **two kinds of term on one axis**:

- **Domains** — the professional discipline/department a product serves (Architecture, Civil Engineering, MEP Engineering, Construction Management, …). These are the original 21 facet items.
- **Personas** — cross-cutting job roles a domain axis cannot express (Project Manager, Project Engineer, Superintendent, Estimator, Scheduler, Foreman / Field Supervisor, Designer / Drafter, BIM Manager, BIM Coordinator).

A separate "Roles" facet was evaluated and **rejected**: ~55% of the proposed roles duplicated existing domains and others duplicated Categories, so a separate facet would have been a half-populated filter that confuses users and curators. Folding personas into a single "who is this for?" axis keeps one vocabulary to curate and no overlap to police.

**History & compatibility.** This facet was named **Discipline** through Phase 2 and was renamed to **Audience** in AECI-121 (tables `taxonomy_disciplines → taxonomy_audiences`, `product_disciplines → product_audiences`; the promote payload/response key `disciplines → audiences`). The 21 original slugs are unchanged, so existing URLs keep resolving via a permanent **301 redirect `/disciplines/:slug → /audiences/:slug`** (and `/disciplines → /audiences`); the `disciplines` slug namespace stays reserved. The review-app promote contract cuts over atomically — see `docs/REVIEW_APP_PROMOTE_API.md` and the cross-repo handoff in `docs/handoffs/AECI-121-review-app-audience-rename.md`.

---

## 6. API Endpoints

Cloudflare Worker at `apps/api/`, exposed via service binding to the SSR worker. Not publicly accessible.

**Endpoint contracts, request/response shapes, error codes, and validation rules are defined in `API_CONTRACTS.md`.** That document is the source of truth for API behavior. This section gives the high-level inventory; consult `API_CONTRACTS.md` for implementation detail.

**Approach summary** (see `API_CONTRACTS.md` §2 for full rationale):
- Shared TypeScript types in `packages/shared/`
- Zod schemas at API boundaries for runtime validation
- Structured error responses with stable error codes (see `API_CONTRACTS.md` §4)
- No OpenAPI spec — overkill for a single-consumer internal API

### 6.1 Endpoint inventory

**Public read (cacheable):**
- `GET /api/products` — list products with filters
- `GET /api/products/:slug` — product detail
- `GET /api/products/:slug/reviews` — approved reviews for product
- `GET /api/vendors`, `GET /api/vendors/:slug`
- `GET /api/integrations`, `GET /api/integrations/:id` _(Stage 1.5 adds the pair-page + claims read paths — `STAGE_1_5_SPEC.md` §6, §8; shapes in `API_CONTRACTS.md`)_
- `GET /api/taxonomy/categories`, `/audiences`, `/phases`
- `GET /api/stats/home`

**Authenticated write:**
- `POST /api/reviews` — submit a review
- `DELETE /api/account` — delete own account

**Public write:**
- `POST /api/requests/claim`
- `POST /api/requests/correction`
- `POST /api/track/pageview`

**Admin (role-restricted via RLS):**
- `GET /api/admin/reviews` — pending reviews queue
- `PATCH /api/admin/reviews/:id` — approve or reject
- `GET /api/admin/requests` — vendor requests queue

**Webhooks:**
- `POST /api/webhooks/linear` — Linear issue state changes (HMAC-verified)

### 6.2 Internal consumption pattern

The SSR Worker calls these endpoints via Cloudflare service binding:

```typescript
import type { GetProductResponse } from '@aeci/shared/api/products';

const apiResponse = await env.API.fetch(
  new Request('https://api/products/procore')
);
const product: GetProductResponse = await apiResponse.json();
```

Type safety end-to-end via the shared package. No code generation needed.

---

## 7. Search — Algolia

### 7.1 Indexes

Three indexes, each denormalized for zero-join search:

**`products` index** — record shape:
```json
{
  "objectID": "rec...",
  "name": "Procore",
  "slug": "procore",
  "description": "...",
  "vendor_name": "Procore Technologies",
  "vendor_slug": "procore-technologies",
  "categories": ["Project Management", "Document Control"],
  "audiences": ["Construction Management"],
  "phases": ["Construction", "Closeout"],
  "integration_count": 342,
  "review_count": 0,
  "rating_overall_avg": null,
  "has_api_docs": true,
  "logo_url": "https://cdn.brandfetch.io/..."
}
```

**`vendors` index** — record shape:
```json
{
  "objectID": "rec...",
  "company_name": "Procore Technologies",
  "slug": "procore-technologies",
  "description": "...",
  "headquarters": "Carpinteria, CA",
  "founded_year": 2003,
  "product_count": 8,
  "integration_count": 412,
  "logo_url": "https://cdn.brandfetch.io/..."
}
```

**`integrations` index** — record shape:
```json
{
  "objectID": "rec...",
  "source_product_name": "Procore",
  "source_product_slug": "procore",
  "target_product_name": "Autodesk Construction Cloud",
  "target_product_slug": "autodesk-construction-cloud",
  "mechanism_kind": "native",
  "mechanism_name": "Procore App",
  "direction": "bidirectional",
  "description": "..."
}
```

### 7.2 Faceting

- `products`: categories, audiences, phases, vendor_name, has_api_docs, integration_count (range buckets: 0, 1–10, 11–50, 51+)
- `vendors`: headquarters, founded_year (range), product_count (range)
- `integrations`: mechanism_kind, direction, source_product_name, target_product_name

**Multi-select semantics (AECI-223).** The three taxonomy facets (categories, audiences, phases) are **multi-select**: **OR within a dimension, AND across dimensions** — e.g. *(category A OR B) AND (audience X)*. This holds for both faceting surfaces: the Algolia `/search` refinement lists (natively multi-select), and the **API-backed listing sidebar** on `/products` and the taxonomy browse pages (`aec-facet-sidebar`, originally single-select). On the API path each dimension takes a **comma-separated UUID list** in its existing `{kind}_id` param (`category_id` / `audience_id` / `phase_id`), matched as `{ some: { <fk>: { in: ids } } }`; the param names are unchanged so a single id (a detail-page chip link, a browse page's locked `{kind}_id`) is just a one-element list. Disjunctive facet counts still exclude a dimension's *own* selections from its own term counts. The sidebar emits the ids **sorted** so click order never forks the edge cache key or breaks SSR↔client hydration parity — see `docs/CACHE_STRATEGY.md` §4a "Value-level normalization for multi-select facets". (This supersedes the prior single-select behavior documented only in code; the original constraint was that the API took one id per dimension.)

### 7.3 Ranking

Default Algolia ranking (typo, geo, words, filters, proximity, attribute, exact, custom) with custom signals layered on top.

**Stage 1 starting point:**
- `products`: `integration_count` desc, `review_count` desc
- `vendors`: `integration_count` desc, `product_count` desc
- `integrations`: `mechanism_kind` priority (native > marketplace-app > iPaaS > api > webhook > partner)

**Full ranking specification, tuning rules, tie-breakers, and feedback loops are maintained in `SEARCH_RANKING.md`.** Search quality is a continuous concern post-launch — that document captures the evolving model.

### 7.4 Sync strategy

- **Initial bulk import**: a one-off `apps/api` CLI (AECI-138) that reuses the AECI-137 Drizzle/D1 transform (`apps/api/src/lib/algolia-transforms.ts`) to read **promoted** rows from D1 (via `wrangler d1 execute --remote`), transforms to the §7.1 Algolia record shapes, applies the §7.2/§7.3 settings, and batch-uploads via `saveObjects` (upsert by `objectID`). Accepts a `--locale` param (§7.6, default `en-US`) and `--dry-run`.
- **Ongoing sync**: scheduled Cloudflare Worker at 08:00 UTC (= 03:00 EST, our US-East launch base; UTC is DST-unaware so 04:00 EDT in summer) daily reads Supabase changes since last sync, pushes incremental updates to Algolia
- **Real-time sync (deferred)**: Supabase webhook → Worker → Algolia, planned for Stage 2 when vendors edit their data

### 7.5 InstantSearch integration

> **Integrations hidden from `/search` (product decision, 2026-06-11):** `/search` currently surfaces
> only **Products** and **Vendors** tabs. The `{prefix}_integrations` Algolia index is still built and
> maintained by the API sync; the search page simply does not query or display it for now. Re-enable by
> restoring the Integrations tab in `apps/web/src/app/search/search-page.ts` and re-wiring the
> integrations index in `search-controller.ts`. (Header autocomplete already excludes integrations.)
>
> **Stage 1.5 follow-through:** per-pair Algolia records are **deferred to Stage 2** (the integrations
> tab stays hidden); the future `{prefix}_pairs` record shape is recorded in `SEARCH_RANKING.md` §3.4
> as part of the §9 follow-through (AECI-298). The still-built per-integration records and internal links
> must resolve to the pair page — either directly (the `/integrations` + `/search` cards emit the canonical
> pair URL, AECI-298) or through the `/integrations/:id` → pair-page 301 — never a dead route.
> See `STAGE_1_5_SPEC.md` §9.

> **Deviation (AECI-142 / Phase 3.9 — see `docs/adr/0014-instantsearch-js-over-angular-instantsearch.md`):**
> `angular-instantsearch` (below) is **not used**. It caps its peer dep at `@angular/core <16`,
> is deprecated, and is `NgModule`/zone-based — unusable on this Angular 22 zoneless/SSR stack.
> `/search` instead uses **`instantsearch.js` + connectors**, rendered with Angular templates and
> mapped into **signals** (Algolia's recommended modern-Angular path), SSR-safe via a dynamic
> `import()` run only in `afterNextRender`. The `ais-*` widget vocabulary below is therefore
> illustrative, not literal; the per-tab sort dropdown is deferred (needs Algolia replicas). All
> other §4.6/§7.5 acceptance criteria (browser-side search-only key, facets, entity tabs, branded
> hit cards, empty state, noindex, non-cacheable, axe-AA) are met. ADR 0014 has the
> full rationale.

- Use `angular-instantsearch` v4+
- Standard widgets: `ais-instant-search`, `ais-search-box`, `ais-hits`, `ais-refinement-list`, `ais-range-input`, `ais-pagination`, `ais-stats`
- Custom hit components per index for branded result cards
- Search-as-you-type with debounce on home page autocomplete
- Full search experience on `/search` route with all facets

### 7.6 Per-locale indexes (multi-language readiness)

At launch, single index per entity type. When additional locales are added, parallel indexes are created (`products_es`, `products_fr`, etc.) and InstantSearch config selects based on active locale. Initial bulk sync script accepts a `locale` parameter to enable this without rewrites.

---

## 7a. Multi-Language Readiness (i18n)

The site launches in `en-US` only, but every layer is built to support additional locales without rework.

### 7a.1 UI strings

- `@angular/localize` configured from day one
- Every user-facing string wrapped in `i18n` attributes or `$localize` tagged templates
- Zero hardcoded English in templates
- Translation files extracted via `ng extract-i18n` to XLIFF or JSON
- New locales added by dropping a translated file into the build pipeline — no code changes

### 7a.2 Database content

- `translations` table (defined in Section 5.1) stores translated content per entity, locale, and field
- Empty at launch; schema is in place
- Read pattern: fetch entity by ID, then `SELECT field, value FROM translations WHERE entity_type=? AND entity_id=? AND locale=?` with **per-field fallback** to the canonical `en-US` value on the entity row — a missing row in `translations` for a given field falls back to canonical, *not* to a blank
- All entities that store user-facing strings have implicit `en-US` content in their primary columns
- The merge runs in two places in production-shaped flow: once on the Worker side (list/aggregate responses) and once in SSR (individual entity render). Both implementations must apply the same per-field fallback rule. The merge pattern is validated in the frozen probe `spikes/stack-test/src/server.ts:119-136` and `spikes/stack-test/src/app/data.service.server.ts:33-50` (no live equivalent yet — translations are en-US-only at launch); the probe uses Cloudflare KV as the overlay store, **Stage 1 production reads from the `translations` table in D1 (via Drizzle) — KV is not the production substrate for translations**

### 7a.3 URL strategy

- Default locale (`en-US`): no prefix — `aecintegrations.com/products/procore`
- Additional locales: subdirectory prefix — `aecintegrations.com/es/products/procore`
- Angular routing configured to support locale prefix from day one
- `hreflang` tags auto-generated in `<head>` once multiple locales exist
- Sitemap includes localized URLs per page

**URL prefix is the cache key for locale.** The edge cache segments naturally by URL prefix (`/products/...` for `en-US`, `/es/products/...` for `es-ES`). `Vary: Accept-Language` is permitted on cached responses (it advertises the dimension to well-behaved proxies; Cloudflare's edge cache key isn't affected since the URL prefix already segments the cache). Any other `Vary` value (`Cookie`, `User-Agent`, etc.) is still forbidden — those fragment the edge cache without a corresponding tag advantage. See `docs/CACHE_STRATEGY.md` §7 for the full SEO header set. Validated in the frozen probe `spikes/stack-test` scenarios T8–T9.

### 7a.3a Build artifact for multi-locale

Angular's per-locale build emits a single `server.mjs` Worker entry that dispatches by URL prefix at request time. The `i18n.locales` block in `angular.json` plus `"localize": true` on the build option is the entire configuration — no per-locale deploy, no separate Worker. The SSR Worker's `LOCALES` constant (see `apps/web/src/server-runtime.ts:77-98` — `LOCALES` + `stripLocalePrefix`) must stay in sync with `angular.json` `i18n.locales`; adding a locale requires updating both.

### 7a.4 Formatting

- Use Angular's built-in `DatePipe`, `DecimalPipe`, `CurrencyPipe` with locale parameters
- Never hardcode date formats, number separators, or currency symbols
- Locale-aware sort order on listing pages

### 7a.5 Reviews

- `reviews.locale` field captures the language the review was written in
- Reviews display in their original language with a "Show in {user locale}" button (deferred to Stage 3+ using Cloud Translation API)
- No auto-translation at launch — preserves authenticity

### 7a.6 Analytics and search

- Every PostHog event and Datadog log includes a `locale` dimension
- Algolia per-locale indexes (Section 7.6)

---

## 8. Authentication

### 8.1 Flow

1. User clicks "Submit a review" on a product page (or any auth-gated CTA)
2. If not authenticated, redirect to `/auth/login?return=<original-path>`
3. Login page offers two options:
   - **Magic link**: enter email → Supabase sends link → user clicks → returns to `/auth/callback?return=<path>`
   - **Google OAuth**: standard Supabase OAuth flow
4. On successful auth:
   - Check if `profiles` row exists; if not, create one with `role='reviewer'`
   - Redirect to original return path
5. Session token stored in HTTP-only cookie (Supabase default)

### 8.2 Admin role

- Set `profiles.role = 'admin'` manually in Supabase dashboard for Chris and Bill
- Admin routes check `profiles.role === 'admin'` via Supabase RLS or middleware
- No admin UI for granting admin in Stage 1 — manual SQL only

### 8.3 Stage 2 readiness

Schema already supports `vendor_admin` role and `vendor_id` foreign key. Stage 2 vendor portal layers on top without migration.

---

## 9. Caching Strategy

### 9.1 SSR output caching at Cloudflare edge

Implemented in the SSR Worker. Two non-obvious rules apply (see §9.1a and §9.1b below):

```typescript
async function handleRequest(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);

  // Skip cache for authenticated, user-specific, or write routes
  if (isUserSpecific(url) || isWriteRequest(request)) {
    return renderAngular(request, env);
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  let response = await cache.match(cacheKey);

  if (!response) {
    // Strip visitor-state cookies (theme, etc.) before SSR — see §9.1a
    const sanitized = stripVisitorStateCookies(request);
    response = await renderAngular(sanitized, env);
    response.headers.set('Cache-Control', cacheControlForRoute(url));
    // Only cache 2xx — see §9.1b
    if (response.status >= 200 && response.status < 300) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
  }

  return response;
}
```

Reference implementation: `apps/web/src/server-runtime.ts` — `stripVisitorStateCookies` (131-153), route classification (`cacheControlForRoute` + `ROUTE_CACHE_PATTERNS`, 187-245), and the cache-write pipeline (`withCacheHeaders` 300-328, `handleSsr` 406-504).

### 9.1a Cached SSR routes must render visitor-state-neutral HTML

Edge cache is keyed by URL. If SSR reads a per-visitor request cookie and bakes it into the rendered HTML (e.g., `<html data-theme="…">`), the first visitor primes the cache for everyone — their personalized render is served to every subsequent visitor.

**Rule:** for any cacheable route, the Worker must strip visitor-state cookies before forwarding the request to the Angular SSR handler; the client reconciles any such state post-hydration and repaints. Server-rendered HTML is neutral by design. The strip list (`VISITOR_STATE_COOKIES`) is **empty as of AECI-226** — `theme`, its original and only entry, was removed with the dark theme — but the mechanism is retained as general cache-pollution infrastructure for future visitor-state cookies.

This is not solvable with `Vary: Cookie` — see §7a.3 (and §9.3 below).

### 9.1b "Pinned 404" trap

If a Worker returns HTTP 200 with a "not found" body and a normal TTL for a missing entity, the edge caches that body for the full TTL. When the entity is subsequently created, visitors continue to see the stale "not found" page until TTL expiry or manual purge.

**Rule:** 404 / not-found responses must return **HTTP 404** with a short TTL (≤60s), not 200. The TTL is short enough that newly-created entities become visible quickly without a purge call; the status code allows downstream tooling (sitemaps, monitoring) to distinguish real misses.

The stack-test probe returned 200 for KV-miss with a 5-minute TTL — a gap it documented at `spikes/stack-test/README.md:215-217`. `apps/web/` closes it: 404s carry HTTP 404 and a ≤60s edge TTL via `NOT_FOUND_TTL` (`apps/web/src/server-runtime.ts:169`, §9.1b).

### 9.2 TTLs

**Superseded.** See `docs/CACHE_STRATEGY.md` §4 for current TTLs per route class. The Phase 2 Spec tightened these values (detail pages dropped from 1 hr to 15 min edge; browser `max-age` went to 0 across the board). The entries previously in this section are historical.

### 9.3 Cache invalidation

**Superseded by `docs/CACHE_STRATEGY.md`.** From Phase 2 onward, invalidation is tag-based: Cloudflare made `Cache-Tag` and purge-by-tag available on all plans in April 2025, so AECi sets a `Cache-Tag` header on every cacheable SSR response and invalidates via a single `POST /admin/purge` endpoint. The URL-invalidation map and `invalidateForEntity()` helper previously described in this section are no longer the strategy.

For tag vocabulary, TTLs, composition rules, the purge endpoint shape, and the SEO header set (which now permits `Vary: Accept-Language` because URL-prefix locale dispatch already segments the cache), see `docs/CACHE_STRATEGY.md`. The implementation lands in [AECI-56](https://linear.app/aec-integrations/issue/AECI-56) (Phase 2.10). The visitor-state-neutral rule (§9.1a) and the pinned-404 trap (§9.1b) above remain authoritative.

**Cloudflare API token scoping:**

The Cloudflare API token used by the purge endpoint must be scoped to **`Zone.Cache Purge` on `aecintegrations.com` only** — the narrowest possible scope. `CLOUDFLARE_ZONE_ID` identifies the target zone. Reviewers should reject any change that broadens this token scope under deadline pressure; rotate by issuing a new token with the same minimal scope. Validated pattern: the live purge handler `apps/web/src/server/routes/admin-purge.ts:15-18` (`CF_PURGE_API_TOKEN` scoped to `Zone.Cache Purge`; `CF_ZONE_ID` identifies the zone).

### 9.4 API response caching

Worker API responses use `Cache-Control` and Cloudflare KV for hot paths. Data access lives in the private API Worker, which reads Cloudflare D1 via Drizzle over its `DB` binding (ADR 0016); the SSR Worker reaches it over the `env.API` service binding (its same-origin `/api/*` passthrough is the sanctioned browser read path).

---

## 10. Stats Pipeline

A daily stats job on the **existing** scheduled API Worker (`apps/api/src/scheduled.ts` — the AECI-139 cron→queue→consumer, ADR 0013), added as a **third cron trigger** (recommended `0 7 * * *` UTC) alongside the Algolia incremental sync (`0 8 * * *`) and drift reconciliation (`0 9 * * *`). It is **not** a separate Worker, and supersedes the stale "02:00 UTC". The `stats_cache` and `page_views` tables already exist (baseline migration `20260515024116`); Phase 4 wires reads/writes, not new tables.

**Computes and writes to `stats_cache`:**
- `home.total_integrations` — count from integrations table
- `home.integrations_added_30d` — count where `created_at >= now() - 30 days`
- `home.total_products` — count from products table (credibility strip, AECI-271)
- `home.total_vendors` — count from vendors table (credibility strip, AECI-271)
- `home.total_reviews` — count of **approved** reviews (credibility strip, AECI-271)
- `home.total_contributing_firms` — distinct count of `reviewer_firm` (normalized `lower(trim(...))`, non-blank) among **approved** reviews (credibility strip, AECI-284)
- `home.most_integrated_product` — product with highest integration count
- `home.most_active_category` — category with highest aggregate integration count
- `home.recent_integrations` — last 10 integrations with linked product names
- `home.trending_products` — top 5 by page_views in last 7 days (joined with PostHog if available, else page_views table)
- `home.recently_added_products` — last 10 products with `created_at` in last 30 days
- `category_counts` — product count per category
- `audience_counts` — product count per audience
- `phase_counts` — product count per phase

**Phase 4 reconciliation (2026-06-10):**
- `category_counts` / `audience_counts` / `phase_counts` are **optional/deferred** — the live taxonomy endpoints (`GET /api/taxonomy`, `/api/categories`, …) already return `product_count`, so the home "browse by" grids read those directly rather than this cache.
- `home.trending_products` is computed from the `page_views` table **only** in Stage 1 (PostHog is not wired until Phase 7). The **client** `POST /api/page-views` capture is the canonical per-view signal; the SSR server-side write undercounts because edge-cache hits bypass the SSR Worker (§9.1, §14.2).

Page reads from `stats_cache` via API endpoint `/api/stats/home`. No live aggregation on page load.

---

## 11. Email & Communication

### 11.1 Transactional email (Resend)

> **Provider: Resend, not Loops (AECI-240 / Phase 7.5).** This section originally
> specced Loops; the build standardized on **Resend** for transactional email
> (mailboxes are Microsoft 365). The wiring, the template catalogue, the secret/env
> setup, and the Supabase→Resend SMTP step for magic links live in `docs/email.md`.

Transactional emails sent via Resend (`apps/api/src/lib/email.ts`, fire-and-forget
via `ctx.waitUntil`, fail-open):
- Review submission confirmation: "Thanks — your review is in moderation"
- Review approved: "Your review of {product} is now live"
- Review rejected: "Your review needs revision — {reason}"
- Account deletion confirmation
- Request-pipeline-failure admin alert (the §6.2 stuck-request email)
- Magic link emails (via Supabase Auth — Resend is the SMTP sender; dashboard config)

### 11.2 Waitlist transition

Pre-launch, the static coming-soon landing page (`apps/landing`) captures emails; post the AECI-257 cut-over these persist to the D1 `mailing_list` table via `POST /api/subscribe` (the legacy Supabase `marketing.waitlist` table is retired). At launch the unified home's closing CTA (§4.1, section 9) carries the same capture forward, so signup survives the apex flip.

**On launch:**
- One-time Resend broadcast sends to entire waitlist: "We're live — explore the directory"
- Landing page DNS flips to the new Angular SSR app

**Welcome state for waitlist subscribers:**
- Email includes a unique link with `?ref=waitlist&token=xyz`
- Landing on the site with this token shows a small welcome banner: "Thanks for waiting — here's the directory."
- Token logged to `page_views` for attribution; banner dismisses after first visit

---

## 12. Issue Tracking — Linear via n8n

> **Superseded for Phase 6 (2026-06-10) — see `docs/STAGE_1_PHASE_6_SPEC.md` §4.** n8n is **dropped**: the form→Linear handler is a **Cloudflare Worker** (Phase 2 Spec §18.1), not an n8n workflow, and AECI-18 (n8n setup) is abandoned for this path. The bidirectional-sync and Linear-board structure below still apply; only the n8n mechanism is replaced by the Worker. There is **no Slack** — Linear's native email notifications + an admin-email-on-failure replace it.

**Workflow:**
1. User submits claim or correction request on the site
2. POST to `/api/requests/claim` or `/api/requests/correction`
3. Worker:
   - Inserts row into `vendor_requests` table
   - Sends webhook to n8n
4. n8n workflow:
   - Calls Linear GraphQL API via n8n's native Linear node (typed actions for Create Issue, Update Issue, Add Comment)
   - Creates Linear issue with appropriate template (Claim or Correction)
   - Populates fields from form payload
   - Assigns to Chris/Bill round-robin
   - Posts back to Worker with Linear issue ID
5. Worker updates `vendor_requests.linear_issue_id`

**Linear board structure:**
- Project: "Vendor Requests" within the AECi team
- States: Linear default states (Backlog, Todo, In Progress, In Review, Done, Cancelled). Vendor Requests doesn't have its own state set — workflow nuances expressed via labels instead.
- Labels: `claim` (request type), `correction` (request type), `domain-check-pending` (workflow stage marker)
- Workflow expressed as: Backlog (newly submitted) → In Progress (under review or domain check) → Done (resolved) or Cancelled (rejected)

**Bidirectional sync (audit trail):**

Linear issue state changes (status, comments, assignees) post webhooks back to a Worker endpoint at `/api/webhooks/linear`. The Worker writes corresponding entries to `workflow_transitions` (see Section 26) so the audit trail captures the full workflow lifecycle in Supabase regardless of where the action originated.

---

## 13. Legal Pages

Markdown source files in `apps/web/src/content/legal/`, rendered as static SSR pages.

**Required at launch:**

1. **Terms of Service** — what the site is, listing basis (public information), reservation of rights to correct or remove, review opinions disclaimer, dispute process
2. **Privacy Policy** — GDPR-compliant, what data is collected (emails, reviews, page views), retention, deletion process, lawful basis
3. **Review Guidelines** — what makes a valid review, prohibited content (fake, defamatory, naming individuals), moderation process
4. **Listing Accuracy Policy** — data sourced from public information, correction process, explicit statement that listings are not removed on vendor request (only correct factual errors or remove defunct companies)

Initial drafts produced from templates and reviewed by counsel before launch.

**Document lifecycle, versioning, and change workflow:** see Section 27.

---

## 14. Analytics & Monitoring

Three layers, each with a specific job. They overlap intentionally where redundancy is useful (audit data also flows to Datadog) but otherwise serve distinct purposes.

### 14.1 PostHog (client-side product analytics)

Tracks what authenticated and anonymous users do on the site from the browser. Best at funnels, cohorts, feature adoption, retention.

Client-side initialization in Angular app:
- Pageview tracking automatic
- Custom events:
  - `search_performed` — query, results count, filters applied
  - `product_viewed` — product_id, source (search / browse / direct)
  - `integration_viewed` — integration_id
  - `review_submitted` — product_id
  - `claim_requested` — vendor_id
  - `correction_requested` — product_id or vendor_id
  - `external_link_clicked` — destination, source
- All events include `locale` and `theme` dimensions

**PostHog gap:** does not see Cloudflare-specific data (CF country, colocation, bot score) or server-only context. The `page_views` table fills this gap (Section 14.2).

### 14.2 Server-side page_views (Supabase)

A lean server-side log captured by the SSR Worker on every cacheable page request. Stores dimensions PostHog cannot see directly. Schema is defined in Section 5.1 — includes `cf_country`, `cf_colo`, `cf_asn`, `cf_bot_score`, hashed user agent, locale, theme, and denormalized profile role.

**Use cases:**
- Ad-hoc SQL queries combining client behavior with server context (e.g. "page views per country", "reviewer activity by Cloudflare colocation")
- Cross-join with `profiles` for queries by user role (excluding personal info) without re-deriving from PostHog
- Bot detection and abuse pattern analysis
- Capacity planning by edge colocation

**Privacy:**
- No raw IPs stored (Cloudflare's CF-Connecting-IP is not persisted)
- User agents are hashed, not stored raw
- No personal info (email, name) in page_views directly — only the foreign key to `profiles`, which can be joined when needed and anonymized on user deletion

**Write path:**
- SSR Worker writes page_views row asynchronously via `ctx.waitUntil()` — never blocks the response
- Failures don't affect the user (logged to Datadog)
- Bot Score < 30 (likely automated) entries can be sampled rather than fully captured to control table growth — decision deferred until launch traffic patterns are visible
- **Two capture paths, one table (Phase 4 reconciliation, 2026-06-10).** The **client** `POST /api/page-views` (fired post-hydration on every view — including edge-cache hits and client-side navigations) is the **canonical per-view signal**, and the source for `home.trending_products`. The SSR Worker's server-side `waitUntil()` write only runs on cache **misses** (edge-cache hits bypass the Worker, §9.1), so it **undercounts** and is treated as supplementary CF/bot-context enrichment, not the counter.

### 14.3 Datadog (performance, errors, logs, audit)

Single platform for performance, error tracking, logs, and audit log forwarding. Unified observability.

**Frontend (Datadog Browser RUM SDK):**
- Initialized in Angular app root
- Captures page load performance, user sessions, frontend errors, Core Web Vitals
- Configured to redact sensitive data (emails, tokens) from session replays

**Backend (Datadog Worker SDK in both SSR Worker and API Worker):**
- APM traces across the full request lifecycle
- Distributed tracing: SSR Worker → API Worker → Supabase → Algolia → Resend
- Logs structured as JSON with trace correlation IDs
- Error tracking with grouping and alerting

**Audit log forwarding (Section 26.5):**
- All `audit_log` and `workflow_transitions` writes also emit Datadog log events
- Tagged with `ddsource: audit_log` for filtering
- Enables alerting on patterns (e.g. >5 rejected reviews from one user in an hour)

**Dashboards:**
- Requests per minute, error rate, p50/p95/p99 latency
- Cache hit rate at the edge
- Algolia query latency and error rate
- Supabase query latency per endpoint
- Active users (RUM)
- Audit event volume by action type

**Alerts to Slack:**
- First occurrence of new error class
- Error rate > 1% over 5 minutes
- p95 latency > 2s over 5 minutes
- Cache hit rate < 60% over 15 minutes (signals invalidation problem)
- Audit anomalies (configurable thresholds)

### 14.4 Cloudflare Workers Analytics

- Built-in observability for request volume, latency, errors at the platform level
- No additional configuration needed
- Complements Datadog rather than duplicates — Cloudflare sees what hits the edge; Datadog sees what happens inside the Worker

### 14.5 How the three layers fit together

Each tool has a job. Use the right tool for each question.

| Question | Tool |
|---|---|
| "Are users succeeding at submitting reviews?" | PostHog (funnels) |
| "Is the site working fast and without errors?" | Datadog (RUM + APM) |
| "How many page views per country last week?" | page_views (SQL) |
| "Which colocation served the most traffic?" | page_views (SQL) |
| "What was the audit history of this product?" | audit_log (SQL) or Datadog (logs) |
| "Is there a suspicious pattern of rejected reviews?" | Datadog (alerts on forwarded audit logs) |
| "What is our cache hit rate by route?" | Datadog |
| "Which products are being viewed by users with admin role?" | page_views joined with profiles (SQL) |

Don't try to make any one tool answer all questions.

---

## 15. Security

### 15.1 Cloudflare WAF

Existing WAF rules in place (per current setup). Stage 1 additions:
- Rate limit on `/api/requests/*` endpoints: 5 submissions per IP per hour
- Rate limit on `/api/reviews` POST: 3 per authenticated user per hour
- Rate limit on `/api/auth/login` magic link requests: 5 per email per hour
- Block known scraper user agents from `/products/*` and `/vendors/*`

> **Implementation (AECI-242, Phase 7.7).** These rules are live on the
> `aecintegrations.com` zone (applied via the CF Rulesets API) — see the operator
> runbook [`waf-rate-limits.md`](./waf-rate-limits.md) for the exact expressions,
> thresholds, deployed rule IDs, and verification. Several spec targets cannot be honored literally on
> our **Pro** plan and are handled differently (recorded here rather than silently
> reworked):
> - **The counting window caps at 1 minute on Pro** (10 s or 1 min — not 1 hour),
>   so *both* WAF rate-limit rules are **per-minute burst caps**, not the spec's
>   hourly caps: `/api/requests/*` and `/api/reviews` are each **5 per IP per
>   minute**. A true hourly cap would need in-Worker KV/Durable-Object state (kept
>   out of scope). The burst caps stop scripted floods; slow-drip abuse across an
>   hour is bounded instead by the app-layer controls below.
> - **`/api/reviews` "3 per authenticated user"** is additionally only a **per-IP**
>   approximation — Pro WAF counts by client IP only (per-user counting is an
>   Enterprise feature). The real per-user controls are the existing auth gate,
>   one-review-per-product-per-user dedup, toxicity scoring, and moderation queue.
> - **magic-link "5 per email / hour"** → lives in **Supabase Auth → Rate Limits**,
>   not Cloudflare: the magic-link request goes browser→Supabase directly and never
>   transits our zone, so no WAF rule can see it. (Owner-managed; out of AECI-242
>   scope.)
>
> The acceptance criteria's "configured as code (Terraform / CF API)" clause was
> intentionally relaxed for launch (dashboard + runbook instead). Datadog visibility
> of WAF events shipped in AECI-262 — the API Worker's hourly cron polls the zone's
> `firewallEventsAdaptiveGroups` over the GraphQL Analytics API and emits
> `aeci.waf.ratelimit.blocked` (the free Pro-plan alternative to Enterprise Logpush);
> CF Security Events remains the per-IP triage surface. See `waf-rate-limits.md` §5
> and `OBSERVABILITY.md`. `/api/page-views` (high-volume beacon) and
> `/api/webhooks/linear` (HMAC-verified, single source) are deliberately excluded —
> see the runbook.

### 15.2 API privacy

API Worker remains private via Cloudflare service binding (per existing architecture): it has no public ingress on its own hostname. The SSR Worker is the only public ingress — and it re-proxies `/api/*` same-origin to the API Worker (the path hydrated browser code and the `/api/health` / `/api/version` checks use; ADR 0001 §Consequences). Read GETs are public through that passthrough by construction; write routes (`/api/promote`, `/admin/purge`, …) carry per-endpoint auth.

### 15.3 Supabase RLS

All tables have RLS enabled. Policies enforce:
- Public read on `products`, `vendors`, `integrations`, taxonomy tables, approved reviews
- Authenticated insert on `reviews`
- Owner update on own pending reviews
- Admin override on moderation tables

---

## 16. Build Order

Phased to deliver working software at each step. Each phase ends with a deployable state.

### Phase 1: Foundation (Week 1–2)
- [ ] Linear workspace and projects configured per Section 24.1
- [ ] Linear ↔ GitHub integration enabled and validated (branch linking, PR auto-close)
- [ ] n8n configured with native Linear node and API token
- [ ] Figma Design System file created with theme tokens from Section 2a.2
- [ ] Brand guidelines DOCX documents dark-mode accent variants (kept as Stage 2 brand assets; not shipped in Stage 1 — AECI-226)
- [ ] Angular 21+ SSR project scaffolded in `apps/web/`, **zoneless** (`provideZonelessChangeDetection()`, no `zone.js`)
- [ ] Hydration providers wired: `provideClientHydration(withHttpTransferCacheOptions({ includePostRequests: false }))` — v22 incremental hydration is the default and auto-enables event replay (no explicit `withEventReplay()`; AECI-130) — mirror `apps/web/src/app/app.config.ts`
- [ ] `@angular/localize` configured with `en-US` as default locale; `angular.json` `i18n.locales` block ready for `es-ES` and others (URL-prefix dispatch, no `Vary` headers — §7a.3)
- [ ] Tailwind **v4** (`@tailwindcss/postcss`) config bound to the light-theme CSS custom property tokens (Stage 1 is light-only — AECI-226; dark tokens return at Stage 2); `@spartan-ng/brain/hlm-tailwind-preset.css` imported
- [ ] Light-only presentation — no theme switcher or system-preference detection in Stage 1 (AECI-226). The dark theme + toggle return with the Stage 2 vendor portal; the semantic tokens make that a token-block + toggle re-introduction
- [ ] Spartan **brain** primitives + Angular CDK installed (no `helm` codegen)
- [ ] Cloudflare Workers deployment pipeline (`wrangler.jsonc`, GitHub Actions) — SSR Worker has `compatibility_flags: ["nodejs_compat"]`
- [ ] SSR Worker entry implements cookie-stripping middleware for cacheable routes (§9.1a) and URL-prefix locale dispatch (§7a.3a); mirror `apps/web/src/server-runtime.ts`
- [ ] Cloudflare D1 access via Drizzle in `apps/api/` using the per-request `getDb(env)` client over the native `DB` binding (`apps/api/src/db/client.ts`; no Prisma, no Accelerate, no `DATABASE_URL`/`DIRECT_URL` — ADR 0016). See `DATABASE_SCHEMA.md` §1a.
- [ ] App-table authorization is **app-layer only** — D1 has no PostgREST/GRANT/RLS; the Worker request guard (`apps/api/src/lib/authz.ts`) is the only authorization layer, gated by the no-leakage authz-matrix specs (see `AUTH_AND_RLS.md` Layer 1)
- [ ] Service binding between SSR Worker and API Worker
- [ ] Datadog Browser RUM and Worker SDK installed and reporting
- [ ] Basic layout shell: header, footer, navigation (all strings i18n-wrapped)
- [ ] Validate SSR + cache plumbing with a "Hello World" page (mirror the frozen probe `spikes/stack-test`)
- [ ] Test infrastructure scaffolded per `TESTING_STRATEGY.md`: Vitest unit harness, Playwright e2e against `wrangler dev`, axe-core hook, Lighthouse CI, and a bash integration runner modeled on `apps/web/scripts/run-extra-tests.sh` for cache/cookie/`Vary` regressions
- [ ] Run first Claude Code task end-to-end against a Linear issue to calibrate the workflow

### Phase 2: Core data display (Week 3–4)
- [ ] Data model additions (profiles, reviews, stats_cache, page_views with CF enrichment, vendor_requests, translations, audit_log, workflow_instances, workflow_transitions)
- [ ] `appendAuditLog()` helper with Datadog forwarding (Section 26.5)
- [ ] Slug generation for products and vendors (backfill existing, append vendor name on collision)
- [ ] Pre-launch slug collision audit and resolution
- [ ] Product detail page with tab routing (`/products/:slug`, `/products/:slug/integrations`, `/products/:slug/reviews`, `/products/:slug/details`)
- [ ] Per-tab meta tags and Schema.org JSON-LD
- [ ] Vendor detail page
- [ ] Integration detail page
- [ ] Category/audience/phase browse pages
- [ ] Edge caching configured with per-route TTLs (see `docs/CACHE_STRATEGY.md` §4)
- [ ] `Cache-Tag` write helper + `POST /admin/purge` endpoint implemented (see `docs/CACHE_STRATEGY.md` §3, §5; lands in AECI-56)
- [ ] Single write-event pipeline scaffolded (Section 20.5)
- [ ] ~~SSR Worker writes server-side page_views rows with CF header enrichment~~ — **relocated to Phase 4.** Phase 2 shipped only the no-op `POST /api/page-views` endpoint (AECI-55); the `page_views` table exists (baseline migration) but the write wiring + CF enrichment is Phase 4 (see API_CONTRACTS §6.9 and Phase 4 below).

### Phase 3: Search & discovery (Week 5)
- [ ] Algolia indexes created and populated via bulk sync script
- [ ] Daily incremental sync Worker
- [ ] Search page with InstantSearch
- [ ] Home page search autocomplete
- [ ] Faceted filters on listing pages

### Phase 4: Home page & stats (Week 6)

Decomposed into AECI Phase 4.1–4.12 (planned 2026-06-10). The `stats_cache` and `page_views` tables and the scheduled Worker already exist (Phases 2–3); Phase 4 is wiring + UI, not new infra.

- [ ] Shared `HomeStatsResponse` types + Zod (`packages/shared`)
- [ ] Wire `page_views` writes + CF enrichment (client `POST /api/page-views` insert is canonical; SSR write supplementary — §14.2)
- [ ] Daily stats computation job → `stats_cache` (third cron on the existing scheduled Worker; §10)
- [ ] `GET /api/stats/home` endpoint (reads `stats_cache`, never live-aggregates)
- [ ] Stats pipeline + page_views observability (job health + `stats_cache` freshness alert)
- [ ] Home page design pass (Impeccable shape + Mobbin anchor)
- [ ] Home hero + search autocomplete mount (reuses the AECI-144 widget)
- [ ] Three stats cards incl. "+X in the last 30 days" subtitle
- [ ] "Browse by" category / audience / phase grids (live taxonomy endpoints)
- [ ] Recently-added integrations + Trending products sections (graceful empty states)
- [ ] Home page assembly: SSR route/resolver, cache tags, home `WebSite`/`Organization` JSON-LD
  - _Re-opened by **AECI-269** (unify marketing + directory home): §4.1 was rewritten (AECI-270) and the marketing bands — credibility, why, how-it-works, closing CTA + capture — ship as AECI-269 build children. See §4.1 + `docs/design/unified-home-direction.md`._
- [ ] Phase 4 completion checkpoint

### Phase 5: Auth & reviews (Week 7)

Governed by `docs/STAGE_1_PHASE_5_SPEC.md` (decomposed into AECI Phase 5.1–5.16, planned 2026-06-10). The data layer already exists (profiles, reviews + all moderation columns, RLS, workflow tables, audit log, `handle_new_user`, `is_admin()`/`is_active_user()`) — Phase 5 is app code, ~zero migrations. **Moderation boundary:** Phase 5 ships *functional* review moderation (queue, approve/reject, toxicity-flag, ban enforcement on submit); the workflow-FSM, Slack alerts, Linear sync, and ban-management UI move to **Phase 6** (Phase-5 spec §3.2).

- [ ] Supabase Auth (magic link + Google OAuth): `/auth/login`, `/auth/callback`, SSR session read, sign-out
- [ ] API Worker authz middleware (JWT verify + role/ban; `AUTH_AND_RLS.md` §4)
- [ ] `POST /api/reviews` (dedup, banned rejection, locale) + Claude toxicity flagging
- [ ] `GET /api/products/:slug/reviews` (public, approved-only) + ProductDetail summary + ≥5 threshold
- [ ] Review submission form `/products/:slug/review` (Signal Forms + Angular Aria — satisfies AECI-133)
- [ ] Reviews display + "Be the first to review" empty state + cache-neutral personalized CTA
- [ ] `/account` + `DELETE /api/account` (GDPR anonymization; Resend email deferred to Phase 7.5 / AECI-240)
- [ ] Admin moderation: `/admin` guard, `GET`/`PATCH /api/admin/reviews`, `/admin/reviews` queue UI
- [ ] Auth/reviews observability + Phase 5 completion checkpoint

### Phase 6: Requests & moderation (Week 8)

Governed by `docs/STAGE_1_PHASE_6_SPEC.md` (decomposed into AECI Phase 6.1–6.13, planned 2026-06-10). Forms already shipped (AECI-128); tables + contracts exist → **zero migrations**. **Decisions:** n8n dropped (form→Linear is a Cloudflare Worker — §12 / Phase 2 §18.1; AECI-18 superseded); **no Slack** (Linear "Vendor Requests" issues + native email + admin-email on pipeline failure); **lean workflow tracking** (status columns + append-only `workflow_transitions`, not a guarded FSM — relaxes §26.3); domain-match is an informational hint only (no auto-approval).

- [ ] Lean workflow tracking (`workflow_instances` + `workflow_transitions` audit; §26.2)
- [ ] Linear issue creation on request submit (CF Worker, idempotent, `waitUntil`) + failure handling
- [ ] `POST /api/webhooks/linear` (HMAC → transitions) + site→Linear sync on admin action
- [ ] Reconciliation sweep (cron) for stuck requests + admin-email backstop
- [ ] domain-match + duplicate flags on submit (informational; no auto-approval)
- [ ] `GET /api/admin/requests` + resolve/reject actions + `/admin/requests` UI
- [ ] Reviewer ban management (admin sets `banned_at`; enforcement-on-submit is Phase 5)
- [ ] Phase 6 observability + completion checkpoint

### Phase 7: SEO, accessibility, legal, launch polish (Week 9–10)

Decomposed into AECI Phase 7.1–7.13 (planned 2026-06-10; **no sibling spec — straight to issues**). Much of §16's original Phase 7 list **already shipped in Phases 2–4** (verified on `main` 2026-06-10) and is struck below; Phase 7 is the genuine launch-readiness remainder.

**Already shipped:** ~~XML sitemap~~ (AECI-63) · ~~OG/Twitter meta~~ + ~~product/vendor JSON-LD~~ (AECI-51) + ~~home JSON-LD~~ (AECI-186) · ~~canonical tags~~ (AECI-147) · ~~404 page~~ (AECI-62) · ~~robots.txt~~ (AECI-63) · ~~axe-core in e2e~~ + ~~Lighthouse a11y ≥95 in CI~~ (AECI-65) · ~~CSP/security headers~~ (AECI-89) · ~~color-contrast validation~~ (AECI-148/150/166/230) · ~~Datadog dashboards~~ (per-phase: AECI-66/141/180/206) — **no Slack** (Phase 6 decision).
**Deferred (not Stage 1):** integration-page JSON-LD (Phase 2 §9.2 → Stage 2); sitemap index/sub-sitemap split (AECI-63 — only needed beyond 50k URLs).

**Phase 7.1–7.13 (the remainder):**
- [x] 7.1 — IndexNow on the write-event pipeline (§20.2) — AECI-236 (Google Indexing API ping deferred → AECI-263)
- [ ] 7.2 — Legal pages: Terms, Privacy, Review Guidelines, Listing Accuracy (§13, §27); counsel-reviewed
- [ ] 7.3 — About + Contact pages
- [ ] 7.4 — PostHog integration (event set + locale/theme dimensions; §14.1)
- [ ] 7.5 — Resend transactional email (review + account-deletion + magic-link sender; §11.1) — home for the Phase 5/6 deferred emails
- [ ] 7.6 — Daily data-quality job (full §23.1 suite + email summary; Algolia-drift line already shipped in AECI-140)
- [x] 7.7 — WAF rate limits on the public endpoints (§15.1) — dashboard runbook `docs/waf-rate-limits.md` (AECI-242)
- [x] 7.8 — Cross-browser / real-device QA via BrowserStack (AECI-154) — non-blocking BrowserStack Automate lane wired (`.github/workflows/browserstack.yml` + `apps/web/browserstack.yml` + `playwright.browserstack.config.ts`); ADR 0012 Accepted. Inert until the personal-subscription `BROWSERSTACK_*` secrets are set (skips green); pre-launch full sweep + a11y audit still pending.
- [ ] 7.9 — Waitlist welcome banner + token attribution (§11.2)
- [ ] 7.10 — Manual screen-reader pass (VoiceOver/NVDA; §21.3)
- [ ] 7.11 — Performance / Core Web Vitals audit
- [ ] 7.12 — Phase 7 completion checkpoint (launch-readiness gate)
- [ ] 7.13 — DNS cutover from the coming-soon page (§11.2)

### Phase 8: Post-launch (Week 11+)
- [ ] Monitor errors, performance, search quality
- [ ] Iterate on stats card content based on real traffic
- [ ] Refine moderation workflow based on first reviews
- [ ] Start Stage 2 planning

### Stage 1.5 — Integration Redesign (pre-launch; parallel track)

Governed by `docs/STAGE_1_5_SPEC.md` (decomposed into AECI-287…300). A focused redesign of the integration surface that runs alongside the Phase 7 launch-readiness work, not a numbered phase of it. Two coordinated changes: **(A)** replace the single-row `source → target` integration page (§4.4) with a context-oriented **product-PAIR page** (`STAGE_1_5_SPEC.md` §7), and **(B)** add a structured **claim/attestation model** — a closed `data_object` vocabulary + computed agreement + a `confirmed/total` sync headline, **AECi-seeded only** (`STAGE_1_5_SPEC.md` §2–§6, §8). Layer A (the pair page) needs no claim data and ships first. Decisions recorded in **ADR 0018** (claims attach to the mechanism row; agreement is computed-not-stored).

- [ ] §2 `data_object` controlled vocabulary — frozen, closed (AECI-287; `DATA_OBJECT_VOCABULARY.md`)
- [ ] §3 + ADR 0018 the claim/attestation model + this spec (AECI-288)
- [ ] §4 Review app (bamako): Airtable `data_objects`/`integration_claims` + claim MCP tools + read-only QA tab (AECI-290/292/295) + OPS re-curation (AECI-299)
- [ ] §5 Promote contract: `claims[]` shared schema + Review emit (AECI-291/296)
- [ ] §6 Main app: D1 schema (`taxonomy_data_objects`/`claims`/`attestations`) + promote ingest (AECI-293/297)
- [ ] §7/§8 Pair page (Layer A) + claim rendering (Layer B) against the AECI-289 prototype (AECI-294/300)
- [ ] §9 Search/SEO follow-through — per-pair Algolia deferred; no dead `/integrations/:id` links (AECI-298)

**Moved to Stage 2 (vendor-portal-dependent):** vendor attestation authoring (AECI-301), conflict UI + notification pipeline (AECI-302), version-diff timeline (AECI-303), paywalled integration depth (AECI-304). Everything in Stage 1.5 renders **"Unverified"** until the vendor portal exists. See §18.

---

## 17. Resolved Design Decisions

The following decisions were made during Stage 1 design and are locked unless explicitly revisited:

1. **Slug collisions** — for products or vendors with name collisions, append the vendor name to the slug (e.g. `connect-fieldwire` vs `connect-procore`). This is expected to be rare; aim to resolve any pre-launch collisions in seed data before going live.
2. **Review moderation SLA** — published commitment of 48 business hours, targeted internal SLA of 24 hours. Operational support includes Slack alerts on new submissions, dashboard showing queue age, and auto-escalation alert if any review is in queue >36 hours. Manual "moderation pause" toggle for vacation periods that adjusts the auto-responder.
3. **Reviews on rejected products** — when a product is later set to `promotion_status='rejected'`, its reviews are soft-deleted (review status set to `archived`) and the product's review aggregates are recomputed. Reviews are preserved for audit trail but no longer counted or displayed.
4. **Logo fallback strategy** — fallback to a generic AECi-branded placeholder logo for products and vendors without Brandfetch coverage. Single placeholder asset, no per-entity initials avatars in Stage 1.
5. **"No reviews yet" presentation** — actively promote interaction. Display a prominent CTA on product pages with no reviews: "Be the first to review {product}." Includes a visual hook (icon or illustration) that makes the empty state feel like an invitation rather than a gap.
6. **SEO and sitemap automation** — see Section 21.

---

## 18. Stage 2 Forward Compatibility

Design decisions in Stage 1 that enable Stage 2 without rework:

- `profiles.role` enum already includes `vendor_admin`
- `profiles.vendor_id` foreign key already exists
- `vendors.verified` boolean ready for vendor-claim flow
- Algolia sync architecture supports real-time updates when vendors edit
- Cache invalidation helper (`invalidateForEntity`) supports vendor-scoped invalidation; same function works for vendor-portal writes
- API endpoint pattern (`/api/admin/*`) extends naturally to `/api/vendor/*`
- `translations` table supports localized vendor-managed content
- `profiles.banned_at` supports moderation escalation

**Stage 1.5 integration spine (claims/attestations) is Stage-2-ready** (`STAGE_1_5_SPEC.md`, ADR 0018):
- Agreement is **computed-not-stored** (`computeAgreement`), so vendor attestations light up the confirmed/`conflict` states with no migration — the function and its branches already exist and are unit-tested.
- Attestation `source` already enumerates `vendor_a` / `vendor_b` (dormant in 1.5); the `introduced_at` / `deprecated_at` version stamps ship dormant for the Stage 2 version-diff timeline.
- The Stage 2 integration carve-outs are tracked as **AECI-301** (vendor attestation authoring), **AECI-302** (conflict UI + notification pipeline), **AECI-303** (version-diff timeline), **AECI-304** (paywalled integration depth).

No schema migrations required for Stage 2 vendor portal — only new endpoints and new UI.

---

## 19. Glossary

| Term | Meaning |
|---|---|
| AECi | AEC Integrations, the platform (short form / nickname) |
| AEC | Architecture, Engineering, and Construction |
| SSR | Server-side rendering |
| RLS | Row-level security (Supabase/Postgres) |
| WAF | Web Application Firewall |
| Edge | Cloudflare's global network of POPs |
| InstantSearch | Algolia's frontend search library |
| Spartan UI | Angular component library, shadcn/ui-inspired |
| n8n | Workflow automation tool, used for Linear integration |
| RUM | Real User Monitoring (Datadog frontend tracking) |
| APM | Application Performance Monitoring (Datadog backend tracing) |
| BCP 47 | Locale tag standard (e.g. `en-US`, `es-ES`) |

---

## 20. SEO and Discoverability

### 20.1 Dynamic XML sitemap

Generated on request by a Cloudflare Worker, not built statically.

- Root sitemap index: `/sitemap.xml` → references per-entity sub-sitemaps
- `/sitemap-products.xml` — all product URLs with `<lastmod>` reflecting `products.updated_at`
- `/sitemap-vendors.xml` — all vendor URLs
- `/sitemap-integrations.xml` — all integration URLs
- `/sitemap-taxonomy.xml` — category, audience, and phase pages
- Edge-cached for 1 hour with tag-based invalidation on writes
- Includes localized URLs via `<xhtml:link rel="alternate" hreflang="...">` once additional locales exist

### 20.2 IndexNow notification

On any write to products, vendors, or integrations, a Cloudflare Worker submits the affected URLs to IndexNow (Bing, Yandex, others). Google Indexing API pinged for the same URLs as a best-effort signal.

This runs as part of the single write-event pipeline described in Section 20.5.

> **Implemented (AECI-236):** the API Worker's `POST /api/promote` post-commit pipeline computes the affected public URLs (`apps/api/src/routes/promote-indexnow-urls.ts`) and submits them to IndexNow (`apps/api/src/lib/indexnow.ts`) right where the Cache-Tag purge fires — best-effort, failures logged to Datadog, never blocking the write. The SSR Worker serves the `{key}.txt` verification file at the site root (`apps/web/src/server/routes/indexnow-key.ts`). Gated on `INDEXNOW_KEY` + `PUBLIC_SITE_URL`, provisioned **only at public launch** (alongside `ALLOW_INDEXING="true"`) so a `noindex` site is never pinged.

> **Implemented (AECI-263):** the **Google Indexing API** ping is now an additional best-effort `waitUntil` consumer in the same post-commit block, reusing the SAME affected-URL set (`affectedUrlsForPromote`, no second deriver). The transport (`apps/api/src/lib/google-indexing.ts`) signs an RS256 service-account JWT with `jose`, exchanges it for an OAuth access token, then `urlNotifications:publish`-es each URL (`URL_UPDATED`) — pure, never throws, failures recorded to Datadog (`aeci.google_indexing.submit` + `aeci.api.promote.google_indexing_failed`), never blocking the write. Gated on `GOOGLE_INDEXING_SA_EMAIL` + `GOOGLE_INDEXING_SA_PRIVATE_KEY` + `PUBLIC_SITE_URL`, provisioned **only at launch** alongside IndexNow (a missing cred → graceful no-op). It stays best-effort because Google officially supports only `JobPosting`/`BroadcastEvent`; the sitemap `<lastmod>` (§20.5 step 5) remains the primary discovery path.

### 20.3 Structured data (Schema.org JSON-LD)

Embedded in `<head>` on relevant pages:

- **Products** — `SoftwareApplication` with `aggregateRating` (once ≥5 reviews), `offers`, `description`
- **Vendors** — `Organization` with `address`, `foundingDate`, `url`
- **Integrations** — `WebPage` with rich description; no perfect schema.org type exists
- **Home** — `WebSite` with `SearchAction` for Google sitelinks search box, plus a publisher `Organization` (whose `logo` is the square monogram)
- **Reviews** — `Review` nested in `SoftwareApplication`

Generates rich results in search once data accumulates (star ratings in Google results, etc.).

> **Home JSON-LD at launch (AECI-276):** the home emits **only** the `WebSite` (with `SearchAction`) + publisher `Organization` — **no** site-level `aggregateRating`/`Review`. Nothing is dual-vendor-verified at Stage 1 (§1 out-of-scope) and the launch review corpus is not an honest basis for star ratings, so org/home aggregate review markup is deliberately withheld until it is genuinely supported. Product-level `aggregateRating` still appears per its own ≥5-review threshold above.

### 20.4 OpenGraph and Twitter Card meta tags

Every product, vendor, and integration page includes:

- `og:title`, `og:description`, `og:image`, `og:url`, `og:type`
- `twitter:card` (`summary_large_image`), `twitter:title`, `twitter:description`, `twitter:image`

Dynamic OG image generation (via Cloudflare Workers + Satori) deferred to a Stage 1.x iteration. At launch, OG image is the entity's logo on a branded background, generated server-side or pre-rendered.

> **Implemented — home share card (AECI-276):** the **home** (`/`) does not use the monogram fallback. It ships a dedicated, pre-rendered **1200×630 PNG** share card (`apps/web/public/branding/home-og.png`, served at `/branding/home-og.png`), and `setHomeMeta` (`apps/web/src/app/core/meta.service.ts`) points `og:image` + `twitter:image` (with `og:image:alt` / `twitter:image:alt`) at it as an **absolute** URL — the home is the highest-value share surface ("buyers send the link to colleagues"). The card is light-editorial and **evergreen** (no live numbers, so the static asset never goes stale); regenerate from `apps/web/scripts/home-og-template.html` via `pnpm --filter @aeci/web og:home` (a manual Playwright-render dev tool, not in CI). **Per-entity** product/vendor OG cards remain the monogram fallback (`DEFAULT_OG_IMAGE`) — a separate effort. The home `Organization` JSON-LD `logo` (§20.3) intentionally stays the square monogram, not the share card.

### 20.5 Single write-event pipeline

A single write to products, vendors, or integrations triggers all downstream consumers via one event handler in the API Worker:

1. Database update
2. Algolia incremental sync (real-time in Stage 2; daily batch in Stage 1)
3. Cloudflare cache invalidation via `POST /admin/purge` with the relevant `Cache-Tag` list (see `docs/CACHE_STRATEGY.md` §5)
4. IndexNow notification for affected URLs
5. `updated_at` bumped → reflected in next sitemap fetch

Built as one function call so adding new consumers later (Slack notifications, vendor email alerts in Stage 2) is trivial.

### 20.6 Canonical URLs

Every page emits a `<link rel="canonical">` tag. Pages reachable through query parameters (filtered listings, search results) canonicalize to the unfiltered version to prevent duplicate content issues.

### 20.7 404 page

Useful 404 — search box, top categories, "you might be looking for these" links derived from the requested path. Logged to Datadog with the source URL so broken inbound links can be redirected.

### 20.8 Robots.txt

Allows all crawlers. Disallows `/auth/*`, `/account`, `/admin/*`, `/api/*`. Sitemap reference points to `/sitemap.xml`.

---

## 21. Accessibility

WCAG 2.1 AA compliance is a build-time concern, not a pre-launch checklist item.

### 21.1 Build practices

- Spartan UI components inherit a11y from Angular CDK primitives (focus management, ARIA attributes, keyboard navigation)
- All interactive elements reachable via keyboard
- Visible focus indicators on all focusable elements (Tailwind `focus-visible:` utilities)
- Form fields have associated `<label>` elements; placeholder text is not a substitute for labels
- Images have meaningful `alt` text (logos use vendor/product name; decorative images use `alt=""`)
- Heading hierarchy is logical (one `<h1>` per page, no skipped levels)
- Color is never the sole means of conveying information (icons + text, not just color states)

### 21.2 Color contrast

Brand tokens validated against WCAG AA contrast ratios:

- Forest `#1E3A2F` on Bone `#F5F2EA` — passes AA for normal text
- Clay `#E89668` on Bone — does NOT pass AA for normal text; only used for large text or graphical elements
- All text/background pairs verified before launch and on any palette change

### 21.3 Testing

- Automated: `axe-core` integrated into Cypress or Playwright e2e tests
- Manual: keyboard-only navigation through full review submission flow
- Manual: screen reader testing on home page, product page, and review submission (VoiceOver on macOS, NVDA on Windows)
- Lighthouse Accessibility score ≥95 enforced in CI

### 21.4 Future considerations

- Reduced motion support via `prefers-reduced-motion` media query
- High contrast mode support via `forced-colors` media query
- Multi-language readiness (Section 7a) inherently supports right-to-left languages — layout uses logical properties (`margin-inline-start`, not `margin-left`) where applicable

---

## 22. Content Moderation Operations

### 22.1 Moderation queue

- Admin dashboard at `/admin/reviews` shows pending reviews with:
  - Product name, reviewer email, submission timestamp, queue age
  - Full review content
  - One-click approve / reject buttons
  - Rejection reason field (required on reject)
- Sortable by queue age, product, reviewer
- "Pending count" badge visible in admin nav
- ~~Slack alert on each new submission to a dedicated `#moderation` channel~~ — **no Slack (Phase 6 decision, 2026-06-10).** New claim/correction requests create a Linear issue (Vendor Requests project) → Linear's native email notifications; new reviews surface via the admin pending badge. See `STAGE_1_PHASE_6_SPEC.md` §10.

### 22.2 Profanity filter

- Reviews scored for toxicity on submission via **Anthropic Claude** (Claude Haiku — AECI-258; supersedes the original Perspective API, which Google is sunsetting)
- High-toxicity scores flag the review in the moderation queue (not auto-reject)
- Saves moderation time by surfacing the worst content first
- Flagged reviews show toxicity score in admin UI

### 22.3 Reviewer ban system

- `profiles.banned_at` and `profiles.ban_reason` columns (added to schema)
- Banned users:
  - Cannot submit new reviews (API rejects with explanation)
  - Their existing approved reviews remain visible but flagged internally
  - Cannot create new accounts with the same email (Supabase Auth enforces)
- Bans are applied manually by admins via direct SQL or admin UI
- "Repeat offender" pattern: if a user's third review is rejected, prompt admin to consider a ban

### 22.4 Review duplicate detection

- API rejects review submission if `reviewer_id` already has a review for the same `product_id`
- Returns a redirect to edit the existing review (Stage 1: edit only if still in `pending` status; Stage 2 may allow editing approved reviews with re-moderation)

### 22.5 Vendor request moderation

- Claim requests with mismatched email domain (e.g. `gmail.com` claiming Procore) are flagged in Linear with a `domain-check-pending` label
- Linear workflow ensures these get manual scrutiny before approval
- Correction requests are reviewed but not auto-applied — admin reviews the suggested change and edits the source data directly

---

## 23. Data Hygiene

### 23.1 Daily data quality job

Cloudflare Worker runs daily at 04:00 UTC. Checks for:

- Products with no associated vendor
- Products with `promotion_status='ready'` for >30 days without promotion to live
- Integrations with broken source or target product references
- Vendors with no products
- Reviews with `reviewer_id=null` but no `anonymized_at` timestamp (data integrity check)
- Stale `stats_cache` rows (older than 48 hours, indicating stats pipeline failure)
- Duplicate vendor candidates (same `company_name` ignoring case and whitespace)
- Duplicate product candidates (same `name` within the same vendor)
- Brandfetch logo URLs returning 404 (sample check, not exhaustive)
- Algolia index drift (record count mismatch with Supabase)

Output: email summary to Chris and Bill at 04:30 UTC. No automatic remediation — humans triage (exception: the Algolia index-drift check self-heals the orphan / negative-drift case; see the AECI-266 note below).

> **Implementation note (AECI-140):** the "Algolia index drift" line item ships as the
> API Worker's scheduled (`scheduled`) handler — `apps/api/src/scheduled.ts`, a daily 09:00
> UTC (= 04:00 EST) cron registered per-env in `apps/api/wrangler.jsonc` (staging + production),
> trailing the 08:00 UTC incremental sync by one hour so it reads a settled index. (Decoupled
> from the 04:00 UTC slot of the broader §23.1 data-quality job, which remains unbuilt.) It compares
> promoted-row counts to Algolia object counts per entity and emits the `aeci.algolia.index_drift`
> gauge; the **alert is the Datadog monitor** (`observability/datadog/monitor-algolia-index-drift.json`),
> not the email summary (the full §23.1 email + the other nine checks remain to be built). A
> report-only (dry-run) post-deploy check also runs in `deploy-staging` (CICD §3.2).
>
> **Self-healing update (AECI-266):** the daily 09:00 cron no longer stops at reporting — right
> after emitting the `index_drift` gauge it runs the orphan sweep (`apps/api/src/lib/algolia-orphans.ts`):
> browse every objectID per index, diff against the authoritative promoted-id set from D1, and
> `deleteObject` the orphans (objects with no promoted D1 row — what the incremental sync
> structurally can't see to delete). The sweep is **delete-only and safety-capped** (≤50 objects
> and ≤20% of an index per pass; a larger purge is refused and surfaced via
> `aeci.algolia.orphans_skipped_cap` for an operator to confirm with
> `db:reconcile-algolia-drift --apply --force`). It heals **negative** drift only; **positive**
> drift (records missing from the index) stays repaired by the 08:00 incremental sync. The
> AECI-138 bulk sync this note once pointed to as the repair path never landed.

### 23.2 Duplicate detection on submission

- Review submission blocks if duplicate detected (Section 22.4)
- Vendor request submission flags duplicates in Linear rather than blocking — sometimes legitimate (e.g. two different people from the same vendor claim independently)

### 23.3 Soft-delete and audit trail

- Reviews use `status='archived'` rather than hard delete
- Profiles deleted via account deletion flow are hard-deleted, but their reviews persist with `reviewer_id=null` (GDPR-compliant anonymization)
- Vendor data changes are not versioned in Stage 1 — added in Stage 2 when vendors edit their own data
- Admin actions (review approval, ban application) logged with admin user ID and timestamp

### 23.4 Reconciliation between Airtable and Supabase

The existing Airtable staging layer remains the curator workspace; Supabase is the production read store. Reconciliation:

- Promotion from Airtable to Supabase is a manual curator action (status flip to `promotion_status='promoted'`) triggering a one-way sync
- Daily reconciliation job compares Airtable counts to Supabase counts and reports drift
- No automatic Airtable → Supabase sync; curators control promotion timing

---

## 24. Development Workflow — Linear, GitHub, Claude Code

### 24.1 Linear setup

- **Workspace:** AEC Integrations
- **Team:** AECi (single team for the founding two; identifier `AECI` → issue IDs like `AECI-42`)
- **Projects** (within the AECi team):
  - `Stage 1 Build` — issues mapped to build order phases (Section 16)
  - `Vendor Requests` — incoming claim/correction requests from the site
  - `Stage 2 Planning` — placeholder, populated when Stage 1 nears launch
  - `Bugs` — separate from feature work
- **Cycles:** 2-week cadences enabled at the team level, aligned to build phases
- **Workflow states:** default Linear states (Backlog, Todo, In Progress, In Review, Done, Cancelled) used across all projects. Vendor Requests uses labels to disambiguate workflow nuances within the same state set.
- **Labels** (workspace-level):
  - Cross-cutting concern: `frontend`, `backend`, `infra`, `data-model`, `seo`, `a11y`, `i18n`, `moderation`, `theme`, `blocker`
  - Issue type (Linear defaults, kept alongside the concern set): `Bug`, `Feature`, `Improvement`
  - Vendor Requests specific: `claim`, `correction`, `domain-check-pending`
  - Vendor Requests label group (replaces a custom `Domain Match` select field): `domain-match:yes`, `domain-match:no`, `domain-match:pending`
- **Issue conventions** (in place of native custom fields — Linear has no generic custom-field feature on any plan tier; verified against the live workspace UI and the public GraphQL schema):
  - Every issue description opens with `**Spec section:** §X.Y` and `**Plan file:** \`.context/plans/NN-…md\``, enforced by team issue templates (`Build Issue Template`, `Bug Template`, `Vendor Claim Template`, `Correction Request Template`)
  - Acceptance criteria captured in issue description as markdown checklist (Linear-native)
  - Dependencies captured via Linear's native issue relations (blocks/blocked by)
- **Vendor Requests intake fields** (written by n8n into the issue, not Linear custom fields):
  - `Submitter Email`, `Source URL` — embedded in the issue description body by the n8n workflow; `Source URL` is additionally posted as a Linear attachment so it renders as a clickable card
  - `Domain Match` — set via the `domain-match:*` label group above (single-select by virtue of being a label group)

### 24.2 Linear ↔ GitHub integration

Linear's GitHub integration is best-in-class for issue trackers — it's a primary reason for selecting Linear over alternatives.

- Branch naming: Linear generates branch names from issue IDs (e.g. `aeci-42-product-page-skeleton`) via the "Copy git branch name" action
- PR descriptions auto-link to issues; `Closes AECI-42` keyword auto-closes the issue on PR merge
- Status changes flow both directions: opening a draft PR moves the issue to In Progress; merging moves it to Done
- Status updates posted to Slack `#dev` channel via Linear's Slack integration

### 24.3 Claude Code workflow (manual)

Stage 1 uses Claude Code manually against Linear issues. No parallel agent orchestration — one issue at a time, one agent at a time, human in the loop on every PR.

**Workflow:**

1. Issue created in Linear with title, description, acceptance criteria, spec reference
2. Issue assigned and pulled by a human (Chris or Bill)
3. Claude Code session started with:
   - The Linear issue ID and full description
   - The relevant spec section pasted in or referenced
   - The Figma frame URL if applicable
4. Agent works against the issue, opens a PR
5. PR includes Linear issue ID in description for auto-close on merge
6. CI runs: type checks, axe-core a11y, Lighthouse budgets, Datadog smoke tests
7. Human review and merge
8. Linear issue auto-closes via GitHub integration

### 24.4 Issue quality standards

Whether work is done by Claude Code or by hand, every Linear issue should have:

- **Clear scope** — one capability, not a phase (e.g. "Implement product page header component" not "Build product page")
- **Spec reference** — which section of `STAGE_1_SPEC.md` governs the work
- **Acceptance criteria** — testable, specific (e.g. "Component renders product name, logo, vendor link, category badges; matches Figma frame X; passes axe-core")
- **Dependencies** — explicit links to prerequisite issues
- **Test expectations** — what unit/integration tests the PR should include

The build order in Section 16 is too coarse-grained for direct work. Each checkbox decomposes into 3–10 focused Linear issues.

### 24.5 Future parallelism

If parallel AI development becomes valuable later, options:

- **Conductor** — orchestrates parallel Claude Code agents across git worktrees, with Linear as the issue source. Linear is its primary supported issue tracker; setup is direct. Worth evaluating once the build pace requires parallel work streams.
- **Git worktrees + manual Claude Code sessions** — spin up multiple worktrees yourself, run separate Claude Code sessions per worktree. No orchestrator, fully manual but gets you parallel work.

Not pursued in early Stage 1. Single-agent workflow is sufficient for the foundation phases. Revisit when issue volume warrants parallelism.

### 24.6 Spec as source of truth

The spec file `STAGE_1_SPEC.md` is committed to the repo root. Every Linear issue references its governing section. When design decisions change:

1. Update the spec first (PR with rationale in commit message)
2. Update or create Linear issues referencing the new spec section
3. Subsequent work follows the updated spec

This prevents drift between human decisions and AI-generated code.

---

## 25. Design Workflow — Figma

### 25.1 Figma file structure

Three files, all under the AEC Integrations team in Figma:

- **`AEC Integrations — Design System`** — single source of truth for visual design
  - Color styles (light theme tokens from Section 2a.2; dark tokens deferred to Stage 2 — AECI-226)
  - Text styles (heading sizes, body sizes, weights)
  - Spacing tokens (matching Tailwind's spacing scale)
  - Component library (buttons, cards, forms, badges, inputs — mirrors Spartan UI primitives)
  - Iconography reference (Lucide icons, project-approved subset)
- **`AEC Integrations — Stage 1 Pages`** — page-level designs
  - One frame per page, mobile + desktop variants
  - Home, product page, vendor page, search results, review submission, integration detail, listing pages, legal pages
- **`AEC Integrations — Marketing / About`** — non-product pages
  - About, Contact, press kit, social OG image templates

### 25.2 Tier

Free Starter tier sufficient to begin (3 files, unlimited collaborators). Upgrade to Professional ($16/editor/month) when feature collaboration expands or version history depth becomes a constraint.

### 25.3 Plugins

- **Tailwind CSS plugin** — generates Tailwind classes from Figma elements
- **Iconify** — Lucide icon library access
- **html.to.design** — reference site imports for inspiration
- **Wireframer** — early-stage layout sketching

### 25.4 Figma ↔ Linear

Native Linear integration — Figma frames embed directly in Linear issues. Each Linear issue for a UI task includes a Figma frame link in its description. Conductor agents receive the frame link as part of the issue context.

### 25.5 Design process

Avoid the trap of designing every page before building anything. Process:

1. Design **one page completely** in Figma — the product page (most complex, most important)
2. Validate the design by implementing it in code
3. Reconcile spec, Figma, and code against any issues discovered
4. Iterate the design system based on what worked
5. Then design the remaining pages with confidence in the system

### 25.6 AI design assistance

Acceptable use for first drafts:

- Figma built-in AI features for initial layouts
- v0.dev or Galileo AI for component design ideation
- Treat output as starting point, not finished work — refine in Figma against the design system

### 25.7 Token parity with code

Figma color styles, text styles, and spacing tokens mirror Tailwind config exactly. Changes to either require updates to both. This is a manual discipline in Stage 1; tooling like Tokens Studio can automate it later if drift becomes a problem.

---

## 26. Audit Trail & Workflows

Comprehensive logging of state-changing events and multi-step approval flows. All audit data is also forwarded to Datadog for unified observability and ad-hoc querying.

### 26.1 Audit log table

Captures every state-changing event across the platform.

```sql
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references profiles(id), -- who did it (null for system/anonymous)
  actor_type text not null, -- 'user' | 'admin' | 'system' | 'workflow'
  action text not null, -- 'review.approved', 'product.updated', 'claim.requested', etc.
  entity_type text, -- 'review' | 'product' | 'vendor' | 'integration' | 'claim' | 'correction'
  entity_id uuid,
  before_state jsonb, -- prior state of changed fields (updates only)
  after_state jsonb, -- new state of changed fields (updates only)
  metadata jsonb, -- workflow context: linear_issue_id, ip_address, user_agent, cf_country, etc.
  created_at timestamptz not null default now()
);

create index audit_log_entity_idx on audit_log(entity_type, entity_id, created_at desc);
create index audit_log_actor_idx on audit_log(actor_id, created_at desc);
create index audit_log_action_idx on audit_log(action, created_at desc);
create index audit_log_created_at_idx on audit_log(created_at desc);
```

**Naming convention:** dot-separated `entity.action` (e.g. `review.approved`, `product.created`, `vendor.updated`, `claim.submitted`, `claim.approved`).

**Coverage:** every write path in the API Worker calls `appendAuditLog(...)` as part of its transaction. Failure to log is a hard failure for the write — the operation is rolled back if audit logging fails. This guarantees no state change happens without a corresponding audit entry.

### 26.2 Workflow instances

Multi-step processes (with approval gates, multiple actors, or external system handoffs) get explicit workflow tracking.

```sql
create table workflow_instances (
  id uuid primary key default gen_random_uuid(),
  workflow_type text not null, -- 'vendor_claim' | 'review_moderation' | 'correction_request'
  entity_id uuid not null, -- the entity being acted on (vendor_request.id, review.id, etc.)
  current_state text not null,
  linear_issue_id text, -- link back to Linear issue if applicable
  initiated_by uuid references profiles(id),
  initiated_at timestamptz not null default now(),
  completed_at timestamptz,
  final_outcome text -- 'approved' | 'rejected' | 'cancelled' | 'completed'
);

create table workflow_transitions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflow_instances(id) on delete cascade,
  from_state text,
  to_state text not null,
  actor_id uuid references profiles(id),
  reason text, -- rejection reason, approval note, etc.
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index workflow_instances_entity_idx on workflow_instances(workflow_type, entity_id);
create index workflow_transitions_workflow_idx on workflow_transitions(workflow_id, created_at);
```

### 26.3 Stage 1 workflow types

| Workflow type | States | Trigger | Outcomes |
|---|---|---|---|
| `vendor_claim` | submitted → triaged → domain_check → approved / rejected | Claim form submission | approved, rejected, cancelled |
| `review_moderation` | submitted → auto_screened → in_moderation → approved / rejected | Review submission | approved, rejected |
| `correction_request` | submitted → triaged → applied / rejected | Correction form submission | applied, rejected |

Each workflow type has a documented state machine in the codebase. Invalid transitions throw at the API layer.

> **Stage-1 relaxation (Phase 6, 2026-06-10):** Stage 1 ships **lean** workflow tracking — moderation is driven off the entities' `status` columns and `workflow_transitions` is an append-only history; the guarded state machine (enforced/throwing transitions) is **deferred** given low request volume. See `STAGE_1_PHASE_6_SPEC.md` §5.

### 26.4 Linear bidirectional sync

When a workflow has a `linear_issue_id`, state changes flow both ways:

- **Site → Linear:** Worker calls Linear GraphQL API on transition (status update, comment append)
- **Linear → Site:** Linear webhook posts to `/api/webhooks/linear` on issue state change; Worker writes a `workflow_transitions` entry with `actor_type='workflow'` and metadata referencing the Linear action

This ensures the audit trail is complete regardless of where the action originated.

### 26.5 Datadog forwarding

Every `audit_log` and `workflow_transitions` entry is also forwarded to Datadog as a structured log event. This enables:

- Unified observability — audit data sits alongside performance and error data in Datadog
- Ad-hoc querying — Datadog's log search and metric tools work across the full event stream
- Alerting — Datadog alerts can fire on suspicious patterns (e.g. >5 rejected reviews from one user in an hour)
- Long-term retention — Datadog retains logs separately from Supabase, so even if the table is later archived, queryable history persists

**Implementation:** the `appendAuditLog()` helper writes to Supabase AND emits a Datadog log event with the same payload in one call. Failures to forward to Datadog are logged but do not fail the audit write — Supabase is the source of truth.

**Log structure:**

```json
{
  "service": "aeci-api",
  "ddsource": "audit_log",
  "level": "info",
  "audit": {
    "id": "uuid",
    "actor_id": "uuid",
    "actor_type": "admin",
    "action": "review.approved",
    "entity_type": "review",
    "entity_id": "uuid",
    "metadata": { "linear_issue_id": "AECI-42", "cf_country": "US" }
  }
}
```

### 26.6 Retention policy

**Stage 1: indefinite retention in Supabase.** Audit and workflow tables grow with platform activity but remain small (estimate: thousands of rows in year one). No archiving or pruning at launch.

When the table becomes large enough to materially affect performance or storage cost (signaled by the daily data quality job in Section 23.1), introduce a retention policy. Likely approach: archive entries older than 1 year to R2 or BigQuery as Parquet, keeping the most recent year hot in Supabase. Datadog retention is governed by Datadog's plan separately.

This decision is intentionally deferred — easier to introduce retention later than to recover data deleted prematurely.

### 26.7 Access control

- `audit_log` and workflow tables are admin-read only via RLS
- No public API exposes audit data
- Personal data in audit entries follows GDPR rules — when a user invokes right to erasure, their `actor_id` references are nulled but audit entries remain (the action happened; the actor is anonymized)

---

## 27. Legal Document Lifecycle

Legal pages (Terms, Privacy, Review Guidelines, Listing Accuracy Policy) require version control, editorial review, and counsel approval. Source of truth is the repo; Linear orchestrates the editorial workflow.

### 27.1 Source of truth

Legal documents live as Markdown files in the repo:

```
apps/web/src/content/legal/
├── terms-of-service.md
├── privacy-policy.md
├── review-guidelines.md
└── listing-accuracy-policy.md
```

Each file includes frontmatter with version and effective date:

```yaml
---
title: Privacy Policy
version: 1.2
effective_date: 2026-06-01
last_updated: 2026-05-15
counsel_approved_by: [name]
counsel_approved_on: 2026-05-12
linear_issue: AECI-128
---
```

The site renders the current versions on `/legal/*` routes. Frontmatter is displayed at the top of each rendered page (version, effective date).

### 27.2 Change workflow

1. **Proposed change** — Chris or Bill identifies needed update (regulatory change, terminology fix, new feature requiring policy update)
2. **Linear issue created** — describes the change rationale, scope, urgency
3. **Branch + PR** — proposed text changes committed to a branch, PR opened linking the Linear issue
4. **Counsel review** — counsel reviews the PR (or rendered preview from a Cloudflare preview deployment); their approval is captured in the Linear issue
5. **Frontmatter updated** — `version` bumped, `effective_date` set, `counsel_approved_by` and `counsel_approved_on` filled in
6. **PR merged** — new version goes live on next deploy
7. **Linear issue closed** — completed with link to the merged PR and effective date

### 27.3 Version history

Git history serves as the version log. Every change is a traceable commit linked to a Linear issue and (when applicable) a counsel approval record.

For users who care about historical versions:
- Each version's permalink is the commit hash on GitHub
- A `/legal/versions` index page (optional, low priority) could list historical versions and their effective dates

### 27.4 Significant changes

When a change materially affects users (e.g. new data collection, expanded use of personal data), Stage 2+ may require notification to affected users via Resend. Stage 1 has no notification mechanism since users don't have persistent accounts that need notifying.

For Stage 1 launch, initial drafts of all four legal documents are produced from templates and reviewed by counsel before launch. The launch versions become version 1.0 of each document.

### 27.5 Non-developer editing

If a non-developer (e.g. counsel directly) needs to propose changes without working in git, they can:

- Provide redlined Markdown or Word document to Chris or Bill
- Chris or Bill commits the change as described above
- Or, in Stage 2+, a simple admin UI for legal page editing can be built if the workflow becomes a friction point

Not pursued in Stage 1 — counsel-driven changes are expected to be infrequent and not worth admin UI overhead.

---

## 28. Application Naming Convention

Throughout this document and the codebase:

- **AEC Integrations** — full name, used on the website, in legal documents, marketing materials
- **AECi** — short form and nickname, used informally and where space is constrained
- **`aecintegrations.com`** — primary domain
- **`aeci`** — code-level prefix for variables, namespaces, and identifiers when needed

Avoid alternative phrasings ("AEC Integration Directory", "AEC Integrations Review", etc.) in user-facing surfaces — consistency is the brand.

---

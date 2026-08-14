// Drizzle SQLite schema — the source of truth for the Cloudflare D1 application
// database (ADR 0016, AECI-252). Originally translated 1:1 from the now-removed
// Prisma schema (formerly apps/api/prisma/schema.prisma, deleted in AECI-278) +
// the CHECK/partial-index detail that lived only in the original
// supabase/migrations/*.sql. Companion spec: docs/DATABASE_SCHEMA.md.
//
// Conventions carried over from Postgres:
// - snake_case at the DB layer (first arg to each column); camelCase in TS.
// - UUID PKs are TEXT generated app-side (`crypto.randomUUID()`); SQLite has no
//   `gen_random_uuid()`.
// - `*_at` columns are TEXT ISO-8601. `created_at`/`updated_at` default app-side;
//   `updated_at` refreshes via `$onUpdate` (replaces the Postgres
//   `set_updated_at()` BEFORE UPDATE triggers — all writes go through Drizzle).
// - Postgres `decimal` → `real`; `smallint`/`int` → `integer`; `boolean` →
//   `integer({ mode: 'boolean' })`; `jsonb` → `text({ mode: 'json' })`.
// - Enum-style fields stay TEXT + a CHECK constraint (mirrors the Postgres CHECKs;
//   `@aeci/shared` Zod schemas remain the first line of enforcement).
// - RLS/GRANTs do NOT translate to D1 — authorization is app-layer (ADR 0016 §4,
//   AECI-254). This file carries data shape + integrity constraints only.

// Type-only, so it is erased before drizzle-kit's esbuild pass ever sees it and
// cannot create a runtime cycle: `lib/job-runs.ts` imports the `jobRuns` table
// value from here, never the reverse.
import type { AdminCronJob } from '@aeci/shared';
import { relations, sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// Shared column builders
// ---------------------------------------------------------------------------

const uuidPk = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString());

const updatedAt = () =>
  text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString())
    .$onUpdate(() => new Date().toISOString());

// ===========================================================================
// Health check (proves the per-request DB path — retained from AECI-28)
// ===========================================================================

export const healthCheck = sqliteTable('health_check', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  createdAt: createdAt(),
});

// ===========================================================================
// Core entities (§4)
// ===========================================================================

export const vendors = sqliteTable(
  'vendors',
  {
    id: uuidPk(),
    slug: text('slug').notNull(),
    companyName: text('company_name').notNull(),
    description: text('description'),
    website: text('website'),
    headquarters: text('headquarters'),
    foundedYear: integer('founded_year'),
    publicPrivate: text('public_private'),
    parentCompany: text('parent_company'),

    linkedinUrl: text('linkedin_url'),
    xUrl: text('x_url'),
    facebookUrl: text('facebook_url'),
    instagramUrl: text('instagram_url'),
    youtubeUrl: text('youtube_url'),
    crunchbaseUrl: text('crunchbase_url'),
    wikiUrl: text('wiki_url'),
    sourceUrl: text('source_url'),
    githubOrg: text('github_org'),
    phoneNumber: text('phone_number'),
    contactEmail: text('contact_email'),

    logoUrl: text('logo_url'),

    verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
    promotionStatus: text('promotion_status').notNull().default('pending'),
    adminNotes: text('admin_notes'),

    vqsCredibility: real('vqs_credibility'),
    vqsMomentum: real('vqs_momentum'),
    vqsFit: real('vqs_fit'),
    vqsTotal: real('vqs_total'),
    vqsComputedAt: text('vqs_computed_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('vendors_slug_key').on(t.slug),
    index('vendors_company_name_idx').on(t.companyName),
    index('vendors_promotion_status_idx').on(t.promotionStatus),
    index('vendors_verified_idx').on(t.verified),
    index('vendors_updated_at_idx').on(t.updatedAt),
    check('vendors_public_private_check', sql`"public_private" IN ('public', 'private')`),
    check(
      'vendors_promotion_status_check',
      sql`"promotion_status" IN ('pending', 'ready', 'promoted', 'retracted', 'rejected')`,
    ),
  ],
);

export const products = sqliteTable(
  'products',
  {
    id: uuidPk(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),

    description: text('description'),
    website: text('website'),
    toolIntegrationsUrl: text('tool_integrations_url'),
    apiDocsUrl: text('api_docs_url'),
    hasApiDocs: integer('has_api_docs', { mode: 'boolean' }).notNull().default(false),
    toolIntegrationCheckNotes: text('tool_integration_check_notes'),

    // Narrative "how teams use it" blob (§4.2); read whole, never queried by point.
    usefulness: text('usefulness', { mode: 'json' }).$type<unknown>(),

    productRole: text('product_role').notNull().default('application'),
    logoUrl: text('logo_url'),

    integrationCount: integer('integration_count').notNull().default(0),
    reviewCount: integer('review_count').notNull().default(0),
    ratingOverallAvg: real('rating_overall_avg'),
    ratingOnboardingAvg: real('rating_onboarding_avg'),

    researchStatus: text('research_status').notNull().default('pending'),
    researchNotes: text('research_notes'),
    promotionStatus: text('promotion_status').notNull().default('pending'),

    /**
     * First-promote timestamp, ISO-8601 (AECI-581 / `ADMIN_PANEL_SPEC.md` §13 D6).
     * **Set-once**, via `COALESCE("promoted_at", ?)` in `routes/promote.ts`'s update
     * branch — promote re-asserts `promotion_status='promoted'` on update too, so a
     * naive `promotedAt: now` there would mean *last* promoted and buy nothing over
     * `updated_at`.
     *
     * Nullable and unset for rows created before the column existed until
     * `scripts/ops/backfill-products-promoted-at.sql` runs on that tier; that
     * backfill is `:= created_at` and is **exact**, because promote is D1's only
     * INSERT path into `products` and retraction is a hard delete (§4's correction).
     * Which is also why the column buys nothing *today* — it is future-proofing
     * against a Tier-1 retract endpoint introducing a real un-promote → re-promote
     * cycle, after which `created_at` stops tracking go-live irrecoverably.
     */
    promotedAt: text('promoted_at'),

    priorityTier: text('priority_tier'),
    priorityScore: real('priority_score'),
    scoreComputedAt: text('score_computed_at'),

    googleTrendsIndex: integer('google_trends_index'),
    searchVolumeMonthly: integer('search_volume_monthly'),
    searchCheckedAt: text('search_checked_at'),

    redditMentions24mo: integer('reddit_mentions_24mo'),
    redditCheckedAt: text('reddit_checked_at'),

    adminNotes: text('admin_notes'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('products_slug_key').on(t.slug),
    index('products_name_idx').on(t.name),
    index('products_promotion_status_idx').on(t.promotionStatus),
    index('products_research_status_idx').on(t.researchStatus),
    index('products_priority_tier_idx').on(t.priorityTier),
    index('products_product_role_idx').on(t.productRole),
    index('products_updated_at_idx').on(t.updatedAt),
    check(
      'products_product_role_check',
      sql`"product_role" IN ('application', 'connector', 'hybrid')`,
    ),
    check(
      'products_research_status_check',
      sql`"research_status" IN ('pending', 'in_progress', 'done', 'blocked')`,
    ),
    check(
      'products_promotion_status_check',
      sql`"promotion_status" IN ('pending', 'ready', 'promoted', 'retracted', 'rejected')`,
    ),
    check(
      'products_priority_tier_check',
      sql`"priority_tier" IN ('tier_1', 'tier_2', 'tier_3', 'tier_4', 'tier_5')`,
    ),
    check('products_google_trends_check', sql`"google_trends_index" BETWEEN 0 AND 100`),
  ],
);

export const integrations = sqliteTable(
  'integrations',
  {
    id: uuidPk(),
    name: text('name'),

    sourceProductId: text('source_product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    targetProductId: text('target_product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),

    mechanismKind: text('mechanism_kind'),
    mechanismName: text('mechanism_name'),
    direction: text('direction'),

    builtByVendorId: text('built_by_vendor_id').references(() => vendors.id),
    poweredByProductId: text('powered_by_product_id').references(() => products.id),

    description: text('description'),
    listingUrl: text('listing_url'),
    docsUrl: text('docs_url'),
    website: text('website'),
    mechanismUrl: text('mechanism_url'),
    pricingModel: text('pricing_model'),
    maturity: text('maturity'),
    notes: text('notes'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('integrations_source_idx').on(t.sourceProductId),
    index('integrations_target_idx').on(t.targetProductId),
    index('integrations_mechanism_kind_idx').on(t.mechanismKind),
    index('integrations_updated_at_idx').on(t.updatedAt),
    index('integrations_built_by_idx')
      .on(t.builtByVendorId)
      .where(sql`"built_by_vendor_id" IS NOT NULL`),
    index('integrations_powered_by_idx')
      .on(t.poweredByProductId)
      .where(sql`"powered_by_product_id" IS NOT NULL`),
    check(
      'integrations_mechanism_kind_check',
      sql`"mechanism_kind" IN ('native', 'iPaaS', 'marketplace-app', 'api', 'webhook', 'partner')`,
    ),
    check('integrations_direction_check', sql`"direction" IN ('one-way', 'bidirectional')`),
    check('integrations_distinct_endpoints_check', sql`"source_product_id" <> "target_product_id"`),
  ],
);

// ===========================================================================
// Taxonomy (§5)
// ===========================================================================

export const taxonomyCategories = sqliteTable(
  'taxonomy_categories',
  {
    id: uuidPk(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    displayOrder: integer('display_order'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('taxonomy_categories_slug_key').on(t.slug)],
);

export const taxonomyAudiences = sqliteTable(
  'taxonomy_audiences',
  {
    id: uuidPk(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    displayOrder: integer('display_order'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('taxonomy_audiences_slug_key').on(t.slug)],
);

export const taxonomyPhases = sqliteTable(
  'taxonomy_phases',
  {
    id: uuidPk(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    displayOrder: integer('display_order'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('taxonomy_phases_slug_key').on(t.slug)],
);

// `trade` controlled vocabulary — the FOURTH taxonomy facet (STAGE_1_SPEC.md §5.5a,
// AECI-538/540): "what work does the company sell?". Mirrors `taxonomyPhases` and adds
// `aliases` exactly as `taxonomyDataObjects` does. Two deliberate divergences from its
// three sibling facets, both from docs/TRADES_VOCABULARY.md:
//   - `description` is NOT NULL — `/trades/:slug` ships as an SEO landing page, so copy
//     is part of the contract, not a later addition (the siblings seed it NULL, ADR 0008).
//   - `aliases` is dual-purpose (§4): the promote resolver matches an incoming trade
//     find-only by slug → name → alias (AECI-542, never find-or-create), AND AECI-545
//     flattens them into a searchable-only `trade_aliases` Algolia attribute so
//     "blacktop"/"glazier" reach the right products. It never drives ranking.
// Closed 34-term list; seeded from `apps/api/seed/trades.sql` (UUIDv5-by-slug,
// idempotent upsert, never deletes).
export const taxonomyTrades = sqliteTable(
  'taxonomy_trades',
  {
    id: uuidPk(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    displayOrder: integer('display_order'),
    aliases: text('aliases', { mode: 'json' }).$type<string[]>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('taxonomy_trades_slug_key').on(t.slug)],
);

// `data_object` controlled vocabulary (Stage 1.5 — STAGE_1_5_SPEC.md §6.1). Mirrors
// `taxonomyCategories` and adds `aliases`: resolver metadata (JSON array of alternate
// names) the promote ingest matches a claim's `dataObject` against, find-only by slug
// then alias (§6.2, AECI-297). Closed 20-term list; seeded from
// `apps/api/seed/data-objects.sql` (UUIDv5-by-slug, idempotent upsert).
export const taxonomyDataObjects = sqliteTable(
  'taxonomy_data_objects',
  {
    id: uuidPk(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    displayOrder: integer('display_order'),
    aliases: text('aliases', { mode: 'json' }).$type<string[]>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('taxonomy_data_objects_slug_key').on(t.slug)],
);

// ===========================================================================
// Claims & attestations (Stage 1.5 — STAGE_1_5_SPEC.md §3 / §6.1)
// ===========================================================================

// A claim asserts a `data_object` flows in a `direction` through one integration
// (mechanism) row — the integration row is the anchor (§3.1, ADR 0018). `direction`
// is stored relative to the row's own endpoints (A = source_product, B = target_product,
// §3.2). The unique `(integration_id, data_object_id, direction)` index is the claim's
// immutable identity AND the promote-ingest upsert target (§6.2).
export const claims = sqliteTable(
  'claims',
  {
    id: uuidPk(),
    integrationId: text('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    dataObjectId: text('data_object_id')
      .notNull()
      .references(() => taxonomyDataObjects.id, { onDelete: 'restrict' }),
    direction: text('direction').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('claims_identity_key').on(t.integrationId, t.dataObjectId, t.direction),
    // Pair-page read by data object (§8). Integration-id lookups are already served by
    // the leftmost prefix of `claims_identity_key`, so no separate integration index.
    index('claims_data_object_idx').on(t.dataObjectId),
    check('claims_direction_check', sql`"direction" IN ('a_to_b', 'b_to_a', 'both')`),
  ],
);

// An attestation records who affirms a claim (§3.3). In Stage 1.5 only `source: 'aeci'`
// is ever written; `vendor_a`/`vendor_b` and the `introduced_at`/`deprecated_at` version
// stamps are additive-and-dormant — present in the schema/contract, written by no 1.5
// code path (reserved for the Stage 2 portal + timeline). Agreement is computed from the
// attestation set, never stored (§3.4, `packages/shared/src/agreement.ts`).
export const attestations = sqliteTable(
  'attestations',
  {
    id: uuidPk(),
    claimId: text('claim_id')
      .notNull()
      .references(() => claims.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    asserted: integer('asserted', { mode: 'boolean' }).notNull().default(true),
    introducedAt: text('introduced_at'),
    deprecatedAt: text('deprecated_at'),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Active attestations for a claim (the §8 read). Partial on the dormant version
    // stamp so Stage 2 can retire an attestation without deleting its history.
    index('attestations_active_idx')
      .on(t.claimId)
      .where(sql`"deprecated_at" IS NULL`),
    check('attestations_source_check', sql`"source" IN ('aeci', 'vendor_a', 'vendor_b')`),
  ],
);

// ===========================================================================
// Join tables (§6) — composite PKs
// ===========================================================================

export const productCategories = sqliteTable(
  'product_categories',
  {
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => taxonomyCategories.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.categoryId] }),
    index('product_categories_category_idx').on(t.categoryId),
  ],
);

export const productAudiences = sqliteTable(
  'product_audiences',
  {
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    audienceId: text('audience_id')
      .notNull()
      .references(() => taxonomyAudiences.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.audienceId] }),
    index('product_audiences_audience_idx').on(t.audienceId),
  ],
);

export const productPhases = sqliteTable(
  'product_phases',
  {
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    phaseId: text('phase_id')
      .notNull()
      .references(() => taxonomyPhases.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.phaseId] }),
    index('product_phases_phase_idx').on(t.phaseId),
  ],
);

// Product ↔ trade join (AECI-538/540). Clone of `productPhases`. SPARSE BY DESIGN —
// a product is tagged only when it has trade-SPECIFIC value (trade-specific features,
// cost databases, templates, takeoff logic, or integrations). Horizontal platforms
// (Procore, Autodesk Build, Bluebeam) carry ZERO rows here, and most of the catalog
// will: TRADES_VOCABULARY.md §1.1 is the load-bearing constraint of the whole facet.
// Rows are written ONLY by the promote flow (AECI-542), never by the taxonomy seed.
export const productTrades = sqliteTable(
  'product_trades',
  {
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    tradeId: text('trade_id')
      .notNull()
      .references(() => taxonomyTrades.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.tradeId] }),
    index('product_trades_trade_idx').on(t.tradeId),
  ],
);

export const productVendors = sqliteTable(
  'product_vendors',
  {
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    vendorId: text('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.vendorId] }),
    index('product_vendors_vendor_idx').on(t.vendorId),
  ],
);

export const productExtensions = sqliteTable(
  'product_extensions',
  {
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    hostProductId: text('host_product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.hostProductId] }),
    index('product_extensions_host_idx').on(t.hostProductId),
    check('product_extensions_distinct_check', sql`"product_id" <> "host_product_id"`),
  ],
);

// ===========================================================================
// User and content (§7)
// ===========================================================================

// `id` is the same UUID as the Supabase `auth.users.id`. Under D1 (ADR 0016)
// there is NO cross-system FK/trigger — provisioning + erasure are app-layer
// seams (AECI-254). No app-generated default: the id is always supplied from
// the verified JWT `sub`.
export const profiles = sqliteTable(
  'profiles',
  {
    id: text('id').primaryKey(),
    displayName: text('display_name'),
    role: text('role').notNull().default('reviewer'),
    vendorId: text('vendor_id').references(() => vendors.id),
    workEmailVerified: integer('work_email_verified', { mode: 'boolean' }).notNull().default(false),
    trustTier: text('trust_tier').notNull().default('standard'),
    themePreference: text('theme_preference').notNull().default('system'),

    bannedAt: text('banned_at'),
    banReason: text('ban_reason'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('profiles_role_idx').on(t.role),
    index('profiles_vendor_idx')
      .on(t.vendorId)
      .where(sql`"vendor_id" IS NOT NULL`),
    index('profiles_banned_idx')
      .on(t.bannedAt)
      .where(sql`"banned_at" IS NOT NULL`),
    check('profiles_role_check', sql`"role" IN ('reviewer', 'admin', 'vendor_admin')`),
    check('profiles_trust_tier_check', sql`"trust_tier" IN ('standard', 'verified', 'trusted')`),
    check(
      'profiles_theme_preference_check',
      sql`"theme_preference" IN ('system', 'light', 'dark')`,
    ),
  ],
);

export const reviews = sqliteTable(
  'reviews',
  {
    id: uuidPk(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    reviewerId: text('reviewer_id').references(() => profiles.id, { onDelete: 'set null' }),
    /** Stamped when a review is GDPR-anonymized — the reviewer's profile is
     *  hard-deleted and `reviewer_id` is nulled in the same `DELETE /api/account`
     *  batch (`routes/account.ts`). A null `reviewer_id` with a null
     *  `anonymized_at` is a data-integrity defect the §23.1 daily data-quality
     *  job flags (AECI-241). */
    anonymizedAt: text('anonymized_at'),

    ratingOverall: integer('rating_overall').notNull(),
    ratingOnboarding: integer('rating_onboarding').notNull(),

    title: text('title').notNull(),
    body: text('body').notNull(),

    roleAtCompany: text('role_at_company'),
    yearsUsing: integer('years_using'),
    wouldRecommend: text('would_recommend'),
    /** Optional free-text reviewer firm/company (AECI-284). Powers the home
     *  credibility strip's distinct contributing-firms count (normalized
     *  `lower(trim(...))`, approved reviews only — see `home-stats.ts`). Not
     *  exposed on the public per-review API; admin-only for moderation context.
     *  GDPR-nulled in the same `DELETE /api/account` batch that nulls
     *  `reviewer_id` and stamps `anonymized_at` (`routes/account.ts`). */
    reviewerFirm: text('reviewer_firm'),

    status: text('status').notNull().default('pending'),
    rejectionReason: text('rejection_reason'),
    moderatedAt: text('moderated_at'),
    moderatedBy: text('moderated_by').references(() => profiles.id),
    toxicityScore: integer('toxicity_score'),

    verifiedWorkEmail: integer('verified_work_email', { mode: 'boolean' }).notNull().default(false),
    locale: text('locale').notNull().default('en-US'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('reviews_product_status_idx').on(t.productId, t.status),
    index('reviews_status_created_idx').on(t.status, t.createdAt),
    index('reviews_reviewer_idx')
      .on(t.reviewerId)
      .where(sql`"reviewer_id" IS NOT NULL`),
    uniqueIndex('reviews_unique_per_user_product')
      .on(t.productId, t.reviewerId)
      .where(sql`"reviewer_id" IS NOT NULL AND "status" <> 'archived'`),
    check('reviews_rating_overall_check', sql`"rating_overall" BETWEEN 1 AND 5`),
    check('reviews_rating_onboarding_check', sql`"rating_onboarding" BETWEEN 1 AND 5`),
    check(
      'reviews_role_at_company_check',
      sql`"role_at_company" IN ('practitioner', 'manager', 'IT', 'exec', 'other')`,
    ),
    check('reviews_would_recommend_check', sql`"would_recommend" IN ('yes', 'no', 'maybe')`),
    check('reviews_status_check', sql`"status" IN ('pending', 'approved', 'rejected', 'archived')`),
  ],
);

// ===========================================================================
// Operations and workflow (§8)
// ===========================================================================

export const vendorRequests = sqliteTable(
  'vendor_requests',
  {
    id: uuidPk(),
    kind: text('kind').notNull(),

    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),

    submitterEmail: text('submitter_email').notNull(),
    submitterName: text('submitter_name'),
    submitterRole: text('submitter_role'),

    domainMatch: text('domain_match').notNull().default('pending'),

    body: text('body').notNull(),
    sourceUrl: text('source_url'),

    status: text('status').notNull().default('open'),
    linearIssueId: text('linear_issue_id'),
    // AECI-261: the linked Linear issue's web permalink (issue.url), persisted so
    // /admin/requests can render a real link. Null until creation/webhook supplies it.
    linearIssueUrl: text('linear_issue_url'),

    // AECI-215 (Phase 6.8): self-FK to the earliest matching open request.
    duplicateOfRequestId: text('duplicate_of_request_id'),

    createdAt: createdAt(),
    resolvedAt: text('resolved_at'),
    resolvedById: text('resolved_by').references(() => profiles.id),
  },
  (t) => [
    foreignKey({
      columns: [t.duplicateOfRequestId],
      foreignColumns: [t.id],
      name: 'vendor_requests_duplicate_of_fk',
    }).onDelete('set null'),
    index('vendor_requests_status_idx').on(t.status),
    index('vendor_requests_target_idx').on(t.targetType, t.targetId),
    index('vendor_requests_created_at_idx').on(t.createdAt),
    check('vendor_requests_kind_check', sql`"kind" IN ('claim', 'correction')`),
    check('vendor_requests_target_type_check', sql`"target_type" IN ('product', 'vendor')`),
    check(
      'vendor_requests_domain_match_check',
      sql`"domain_match" IN ('pending', 'match', 'no_match', 'manual_review')`,
    ),
    check(
      'vendor_requests_status_check',
      sql`"status" IN ('open', 'in_review', 'resolved', 'rejected')`,
    ),
  ],
);

export const workflowInstances = sqliteTable(
  'workflow_instances',
  {
    id: uuidPk(),
    workflowType: text('workflow_type').notNull(),
    entityId: text('entity_id').notNull(),

    currentState: text('current_state').notNull(),
    linearIssueId: text('linear_issue_id'),

    initiatedBy: text('initiated_by').references(() => profiles.id),
    initiatedAt: text('initiated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    completedAt: text('completed_at'),
    finalOutcome: text('final_outcome'),
  },
  (t) => [
    index('workflow_instances_type_entity_idx').on(t.workflowType, t.entityId),
    index('workflow_instances_state_idx')
      .on(t.workflowType, t.currentState)
      .where(sql`"completed_at" IS NULL`),
    index('workflow_instances_linear_idx')
      .on(t.linearIssueId)
      .where(sql`"linear_issue_id" IS NOT NULL`),
    check(
      // 'reviewer_ban' (Phase 6.11 / AECI-218) was MISSING from the Postgres
      // baseline CHECK — the ban workflow would have CHECK-failed in prod. Added
      // here (the harness caught it). The app writes all four workflow types.
      'workflow_instances_type_check',
      sql`"workflow_type" IN ('vendor_claim', 'review_moderation', 'correction_request', 'reviewer_ban')`,
    ),
    check(
      'workflow_instances_final_outcome_check',
      sql`"final_outcome" IN ('approved', 'rejected', 'cancelled', 'completed')`,
    ),
  ],
);

export const workflowTransitions = sqliteTable(
  'workflow_transitions',
  {
    id: uuidPk(),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'cascade' }),

    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    actorId: text('actor_id').references(() => profiles.id),
    reason: text('reason'),
    metadata: text('metadata', { mode: 'json' }).$type<unknown>(),

    createdAt: createdAt(),
  },
  (t) => [index('workflow_transitions_workflow_idx').on(t.workflowId, t.createdAt)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: uuidPk(),

    actorId: text('actor_id').references(() => profiles.id),
    actorType: text('actor_type').notNull(),

    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),

    beforeState: text('before_state', { mode: 'json' }).$type<unknown>(),
    afterState: text('after_state', { mode: 'json' }).$type<unknown>(),
    metadata: text('metadata', { mode: 'json' }).$type<unknown>(),

    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.entityType, t.entityId, t.createdAt),
    index('audit_log_action_idx').on(t.action, t.createdAt),
    index('audit_log_created_at_idx').on(t.createdAt),
    index('audit_log_actor_idx')
      .on(t.actorId, t.createdAt)
      .where(sql`"actor_id" IS NOT NULL`),
    check(
      'audit_log_actor_type_check',
      sql`"actor_type" IN ('user', 'admin', 'system', 'workflow')`,
    ),
    // NOTE: audit_log.entity_type is intentionally UNCONSTRAINED (freeform) — the
    // app writes 'review', 'vendor_request', 'profile', etc. The entity_type CHECK
    // belongs to `translations`, not here (Postgres baseline §audit_log).
  ],
);

// ===========================================================================
// Analytics and caching (§9)
// ===========================================================================

export const pageViews = sqliteTable(
  'page_views',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    // `path` is the route the WRITER named: the pattern (`/products/:slug`) when it
    // knows one (an SSR resolver attached `ctx.pageView`), the concrete path
    // otherwise (the browser tracker, an SSR cache HIT). `concrete_path` is always
    // the real URL path — locale-stripped, no query or hash — so a taxonomy row can
    // say WHICH term was viewed even when nothing joins (AECI-585 / §7.3). The two
    // are stored side by side rather than one replacing the other: grouping "top
    // pages" wants the pattern, naming a row wants the concrete path.
    path: text('path').notNull(),
    concretePath: text('concrete_path'),

    productId: text('product_id').references(() => products.id),
    vendorId: text('vendor_id').references(() => vendors.id),

    // Which taxonomy term a facet browse page showed (AECI-585 / §7.3). The SSR
    // resolvers have always sent `entity_type: 'category'|'audience'|'phase'|'trade'`
    // plus the term id; ingest used to drop them, so ~600 rows could say a taxonomy
    // page was viewed but not which one.
    //
    // Two columns for four facets, and deliberately NOT a foreign key: SQLite cannot
    // point one column at four tables, and a hard FK would block ever deleting a term
    // (`lib/retract-product.ts` already has to delete `page_views` rows for exactly
    // that reason on products). Integrity comes from the ingest-time existence check
    // in `routes/page-views.ts` instead — an unknown id stores as null, never as a
    // lie. No CHECK on `taxonomy_kind` for the same reason the write is swallowed on
    // error: this is a log table, and a constraint violation would silently drop the
    // row. The value comes from a closed server-side map.
    taxonomyKind: text('taxonomy_kind'),
    taxonomyId: text('taxonomy_id'),

    // How the visitor got here (AECI-585 / §7.3): `'arrival'` = full-document load
    // (the SSR Worker's `firePageView`), `'spa'` = in-app navigation (the browser
    // `PageViewTracker`). Null = unknown — every row written before this shipped, and
    // any POST that omits it. NEVER inferred: the same-origin `Referer` on an SPA hop
    // classifies as `Direct`, which is precisely the conflation this column exists to
    // undo, so guessing would recreate the bug in a new column.
    navigation: text('navigation'),

    referrer: text('referrer'),

    // Campaign attribution (AECI-243 / §11.2). Populated only when a visitor
    // arrives via a tagged link (e.g. the waitlist launch email's
    // `?ref=waitlist&token=xyz`); null for ordinary views.
    refSource: text('ref_source'),
    refToken: text('ref_token'),

    cfCountry: text('cf_country'),
    cfColo: text('cf_colo'),
    cfAsn: integer('cf_asn'),
    // The AS *holder name* beside the number (AECI-585 / §13 D10), mirroring
    // `mailing_list.as_organization`. An ASN cannot label itself, so without this the
    // internal-traffic filter reads "excluding AS23700" and the bot classifier's
    // weekly audit is a list of bare numbers. `POST_LAUNCH_MONITORING.md` §3b names
    // holder-name capture as the durable fix for the bot/human split — "not a longer
    // list". READ-side signal only: it never feeds `is_bot` at ingest.
    cfAsOrganization: text('cf_as_organization'),
    cfBotScore: integer('cf_bot_score'),

    userAgentHash: text('user_agent_hash'),
    locale: text('locale'),

    // Traffic classification (AECI-526 follow-up). Set at ingest from the raw UA +
    // ASN (`lib/bot-classification.ts`) so the daily digest can report human-only
    // metrics and a crawler breakdown grouped by `bot_name`. Nullable: rows written
    // before the column existed read as human (`is_bot IS NOT 1`) until the one-time
    // ASN backfill (`scripts/ops/backfill-page-view-bots.sql`) classifies them.
    isBot: integer('is_bot', { mode: 'boolean' }),
    botName: text('bot_name'),

    // Traffic source (AECI-526 follow-up). Derived at ingest from the eyeball's
    // `Referer` (`lib/referrer-classification.ts`) so the digest can break arrivals
    // down by LinkedIn / Twitter/X / Google / other search engines / Direct / Other.
    // `referrer` (declared above) now stores the external referrer host (privacy: host
    // only, no path/query); `referrer_source` is the coarse label the digest groups on.
    // Null on rows captured before this shipped — not backfillable (the header was
    // never stored) — so those are excluded from the digest's Traffic-sources table.
    referrerSource: text('referrer_source'),

    // NOTE: `user_id`, `session_id` and `profile_role` were dropped by AECI-585
    // (§13 D7). All three were declared at init and never written by any code path,
    // and the decision was to drop rather than fill: there is no client-side session
    // id anywhere in `apps/web`, and minting one would create a durable first-party
    // identifier — exactly what makes this table's write defensible as
    // consent-independent today. `user_id` is reachable on the browser POST but never
    // on the SSR arrival path, so it would have been right half the time. `page_views`
    // now holds no user linkage at all, which is also the strongest form of the GDPR
    // erasure story (`AUTH_AND_RLS.md` §12). Do not reintroduce them.

    createdAt: createdAt(),
  },
  (t) => [
    index('page_views_path_idx').on(t.path, t.createdAt),
    index('page_views_country_idx').on(t.cfCountry, t.createdAt),
    index('page_views_product_idx')
      .on(t.productId, t.createdAt)
      .where(sql`"product_id" IS NOT NULL`),
    // Serves the digest's human/bot split + crawler grouping over a day window.
    index('page_views_bot_idx').on(t.isBot, t.createdAt),
    // No index on the AECI-585 columns: nothing groups or filters on them yet, and
    // `page_views` is the hottest write path in the app (D1 bills rows written,
    // indexes included). Add one with the read that needs it, not before.
  ],
);

export const statsCache = sqliteTable('stats_cache', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  computedAt: text('computed_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

/**
 * The admin panel's long memory (AECI-581 / `ADMIN_PANEL_SPEC.md` §7.1). One row
 * per (UTC day, metric): a narrow key-value shape mirroring `stats_cache`'s key
 * convention, so adding a metric never needs a migration.
 *
 * It exists because nothing else in D1 can answer "how many did we have on July
 * 3rd" (§4). `stats_cache` is overwritten by the 07:00 cron, so no history
 * survives; `audit_log` records genuine *additions* but not net totals — 827
 * `integration.created` events back 496 live rows, because the 2026-07-25 reset
 * removed rows without per-row audit. Written daily by the `snapshot` cron
 * (`lib/metrics-snapshot.ts`), which captures the prior COMPLETE UTC day.
 *
 * Three properties are load-bearing:
 *
 * **`source` is stored, not inferred.** §7.1 proposed marking a backfilled row
 * through its `computed_at`; that mislabels a legitimate late re-run of a missed
 * day, whose sources are still intact. The column yields one precedence rule the
 * cron and the backfill both obey: a `measured` write always wins, a
 * `reconstructed` write applies only over an absent or `reconstructed` row.
 *
 * **No `audit_log` row.** Derived bookkeeping, exempt from the §26.1
 * audit-in-batch invariant under ADR 0022 / §13 D11. Writes go per key, OUTSIDE
 * any batch, so one failing metric never aborts the others.
 *
 * **Retention is indefinite** (§7.4 / §13 D5). P3.2's pruning cron must never
 * touch this table, and must never prune raw `page_views` for a day it has not
 * captured.
 */
export const metricsDaily = sqliteTable(
  'metrics_daily',
  {
    /** `YYYY-MM-DD`, UTC. Text, so it sorts lexically = chronologically and can be
     *  compared directly against `substr(created_at, 1, 10)` elsewhere. */
    day: text('day').notNull(),
    /** One of `ADMIN_SNAPSHOT_METRIC_KEYS` (`@aeci/shared`). Deliberately NOT a
     *  CHECK constraint: the whole point of the key-value shape is that a new
     *  metric costs no migration, and a SQLite CHECK change forces a table rebuild. */
    metric: text('metric').notNull(),
    /** REAL so a future ratio/average metric needs no migration. Every metric in
     *  the vocabulary today is a count, so readers round. */
    value: real('value').notNull(),
    /** `measured` | `reconstructed` — see the docblock above. */
    source: text('source').notNull().default('measured'),
    computedAt: text('computed_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    // Leading `day` serves P3.2's "is this day captured?" probe.
    primaryKey({ columns: [t.day, t.metric] }),
    // The read pattern of GET /api/admin/metrics/timeseries: one metric, day range.
    index('metrics_daily_metric_day_idx').on(t.metric, t.day),
    check('metrics_daily_source_check', sql`"source" IN ('measured', 'reconstructed')`),
  ],
);

// ===========================================================================
// Cron bookkeeping (ADMIN_PANEL_SPEC.md §7.2)
//
// Derived, log-class, cron-written, and **exempt from the §26.1 audit-in-batch
// invariant under ADR 0022** — `job_runs` IS the observability record, so an
// `audit_log` row about it would be auditing the audit. Written per row,
// OUTSIDE any `db.batch`, each inside its own try/catch (`lib/job-runs.ts`),
// exactly as `stats_cache` is (`lib/home-stats.ts` `upsertStat`): a bookkeeping
// write must never abort the job it records.
// ===========================================================================

/**
 * One row per execution of one of the ten `scheduled.ts` cron jobs (§7.2).
 * The row is inserted on ENTRY and completed on EXIT, so a run the isolate never
 * came back from (CPU/wall-clock limit, eviction) stays durably visible as
 * `finished_at IS NULL` rather than vanishing — that unfinished row is the
 * signal, and it is lost if the row is only written on success.
 */
export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /**
     * An `AdminCronJob` id (`packages/shared/src/api/admin-panel.ts`) — the same
     * vocabulary `CRON_SCHEDULES` keys on and `GET /api/admin/system` renders,
     * NOT the internal `ScheduledJob` union `scheduled.ts` dispatches on
     * (`ADMIN_CRON_JOB` in `lib/cron-schedules.ts` is the mapping).
     *
     * Deliberately CHECK-free, following `audit_log.action`: the vocabulary grows
     * every time a cron is added and SQLite cannot ALTER a CHECK, so a ninth cron
     * would need a table-recreate migration. The `Record<ScheduledJob, …>` map and
     * the Zod enum are the enforcement; this column is the storage.
     */
    job: text('job').notNull().$type<AdminCronJob>(),

    startedAt: text('started_at').notNull(),

    /** Null while the run is in flight — and PERMANENTLY null if the isolate was
     *  reclaimed mid-run. See the table doc above. */
    finishedAt: text('finished_at'),

    /**
     * Null while in flight; one of the three terminal values after.
     *
     * There is deliberately **no `'running'` member**: in-flight is already
     * representable as `finished_at IS NULL AND outcome IS NULL`, and a second
     * encoding of the same state would let the two disagree. It also assigns
     * straight into `AdminCronRunSchema.last_outcome` with no translation.
     *
     * NULL passes the CHECK below — SQLite satisfies a CHECK when the expression
     * is true *or* NULL, and `NULL IN (…)` is NULL. Same construction as
     * `vendors.public_private`.
     */
    outcome: text('outcome').$type<'ok' | 'failed' | 'skipped'>(),

    /** Per-job payload: the data-quality run's full `DataQualityCheckResult[]`,
     *  the 09:00 run's drift + orphan-sweep result, the reconcile counts. Typed
     *  `unknown` at the schema layer (as `stats_cache.value` and
     *  `audit_log.metadata` are) because every reader crosses a process boundary
     *  and must parse rather than assume; `JobRunDetail` in `lib/job-runs.ts` is
     *  the writer's shape and the typed accessors there are the readers'. */
    detail: text('detail', { mode: 'json' }).$type<unknown>(),
  },
  (t) => [
    // §7.2's `INDEX (job, started_at)`. Serves the read side's "newest run per
    // job" as an equality seek + descending scan of one job's slice
    // (`SEARCH … USING INDEX (job=?)` + LIMIT 1, eight rows read regardless of
    // table size) and the §7.4 prune's cutoff scan.
    index('job_runs_job_started_at_idx').on(t.job, t.startedAt),
    check('job_runs_outcome_check', sql`"outcome" IN ('ok', 'failed', 'skipped')`),
  ],
);

// ===========================================================================
// Future-ready (§10)
// ===========================================================================

export const translations = sqliteTable(
  'translations',
  {
    id: uuidPk(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    locale: text('locale').notNull(),
    field: text('field').notNull(),
    value: text('value').notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('translations_entity_type_entity_id_locale_field_key').on(
      t.entityType,
      t.entityId,
      t.locale,
      t.field,
    ),
    index('translations_lookup_idx').on(t.entityType, t.entityId, t.locale),
    // NOTE (AECI-540): 'trade' is deliberately NOT in this list. The trade facet is
    // resolve-only at promote time, so no runtime path writes a translation for one,
    // and this table has no writer at all today (en-US only at launch — §7a). Adding a
    // value to a SQLite CHECK forces a full table rebuild, so it is deferred to
    // whichever issue actually wires i18n for taxonomy terms — add 'trade' there.
    check(
      'translations_entity_type_check',
      sql`"entity_type" IN ('product', 'vendor', 'category', 'audience', 'phase', 'integration')`,
    ),
  ],
);

// ===========================================================================
// Lead-capture tables (pre-AECI). Written by the API Worker's POST /api/feedback
// + /api/subscribe handlers (routes/landing-forms.ts) on D1 (AECI-257) — NOT via
// Supabase/PostgREST. The pre-launch apps/landing Worker was the original caller;
// it was retired at the apex cutover (AECI-247/277), so the sole caller is now the
// unified home's closing-CTA island (apps/web). Out of scope for the AECI Stage 1
// spec; modeled here because they share the D1 database (ADR 0016).
// ===========================================================================

export const feedback = sqliteTable(
  'feedback',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    features: text('features'),
    tools: text('tools'),
    email: text('email'),
    subscribed: integer('subscribed', { mode: 'boolean' }).notNull().default(false),
    country: text('country'),
    city: text('city'),
    region: text('region'),
    timezone: text('timezone'),
    referrer: text('referrer'),
    createdAt: createdAt(),
  },
  // AECI-586: this table's first index, added with its first read surface
  // (`GET /api/admin/feedback`), which orders the whole inbox by `created_at`.
  // `page_views` and `audit_log` have carried the equivalent since 0000.
  (t) => [index('feedback_created_at_idx').on(t.createdAt)],
);

export const mailingList = sqliteTable(
  'mailing_list',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull(),
    country: text('country'),
    city: text('city'),
    region: text('region'),
    timezone: text('timezone'),
    asOrganization: text('as_organization'),
    asn: integer('asn'),
    metroCode: integer('metro_code'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    referrer: text('referrer'),
    // Opaque per-subscriber unsubscribe token (AECI-537). Set on insert
    // (`crypto.randomUUID()`); backfilled for pre-existing rows via the 0006
    // migration. Powers the `/unsubscribe?token=…` page link + the RFC 8058
    // one-click `List-Unsubscribe-Post` header on the welcome email.
    unsubscribeToken: text('unsubscribe_token'),
    // Soft-delete / suppression (AECI-537). Null = active subscriber; an
    // ISO-8601 timestamp = opted out (never re-emailed). A resubscribe clears
    // this back to null (`createSubscribeHandler` reactivation path).
    unsubscribedAt: text('unsubscribed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mailing_list_email_key').on(t.email),
    uniqueIndex('mailing_list_unsubscribe_token_key').on(t.unsubscribeToken),
    // AECI-586: the §5.4 Audience section buckets signups by day on `created_at`
    // and churn by day on `unsubscribed_at`, and computes the active population
    // at a window boundary from both. Without these every one of those is a full
    // scan — the two lead-capture tables were the only ones in the schema with no
    // `created_at` index at all.
    index('mailing_list_created_at_idx').on(t.createdAt),
    index('mailing_list_unsubscribed_at_idx').on(t.unsubscribedAt),
  ],
);

// ===========================================================================
// Relations — power the Drizzle relational query builder (`db.query.*`), which
// hydrates nested rows the way Prisma `select`/`include` did. Multi-FK targets
// (a product referenced by both source/target on integrations; reviewer vs
// moderator on reviews) carry an explicit `relationName` matching the old
// Prisma `@relation("…")` so the two sides disambiguate.
// ===========================================================================

export const vendorsRelations = relations(vendors, ({ many }) => ({
  productVendors: many(productVendors),
  builtIntegrations: many(integrations, { relationName: 'IntegrationBuiltByVendor' }),
}));

export const productsRelations = relations(products, ({ many }) => ({
  productVendors: many(productVendors),
  productCategories: many(productCategories),
  productAudiences: many(productAudiences),
  productPhases: many(productPhases),
  productTrades: many(productTrades),
  reviews: many(reviews),
  sourceIntegrations: many(integrations, { relationName: 'IntegrationSource' }),
  targetIntegrations: many(integrations, { relationName: 'IntegrationTarget' }),
  // Integrations this product POWERS as the connector/mechanism (Stage 1.5
  // Addendum B) — the inverse of `integrations.poweredByProduct`, so the
  // product detail query can hydrate a connector's edges.
  poweredIntegrations: many(integrations, { relationName: 'IntegrationPoweredByProduct' }),
}));

export const integrationsRelations = relations(integrations, ({ one, many }) => ({
  sourceProduct: one(products, {
    fields: [integrations.sourceProductId],
    references: [products.id],
    relationName: 'IntegrationSource',
  }),
  targetProduct: one(products, {
    fields: [integrations.targetProductId],
    references: [products.id],
    relationName: 'IntegrationTarget',
  }),
  builtByVendor: one(vendors, {
    fields: [integrations.builtByVendorId],
    references: [vendors.id],
    relationName: 'IntegrationBuiltByVendor',
  }),
  poweredByProduct: one(products, {
    fields: [integrations.poweredByProductId],
    references: [products.id],
    relationName: 'IntegrationPoweredByProduct',
  }),
  // Stage 1.5 (§6.1): claims anchor to the mechanism row. Relations-only — no
  // `integrations`-table change — so the pair page can hydrate claims per integration.
  claims: many(claims),
}));

export const taxonomyCategoriesRelations = relations(taxonomyCategories, ({ many }) => ({
  productCategories: many(productCategories),
}));
export const taxonomyAudiencesRelations = relations(taxonomyAudiences, ({ many }) => ({
  productAudiences: many(productAudiences),
}));
export const taxonomyPhasesRelations = relations(taxonomyPhases, ({ many }) => ({
  productPhases: many(productPhases),
}));
export const taxonomyTradesRelations = relations(taxonomyTrades, ({ many }) => ({
  productTrades: many(productTrades),
}));

export const taxonomyDataObjectsRelations = relations(taxonomyDataObjects, ({ many }) => ({
  claims: many(claims),
}));
export const claimsRelations = relations(claims, ({ one, many }) => ({
  integration: one(integrations, {
    fields: [claims.integrationId],
    references: [integrations.id],
  }),
  dataObject: one(taxonomyDataObjects, {
    fields: [claims.dataObjectId],
    references: [taxonomyDataObjects.id],
  }),
  attestations: many(attestations),
}));
export const attestationsRelations = relations(attestations, ({ one }) => ({
  claim: one(claims, { fields: [attestations.claimId], references: [claims.id] }),
}));

export const productCategoriesRelations = relations(productCategories, ({ one }) => ({
  product: one(products, { fields: [productCategories.productId], references: [products.id] }),
  category: one(taxonomyCategories, {
    fields: [productCategories.categoryId],
    references: [taxonomyCategories.id],
  }),
}));
export const productAudiencesRelations = relations(productAudiences, ({ one }) => ({
  product: one(products, { fields: [productAudiences.productId], references: [products.id] }),
  audience: one(taxonomyAudiences, {
    fields: [productAudiences.audienceId],
    references: [taxonomyAudiences.id],
  }),
}));
export const productPhasesRelations = relations(productPhases, ({ one }) => ({
  product: one(products, { fields: [productPhases.productId], references: [products.id] }),
  phase: one(taxonomyPhases, {
    fields: [productPhases.phaseId],
    references: [taxonomyPhases.id],
  }),
}));
export const productTradesRelations = relations(productTrades, ({ one }) => ({
  product: one(products, { fields: [productTrades.productId], references: [products.id] }),
  trade: one(taxonomyTrades, {
    fields: [productTrades.tradeId],
    references: [taxonomyTrades.id],
  }),
}));

export const productVendorsRelations = relations(productVendors, ({ one }) => ({
  product: one(products, { fields: [productVendors.productId], references: [products.id] }),
  vendor: one(vendors, { fields: [productVendors.vendorId], references: [vendors.id] }),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
  product: one(products, { fields: [reviews.productId], references: [products.id] }),
  reviewer: one(profiles, {
    fields: [reviews.reviewerId],
    references: [profiles.id],
    relationName: 'ReviewReviewer',
  }),
  moderator: one(profiles, {
    fields: [reviews.moderatedBy],
    references: [profiles.id],
    relationName: 'ReviewModerator',
  }),
}));

export const workflowInstancesRelations = relations(workflowInstances, ({ many }) => ({
  transitions: many(workflowTransitions),
}));
export const workflowTransitionsRelations = relations(workflowTransitions, ({ one }) => ({
  workflow: one(workflowInstances, {
    fields: [workflowTransitions.workflowId],
    references: [workflowInstances.id],
  }),
}));

// ---------------------------------------------------------------------------
// Aggregate export — passed to `drizzle(env.DB, { schema })` so the relational
// query builder + types are available app-wide.
// ---------------------------------------------------------------------------

export const schema = {
  healthCheck,
  vendors,
  products,
  integrations,
  taxonomyCategories,
  taxonomyAudiences,
  taxonomyPhases,
  taxonomyTrades,
  taxonomyDataObjects,
  claims,
  attestations,
  productCategories,
  productAudiences,
  productPhases,
  productTrades,
  productVendors,
  productExtensions,
  profiles,
  reviews,
  vendorRequests,
  workflowInstances,
  workflowTransitions,
  auditLog,
  pageViews,
  statsCache,
  jobRuns,
  translations,
  feedback,
  mailingList,
  // relations
  vendorsRelations,
  productsRelations,
  integrationsRelations,
  taxonomyCategoriesRelations,
  taxonomyAudiencesRelations,
  taxonomyPhasesRelations,
  taxonomyTradesRelations,
  taxonomyDataObjectsRelations,
  claimsRelations,
  attestationsRelations,
  productCategoriesRelations,
  productAudiencesRelations,
  productPhasesRelations,
  productTradesRelations,
  productVendorsRelations,
  reviewsRelations,
  workflowInstancesRelations,
  workflowTransitionsRelations,
};

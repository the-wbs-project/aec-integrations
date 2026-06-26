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
    path: text('path').notNull(),
    productId: text('product_id').references(() => products.id),
    vendorId: text('vendor_id').references(() => vendors.id),
    userId: text('user_id').references(() => profiles.id),
    sessionId: text('session_id'),
    referrer: text('referrer'),

    // Campaign attribution (AECI-243 / §11.2). Populated only when a visitor
    // arrives via a tagged link (e.g. the waitlist launch email's
    // `?ref=waitlist&token=xyz`); null for ordinary views.
    refSource: text('ref_source'),
    refToken: text('ref_token'),

    cfCountry: text('cf_country'),
    cfColo: text('cf_colo'),
    cfAsn: integer('cf_asn'),
    cfBotScore: integer('cf_bot_score'),

    userAgentHash: text('user_agent_hash'),
    locale: text('locale'),

    profileRole: text('profile_role'),

    createdAt: createdAt(),
  },
  (t) => [
    index('page_views_path_idx').on(t.path, t.createdAt),
    index('page_views_country_idx').on(t.cfCountry, t.createdAt),
    index('page_views_product_idx')
      .on(t.productId, t.createdAt)
      .where(sql`"product_id" IS NOT NULL`),
    index('page_views_user_idx')
      .on(t.userId, t.createdAt)
      .where(sql`"user_id" IS NOT NULL`),
  ],
);

export const statsCache = sqliteTable('stats_cache', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  computedAt: text('computed_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

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
    check(
      'translations_entity_type_check',
      sql`"entity_type" IN ('product', 'vendor', 'category', 'audience', 'phase', 'integration')`,
    ),
  ],
);

// ===========================================================================
// Landing-page tables (pre-AECI). Written by apps/landing via PostgREST, NOT by
// the API Worker. Modeled here for completeness; the landing write path's
// cut-over (or retention on Supabase) is tracked separately (ADR 0016 Phase 5/6).
// ===========================================================================

export const feedback = sqliteTable('feedback', {
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
});

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
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('mailing_list_email_key').on(t.email)],
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
  reviews: many(reviews),
  sourceIntegrations: many(integrations, { relationName: 'IntegrationSource' }),
  targetIntegrations: many(integrations, { relationName: 'IntegrationTarget' }),
}));

export const integrationsRelations = relations(integrations, ({ one }) => ({
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
  productCategories,
  productAudiences,
  productPhases,
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
  productCategoriesRelations,
  productAudiencesRelations,
  productPhasesRelations,
  productVendorsRelations,
  reviewsRelations,
  workflowInstancesRelations,
  workflowTransitionsRelations,
};

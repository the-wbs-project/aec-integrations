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

/**
 * The maintenance-marker pair (AECI-616 / `STAGE_2_ATTESTATIONS_SPEC.md` §13), on
 * `vendors` / `products` / `integrations`.
 *
 * `last_reviewed_at` is when a human LAST ACTUALLY RE-CHECKED the record — a
 * falsifiable claim the marker renders to readers. It is deliberately a **plain
 * column**: no `$defaultFn`, and above all **no `$onUpdate`**, unlike `updatedAt()`
 * directly above. It is written by exactly two paths — an explicit `lastReviewedAt`
 * in the promote payload, and a vendor attestation — and by nothing else.
 *
 * Never source it from `updated_at`, `created_at`, or `promoted_at`, and never
 * backfill it from them. `updated_at` restamps on ANY write and promote re-asserts
 * `promotion_status` on every re-promote, so in production 60 products share one
 * `updated_at` day and 40 share another: it is a bulk-sweep timestamp wearing a
 * freshness costume, which is the exact failure the marker exists to expose.
 */
const lastReviewedAt = () => text('last_reviewed_at');

/** Who is on the hook for the record's accuracy. `'vendor'` is reachable only via
 *  a live vendor attestation (AECI-301); promote must never write this column, or a
 *  routine Airtable push would silently un-vendor a record. */
const maintainedBy = () => text('maintained_by').notNull().default('aeci');

/** The CHECK companion to {@link maintainedBy}, so the three tables can't drift. */
const maintainedByCheck = (
  table: 'vendors' | 'products' | 'integrations' | 'connector_evidenced_pairs',
) => check(`${table}_maintained_by_check`, sql`"maintained_by" IN ('aeci', 'vendor')`);

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

    lastReviewedAt: lastReviewedAt(),
    maintainedBy: maintainedBy(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('vendors_slug_key').on(t.slug),
    maintainedByCheck('vendors'),
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

    lastReviewedAt: lastReviewedAt(),
    maintainedBy: maintainedBy(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('products_slug_key').on(t.slug),
    maintainedByCheck('products'),
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

    lastReviewedAt: lastReviewedAt(),
    maintainedBy: maintainedBy(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    maintainedByCheck('integrations'),
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
// Product versions (Stage 2 migration 2 — STAGE_2_ATTESTATIONS_SPEC.md §8 /
// AECI-607). Declared BEFORE `attestations` because that table's version-stamp
// FKs reference it.
// ===========================================================================

// A release of one product, as the vendor names it. The entity AECI-303's
// "source-version × target-version" diff needs and that the dormant
// `attestations.introduced_at` / `deprecated_at` ISO dates cannot stand in for:
// dates cannot answer "what flowed between Procore 2026.1 and BIM 360 v5".
//
// `sort_key` is the load-bearing column and it is NOT optional (§8.2). Version
// labels do not sort lexically — `'2026.10' < '2026.9'` as strings, and
// `'v10' < 'v9'` — so every ordering, every before/after comparison in §9, and
// the "latest" default key off this INTEGER, never off `label` and never off the
// nullable `released_at`. `@aeci/shared/version-sort` owns the derivation
// (`deriveVersionSortKey`) and the comparator; the write API derives on create
// and accepts an explicit override for labels the packer cannot read.
//
// **Authority (§8.2).** A version stamped by an attestation always belongs to the
// ATTESTING SIDE'S OWN endpoint product — a `vendor_a` attestation stamps
// versions of product A. That keeps versioning inside the same boundary as §2.1,
// so no vendor can assert anything about the counterparty's release history. The
// FK alone cannot express it; the §5 write path enforces it through
// `resolveAttestationSlots` (`lib/attestation-authority.ts`).
//
// Vendor-authored only at launch: promote does not ingest versions (§8.3 / §11).
export const productVersions = sqliteTable(
  'product_versions',
  {
    id: uuidPk(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    releasedAt: text('released_at'),
    sunsetAt: text('sunset_at'),
    sortKey: integer('sort_key').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Label identity within a product. Two products may both ship a `v5.2`.
    uniqueIndex('product_versions_label_key').on(t.productId, t.label),
    // The ordered read (§8.2). Product-id lookups ride the leftmost prefix of
    // either index; this one also serves the ORDER BY.
    index('product_versions_order_idx').on(t.productId, t.sortKey),
  ],
);

// ===========================================================================
// Claims & attestations (Stage 1.5 — STAGE_1_5_SPEC.md §3 / §6.1;
// provenance + authority added by Stage 2 migration 1 —
// STAGE_2_ATTESTATIONS_SPEC.md §2 / AECI-603)
// ===========================================================================

// A claim asserts a `data_object` flows in a `direction` through one integration
// (mechanism) row — the integration row is the anchor (§3.1, ADR 0018). `direction`
// is stored relative to the row's own endpoints (A = source_product, B = target_product,
// §3.2). The unique `(integration_id, data_object_id, direction)` index is the claim's
// immutable identity AND the promote-ingest upsert target (§6.2).
//
// `origin` + `created_by_vendor_id` are the Stage 2 provenance pair
// (STAGE_2_ATTESTATIONS_SPEC.md §2.2). They exist for WRITE ARBITRATION — promote
// replaces AECi curation without touching vendor-created rows (§3) — and for the AECi
// ops view. Provenance is deliberately NOT a reader-facing trust badge: a
// vendor-created claim renders through the same agreement states as an AECi-seeded one.
// The biconditional `origin = 'vendor' ⟺ created_by_vendor_id IS NOT NULL` is a
// two-column invariant enforced in ONE place in application code
// (`lib/attestation-authority.ts`), not by a DB CHECK.
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
    origin: text('origin').notNull().default('aeci'),
    // SET NULL, not cascade: losing the vendor row must not silently delete the claim.
    // The claim survives as an orphan for AECi to re-curate.
    createdByVendorId: text('created_by_vendor_id').references(() => vendors.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('claims_identity_key').on(t.integrationId, t.dataObjectId, t.direction),
    // Pair-page read by data object (§8). Integration-id lookups are already served by
    // the leftmost prefix of `claims_identity_key`, so no separate integration index.
    index('claims_data_object_idx').on(t.dataObjectId),
    check('claims_direction_check', sql`"direction" IN ('a_to_b', 'b_to_a', 'both')`),
    check('claims_origin_check', sql`"origin" IN ('aeci', 'vendor')`),
  ],
);

// An attestation records who affirms a claim (§3.3). Agreement is computed from the
// attestation set, never stored (§3.4, `packages/shared/src/agreement.ts`).
//
// `vendor_a` / `vendor_b` stopped being dormant with the Stage 2 attestations epic
// (AECI-514): which slot a caller may write is derived from product ownership in
// `product_vendors`, never from the request — `lib/attestation-authority.ts` is the
// single implementation of that rule (STAGE_2_ATTESTATIONS_SPEC.md §2.1).
// `attested_by_vendor_id` records WHICH vendor identity filled the slot, because
// `confirmed` requires two DISTINCT identities (§4) — one company owning both endpoints
// of an integration must never render as bilateral agreement.
//
// Two lifecycle columns that are easy to conflate and must not be:
//   - `introduced_at` / `deprecated_at` are VERSION STAMPS (§3.3) — "this flow existed
//     from v4 until v6". They say nothing about whether the attestation still stands.
//   - `retracted_at` is SUPERSESSION — the vendor withdrew or replaced its assertion.
// Supersession is retract-then-insert, never UPDATE, so the history stays append-only
// for the §9 timeline. Only `retracted_at` may gate the read path.
//
// `introduced_version_id` / `deprecated_version_id` (Stage 2 migration 2, §8.2) are the
// PRECISE form of those version stamps, and they sit ALONGSIDE the ISO dates rather than
// replacing them: the dates stay the coarse fallback for claims carrying no version data,
// which is every claim promote has ever written. The referenced version must belong to the
// attesting side's own endpoint product — see the `productVersions` header.

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
    // SET NULL, not cascade: deleting a version must degrade the stamp to "no
    // version data" (the row falls back to the ISO dates), never delete the
    // vendor's assertion.
    introducedVersionId: text('introduced_version_id').references(() => productVersions.id, {
      onDelete: 'set null',
    }),
    deprecatedVersionId: text('deprecated_version_id').references(() => productVersions.id, {
      onDelete: 'set null',
    }),
    retractedAt: text('retracted_at'),
    // SET NULL rather than cascade — see the claims note; the historical assertion
    // survives for the §9 timeline even if the vendor row goes away.
    attestedByVendorId: text('attested_by_vendor_id').references(() => vendors.id, {
      onDelete: 'set null',
    }),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One LIVE attestation per slot (§2.1). Partial so retract-then-insert works: any
    // number of retracted rows may share a slot, exactly one non-retracted row may.
    // This is what makes last-write-wins explicit when two accounts on the same vendor
    // target the same slot, instead of silently accumulating duplicate votes.
    uniqueIndex('attestations_slot_key')
      .on(t.claimId, t.source)
      .where(sql`"retracted_at" IS NULL`),
    // Live attestations for a claim (the §8 read). Predicated on `retracted_at`, NOT on
    // the `deprecated_at` version stamp — a vendor recording that a flow was deprecated
    // in v6 must not make the attestation vanish from the read path (AECI-303 reads it).
    index('attestations_active_idx')
      .on(t.claimId)
      .where(sql`"retracted_at" IS NULL`),
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
    /**
     * "This account proved control of an address on the vendor's own registrable
     * domain." Written ONLY by the seat-invite redeem (`routes/seat-invites.ts`),
     * which evaluates `computeDomainMatch` against the address actually being
     * redeemed — at REDEEM time, because the invite-time domain gate was removed
     * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11a.3) and an invited address may now
     * legitimately be off-domain. An off-domain redeem leaves it alone; nothing
     * ever clears it. Read by a human on the admin claim queue while deciding
     * whether a claimant really works there, which is why it must track the
     * address rather than the mere fact that a redeem happened.
     */
    workEmailVerified: integer('work_email_verified', { mode: 'boolean' }).notNull().default(false),
    /**
     * The owner/admin distinction `STAGE_2_VENDOR_PORTAL_SPEC.md` §11 deferred,
     * activated by AECI-664 (§11a). Meaningful ONLY on a `vendor_admin` row; it
     * is inert noise on a `reviewer`/`admin` profile and nothing reads it there.
     *
     * `true` = this seat may invite colleagues and remove seats. Set by
     * `grantSeatStatements` (an AECi-reviewed claim grant IS the owner event) and
     * cleared by `revokeSeatStatements`; a seat created by ACCEPTING an invite
     * gets `false`, which is what stops an unbounded transitive invite chain from
     * one reviewed human.
     *
     * The `0020` migration backfills every pre-existing `vendor_admin` to `true`
     * — they were all admin-granted, and a default-`false` rollout would ship the
     * invite feature dead (nobody could invite anyone).
     */
    seatOwner: integer('seat_owner', { mode: 'boolean' }).notNull().default(false),
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

/**
 * Vendor entitlements (AECI-609 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §2). The real
 * paid-tier model. `vendors.verified` is demoted to a DENORMALIZED MIRROR of this
 * table, so the five shipped readers (the public `?verified=` filter,
 * `VendorLinkSchema`, `VendorDetail`/`VendorListItem`, the Algolia vendor record,
 * `aec-verified-badge`) are untouched by the epic (§2.4/§2.5).
 *
 * THE MIRROR INVARIANT (§2.1): `vendors.verified = true` IFF this table holds a row
 * for the vendor with `status = 'active'`. `vendor_id` is UNIQUE, so that predicate
 * is a single-row test — and both sides move inside ONE `db.batch([...])` emitted by
 * `lib/vendor-entitlement.ts`, the SOLE writer of either side. No route handler
 * writes `vendors.verified` directly: an ESLint `no-restricted-syntax` rule is the
 * compile-time guard, and the `entitlement_mirror_drift` data-quality check (04:00
 * UTC) is the run-time guard that catches what lint cannot — hand-written D1 SQL
 * against a tier, the `apps/datatool` worker, and a backfill that ran on staging but
 * not demo.
 *
 * ONE ROW PER VENDOR, not a period history. The invariant has to be expressible as a
 * guarded single-row `UPDATE … WHERE status <> 'active'`, because D1 has no
 * interactive transactions and a read-then-write is a race with no available fix.
 * With history rows the predicate becomes `MAX(period_end)` over N rows, which is not
 * something you can put in a `WHERE`. `audit_log` IS the history ledger:
 * `audit_log_entity_idx` is `(entity_type, entity_id, created_at)`, so
 * `entity_type = 'vendor_entitlement', entity_id = <vendor_id>` yields the whole
 * grant/renew/lapse trail with no new index and no new reader. If finance later wants
 * a queryable term history, an append-only `vendor_entitlement_periods` child table is
 * purely additive and changes no reader.
 *
 * `tier` is DELIBERATELY UNCONSTRAINED — the `audit_log.entity_type` posture, NOT the
 * `workflow_instances_type_check` one three tables down. Adding a tier rung must be a
 * data edit in the capability registry (`@aeci/shared/entitlements`, §3.1), never a
 * SQLite table rebuild; an unknown tier resolves to ZERO capabilities (fail-closed),
 * which is strictly safer than a write-time CHECK failure. `status` IS CHECK
 * constrained: adding a status is a state-machine change, so it is a code change
 * anyway. Only `active` mirrors — `pending` is "arrangement recorded, PO issued, not
 * yet effective", `expired` is an amicable lapse, `revoked` is for cause.
 *
 * NO `workflow_instances` ROW is written for an entitlement change, deliberately:
 * `workflow_instances_type_check` (below) is a CLOSED check and opening it on SQLite
 * is a full table rebuild (§1.2 / R1). Settled here so §5 never has to discover it.
 *
 * `granted_by` is one of the eight inbound FKs to `profiles.id` — `ON DELETE SET NULL`
 * AND nulled explicitly in the `DELETE /api/account` erasure batch (`routes/account.ts`;
 * `docs/AUTH_AND_RLS.md` §8, which is the live register). Miss either and account
 * deletion FK-fails for any admin who ever granted an entitlement (R6).
 */
export const vendorEntitlements = sqliteTable(
  'vendor_entitlements',
  {
    id: uuidPk(),
    vendorId: text('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),

    /** Capability-registry tier id (§3.1). Unconstrained on purpose — see header. */
    tier: text('tier').notNull().default('verified'),
    status: text('status').notNull().default('active'),

    /** ISO-8601. `period_start` null = open-ended; `period_end` null = PERPETUAL
     *  (what the §2.4 backfill writes), which the partial expiry index ignores. */
    periodStart: text('period_start'),
    periodEnd: text('period_end'),

    /** The offline PO/invoice arrangement — a superset of `ClaimEntitlementSchema`
     *  (`packages/shared/src/api/admin-claims.ts`). `amount` stays TEXT, not `real`:
     *  free-form and currency-agnostic ("USD 5,000 / yr"), matching the shipped
     *  contract and keeping the model payer-agnostic (§8.1(4)). */
    payer: text('payer'),
    amount: text('amount'),
    terms: text('terms'),
    arrangedBy: text('arranged_by'),
    invoiceRef: text('invoice_ref'),
    notes: text('notes'),

    grantedBy: text('granted_by').references(() => profiles.id, { onDelete: 'set null' }),
    grantedAt: text('granted_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    /** Stamped when `status` leaves `'active'`. */
    endedAt: text('ended_at'),
    /** The §7 expiry cron's idempotency fence — one notice per term, not per night. */
    expiryNoticeSentAt: text('expiry_notice_sent_at'),

    /** The claim this arrangement came from, when it came from one (§6). NO ACTION:
     *  nothing in the app deletes a `vendor_requests` row (erasure nulls
     *  `resolved_by`, it does not delete). */
    sourceRequestId: text('source_request_id').references(() => vendorRequests.id),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The STRUCTURAL half of the mirror invariant: one row per vendor is what makes
    // `status = 'active'` a legal single-row `WHERE`.
    uniqueIndex('vendor_entitlements_vendor_key').on(t.vendorId),
    index('vendor_entitlements_status_idx').on(t.status),
    // The §7 cron's ONLY scan. PARTIAL, so perpetual + backfilled rows (null
    // `period_end`) and every non-active row are invisible to it.
    index('vendor_entitlements_expiry_idx')
      .on(t.periodEnd)
      .where(sql`"period_end" IS NOT NULL AND "status" = 'active'`),
    check(
      'vendor_entitlements_status_check',
      sql`"status" IN ('pending', 'active', 'expired', 'revoked')`,
    ),
  ],
);

/**
 * Vendor seat invites — the self-serve half of the §6 seat roster (AECI-664 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11a). A row is an INTENT, never an account:
 * this table is why the vendor portal can add a colleague without the vendor ever
 * triggering a Supabase account create.
 *
 * ── THE ROW GRANTS NOTHING ──────────────────────────────────────────────────
 * Acceptance requires the redeemer's VERIFIED JWT email to equal `email` here, so
 * a forwarded or leaked `token` is inert — whoever holds it still has to prove
 * control of that mailbox through the ordinary sign-in. The token is an opaque
 * lookup handle, not a bearer credential, which is also why it is safe to put in
 * a URL. Shape and discipline are `mailing_list.unsubscribe_token`'s: an opaque
 * `crypto.randomUUID()`, a unique index for the direct lookup, and SOFT-delete
 * (`revoked_at`) rather than a row delete, so a revoked invite stays auditable.
 *
 * ── NO FK ON THE INVITEE ────────────────────────────────────────────────────
 * `email` is deliberately not a `profiles` reference: at insert time the invitee
 * usually has no account at all, and inventing one is the exact thing this design
 * avoids. Who actually redeemed it is recorded on the `audit_log` row
 * (`vendor_seat.invite_accepted`, `actor_id` = the redeemer), not here — which
 * keeps `profiles` at its existing inbound-FK count plus one rather than plus two.
 *
 * `invited_by_id` IS that one — one of the eight inbound FKs to `profiles.id`. Like
 * `vendor_entitlements.granted_by` it is `ON DELETE SET NULL` **and** nulled
 * explicitly in the `DELETE /api/account` erasure batch (`routes/account.ts`;
 * `docs/AUTH_AND_RLS.md` §8, which is the live register) — miss either and account
 * deletion FK-fails for anyone who ever sent an invite.
 */
export const vendorSeatInvites = sqliteTable(
  'vendor_seat_invites',
  {
    id: uuidPk(),
    vendorId: text('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),

    /** The invitee's address, lowercased at the handler (GoTrue stores lowercase
     *  and the accept comparison must be exact — see `normalizeEmail`). */
    email: text('email').notNull(),

    /** Opaque lookup handle. Unique so the accept path is one indexed read. */
    token: text('token')
      .notNull()
      .$defaultFn(() => crypto.randomUUID()),

    invitedById: text('invited_by_id').references(() => profiles.id, { onDelete: 'set null' }),

    /** ISO-8601. Checked in TS on redeem, not by a CHECK — a CHECK change on
     *  SQLite is a full table rebuild (§1.2 / R1) and expiry is not a data
     *  integrity rule, it is a policy that may well be tuned. */
    expiresAt: text('expires_at').notNull(),

    /** Terminal states. Both null = pending; either set = spent. */
    acceptedAt: text('accepted_at'),
    revokedAt: text('revoked_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('vendor_seat_invites_token_key').on(t.token),
    /** The roster's "pending invites for this vendor" read, and the per-vendor
     *  daily rate-limit count, which scans by `vendor_id` + `created_at`. */
    index('vendor_seat_invites_vendor_idx').on(t.vendorId, t.createdAt),
    /** The duplicate probe: "is there already a live invite for this address on
     *  this vendor?" PARTIAL, so spent rows never widen it. */
    index('vendor_seat_invites_pending_idx')
      .on(t.vendorId, t.email)
      .where(sql`"accepted_at" IS NULL AND "revoked_at" IS NULL`),
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

/**
 * Exactly-once guard for the async promote ingest (AECI-571 / ADR 0021).
 *
 * Cloudflare Workflows guarantee a step runs *at least* once: if the engine dies in
 * the window between the ingest's `db.batch` committing and the step result being
 * persisted, the step callback re-executes on resume. The plan phase then mints fresh
 * `crypto.randomUUID()`s and re-derives the slug against the row it just committed, so
 * an unguarded replay lands a *created* product twice — as `revit` AND `revit-2`.
 *
 * The guard is this primary key, not application logic. `runPromoteIngest` pushes the
 * INSERT as the FIRST statement of the same atomic `db.batch` as the promote's writes,
 * so a replayed batch trips the PK and D1 rolls the WHOLE batch back — the duplicate is
 * impossible rather than detected afterwards. `result` then lets the replay return an
 * identical `PromoteIngestResult` (same ids, same slug), so the job still completes and
 * the post-commit hooks — which never fired for the lost attempt, being dispatched from
 * `run()` *after* the step — fire exactly once.
 *
 * Internal bookkeeping, NOT a curation-tool key: `job_id` is AECi's own promote job id
 * (= the Workflow instance id), so the AECI-562 ruling that no Airtable record id
 * belongs in this schema is untouched.
 *
 * Deliberately has NO foreign keys: a cascade delete would silently drop the guard and
 * re-open the window. For the same reason, deleting a row is a safety regression rather
 * than housekeeping — any future prune floor must be >= 90 days, the TTL of the KV
 * result mirror this row backstops (`PROMOTE_RESULT_TTL_SECONDS`).
 */
export const promoteJobs = sqliteTable(
  'promote_jobs',
  {
    /** The caller-supplied promote job id, which is also the Workflow instance id.
     *  Deliberately not `uuidPk()`: the value is always supplied, never generated here
     *  (`PromoteJobIdSchema` — 8-100 chars of `[A-Za-z0-9_-]`). */
    jobId: text('job_id').primaryKey(),
    /** The committed `PromoteJobLedger` envelope (`routes/promote.ts`) — the ID map plus
     *  everything the post-commit hooks read, minus the per-session D1 bookmark. Typed
     *  `unknown` here, like `stats_cache.value`, so this module stays a leaf: narrowing
     *  belongs to the ingest that owns the envelope. */
    result: text('result', { mode: 'json' }).$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  // The write path is served by the PK; this indexes the only sane ops query on the
  // table (time-windowed) and makes a future range-delete prune cheap.
  (t) => [index('promote_jobs_created_at_idx').on(t.createdAt)],
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
    // erasure story (`AUTH_AND_RLS.md` §8). Do not reintroduce them.

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
    // (`SEARCH … USING INDEX (job=?)` + LIMIT 1, ten rows read regardless of
    // table size — one per cron) and the §7.4 prune's cutoff scan.
    index('job_runs_job_started_at_idx').on(t.job, t.startedAt),
    check('job_runs_outcome_check', sql`"outcome" IN ('ok', 'failed', 'skipped')`),
  ],
);

// ===========================================================================
// Connector lane (Stage 1.5 Addendum C §13 / AECI-714)
//
// A PROJECTION of the review app's connector-lane model (`aec-integrations-review`,
// AECI-719, its migration 0004). Same column names, same semantics, deliberately:
// review → AECi is a copy, not a transformation, which is what lets the AECI-720
// per-iPaaS cutoff be "freeze a lane" rather than "migrate data". Rows arrive only
// via `POST /api/promote/connector-catalog`; nothing else writes these tables.
//
// TWO TIERS live here and conflating them is the failure this lane exists to
// prevent (§13.1):
//   • DELIVERED — `connector_evidenced_pairs`. A working integration exists TODAY.
//     AECI-721 migrates the ~326 `integrations.powered_by_product_id` edges into it.
//   • REACHABLE — NOT a table. Derived at read time from `connector_stubs` +
//     `connector_stub_mappings`, and gated for publication by
//     `connector_pairs.surface`. Never stored as delivered, and **never counted** —
//     not in a heading, not in `integration_count`, not in a facet, not in the home
//     stats (§13.5).
//
// IDS ARE THE REVIEW-SIDE RECORD IDS, not `uuidPk()` — the same shape, and the same
// reason, as `promote_jobs.job_id`: the value is always supplied by the caller and
// never generated here.
//
// The decisive argument is not convenience, it is that `connector_stub_mappings` has
// NO OTHER USABLE UPSERT TARGET. Its natural key is `(stub_id, product_id)` with a
// NULLABLE `product_id`, and SQLite treats NULLs as distinct — so
// `ON CONFLICT (stub_id, product_id)` can never match a stub-level decision row. A
// re-sent page would try to insert a second `no_record`, the partial unique index
// below would reject it, and D1 would roll the whole page back. With the review id as
// the key every statement in the sync is one shape: `onConflictDoUpdate({ target:
// <table>.id })`. Two lesser benefits follow: a mapping names its stub across page
// boundaries with no ref graph, and the AECI-720 cutoff is a skip rather than an id
// mapping that has to survive a vendor handover.
//
// The natural-key unique indexes below are the loud guard — if the review app ever
// re-mints ids the way its own migration 0004 did for catalogues, the insert collides
// there and the batch fails visibly instead of silently duplicating a catalogue.
//
// This is not the AECI-562 Airtable-key ban: the review app's `server/db/ids.ts` is
// explicit that these are its OWN D1 ids, which merely keep Airtable's format.
//
// NO `relations()` BLOCKS YET, and that is a deferral rather than a decision like
// `vendorEntitlements`' (see the note on the aggregate `schema` export below).
// Nothing reads this data until AECI-715 / AECI-716 / AECI-722, and the relational
// query builder is only needed for `with:` hydration; the sync's own bounded
// pre-reads use `db.select()`. Whichever issue builds the first read config adds the
// relations alongside it, and the inverse entries on `productsRelations`.
// ===========================================================================

/** See the section header. The review app supplies every id; we never mint one. */
const reviewRecordPk = () => text('id').primaryKey();

/**
 * One row per iPaaS. The catalogue as a whole, never one of its index pages — which
 * is what gives `managed_by` somewhere to live, because a vendor takes over a
 * CATALOGUE and not an index URL (AECI-720).
 *
 * `managed_by` is held AND enforced on this side on purpose: the review app is the
 * component being decommissioned, so the surviving system owns who-controls-what.
 * AECI-714 only lands the column; rejecting writes to a vendor-managed catalogue is
 * AECI-720.
 *
 * `connector_authorship` is a property of the vendor's business model, not of a
 * surface. Zapier inverts what every other row here assumes — the app vendors write
 * the connectors, not Zapier — and a reader assuming `platform` would attribute nine
 * thousand connectors to the wrong party.
 */
export const connectorCatalogs = sqliteTable(
  'connector_catalogs',
  {
    id: reviewRecordPk(),
    /** `cascade`: a catalogue describes one product's published listings and means
     *  nothing without it. NOT NULL is deliberate — a catalogue whose connector is not
     *  promoted yet is reported in the sync's `skipped[]`, never stored half-formed.
     *  Whether an unpromoted connector may ever be named is AECI-721's open question
     *  (`aec-integrations-review` `docs/connector-vendors.md`). */
    connectorProductId: text('connector_product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    connectorAuthorship: text('connector_authorship'),
    managedBy: text('managed_by').notNull().default('review'),
    notes: text('notes'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('connector_catalogs_product_idx').on(t.connectorProductId),
    check(
      'connector_catalogs_authorship_check',
      sql`"connector_authorship" IN ('platform', 'partner', 'mixed')`,
    ),
    check('connector_catalogs_managed_by_check', sql`"managed_by" IN ('review', 'vendor')`),
  ],
);

/**
 * One row per index SURFACE — a URL the review-side ingest crawls.
 *
 * Vendors publish more than one: Aquifer and Kroo split sources from destinations,
 * MindCloud and Agave publish an app index and a pair index. Keying on the catalogue
 * alone would collapse those and lose which URL produced which entries, so
 * `surface_role` is part of the row identity.
 *
 * There are deliberately NO count columns. A count here is a maintained number that
 * goes stale on the first truncated fetch and that nobody can date. `last_ingested_at`
 * is the exception and it is a timestamp, not a count — `STAGE_2_SPEC.md` §8.9(4)
 * names it as the catalogue-freshness signal the connector-vendor seat is judged on.
 */
export const connectorCatalogSurfaces = sqliteTable(
  'connector_catalog_surfaces',
  {
    id: reviewRecordPk(),
    catalogId: text('catalog_id')
      .notNull()
      .references(() => connectorCatalogs.id, { onDelete: 'cascade' }),
    /** `all` is the neutral value for a vendor publishing ONE combined index — the
     *  2026-08-27 survey found Aquifer and Kroo each facet by industry, never by
     *  direction, so without it the directional pair would stay empty forever. */
    surfaceRole: text('surface_role').notNull(),
    indexKind: text('index_kind'),
    indexUrl: text('index_url'),
    lastIngestedAt: text('last_ingested_at'),
    notes: text('notes'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('connector_catalog_surfaces_role_idx').on(t.catalogId, t.surfaceRole),
    // `surface_role` and `index_kind` are deliberately NOT CHECKed, and neither is
    // `connector_stubs.direction_role`. The rule this section follows: a column the
    // DB CHECKs, the wire schema enums; a column the wire schema leaves a loose
    // string, the DB leaves unconstrained. These three are scraper vocabulary and
    // have a demonstrated history of moving — the review app added `all` only after
    // the 2026-08-27 Aquifer/Kroo survey found neither publishes a directional
    // index, and re-measured Zapier on 2026-08-31. A CHECK change is a destructive
    // D1 recreate (docs/migrations.md §0), the sync is the only writer, and the
    // fail-loud read coercers catch a bad value at the surface that renders it.
  ],
);

/**
 * Every listing in a catalogue, not only the ones that match one of our products.
 *
 * The question this lane answers is "is this new listing one of ours?", and that
 * needs the misses present too — MindCloud alone is ~3,395 rows, most of which will
 * never map to anything. Holding the full set is also what makes AECI-720's cutoff a
 * freeze rather than a migration, and what gives AECI-722's triage queue its rows.
 *
 * The stub is a FACT — the iPaaS publishes this listing — which is why it carries no
 * decision columns at all. Everything anybody CONCLUDES about it lives in
 * `connector_stub_mappings`.
 *
 * The timestamps are current-state-plus-history, NOT a snapshot per crawl:
 * `last_seen_at` moves on every run that sees the stub, `removed_at` is stamped when
 * a run stops seeing it, and re-appearance clears it. All three are computed
 * review-side and copied here — the sync does no diffing of its own, and never
 * deletes (`REVIEW_APP_PROMOTE_API.md` §5.1).
 */
export const connectorStubs = sqliteTable(
  'connector_stubs',
  {
    id: reviewRecordPk(),
    catalogId: text('catalog_id')
      .notNull()
      .references(() => connectorCatalogs.id, { onDelete: 'cascade' }),
    /** Identity within ONE catalogue — half a dozen vendors all publish a
     *  `quickbooks`, and `adp` on MindCloud is not `adp` on Zapier. Mutable (iPaaS
     *  sites rename and merge listings), so nothing keys on it except the guard
     *  index below. */
    slug: text('slug').notNull(),
    label: text('label'),
    /** The vendor's own page for this listing. */
    url: text('url'),
    /** NULL where the surface does not say. Aquifer and Kroo publish directional
     *  indexes; MindCloud does not, and inventing `both` for it would fabricate a
     *  claim the vendor never made. */
    directionRole: text('direction_role'),
    actionCount: integer('action_count'),
    /** JSON action inventory. **NULL means NEVER FETCHED, not "no actions".** The
     *  lazy fetch is the scope cut that makes Zapier survivable: an index ingest is
     *  one cheap enumeration of slugs, while the per-listing inventory is ~73k
     *  actions across MindCloud alone. */
    actions: text('actions', { mode: 'json' }).$type<unknown>(),
    /** Hash of the fetched inventory, so a refetch tells "unchanged" from "never
     *  looked". */
    actionsHash: text('actions_hash'),
    actionsFetchedAt: text('actions_fetched_at'),
    /** JSON string array. Vendors rename listings and mappings key on the stub ROW,
     *  so old names are kept as search fodder rather than as identity. */
    previousLabels: text('previous_labels', { mode: 'json' }).$type<string[]>(),
    /** JSON. Per-adapter extras — category, logo, whatever the surface carried. */
    meta: text('meta', { mode: 'json' }).$type<unknown>(),
    /** Both NOT NULL with **no default**, unlike the review side, which defaults them
     *  to `now()` because rows are born there from a crawl. Here every row arrives
     *  from a sync that already knows both, so a default would only ever mask a
     *  sender bug as a plausible timestamp. */
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    /** Tombstone. Review-side rule: may only be stamped by a diff against a run that
     *  finished `complete`, because a sitemap fetch that truncates halfway is
     *  indistinguishable from a vendor deleting half their catalogue. */
    removedAt: text('removed_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('connector_stubs_catalog_slug_idx').on(t.catalogId, t.slug),
    // Every "is this listing one of ours?" lookup arrives with a label, not a slug.
    index('connector_stubs_label_idx').on(t.label),
  ],
);

/**
 * What somebody CONCLUDED about a stub — many-to-many (AECI-719).
 *
 * One listing may be several of our products and one product may appear as several
 * listings in the same catalogue: MindCloud's single `adp` listing is ADP Workforce
 * Now and any edition built within it, and Procore's seven SKU records sit behind one
 * `procore` listing over one API and one developer portal.
 *
 * There is NO `pending` status — the ABSENCE of a row is pending. A row per
 * unreviewed stub would be ~3,300 rows of nothing before anybody had decided
 * anything.
 *
 * Five statuses in TWO families:
 *   PER-PRODUCT ASSERTIONS, `product_id` set — `mapped` (this listing IS that
 *     product) and `ruled_out` (considered and rejected; the row exists so the
 *     review-side auto pass does not re-propose the same wrong product every run).
 *   STUB-LEVEL DECISIONS, `product_id` NULL, at most ONE per stub —
 *     `out_of_scope`, `no_record`, `ambiguous_parked`.
 *
 * The two-column invariant `status IN ('mapped','ruled_out') ⟺ product_id IS NOT
 * NULL` is enforced in application code and in the wire schema, **never as a DB
 * CHECK** — the same shape, and for a sharper reason, as the `origin`/
 * `created_by_vendor_id` biconditional on `claims`. `product_id` goes NULL under
 * ON DELETE SET NULL, so a CHECK would be re-evaluated by that update and would make
 * deleting a mapped product FAIL. A `mapped` row left holding NULL is a visible
 * integrity signal, not something to tidy away by breaking deletes.
 *
 * The publication gate is PROVENANCE, not confidence: reachability the public site
 * carries is only what somebody stands behind, so it reads `decided_by` (the review
 * app's auto pass writes the reserved `auto-name-match`, a human writes their name).
 * `confidence` would publish hundreds of machine guesses at `medium`.
 */
export const connectorStubMappings = sqliteTable(
  'connector_stub_mappings',
  {
    id: reviewRecordPk(),
    stubId: text('stub_id')
      .notNull()
      .references(() => connectorStubs.id, { onDelete: 'cascade' }),
    /** Denormalised copy of `connector_stubs.catalog_id`, written from the stub at
     *  insert time and never independently edited. It exists for one index: the
     *  triage counts are "how many of this catalogue's stubs sit in each state", and
     *  without the column that GROUP BY joins every mapping row back to its stub. */
    catalogId: text('catalog_id')
      .notNull()
      .references(() => connectorCatalogs.id, { onDelete: 'cascade' }),
    /** `set null`, deliberately. The decision trail — who decided, when, on what —
     *  outlives the product row; `cascade` would delete the evidence that this
     *  listing was ever recognised and hand the next sweep the same ambiguity from
     *  scratch. */
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    status: text('status').notNull(),
    confidence: text('confidence'),
    /** Per ROW, not per stub: an edition inherits a platform's reach but not its
     *  evidence, so each assertion cites its own (AECI-697). */
    evidenceUrl: text('evidence_url'),
    /** The publication gate — see the doc comment above. */
    decidedBy: text('decided_by'),
    decidedAt: text('decided_at'),
    /** Drives the review side's self-healing sweeps; moves on every re-examination,
     *  decided or not. */
    checkedAt: text('checked_at'),
    notes: text('notes'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('connector_stub_mappings_pair_idx').on(t.stubId, t.productId),
    // SQLite treats NULLs as DISTINCT, so the index above does NOT make the
    // stub-level decision a singleton — it would happily take five `no_record` rows
    // on one stub. Hence a partial index, keyed on STATUS rather than on
    // `product_id IS NULL`: under ON DELETE SET NULL a stub whose two mapped products
    // were both deleted would collide on a null-keyed index and make the product
    // delete FAIL. Keying on status leaves those orphans alone, visible.
    uniqueIndex('connector_stub_mappings_decision_idx')
      .on(t.stubId)
      .where(sql`"status" IN ('out_of_scope', 'no_record', 'ambiguous_parked')`),
    index('connector_stub_mappings_product_idx').on(t.productId),
    index('connector_stub_mappings_status_idx').on(t.catalogId, t.status),
    check(
      'connector_stub_mappings_status_check',
      sql`"status" IN ('mapped', 'ruled_out', 'out_of_scope', 'no_record', 'ambiguous_parked')`,
    ),
    check(
      'connector_stub_mappings_confidence_check',
      sql`"confidence" IN ('low', 'medium', 'high')`,
    ),
  ],
);

/**
 * A pair of STUBS the connector publishes a page for, filtered review-side to pairs
 * where both sides map to one of our products. That filter is the difference between
 * ~2,000 rows and MindCloud's 104,186; the full index scale is not lost, it is
 * recorded as a count on the review side's run log.
 *
 * This table is NOT the reachable tier and does not assert delivery. It exists for
 * one reason the mapping graph cannot supply: `surface`. Reachability is derivable
 * from stubs + mappings alone (§13.1), but PUBLICATION is not — §13.7 publishes the
 * curated set, and curated-vs-generated is a classification on the vendor's own
 * published pair row (AECI-677). Without this table the only derivable thing is the
 * auto-generated cross-product that §13.7 and AECI-716 explicitly refuse to publish.
 *
 * `surface` defaults to `unknown` on purpose: appearing in an index says a page
 * exists, not that anyone read it.
 *
 * The canonical `stub_a_id < stub_b_id` ordering is a CHECK rather than a convention
 * because vendors publish both directions as separate pages — without it every pair
 * arrives twice and the unique index cannot see the collision. Keeping both page
 * URLs means the ordering costs no information.
 */
export const connectorPairs = sqliteTable(
  'connector_pairs',
  {
    id: reviewRecordPk(),
    catalogId: text('catalog_id')
      .notNull()
      .references(() => connectorCatalogs.id, { onDelete: 'cascade' }),
    stubAId: text('stub_a_id')
      .notNull()
      .references(() => connectorStubs.id, { onDelete: 'cascade' }),
    stubBId: text('stub_b_id')
      .notNull()
      .references(() => connectorStubs.id, { onDelete: 'cascade' }),
    /** The vendor's page for the a→b direction, and for b→a. Either may be absent. */
    urlAToB: text('url_a_to_b'),
    urlBToA: text('url_b_to_a'),
    surface: text('surface').notNull().default('unknown'),
    classifiedAt: text('classified_at'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    removedAt: text('removed_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('connector_pairs_pair_idx').on(t.catalogId, t.stubAId, t.stubBId),
    // "Which pairs involve stub X" has to look at both columns, and the canonical
    // ordering guarantees roughly half the answers sit on the b side.
    index('connector_pairs_stub_b_idx').on(t.stubBId),
    check('connector_pairs_canonical_order', sql`"stub_a_id" < "stub_b_id"`),
    check('connector_pairs_surface_check', sql`"surface" IN ('curated', 'generated', 'unknown')`),
  ],
);

/**
 * The DELIVERED tier of the connector lane — a working, evidenced integration that a
 * named connector delivers between two of our products (§13.1). The one table here
 * with no review-side counterpart, and the destination structure AECI-721 is blocked
 * on: it migrates the ~326 `integrations.powered_by_product_id` edges into this table
 * with their evidence intact, after which `integrations` keeps only accountable-party
 * edges and `iPaaS` leaves its mechanism enum.
 *
 * **AECI-714 creates this table and writes no row into it.** Everything about filling
 * it — the edge move, the ~20-row `marketplace-app`-with-`powered_by` residue §13.2
 * records as OPEN, the ten-site `integration_count` lockstep, and the claims re-home
 * — is AECI-721's.
 *
 * `id` is a locally generated `uuidPk()`, unlike its five neighbours: nothing upstream
 * supplies one. Its SHAPE is what protects AECI-721, and the mandated data check is
 * why that matters — **94 of 1,697 production claims are anchored on powered edges**,
 * and `claims.integration_id` is a single-column NOT NULL FK inside
 * `claims_identity_key`, so re-homing them is a destructive recreate of `claims`.
 * Two properties keep that to ONE recreate rather than two:
 *
 *   1. A single-column surrogate key. A composite PK
 *      `(connector_product_id, product_a_id, product_b_id)` would force a
 *      THREE-column FK from `claims`, and adding a surrogate afterwards would mean
 *      recreating this table too.
 *   2. `uuidPk()`'s `$defaultFn` is overridden by an explicit value, so AECI-721 can
 *      supply the migrated `integrations.id` VERBATIM as the new row's id. The 94
 *      claims' stored anchor value then never moves — only which table it points at,
 *      turning the re-home into a column add plus
 *      `UPDATE claims SET evidenced_pair_id = integration_id`, with no id remapping
 *      table anywhere.
 *
 * The pair is canonicalised (`product_a_id < product_b_id`) so per-connector
 * uniqueness is expressible, and `direction` carries orientation against that
 * ordering using the same `a_to_b | b_to_a | both` vocabulary as `claims.direction`
 * rather than inventing a second one.
 */
export const connectorEvidencedPairs = sqliteTable(
  'connector_evidenced_pairs',
  {
    id: uuidPk(),
    connectorProductId: text('connector_product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    productAId: text('product_a_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    productBId: text('product_b_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),

    name: text('name'),
    /**
     * The accountable builder, when there is one. Mirrors
     * `integrations.built_by_vendor_id`, including its lack of an `onDelete`.
     *
     * Here on day one because §13.2 records an OPEN residue: ~326 edges carry
     * `powered_by` against 308 marked `iPaaS`, and the ~20-row difference is
     * accountable — AnyWare Apps' two Ramp↔Sage edges are `marketplace-app` WITH a
     * `powered_by`, built and maintained by Cherry Bekaert. A table that could not
     * hold a builder would silently pre-decide that residue as "they stay behind",
     * which is AECI-721's call and not this issue's. And an FK added later loses
     * its `ON DELETE` clause under `ADD COLUMN` (docs/migrations.md §0).
     */
    builtByVendorId: text('built_by_vendor_id').references(() => vendors.id),
    mechanismName: text('mechanism_name'),
    /**
     * Orientation, against the canonical `product_a_id < product_b_id` ordering —
     * the same `a_to_b | b_to_a | both` vocabulary as `claims.direction`, and for
     * the identical reason: once a pair is canonicalised, `one-way` alone no longer
     * says which way.
     *
     * So AECI-721's migration is a CASE and not a straight copy, deliberately —
     * `integrations` carries orientation in `source_product_id`/`target_product_id`
     * and this table carries it here, losslessly:
     *   one-way,   source = A  ->  'a_to_b'
     *   one-way,   source = B  ->  'b_to_a'
     *   bidirectional          ->  'both'
     *   NULL                   ->  NULL
     * Reusing `integrations`' own `one-way | bidirectional` vocabulary would have
     * made the copy simpler and thrown the direction away.
     */
    direction: text('direction'),
    description: text('description'),
    website: text('website'),
    /** The evidence. §13.1: reach scraped from a published spec is *spec-published*,
     *  not *exercised* — a delivered claim needs a page that says so. */
    listingUrl: text('listing_url'),
    docsUrl: text('docs_url'),
    mechanismUrl: text('mechanism_url'),
    pricingModel: text('pricing_model'),
    maturity: text('maturity'),
    notes: text('notes'),

    lastReviewedAt: lastReviewedAt(),
    maintainedBy: maintainedBy(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('connector_evidenced_pairs_pair_idx').on(
      t.connectorProductId,
      t.productAId,
      t.productBId,
    ),
    maintainedByCheck('connector_evidenced_pairs'),
    index('connector_evidenced_pairs_product_a_idx').on(t.productAId),
    index('connector_evidenced_pairs_product_b_idx').on(t.productBId),
    index('connector_evidenced_pairs_connector_idx').on(t.connectorProductId),
    index('connector_evidenced_pairs_built_by_idx')
      .on(t.builtByVendorId)
      .where(sql`"built_by_vendor_id" IS NOT NULL`),
    check('connector_evidenced_pairs_canonical_order', sql`"product_a_id" < "product_b_id"`),
    // §13.2(a), structurally. Review-side Convention A stores "product X ships a
    // connector on platform C" as ONE edge whose `powered_by` IS one of its own
    // endpoints — ~152 of the 308 `iPaaS` rows. Those stay in the DIRECT list; letting
    // one in here would render "Via Aquifer → Aquifer".
    check(
      'connector_evidenced_pairs_distinct_connector',
      sql`"connector_product_id" <> "product_a_id" AND "connector_product_id" <> "product_b_id"`,
    ),
    check(
      'connector_evidenced_pairs_direction_check',
      sql`"direction" IN ('a_to_b', 'b_to_a', 'both')`,
    ),
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
  // Stage 2 provenance/authority back-relations (AECI-603). Named because a vendor is
  // reachable from two different tables here, same as the built-by disambiguation above.
  createdClaims: many(claims, { relationName: 'ClaimCreatedByVendor' }),
  attestationsMade: many(attestations, { relationName: 'AttestationAttestedByVendor' }),
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
  // Stage 2 §8 — the product's declared releases. Order with `sort_key`, never
  // by insertion or by label.
  versions: many(productVersions),
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
  createdByVendor: one(vendors, {
    fields: [claims.createdByVendorId],
    references: [vendors.id],
    relationName: 'ClaimCreatedByVendor',
  }),
  attestations: many(attestations),
}));
export const attestationsRelations = relations(attestations, ({ one }) => ({
  claim: one(claims, { fields: [attestations.claimId], references: [claims.id] }),
  attestedByVendor: one(vendors, {
    fields: [attestations.attestedByVendorId],
    references: [vendors.id],
    relationName: 'AttestationAttestedByVendor',
  }),
  // Two FKs into the SAME table, so both sides need an explicit `relationName`
  // to disambiguate — the pattern `IntegrationSource`/`IntegrationTarget`
  // already uses. Without it Drizzle cannot tell which relation a
  // `productVersions` back-reference belongs to.
  introducedVersion: one(productVersions, {
    fields: [attestations.introducedVersionId],
    references: [productVersions.id],
    relationName: 'AttestationIntroducedVersion',
  }),
  deprecatedVersion: one(productVersions, {
    fields: [attestations.deprecatedVersionId],
    references: [productVersions.id],
    relationName: 'AttestationDeprecatedVersion',
  }),
}));

export const productVersionsRelations = relations(productVersions, ({ one, many }) => ({
  product: one(products, { fields: [productVersions.productId], references: [products.id] }),
  introducedAttestations: many(attestations, { relationName: 'AttestationIntroducedVersion' }),
  deprecatedAttestations: many(attestations, { relationName: 'AttestationDeprecatedVersion' }),
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
  productVersions,
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
  vendorEntitlements,
  vendorSeatInvites,
  workflowInstances,
  workflowTransitions,
  auditLog,
  promoteJobs,
  pageViews,
  statsCache,
  jobRuns,
  translations,
  connectorCatalogs,
  connectorCatalogSurfaces,
  connectorStubs,
  connectorStubMappings,
  connectorPairs,
  connectorEvidencedPairs,
  feedback,
  mailingList,
  // NOTE: `vendorEntitlements` deliberately has NO relations() entry, and that is
  // load-bearing rather than an oversight. A relation is exactly what would make
  // `db.query.vendors.findMany({ ...vendorListConfig, with: { entitlement: true } })`
  // type-check and autocomplete — the read path `STAGE_2_PAID_TIERS_SPEC.md` §2.5
  // forbids ("joining vendor_entitlements into the public ?verified= filter so it
  // reads the truth rather than the mirror would defeat the entire denormalization").
  // Without the relation that line does not compile. The §4 entitlement gate and the
  // `entitlement_mirror_drift` check both use an explicit leftJoin, which needs none.
  // Every other ops/ledger table here (auditLog, pageViews, statsCache, vendorRequests)
  // has no relations entry either.
  //
  // The six `connector*` tables (AECI-714) also have none, but for a weaker reason —
  // deferral, not prohibition. Nothing reads them until AECI-715 / 716 / 722, and the
  // sync's own bounded pre-reads use `db.select()`. Whichever issue builds the first
  // read config adds the relations and the inverse entries on `productsRelations`.
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
  productVersionsRelations,
  productCategoriesRelations,
  productAudiencesRelations,
  productPhasesRelations,
  productTradesRelations,
  productVendorsRelations,
  reviewsRelations,
  workflowInstancesRelations,
  workflowTransitionsRelations,
};

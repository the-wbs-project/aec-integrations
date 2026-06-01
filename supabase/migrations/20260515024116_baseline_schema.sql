-- =============================================================================
-- Stage 1 baseline schema (AECI-39).
--
-- Source of truth: docs/DATABASE_SCHEMA.md §3-§11.
-- Table inventory verified against docs/rls_policies.sql (AECI-29 attaches RLS
-- + GRANTs to the tables produced here).
--
-- Structure:
--   1. pgcrypto extension (for gen_random_uuid() defaults below)
--   2. Prisma-generated CREATE TABLE / CREATE INDEX / ALTER TABLE statements
--   3. Hand-authored: CHECK constraints, partial indexes, triggers
--      (see "RAW SQL" section at the bottom)
--
-- Intentionally deferred to AECI-29 (RLS migration):
--   - profiles.id -> auth.users(id) FK + ON DELETE CASCADE
--   - handle_new_user() trigger (auto-create profile on Supabase Auth signup)
--   These reference Supabase's `auth` schema, which doesn't exist on vanilla
--   Postgres. Keeping them out lets this migration apply against any PG 13+.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateTable
CREATE TABLE "health_check" (
    "id" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_check_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "description" TEXT,
    "website" TEXT,
    "headquarters" TEXT,
    "founded_year" INTEGER,
    "public_private" TEXT,
    "parent_company" TEXT,
    "linkedin_url" TEXT,
    "crunchbase_url" TEXT,
    "wiki_url" TEXT,
    "source_url" TEXT,
    "github_org" TEXT,
    "phone_number" TEXT,
    "contact_email" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "promotion_status" TEXT NOT NULL DEFAULT 'pending',
    "admin_notes" TEXT,
    "vqs_credibility" DECIMAL(4,2),
    "vqs_momentum" DECIMAL(4,2),
    "vqs_fit" DECIMAL(4,2),
    "vqs_total" DECIMAL(4,2),
    "vqs_computed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "website" TEXT,
    "tool_integrations_url" TEXT,
    "api_docs_url" TEXT,
    "has_api_docs" BOOLEAN NOT NULL DEFAULT false,
    "tool_integration_check_notes" TEXT,
    "product_role" TEXT NOT NULL DEFAULT 'application',
    "logo_url" TEXT,
    "integration_count" INTEGER NOT NULL DEFAULT 0,
    "review_count" INTEGER NOT NULL DEFAULT 0,
    "rating_overall_avg" DECIMAL(3,2),
    "rating_onboarding_avg" DECIMAL(3,2),
    "research_status" TEXT NOT NULL DEFAULT 'pending',
    "research_notes" TEXT,
    "promotion_status" TEXT NOT NULL DEFAULT 'pending',
    "priority_tier" TEXT,
    "priority_score" DECIMAL(5,2),
    "score_computed_at" TIMESTAMPTZ(6),
    "google_trends_index" INTEGER,
    "search_volume_monthly" INTEGER,
    "search_checked_at" TIMESTAMPTZ(6),
    "reddit_mentions_24mo" INTEGER,
    "reddit_checked_at" TIMESTAMPTZ(6),
    "admin_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT,
    "source_product_id" UUID NOT NULL,
    "target_product_id" UUID NOT NULL,
    "mechanism_kind" TEXT,
    "mechanism_name" TEXT,
    "direction" TEXT,
    "built_by_vendor_id" UUID,
    "powered_by_product_id" UUID,
    "description" TEXT,
    "listing_url" TEXT,
    "docs_url" TEXT,
    "website" TEXT,
    "mechanism_url" TEXT,
    "pricing_model" TEXT,
    "maturity" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxonomy_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "display_order" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "taxonomy_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxonomy_disciplines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "display_order" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "taxonomy_disciplines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxonomy_phases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "display_order" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "taxonomy_phases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "product_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("product_id","category_id")
);

-- CreateTable
CREATE TABLE "product_disciplines" (
    "product_id" UUID NOT NULL,
    "discipline_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_disciplines_pkey" PRIMARY KEY ("product_id","discipline_id")
);

-- CreateTable
CREATE TABLE "product_phases" (
    "product_id" UUID NOT NULL,
    "phase_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_phases_pkey" PRIMARY KEY ("product_id","phase_id")
);

-- CreateTable
CREATE TABLE "product_vendors" (
    "product_id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_vendors_pkey" PRIMARY KEY ("product_id","vendor_id")
);

-- CreateTable
CREATE TABLE "product_extensions" (
    "product_id" UUID NOT NULL,
    "host_product_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_extensions_pkey" PRIMARY KEY ("product_id","host_product_id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "display_name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'reviewer',
    "vendor_id" UUID,
    "work_email_verified" BOOLEAN NOT NULL DEFAULT false,
    "trust_tier" TEXT NOT NULL DEFAULT 'standard',
    "theme_preference" TEXT NOT NULL DEFAULT 'system',
    "banned_at" TIMESTAMPTZ(6),
    "ban_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "reviewer_id" UUID,
    "rating_overall" SMALLINT NOT NULL,
    "rating_onboarding" SMALLINT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "role_at_company" TEXT,
    "years_using" SMALLINT,
    "would_recommend" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rejection_reason" TEXT,
    "moderated_at" TIMESTAMPTZ(6),
    "moderated_by" UUID,
    "toxicity_score" SMALLINT,
    "verified_work_email" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "vendor_id" UUID,
    "product_id" UUID,
    "submitted_email" TEXT NOT NULL,
    "submitted_name" TEXT,
    "payload" JSONB NOT NULL,
    "linear_issue_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_instances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workflow_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "current_state" TEXT NOT NULL,
    "linear_issue_id" TEXT,
    "initiated_by" UUID,
    "initiated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "final_outcome" TEXT,

    CONSTRAINT "workflow_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_transitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workflow_id" UUID NOT NULL,
    "from_state" TEXT,
    "to_state" TEXT NOT NULL,
    "actor_id" UUID,
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" UUID,
    "before_state" JSONB,
    "after_state" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_views" (
    "id" BIGSERIAL NOT NULL,
    "path" TEXT NOT NULL,
    "product_id" UUID,
    "vendor_id" UUID,
    "user_id" UUID,
    "session_id" TEXT,
    "referrer" TEXT,
    "cf_country" TEXT,
    "cf_colo" TEXT,
    "cf_asn" INTEGER,
    "cf_bot_score" INTEGER,
    "user_agent_hash" TEXT,
    "locale" TEXT,
    "profile_role" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stats_cache" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stats_cache_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "translations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendors_slug_key" ON "vendors"("slug");

-- CreateIndex
CREATE INDEX "vendors_slug_idx" ON "vendors"("slug");

-- CreateIndex
CREATE INDEX "vendors_company_name_idx" ON "vendors"("company_name");

-- CreateIndex
CREATE INDEX "vendors_promotion_status_idx" ON "vendors"("promotion_status");

-- CreateIndex
CREATE INDEX "vendors_verified_idx" ON "vendors"("verified");

-- CreateIndex
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");

-- CreateIndex
CREATE INDEX "products_slug_idx" ON "products"("slug");

-- CreateIndex
CREATE INDEX "products_name_idx" ON "products"("name");

-- CreateIndex
CREATE INDEX "products_promotion_status_idx" ON "products"("promotion_status");

-- CreateIndex
CREATE INDEX "products_research_status_idx" ON "products"("research_status");

-- CreateIndex
CREATE INDEX "products_priority_tier_idx" ON "products"("priority_tier");

-- CreateIndex
CREATE INDEX "products_product_role_idx" ON "products"("product_role");

-- CreateIndex
CREATE INDEX "products_updated_at_idx" ON "products"("updated_at" DESC);

-- CreateIndex
CREATE INDEX "integrations_source_idx" ON "integrations"("source_product_id");

-- CreateIndex
CREATE INDEX "integrations_target_idx" ON "integrations"("target_product_id");

-- CreateIndex
CREATE INDEX "integrations_mechanism_kind_idx" ON "integrations"("mechanism_kind");

-- CreateIndex
CREATE UNIQUE INDEX "taxonomy_categories_slug_key" ON "taxonomy_categories"("slug");

-- CreateIndex
CREATE INDEX "taxonomy_categories_slug_idx" ON "taxonomy_categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "taxonomy_disciplines_slug_key" ON "taxonomy_disciplines"("slug");

-- CreateIndex
CREATE INDEX "taxonomy_disciplines_slug_idx" ON "taxonomy_disciplines"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "taxonomy_phases_slug_key" ON "taxonomy_phases"("slug");

-- CreateIndex
CREATE INDEX "taxonomy_phases_slug_idx" ON "taxonomy_phases"("slug");

-- CreateIndex
CREATE INDEX "product_categories_category_idx" ON "product_categories"("category_id");

-- CreateIndex
CREATE INDEX "product_disciplines_discipline_idx" ON "product_disciplines"("discipline_id");

-- CreateIndex
CREATE INDEX "product_phases_phase_idx" ON "product_phases"("phase_id");

-- CreateIndex
CREATE INDEX "product_vendors_vendor_idx" ON "product_vendors"("vendor_id");

-- CreateIndex
CREATE INDEX "product_extensions_host_idx" ON "product_extensions"("host_product_id");

-- CreateIndex
CREATE INDEX "profiles_role_idx" ON "profiles"("role");

-- CreateIndex
CREATE INDEX "reviews_product_status_idx" ON "reviews"("product_id", "status");

-- CreateIndex
CREATE INDEX "reviews_status_created_idx" ON "reviews"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "vendor_requests_kind_status_idx" ON "vendor_requests"("kind", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "workflow_instances_type_entity_idx" ON "workflow_instances"("workflow_type", "entity_id");

-- CreateIndex
CREATE INDEX "workflow_transitions_workflow_idx" ON "workflow_transitions"("workflow_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_entity_idx" ON "audit_log"("entity_type", "entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_action_idx" ON "audit_log"("action", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at" DESC);

-- CreateIndex
CREATE INDEX "page_views_path_idx" ON "page_views"("path", "created_at");

-- CreateIndex
CREATE INDEX "page_views_country_idx" ON "page_views"("cf_country", "created_at");

-- CreateIndex
CREATE INDEX "translations_lookup_idx" ON "translations"("entity_type", "entity_id", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "translations_entity_type_entity_id_locale_field_key" ON "translations"("entity_type", "entity_id", "locale", "field");

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_source_product_id_fkey" FOREIGN KEY ("source_product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_target_product_id_fkey" FOREIGN KEY ("target_product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_built_by_vendor_id_fkey" FOREIGN KEY ("built_by_vendor_id") REFERENCES "vendors"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_powered_by_product_id_fkey" FOREIGN KEY ("powered_by_product_id") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "taxonomy_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_disciplines" ADD CONSTRAINT "product_disciplines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_disciplines" ADD CONSTRAINT "product_disciplines_discipline_id_fkey" FOREIGN KEY ("discipline_id") REFERENCES "taxonomy_disciplines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_phases" ADD CONSTRAINT "product_phases_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_phases" ADD CONSTRAINT "product_phases_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "taxonomy_phases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_vendors" ADD CONSTRAINT "product_vendors_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_vendors" ADD CONSTRAINT "product_vendors_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_extensions" ADD CONSTRAINT "product_extensions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_extensions" ADD CONSTRAINT "product_extensions_host_product_id_fkey" FOREIGN KEY ("host_product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_moderated_by_fkey" FOREIGN KEY ("moderated_by") REFERENCES "profiles"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vendor_requests" ADD CONSTRAINT "vendor_requests_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vendor_requests" ADD CONSTRAINT "vendor_requests_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_initiated_by_fkey" FOREIGN KEY ("initiated_by") REFERENCES "profiles"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflow_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "profiles"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "profiles"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "page_views" ADD CONSTRAINT "page_views_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "page_views" ADD CONSTRAINT "page_views_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "page_views" ADD CONSTRAINT "page_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- =============================================================================
-- RAW SQL — features Prisma cannot model in schema.prisma
-- (CHECK constraints, partial indexes, updated_at trigger function + triggers)
-- =============================================================================


-- ---- CHECK constraints (§4-§10 enums + numeric ranges) ----------------------
--
-- Stage 1 models enums as TEXT + CHECK rather than Postgres ENUMs because new
-- values can be added without an ALTER TYPE migration. Mirror docs/DATABASE_SCHEMA.md.

-- vendors -------------------------------------------------------------
ALTER TABLE "vendors"
  ADD CONSTRAINT vendors_public_private_check
  CHECK ("public_private" IN ('public', 'private'));
ALTER TABLE "vendors"
  ADD CONSTRAINT vendors_promotion_status_check
  CHECK ("promotion_status" IN ('pending', 'ready', 'promoted', 'retracted', 'rejected'));

-- products ------------------------------------------------------------
ALTER TABLE "products"
  ADD CONSTRAINT products_product_role_check
  CHECK ("product_role" IN ('application', 'connector', 'hybrid'));
ALTER TABLE "products"
  ADD CONSTRAINT products_research_status_check
  CHECK ("research_status" IN ('pending', 'in_progress', 'done', 'blocked'));
ALTER TABLE "products"
  ADD CONSTRAINT products_promotion_status_check
  CHECK ("promotion_status" IN ('pending', 'ready', 'promoted', 'retracted', 'rejected'));
ALTER TABLE "products"
  ADD CONSTRAINT products_priority_tier_check
  CHECK ("priority_tier" IN ('tier_1', 'tier_2', 'tier_3', 'tier_4', 'tier_5'));
ALTER TABLE "products"
  ADD CONSTRAINT products_google_trends_index_check
  CHECK ("google_trends_index" BETWEEN 0 AND 100);

-- integrations --------------------------------------------------------
ALTER TABLE "integrations"
  ADD CONSTRAINT source_target_differ
  CHECK ("source_product_id" <> "target_product_id");
ALTER TABLE "integrations"
  ADD CONSTRAINT integrations_mechanism_kind_check
  CHECK ("mechanism_kind" IN ('native', 'iPaaS', 'marketplace-app', 'api', 'webhook', 'partner'));
ALTER TABLE "integrations"
  ADD CONSTRAINT integrations_direction_check
  CHECK ("direction" IN ('one-way', 'bidirectional'));

-- product_extensions --------------------------------------------------
ALTER TABLE "product_extensions"
  ADD CONSTRAINT product_extensions_differ
  CHECK ("product_id" <> "host_product_id");

-- profiles ------------------------------------------------------------
ALTER TABLE "profiles"
  ADD CONSTRAINT profiles_role_check
  CHECK ("role" IN ('reviewer', 'admin', 'vendor_admin'));
ALTER TABLE "profiles"
  ADD CONSTRAINT profiles_trust_tier_check
  CHECK ("trust_tier" IN ('standard', 'verified', 'trusted'));
ALTER TABLE "profiles"
  ADD CONSTRAINT profiles_theme_preference_check
  CHECK ("theme_preference" IN ('system', 'light', 'dark'));

-- reviews -------------------------------------------------------------
ALTER TABLE "reviews"
  ADD CONSTRAINT reviews_rating_overall_check
  CHECK ("rating_overall" BETWEEN 1 AND 5);
ALTER TABLE "reviews"
  ADD CONSTRAINT reviews_rating_onboarding_check
  CHECK ("rating_onboarding" BETWEEN 1 AND 5);
ALTER TABLE "reviews"
  ADD CONSTRAINT reviews_role_at_company_check
  CHECK ("role_at_company" IN ('practitioner', 'manager', 'IT', 'exec', 'other'));
ALTER TABLE "reviews"
  ADD CONSTRAINT reviews_years_using_check
  CHECK ("years_using" BETWEEN 0 AND 50);
ALTER TABLE "reviews"
  ADD CONSTRAINT reviews_would_recommend_check
  CHECK ("would_recommend" IN ('yes', 'no', 'maybe'));
ALTER TABLE "reviews"
  ADD CONSTRAINT reviews_status_check
  CHECK ("status" IN ('pending', 'approved', 'rejected', 'archived'));

-- vendor_requests -----------------------------------------------------
ALTER TABLE "vendor_requests"
  ADD CONSTRAINT vendor_requests_kind_check
  CHECK ("kind" IN ('claim', 'correction'));
ALTER TABLE "vendor_requests"
  ADD CONSTRAINT vendor_requests_status_check
  CHECK ("status" IN ('open', 'resolved', 'rejected'));

-- workflow_instances --------------------------------------------------
ALTER TABLE "workflow_instances"
  ADD CONSTRAINT workflow_instances_workflow_type_check
  CHECK ("workflow_type" IN ('vendor_claim', 'review_moderation', 'correction_request'));
ALTER TABLE "workflow_instances"
  ADD CONSTRAINT workflow_instances_final_outcome_check
  CHECK ("final_outcome" IN ('approved', 'rejected', 'cancelled', 'completed'));

-- audit_log -----------------------------------------------------------
ALTER TABLE "audit_log"
  ADD CONSTRAINT audit_log_actor_type_check
  CHECK ("actor_type" IN ('user', 'admin', 'system', 'workflow'));

-- translations --------------------------------------------------------
ALTER TABLE "translations"
  ADD CONSTRAINT translations_entity_type_check
  CHECK ("entity_type" IN ('product', 'vendor', 'category', 'discipline', 'phase', 'integration'));


-- ---- Partial indexes (§4-§9) ------------------------------------------------
--
-- Prisma's @@index cannot emit `WHERE`. Listed in schema.prisma comments next
-- to each model so reviewers see the link.

CREATE INDEX integrations_built_by_idx
  ON "integrations" ("built_by_vendor_id")
  WHERE "built_by_vendor_id" IS NOT NULL;

CREATE INDEX integrations_powered_by_idx
  ON "integrations" ("powered_by_product_id")
  WHERE "powered_by_product_id" IS NOT NULL;

CREATE INDEX profiles_vendor_idx
  ON "profiles" ("vendor_id")
  WHERE "vendor_id" IS NOT NULL;

CREATE INDEX profiles_banned_idx
  ON "profiles" ("banned_at")
  WHERE "banned_at" IS NOT NULL;

CREATE INDEX reviews_reviewer_idx
  ON "reviews" ("reviewer_id")
  WHERE "reviewer_id" IS NOT NULL;

-- One non-archived review per (product, reviewer); anonymous reviews exempt.
CREATE UNIQUE INDEX reviews_unique_per_user_product
  ON "reviews" ("product_id", "reviewer_id")
  WHERE "reviewer_id" IS NOT NULL AND "status" <> 'archived';

CREATE INDEX vendor_requests_vendor_idx
  ON "vendor_requests" ("vendor_id")
  WHERE "vendor_id" IS NOT NULL;

CREATE INDEX vendor_requests_product_idx
  ON "vendor_requests" ("product_id")
  WHERE "product_id" IS NOT NULL;

CREATE INDEX vendor_requests_linear_idx
  ON "vendor_requests" ("linear_issue_id")
  WHERE "linear_issue_id" IS NOT NULL;

CREATE INDEX workflow_instances_state_idx
  ON "workflow_instances" ("workflow_type", "current_state")
  WHERE "completed_at" IS NULL;

CREATE INDEX workflow_instances_linear_idx
  ON "workflow_instances" ("linear_issue_id")
  WHERE "linear_issue_id" IS NOT NULL;

CREATE INDEX audit_log_actor_idx
  ON "audit_log" ("actor_id", "created_at" DESC)
  WHERE "actor_id" IS NOT NULL;

CREATE INDEX page_views_product_idx
  ON "page_views" ("product_id", "created_at")
  WHERE "product_id" IS NOT NULL;

CREATE INDEX page_views_user_idx
  ON "page_views" ("user_id", "created_at")
  WHERE "user_id" IS NOT NULL;


-- ---- updated_at trigger (§11.1) ---------------------------------------------
--
-- Prisma sets `updated_at` defaults at insert, but does not bump on UPDATE.
-- This trigger does. Applied to every table with an `updated_at` column.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vendors_updated_at
  BEFORE UPDATE ON "vendors"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON "products"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER integrations_updated_at
  BEFORE UPDATE ON "integrations"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER taxonomy_categories_updated_at
  BEFORE UPDATE ON "taxonomy_categories"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER taxonomy_disciplines_updated_at
  BEFORE UPDATE ON "taxonomy_disciplines"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER taxonomy_phases_updated_at
  BEFORE UPDATE ON "taxonomy_phases"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON "profiles"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER reviews_updated_at
  BEFORE UPDATE ON "reviews"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER translations_updated_at
  BEFORE UPDATE ON "translations"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ---- Denormalized count strategy (§11.2) ------------------------------------
--
-- products.integration_count, products.review_count, products.rating_overall_avg,
-- and products.rating_onboarding_avg are denormalized columns kept in sync at
-- the application layer in Stage 1, NOT by database triggers. On every write to
-- integrations/reviews, the API Worker recomputes these columns inside the same
-- transaction via the shared helper recomputeProductCounts()
-- (apps/api/src/lib/product-counts.ts). review_count and the rating averages
-- count only reviews with status='approved' (STAGE_1_SPEC.md §4.7, §12); the
-- averages are NULL when there are no approved reviews. Cache-Tag purging of
-- affected pages is a separate concern (see CLAUDE.md "Cache invalidation"), not
-- part of count maintenance.
--
-- A reconciliation script/test (apps/api/scripts/reconcile-product-counts.ts,
-- findProductCountDrift) recomputes the expected values from the source rows and
-- flags drift. Triggers are reserved for Phase 2 if write performance becomes an
-- issue (DATABASE_SCHEMA.md §11.2). The columns ship with safe defaults (0 for
-- counts, NULL for averages) so a product row is valid the moment it's inserted,
-- even before any aggregation has run.

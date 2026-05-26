-- Landing-page baseline (pre-AECI Stage 1).
--
-- Captures the two tables that existed on the renamed `aeci-production` project
-- (originally the sole dev/landing DB) before our migration system was
-- introduced. These tables are written to by `apps/landing/` via Supabase
-- PostgREST using the anon key, so the GRANTs and "Allow anonymous inserts"
-- RLS policies are part of the contract.
--
-- Ownership: tables are owned by `apps/landing/` (lead-capture for the
-- pre-launch site). They sit in the `public` schema for PostgREST reachability
-- but are out-of-scope for the AECI Stage 1 build — no AECI code reads or
-- writes them. The `aeci-development` project (newly provisioned, empty) will
-- pick up these tables when migrations are first pushed to it; that is fine
-- and intentional (local-dev parity with prod schema). The landing Worker
-- continues to point at the prod project's PostgREST endpoint regardless.
--
-- Timestamp is deliberately set to 2026-01-01 so the file sorts visibly
-- ahead of the 2026-05-15 AECI baseline — making the pre-history origin of
-- these tables obvious in directory listings.
--
-- Source: `supabase db dump --linked --schema public` taken
-- 2026-05-26 (file: .context/prod-public-schema.sql), reformatted for
-- consistency with the rest of supabase/migrations/.

BEGIN;

-- ─── feedback ────────────────────────────────────────────────────────────────
-- Written by apps/landing/src/services/feedback.ts (POST /api/feedback).
CREATE TABLE IF NOT EXISTS "public"."feedback" (
    "id"          BIGINT NOT NULL,
    "features"    TEXT,
    "tools"       TEXT,
    "email"       TEXT,
    "subscribed"  BOOLEAN NOT NULL DEFAULT FALSE,
    "country"     TEXT,
    "city"        TEXT,
    "region"      TEXT,
    "timezone"    TEXT,
    "referrer"    TEXT,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE "public"."feedback"
    ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
        SEQUENCE NAME "public"."feedback_id_seq"
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1
    );

ALTER TABLE ONLY "public"."feedback"
    ADD CONSTRAINT "feedback_pkey" PRIMARY KEY ("id");

-- ─── mailing_list ────────────────────────────────────────────────────────────
-- Written by apps/landing/src/services/{feedback,subscribe}.ts (anon inserts).
CREATE TABLE IF NOT EXISTS "public"."mailing_list" (
    "id"               BIGINT NOT NULL,
    "email"            TEXT NOT NULL,
    "country"          TEXT,
    "city"             TEXT,
    "region"           TEXT,
    "timezone"         TEXT,
    "as_organization"  TEXT,
    "asn"              INTEGER,
    "metro_code"       INTEGER,
    "utm_source"       TEXT,
    "utm_medium"       TEXT,
    "utm_campaign"     TEXT,
    "referrer"         TEXT,
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE "public"."mailing_list"
    ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
        SEQUENCE NAME "public"."mailing_list_id_seq"
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1
    );

ALTER TABLE ONLY "public"."mailing_list"
    ADD CONSTRAINT "mailing_list_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."mailing_list"
    ADD CONSTRAINT "mailing_list_email_key" UNIQUE ("email");

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- Both tables are write-only from anon (lead capture). No SELECT/UPDATE/DELETE
-- policy is granted, so PostgREST only accepts inserts. Verified against the
-- live policy set in prod (see .context/prod-public-schema.sql lines 158-162).
ALTER TABLE "public"."feedback"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."mailing_list" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anonymous inserts" ON "public"."feedback";
CREATE POLICY "Allow anonymous inserts"
    ON "public"."feedback"
    FOR INSERT
    WITH CHECK (TRUE);

DROP POLICY IF EXISTS "Allow anonymous inserts" ON "public"."mailing_list";
CREATE POLICY "Allow anonymous inserts"
    ON "public"."mailing_list"
    FOR INSERT
    WITH CHECK (TRUE);

-- ─── Grants ──────────────────────────────────────────────────────────────────
-- Mirrors prod. PostgREST connects as anon/authenticated and needs explicit
-- table + sequence privileges in addition to the RLS policies above.
GRANT ALL ON TABLE "public"."feedback"     TO "anon", "authenticated", "service_role";
GRANT ALL ON TABLE "public"."mailing_list" TO "anon", "authenticated", "service_role";

GRANT ALL ON SEQUENCE "public"."feedback_id_seq"     TO "anon", "authenticated", "service_role";
GRANT ALL ON SEQUENCE "public"."mailing_list_id_seq" TO "anon", "authenticated", "service_role";

COMMIT;

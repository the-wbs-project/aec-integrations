-- AECI-87: PostgREST GRANT + RLS deny/allow probe.
--
-- Verifies that the authorization surface installed by
-- supabase/migrations/20260602051513_rls_grants_and_policies.sql is actually in
-- effect on whatever DB this runs against. It impersonates the PostgREST roles
-- at the SQL layer (`SET ROLE anon`) so it needs NO running PostgREST/GoTrue and
-- NO minted JWT — the anon/authenticated/service_role roles are baked into the
-- Supabase Postgres image, so this works in the Postgres-only stack that
-- drift-check boots (`supabase db start`) as well as against staging/prod.
--
-- It checks the BINARY GRANT matrix + helper existence + the landing carve-out.
-- The row-filter RLS that depends on auth.uid() (promoted-only, own-row) needs a
-- real JWT and is covered by the PostgREST integration specs
-- (apps/api/src/integration/*.rls.spec.ts), not here.
--
-- Invoked via:
--   psql "$URL" -v ON_ERROR_STOP=1 -f scripts/verify-rls.sql
-- Any failed assertion raises an exception -> psql exits non-zero -> CI hard-stop.
-- Wired into .github/workflows/{drift-check,refresh-staging,promote-to-prod}.yml.
--
-- All probe writes happen inside a rolled-back transaction, so this leaves NO
-- residue on the persistent staging/prod DBs (it burns an identity sequence
-- value per run — harmless).

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Helpers exist and are EXECUTE-able as anon. A missing function or a
--    stripped EXECUTE grant raises here (so this also guards STEP 2 ordering).
--    auth.uid() is NULL under SET ROLE, so both return false — that's fine; we
--    only assert they run without error.
-- ---------------------------------------------------------------------------
begin;
set local role anon;
select public.is_admin();
select public.is_active_user();
rollback;

-- ---------------------------------------------------------------------------
-- 2. anon CAN INSERT into the landing tables (AECI-87 acceptance criterion #3).
--    Rolled back so no row is persisted; if the GRANT/sequence-USAGE were
--    missing the INSERT would raise 42501 and abort the script.
-- ---------------------------------------------------------------------------
begin;
set local role anon;
insert into public.feedback (email)     values ('verify-rls-probe@example.com');
insert into public.mailing_list (email) values ('verify-rls-probe@example.com');
rollback;

-- ---------------------------------------------------------------------------
-- 2b. anon CAN SELECT every public-read table. A missing table-level GRANT
--     surfaces as 42501 insufficient_privilege BEFORE RLS is consulted — the
--     exact failure mode a privilege-stripping staging refresh produces (the
--     restore strips grants and `db push` skips the already-in-history grant
--     migration). Probing only the INSERT carve-out (STEP 2) would let that
--     class of regression through silently, so assert the read grants too. RLS
--     may still filter the result to zero rows; we only assert the SELECT is
--     not blocked at the GRANT layer. Each table is probed in its own sub-block
--     so a missing grant names the offending table. profiles is excluded — it
--     is granted to authenticated only, never anon.
-- ---------------------------------------------------------------------------
do $$
declare
  tbl text;
  granted_tables text[] := array[
    'vendors',
    'products',
    'integrations',
    'taxonomy_categories',
    'taxonomy_audiences',
    'taxonomy_phases',
    'product_categories',
    'product_audiences',
    'product_phases',
    'product_vendors',
    'product_extensions',
    'reviews',
    'stats_cache',
    'translations'
  ];
begin
  set local role anon;
  foreach tbl in array granted_tables loop
    begin
      execute format('select 1 from public.%I limit 1', tbl);
    exception
      when insufficient_privilege then
        raise exception 'GRANT FAIL: anon SELECT on % denied (42501) — missing table GRANT', tbl;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. anon CANNOT SELECT the no-grant tables — PostgREST returns 42501
--    insufficient_privilege before RLS is even consulted. feedback and
--    mailing_list are included because the carve-out grants INSERT only, so a
--    SELECT on them must also be denied. Each table is probed in its own
--    sub-block; catching insufficient_privilege == PASS, a successful SELECT
--    raises.
-- ---------------------------------------------------------------------------
do $$
declare
  tbl text;
  denied_tables text[] := array[
    'audit_log',
    'profiles',
    'vendor_requests',
    'workflow_instances',
    'workflow_transitions',
    'page_views',
    'feedback',
    'mailing_list'
  ];
begin
  set local role anon;
  foreach tbl in array denied_tables loop
    begin
      execute format('select 1 from public.%I limit 1', tbl);
      raise exception 'DENY FAIL: anon SELECT on % unexpectedly succeeded', tbl;
    exception
      when insufficient_privilege then
        null; -- 42501 == expected; anon is blocked at the GRANT layer
    end;
  end loop;
end $$;

\echo 'verify-rls: PASS'

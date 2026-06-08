-- =============================================================================
-- Re-assertable PostgREST authorization surface (Layer 2 GRANTs + Layer 3 RLS
-- policies + the is_admin()/is_active_user() helpers).
--
-- WHAT THIS IS, AND WHY IT EXISTS SEPARATELY FROM THE MIGRATION
-- -----------------------------------------------------------------------------
-- The canonical, ONE-TIME source of this surface is the tracked migration
-- supabase/migrations/20260602051513_rls_grants_and_policies.sql (AECI-87),
-- which `supabase db push` / `db reset` apply in order on prod and on fresh DBs.
-- This file is the CUMULATIVE, CURRENT-SCHEMA re-assertion of that same surface,
-- run on every staging refresh — and it MUST be kept in step with the migrations
-- as they evolve (see "MAINTENANCE" below).
--
-- WHY THE REFRESH NEEDS IT (the bug this closes):
--   refresh-staging.yml does wipe -> restore prod -> `db push`. The restore uses
--   `pg_dump --no-privileges`, so it brings prod's tables / functions / RLS
--   policies but STRIPS every GRANT. The restore ALSO replays prod's
--   supabase_migrations history, so `db push` SKIPS 20260602051513 (its row is
--   already present) and never re-installs the grants. Net: after a refresh
--   anon/authenticated have NO table grants at all, and verify-rls.sql fails on
--   the first explicit grant it probes (anon INSERT into feedback). Replaying the
--   migration itself is impossible — it names taxonomy_disciplines /
--   product_disciplines, which 20260604042945 (AECI-121) renamed to
--   taxonomy_audiences / product_audiences (grants follow the table OID), so the
--   restored schema is already at the renamed end-state. This file is the
--   migration's surface expressed against the CURRENT table names.
--
-- WHERE IT RUNS:
--   .github/workflows/refresh-staging.yml, between "Apply pending migrations"
--   and "Verify RLS GRANT matrix" — the verify step is the immediate guard.
--   prod (promote-to-prod.yml) and the fresh local DB (drift-check.yml) do NOT
--   run this: they apply migrations in order with no privilege-stripping restore,
--   so their grants are already correct.
--
-- MAINTENANCE: when a future migration changes the grant/policy surface (a new
--   public-read table, a changed policy, a new carve-out), update THIS file in
--   the same PR. verify-rls.sql is the backstop that catches drift on the next
--   refresh. This is the same code-owned-state-re-applied-every-refresh tradeoff
--   that supabase/reference-data/taxonomy.sql accepts (ADR 0008).
--
-- Idempotent and re-run safe by construction: CREATE OR REPLACE FUNCTION,
-- REVOKE/GRANT/ALTER DEFAULT PRIVILEGES/ENABLE RLS are all idempotent, and every
-- CREATE POLICY is preceded by DROP POLICY IF EXISTS.
-- =============================================================================

\set ON_ERROR_STOP on

begin;

-- =============================================================================
-- STEP 1: HELPERS (in public — see 20260602051513 header for why not auth)
--
-- security definer + pinned search_path per the AECI-44 hardening rule.
-- `auth.uid()` and `public.profiles` are fully qualified, so `auth` is NOT
-- required on the path. Re-created here belt-and-braces: the restore already
-- carries prod's copies, but CREATE OR REPLACE keeps this file self-describing
-- and guarantees the definer/search_path settings regardless of restore state.
-- =============================================================================

create or replace function public.is_admin()
  returns boolean
  language sql
  security definer
  stable
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

create or replace function public.is_active_user()
  returns boolean
  language sql
  security definer
  stable
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and banned_at is null
  );
$$;


-- =============================================================================
-- STEP 2: REVOKE EVERYTHING FROM anon AND authenticated
--
-- Re-establish deny-by-default. The blanket `revoke ... on all functions` also
-- strips EXECUTE on the two helpers above (and their implicit PUBLIC grant), so
-- we revoke from PUBLIC and re-grant EXECUTE to the two named roles immediately.
-- service_role grants are NOT touched — that preserves Studio's table editor.
-- =============================================================================

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

revoke execute on function public.is_admin()       from public;
revoke execute on function public.is_active_user() from public;
grant  execute on function public.is_admin()       to anon, authenticated;
grant  execute on function public.is_active_user() to anon, authenticated;


-- =============================================================================
-- STEP 3: DEFAULT PRIVILEGES FOR FUTURE OBJECTS
--
-- Anything created in `public` from now on must get its anon/authenticated
-- grants explicitly. Lock down both the unqualified target and the FOR ROLE
-- postgres target (migrations create objects as `postgres`).
-- =============================================================================

alter default privileges in schema public
  revoke all on tables    from anon, authenticated;
alter default privileges in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges in schema public
  revoke all on functions from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;


-- =============================================================================
-- STEP 3b: LANDING-FORM CARVE-OUT (AECI-87)
--
-- Restore exactly what the write-only landing forms need: INSERT on the table +
-- USAGE on the identity-backing sequence (GENERATED ALWAYS AS IDENTITY calls
-- nextval() as the inserting role). Narrower than the baseline's GRANT ALL —
-- anon never had a working SELECT/UPDATE/DELETE (no policy for those).
-- =============================================================================

grant insert on table    public.feedback             to anon, authenticated;
grant insert on table    public.mailing_list         to anon, authenticated;
grant usage  on sequence public.feedback_id_seq      to anon, authenticated;
grant usage  on sequence public.mailing_list_id_seq  to anon, authenticated;


-- =============================================================================
-- STEP 4: ENABLE RLS ON EVERY TABLE
--
-- Idempotent reinforcement (an event trigger already enables it on future
-- tables). NB: taxonomy_audiences / product_audiences are the post-AECI-121
-- names of the former taxonomy_disciplines / product_disciplines.
-- =============================================================================

alter table vendors                enable row level security;
alter table products               enable row level security;
alter table integrations           enable row level security;
alter table taxonomy_categories    enable row level security;
alter table taxonomy_audiences     enable row level security;
alter table taxonomy_phases        enable row level security;
alter table product_categories     enable row level security;
alter table product_audiences      enable row level security;
alter table product_phases         enable row level security;
alter table product_vendors        enable row level security;
alter table product_extensions     enable row level security;
alter table profiles               enable row level security;
alter table reviews                enable row level security;
alter table vendor_requests        enable row level security;
alter table workflow_instances     enable row level security;
alter table workflow_transitions   enable row level security;
alter table audit_log              enable row level security;
alter table page_views             enable row level security;
alter table stats_cache            enable row level security;
alter table translations           enable row level security;


-- =============================================================================
-- STEP 5: SELECTIVE GRANTS + RLS POLICIES
-- =============================================================================


-- ---- Vendors (public-read, promoted only) -----------------------------------

grant select on table vendors to anon, authenticated;

drop policy if exists "vendors: public read promoted" on vendors;
create policy "vendors: public read promoted"
  on vendors
  for select
  to anon, authenticated
  using (promotion_status = 'promoted');


-- ---- Products (public-read, promoted only) ----------------------------------

grant select on table products to anon, authenticated;

drop policy if exists "products: public read promoted" on products;
create policy "products: public read promoted"
  on products
  for select
  to anon, authenticated
  using (promotion_status = 'promoted');


-- ---- Integrations (public-read, both endpoints promoted) --------------------

grant select on table integrations to anon, authenticated;

drop policy if exists "integrations: public read when both endpoints promoted" on integrations;
create policy "integrations: public read when both endpoints promoted"
  on integrations
  for select
  to anon, authenticated
  using (
    exists (select 1 from products p where p.id = source_product_id and p.promotion_status = 'promoted')
    and exists (select 1 from products p where p.id = target_product_id and p.promotion_status = 'promoted')
  );


-- ---- Taxonomy (public-read, no filter) --------------------------------------

grant select on table taxonomy_categories to anon, authenticated;
grant select on table taxonomy_audiences  to anon, authenticated;
grant select on table taxonomy_phases     to anon, authenticated;

drop policy if exists "taxonomy_categories: public read" on taxonomy_categories;
create policy "taxonomy_categories: public read"
  on taxonomy_categories
  for select to anon, authenticated
  using (true);

drop policy if exists "taxonomy_audiences: public read" on taxonomy_audiences;
create policy "taxonomy_audiences: public read"
  on taxonomy_audiences
  for select to anon, authenticated
  using (true);

drop policy if exists "taxonomy_phases: public read" on taxonomy_phases;
create policy "taxonomy_phases: public read"
  on taxonomy_phases
  for select to anon, authenticated
  using (true);


-- ---- Join tables (public-read, scoped to promoted) --------------------------

grant select on table product_categories to anon, authenticated;
grant select on table product_audiences  to anon, authenticated;
grant select on table product_phases     to anon, authenticated;
grant select on table product_vendors    to anon, authenticated;
grant select on table product_extensions  to anon, authenticated;

drop policy if exists "product_categories: public read when product promoted" on product_categories;
create policy "product_categories: public read when product promoted"
  on product_categories
  for select to anon, authenticated
  using (exists (select 1 from products p where p.id = product_id and p.promotion_status = 'promoted'));

drop policy if exists "product_audiences: public read when product promoted" on product_audiences;
create policy "product_audiences: public read when product promoted"
  on product_audiences
  for select to anon, authenticated
  using (exists (select 1 from products p where p.id = product_id and p.promotion_status = 'promoted'));

drop policy if exists "product_phases: public read when product promoted" on product_phases;
create policy "product_phases: public read when product promoted"
  on product_phases
  for select to anon, authenticated
  using (exists (select 1 from products p where p.id = product_id and p.promotion_status = 'promoted'));

drop policy if exists "product_vendors: public read when product promoted" on product_vendors;
create policy "product_vendors: public read when product promoted"
  on product_vendors
  for select to anon, authenticated
  using (exists (select 1 from products p where p.id = product_id and p.promotion_status = 'promoted'));

drop policy if exists "product_extensions: public read when both products promoted" on product_extensions;
create policy "product_extensions: public read when both products promoted"
  on product_extensions
  for select to anon, authenticated
  using (
    exists (select 1 from products p where p.id = product_id and p.promotion_status = 'promoted')
    and exists (select 1 from products p where p.id = host_product_id and p.promotion_status = 'promoted')
  );


-- ---- Profiles (authenticated-only, scoped to own or admin) ------------------

grant select on table profiles to authenticated;

drop policy if exists "profiles: owner read" on profiles;
create policy "profiles: owner read"
  on profiles
  for select to authenticated
  using (auth.uid() = id);

drop policy if exists "profiles: admin read all" on profiles;
create policy "profiles: admin read all"
  on profiles
  for select to authenticated
  using (public.is_admin());


-- ---- Reviews (mixed: anon sees approved, authenticated sees own + approved) -

grant select on table reviews to anon, authenticated;

drop policy if exists "reviews: public read approved" on reviews;
create policy "reviews: public read approved"
  on reviews
  for select to anon, authenticated
  using (status = 'approved');

drop policy if exists "reviews: owner read own" on reviews;
create policy "reviews: owner read own"
  on reviews
  for select to authenticated
  using (
    auth.uid() = reviewer_id
    and public.is_active_user()
  );

drop policy if exists "reviews: admin read all" on reviews;
create policy "reviews: admin read all"
  on reviews
  for select to authenticated
  using (public.is_admin());


-- ---- Stats cache (public-read aggregate) ------------------------------------

grant select on table stats_cache to anon, authenticated;

drop policy if exists "stats_cache: public read" on stats_cache;
create policy "stats_cache: public read"
  on stats_cache
  for select to anon, authenticated
  using (true);


-- ---- Translations (public-read, empty at launch) ----------------------------

grant select on table translations to anon, authenticated;

drop policy if exists "translations: public read" on translations;
create policy "translations: public read"
  on translations
  for select to anon, authenticated
  using (true);


-- =============================================================================
-- STEP 6: TABLES WITH NO GRANTS (admin-only via Worker)
--
-- No grant to anon/authenticated -> PostgREST returns 42501 before RLS is
-- consulted. The admin-read policies are belt-and-braces in case a grant is
-- ever added by mistake.
-- =============================================================================

drop policy if exists "vendor_requests: admin read" on vendor_requests;
create policy "vendor_requests: admin read"
  on vendor_requests
  for select to authenticated
  using (public.is_admin());

drop policy if exists "workflow_instances: admin read" on workflow_instances;
create policy "workflow_instances: admin read"
  on workflow_instances
  for select to authenticated
  using (public.is_admin());

drop policy if exists "workflow_transitions: admin read" on workflow_transitions;
create policy "workflow_transitions: admin read"
  on workflow_transitions
  for select to authenticated
  using (public.is_admin());

drop policy if exists "audit_log: admin read" on audit_log;
create policy "audit_log: admin read"
  on audit_log
  for select to authenticated
  using (public.is_admin());

drop policy if exists "page_views: admin read" on page_views;
create policy "page_views: admin read"
  on page_views
  for select to authenticated
  using (public.is_admin());

commit;

\echo 'apply-authorization: DONE'

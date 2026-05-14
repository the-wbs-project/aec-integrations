-- =============================================================================
-- AEC Integrations — Row-Level Security + GRANT Policies
-- Stage 1
-- Generated: 2026-05
-- Apply against: Supabase (PostgreSQL 16)
-- =============================================================================
--
-- ARCHITECTURE NOTE
--
-- The AEC Integrations Worker connects to the database via Prisma Accelerate
-- using a privileged Postgres role. That role BYPASSES both RLS and the
-- table-level GRANT system below. The Worker is the authoritative
-- authorization layer — see "Worker authorization" in AUTH_AND_RLS.md for
-- the patterns it enforces.
--
-- These RLS policies AND GRANTs together lock down a second surface:
-- Supabase's PostgREST API at /rest/v1/*.
--
-- THREE-LAYER MODEL
--
--   1. Worker JWT verify + role check    (primary, blocks 99.9% of traffic)
--   2. PostgREST GRANTs                  (binary table-level access)
--   3. RLS row-filter policies           (row-level filtering)
--
-- Per the Supabase email of May 2026: from Oct 30, 2026 all existing
-- projects require explicit GRANTs for new tables. We're applying the
-- new model preemptively to existing tables so the behavior is uniform
-- and matches what new tables will require by default.
-- =============================================================================


-- =============================================================================
-- STEP 1: HELPERS
-- =============================================================================

create or replace function auth.is_admin()
  returns boolean
  language sql
  security definer
  stable
  set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

create or replace function auth.is_active_user()
  returns boolean
  language sql
  security definer
  stable
  set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and banned_at is null
  );
$$;

revoke execute on function auth.is_admin() from public;
revoke execute on function auth.is_active_user() from public;
grant execute on function auth.is_admin() to anon, authenticated;
grant execute on function auth.is_active_user() to anon, authenticated;


-- =============================================================================
-- STEP 2: REVOKE EVERYTHING FROM anon AND authenticated
--
-- This wipes the default grants Supabase applied when each table was
-- created. From this point forward, anon and authenticated have access
-- to a table ONLY when we explicitly grant it below.
--
-- service_role grants are NOT touched — keeping defaults there preserves
-- service-key access for Supabase Studio's table editor and similar.
-- =============================================================================

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;


-- =============================================================================
-- STEP 3: DEFAULT PRIVILEGES FOR FUTURE OBJECTS
--
-- Anything we (or Prisma) create in the public schema from now on must
-- get its anon/authenticated grants explicitly. This is the "lock down
-- by default" stance Supabase is moving toward; we're getting there first.
--
-- service_role default privileges remain Supabase-managed.
-- =============================================================================

-- The ALTER DEFAULT PRIVILEGES target depends on the role that creates
-- the table. Prisma migrations execute as the role configured in
-- DIRECT_URL, typically `postgres`. The dashboard SQL editor also runs
-- as `postgres`. We lock down defaults for both common creators.

alter default privileges in schema public
  revoke all on tables    from anon, authenticated;
alter default privileges in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges in schema public
  revoke all on functions from anon, authenticated;

-- Belt-and-braces: also lock down anything created by the postgres role
-- specifically (in case ALTER DEFAULT PRIVILEGES without FOR ROLE doesn't
-- apply to objects created by postgres in some Supabase configurations).
alter default privileges for role postgres in schema public
  revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;


-- =============================================================================
-- STEP 4: ENABLE RLS ON EVERY TABLE
--
-- RLS is enabled on every table for two reasons:
--   1. Defense in depth — if a future grant is added by mistake, RLS
--      still filters.
--   2. Supabase dashboard hygiene — every table shows "RLS enabled"
--      and there are no "Public table without RLS" warnings.
--
-- For tables with no GRANT to anon/authenticated, RLS is academic.
-- That's fine — it's free.
-- =============================================================================

alter table vendors                enable row level security;
alter table products               enable row level security;
alter table integrations           enable row level security;
alter table taxonomy_categories    enable row level security;
alter table taxonomy_disciplines   enable row level security;
alter table taxonomy_phases        enable row level security;
alter table product_categories     enable row level security;
alter table product_disciplines    enable row level security;
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
--
-- For each table, we either:
--   (A) Grant SELECT to anon/authenticated and add an RLS policy to filter
--       which rows are visible (public-read tables), or
--   (B) Grant nothing (admin-only and write-only tables) — PostgREST
--       returns 42501 to any anon/auth request regardless of RLS.
--
-- No INSERT/UPDATE/DELETE grants anywhere. All writes are Worker-only.
-- =============================================================================


-- ---- Vendors (public-read, promoted only) -----------------------------------

grant select on table vendors to anon, authenticated;

create policy "vendors: public read promoted"
  on vendors
  for select
  to anon, authenticated
  using (promotion_status = 'promoted');


-- ---- Products (public-read, promoted only) ----------------------------------

grant select on table products to anon, authenticated;

create policy "products: public read promoted"
  on products
  for select
  to anon, authenticated
  using (promotion_status = 'promoted');


-- ---- Integrations (public-read, both endpoints promoted) --------------------

grant select on table integrations to anon, authenticated;

create policy "integrations: public read when both endpoints promoted"
  on integrations
  for select
  to anon, authenticated
  using (
    exists (select 1 from products p where p.id = source_product_id and p.promotion_status = 'promoted')
    and exists (select 1 from products p where p.id = target_product_id and p.promotion_status = 'promoted')
  );


-- ---- Taxonomy (public-read, no filter) --------------------------------------

grant select on table taxonomy_categories  to anon, authenticated;
grant select on table taxonomy_disciplines to anon, authenticated;
grant select on table taxonomy_phases      to anon, authenticated;

create policy "taxonomy_categories: public read"
  on taxonomy_categories
  for select to anon, authenticated
  using (true);

create policy "taxonomy_disciplines: public read"
  on taxonomy_disciplines
  for select to anon, authenticated
  using (true);

create policy "taxonomy_phases: public read"
  on taxonomy_phases
  for select to anon, authenticated
  using (true);


-- ---- Join tables (public-read, scoped to promoted) --------------------------

grant select on table product_categories  to anon, authenticated;
grant select on table product_disciplines to anon, authenticated;
grant select on table product_phases      to anon, authenticated;
grant select on table product_vendors     to anon, authenticated;
grant select on table product_extensions  to anon, authenticated;

create policy "product_categories: public read when product promoted"
  on product_categories
  for select to anon, authenticated
  using (exists (select 1 from products p where p.id = product_id and p.promotion_status = 'promoted'));

create policy "product_disciplines: public read when product promoted"
  on product_disciplines
  for select to anon, authenticated
  using (exists (select 1 from products p where p.id = product_id and p.promotion_status = 'promoted'));

create policy "product_phases: public read when product promoted"
  on product_phases
  for select to anon, authenticated
  using (exists (select 1 from products p where p.id = product_id and p.promotion_status = 'promoted'));

create policy "product_vendors: public read when product promoted"
  on product_vendors
  for select to anon, authenticated
  using (exists (select 1 from products p where p.id = product_id and p.promotion_status = 'promoted'));

create policy "product_extensions: public read when both products promoted"
  on product_extensions
  for select to anon, authenticated
  using (
    exists (select 1 from products p where p.id = product_id and p.promotion_status = 'promoted')
    and exists (select 1 from products p where p.id = host_product_id and p.promotion_status = 'promoted')
  );


-- ---- Profiles (authenticated-only, scoped to own or admin) ------------------
--
-- SELECT granted to authenticated only — anon has no grant and no policy.
-- The RLS policies filter authenticated requests to own row + admin-sees-all.

grant select on table profiles to authenticated;

create policy "profiles: owner read"
  on profiles
  for select to authenticated
  using (auth.uid() = id);

create policy "profiles: admin read all"
  on profiles
  for select to authenticated
  using (auth.is_admin());


-- ---- Reviews (mixed: anon sees approved, authenticated sees own + approved) -

grant select on table reviews to anon, authenticated;

create policy "reviews: public read approved"
  on reviews
  for select to anon, authenticated
  using (status = 'approved');

create policy "reviews: owner read own"
  on reviews
  for select to authenticated
  using (
    auth.uid() = reviewer_id
    and auth.is_active_user()
  );

create policy "reviews: admin read all"
  on reviews
  for select to authenticated
  using (auth.is_admin());


-- ---- Stats cache (public-read aggregate) ------------------------------------

grant select on table stats_cache to anon, authenticated;

create policy "stats_cache: public read"
  on stats_cache
  for select to anon, authenticated
  using (true);


-- ---- Translations (public-read, empty at launch) ----------------------------

grant select on table translations to anon, authenticated;

create policy "translations: public read"
  on translations
  for select to anon, authenticated
  using (true);


-- =============================================================================
-- STEP 6: TABLES WITH NO GRANTS (admin-only via Worker)
--
-- The following tables have NO grants to anon or authenticated. PostgREST
-- requests against them return 42501 insufficient_privilege. RLS policies
-- on these tables exist as belt-and-braces — if a grant gets added by
-- mistake later, the policies still restrict access to admins.
-- =============================================================================

-- vendor_requests -------------------------------------------------------------
-- No GRANT. RLS policy below is a no-op for PostgREST until grants are added.
create policy "vendor_requests: admin read"
  on vendor_requests
  for select to authenticated
  using (auth.is_admin());

-- workflow_instances ----------------------------------------------------------
create policy "workflow_instances: admin read"
  on workflow_instances
  for select to authenticated
  using (auth.is_admin());

-- workflow_transitions --------------------------------------------------------
create policy "workflow_transitions: admin read"
  on workflow_transitions
  for select to authenticated
  using (auth.is_admin());

-- audit_log -------------------------------------------------------------------
create policy "audit_log: admin read"
  on audit_log
  for select to authenticated
  using (auth.is_admin());

-- page_views ------------------------------------------------------------------
create policy "page_views: admin read"
  on page_views
  for select to authenticated
  using (auth.is_admin());


-- =============================================================================
-- VERIFICATION QUERIES (run manually after applying)
-- =============================================================================
--
-- Check which tables anon can SELECT from:
--   select table_name, privilege_type
--   from information_schema.role_table_grants
--   where grantee = 'anon' and table_schema = 'public'
--   order by table_name;
--
-- Expected anon SELECT grants:
--   integrations, product_categories, product_disciplines, product_extensions,
--   product_phases, product_vendors, products, reviews, stats_cache,
--   taxonomy_categories, taxonomy_disciplines, taxonomy_phases,
--   translations, vendors
--
-- Expected: NO grants for anon on:
--   audit_log, page_views, profiles, vendor_requests, workflow_instances,
--   workflow_transitions
--
-- Same query for authenticated, expected to include all of anon's grants
-- PLUS profiles. No write grants anywhere.
--
-- =============================================================================
-- INTENTIONAL OMISSIONS
-- =============================================================================
--
-- 1. No INSERT/UPDATE/DELETE grants or policies anywhere.
--    All writes go through the Worker.
--
-- 2. service_role grants are not touched.
--    Service role retains its Supabase defaults so Studio's table editor
--    keeps working.
--
-- 3. handle_new_user() trigger handles profile INSERT.
--    No GRANT or policy needed for that path — it runs as security definer
--    inside Postgres.
--
-- 4. Cascading FKs handle deletion. Account deletion is a single Worker
--    call to Supabase Auth's delete-user API; the DB cascades the rest.
-- =============================================================================
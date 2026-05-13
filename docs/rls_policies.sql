-- =============================================================================
-- AEC Integrations — Row-Level Security Policies
-- Stage 1
-- Generated: 2026-05
-- Apply against: Supabase (PostgreSQL 16)
-- =============================================================================
--
-- ARCHITECTURE NOTE
--
-- The AEC Integrations Worker connects to the database via Prisma Accelerate
-- using a privileged Postgres role. That role BYPASSES RLS. The Worker is
-- the authoritative authorization layer — see "Worker authorization" in
-- AUTH_AND_RLS.md for the patterns it enforces.
--
-- These RLS policies exist to lock down a SECOND surface: Supabase's
-- PostgREST API at /rest/v1/*. PostgREST is enabled by default in every
-- Supabase project, and the anon key (designed to be public) can query any
-- table exposed there. Without RLS, an anon key leak would expose the entire
-- database. With these policies, the PostgREST surface returns only what
-- it's explicitly allowed to return.
--
-- This is defense in depth. The Worker should never break, but if it does,
-- or if anyone enables a Supabase JS client in the future, RLS is what
-- contains the blast radius.
--
-- WHO THESE POLICIES TARGET
--
--   anon role:           anyone hitting /rest/v1 with the anon key
--   authenticated role:  a user with a valid Supabase auth JWT (Stage 1
--                        does not use the Supabase JS client, but Supabase
--                        Auth still issues these JWTs)
--
-- The Worker (Prisma Accelerate) and the dashboard (postgres superuser)
-- bypass everything below. That is expected.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- HELPERS
-- -----------------------------------------------------------------------------

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
-- DOMAIN 1: CORE ENTITIES
-- Only promoted records are exposed via PostgREST.
-- =============================================================================

alter table vendors      enable row level security;
alter table products     enable row level security;
alter table integrations enable row level security;

create policy "vendors: public read promoted"
  on vendors
  for select
  to anon, authenticated
  using (promotion_status = 'promoted');

create policy "products: public read promoted"
  on products
  for select
  to anon, authenticated
  using (promotion_status = 'promoted');

create policy "integrations: public read when both endpoints promoted"
  on integrations
  for select
  to anon, authenticated
  using (
    exists (select 1 from products p where p.id = source_product_id and p.promotion_status = 'promoted')
    and exists (select 1 from products p where p.id = target_product_id and p.promotion_status = 'promoted')
  );


-- =============================================================================
-- DOMAIN 2: TAXONOMY — public read
-- =============================================================================

alter table taxonomy_categories  enable row level security;
alter table taxonomy_disciplines enable row level security;
alter table taxonomy_phases      enable row level security;

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


-- =============================================================================
-- DOMAIN 3: JOIN TABLES — scoped to promoted products
-- =============================================================================

alter table product_categories   enable row level security;
alter table product_disciplines  enable row level security;
alter table product_phases       enable row level security;
alter table product_vendors      enable row level security;
alter table product_extensions   enable row level security;

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


-- =============================================================================
-- DOMAIN 4: USER & CONTENT
-- =============================================================================

alter table profiles enable row level security;
alter table reviews  enable row level security;


-- profiles --------------------------------------------------------------------
create policy "profiles: owner read"
  on profiles
  for select to authenticated
  using (auth.uid() = id);

create policy "profiles: admin read all"
  on profiles
  for select to authenticated
  using (auth.is_admin());


-- reviews ---------------------------------------------------------------------
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


-- =============================================================================
-- DOMAIN 5: OPERATIONS & WORKFLOW — admin read only
-- =============================================================================

alter table vendor_requests       enable row level security;
alter table workflow_instances    enable row level security;
alter table workflow_transitions  enable row level security;
alter table audit_log             enable row level security;

create policy "vendor_requests: admin read"
  on vendor_requests
  for select to authenticated
  using (auth.is_admin());

create policy "workflow_instances: admin read"
  on workflow_instances
  for select to authenticated
  using (auth.is_admin());

create policy "workflow_transitions: admin read"
  on workflow_transitions
  for select to authenticated
  using (auth.is_admin());

create policy "audit_log: admin read"
  on audit_log
  for select to authenticated
  using (auth.is_admin());


-- =============================================================================
-- DOMAIN 6: ANALYTICS & CACHING
-- =============================================================================

alter table page_views   enable row level security;
alter table stats_cache  enable row level security;

create policy "page_views: admin read"
  on page_views
  for select to authenticated
  using (auth.is_admin());

create policy "stats_cache: public read"
  on stats_cache
  for select to anon, authenticated
  using (true);


-- =============================================================================
-- DOMAIN 7: TRANSLATIONS
-- =============================================================================

alter table translations enable row level security;

create policy "translations: public read"
  on translations
  for select to anon, authenticated
  using (true);


-- =============================================================================
-- INTENTIONAL OMISSIONS
-- =============================================================================
--
-- 1. No INSERT/UPDATE/DELETE policies anywhere via anon/authenticated.
--    Writes via PostgREST are denied by default when RLS is on and no
--    write policy exists. All writes must go through the Worker, which
--    validates JWTs, checks roles, runs Zod validation, and appends
--    audit log entries inside the same transaction.
--
-- 2. No owner-update policy on reviews.
--    Stage 1 reviews are immutable after submission. Users cannot edit
--    a pending review — if they want to change it they submit a new one.
--    Stage 2 may revisit this with re-moderation.
--
-- 3. No owner-update policy on profiles.
--    Profile field changes (display_name, theme_preference) go through
--    the Worker so they can be audited.
--
-- 4. handle_new_user() trigger handles profile INSERT automatically on
--    auth.users insert. No application code or RLS policy needed.
--
-- 5. Cascading FKs handle most "deletion" semantics. Account deletion
--    is a single Worker call to Supabase Auth's delete-user API; the DB
--    cascades to profiles and nulls reviews.reviewer_id automatically.
-- =============================================================================
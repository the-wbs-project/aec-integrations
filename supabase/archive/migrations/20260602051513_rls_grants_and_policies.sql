-- =============================================================================
-- AECI-87: PostgREST authorization surface — Layer 2 GRANTs + Layer 3 RLS
-- policies + the is_admin()/is_active_user() helpers, as a tracked migration.
--
-- Previously this lived in docs/rls_policies.sql and was applied ONLY to the
-- local Docker container (as supabase_admin, via `pnpm db:apply-rls`). It never
-- reached staging/prod and the staging refresh wiped it. Converting it to a
-- numbered migration means `supabase db push` / `db reset` apply it everywhere,
-- it survives the staging refresh, and a fresh DB has the helper functions the
-- policies reference. See docs/AUTH_AND_RLS.md and docs/CICD_PLAN.md §5.4.
--
-- WHY THE HELPERS LIVE IN `public`, NOT `auth`:
--   Migrations apply as the `postgres` role, which has no CREATE on the `auth`
--   schema (owned by supabase_admin) — `create function auth.is_admin()` fails
--   42501 under `supabase db push`/`reset`. That privilege gap is exactly why
--   the old apply ran as supabase_admin. The helpers move to `public.is_admin()`
--   / `public.is_active_user()`; their bodies already schema-qualify both
--   `auth.uid()` and `public.profiles`, so nothing else changes semantically.
--   anon/authenticated get EXECUTE explicitly (STEP 2) so RLS evaluation works.
--
-- THREE-LAYER MODEL (docs/AUTH_AND_RLS.md §1):
--   1. Worker JWT verify + role check    (primary, blocks 99.9% of traffic)
--   2. PostgREST GRANTs                  (binary table-level access)
--   3. RLS row-filter policies           (row-level filtering)
-- The Worker's Prisma Accelerate connection uses a privileged role that
-- BYPASSES both GRANTs and RLS. This file locks down the /rest/v1/* surface.
--
-- Re-run safety: every `create policy` is preceded by `drop policy if exists`;
-- REVOKE/GRANT/ALTER DEFAULT PRIVILEGES/ENABLE RLS/CREATE OR REPLACE FUNCTION
-- are all idempotent. (Once recorded in supabase_migrations a fix needs a NEW
-- forward migration — never edit this file after merge; see docs/migrations.md.)
-- =============================================================================

begin;

-- =============================================================================
-- STEP 1: HELPERS (in public — see header for why not auth)
--
-- security definer + pinned search_path follows the AECI-44 hardening rule for
-- every SECURITY DEFINER function in the project. `auth.uid()` and
-- `public.profiles` are fully qualified, so `auth` is NOT required on the path.
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
-- Wipes the default grants Supabase applied when each table was created. From
-- here on, anon/authenticated reach a table ONLY where we explicitly grant it.
-- service_role grants are NOT touched — that preserves Studio's table editor.
--
-- ORDERING IS LOAD-BEARING: the blanket `revoke ... on all functions` also
-- strips EXECUTE on the two helpers created above, so we re-grant them
-- immediately after. anon/authenticated also inherit EXECUTE via the implicit
-- PUBLIC grant, so we must `revoke ... from public` before re-granting to the
-- two named roles — otherwise the helpers stay world-executable.
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
-- Anything we (or Prisma) create in `public` from now on must get its
-- anon/authenticated grants explicitly. Matches the post-Oct-30 Supabase
-- default. Migrations create tables as `postgres`, so we lock down both the
-- unqualified target and the FOR ROLE postgres target.
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
-- The blanket REVOKE in STEP 2 strips the anon/authenticated grants the landing
-- baseline (20260101000000_landing_baseline.sql:113-117) issued on feedback /
-- mailing_list — which would break the pre-launch lead-capture forms. Restore
-- exactly what those write-only forms need: INSERT on the table + USAGE on the
-- identity-backing sequence (GENERATED ALWAYS AS IDENTITY calls nextval() as the
-- inserting role). This is narrower than the baseline's GRANT ALL — anon never
-- had a working SELECT/UPDATE/DELETE (no RLS policy for those), so dropping them
-- tightens the deny-by-default posture with no behavioural change for the forms.
-- service_role keeps its baseline GRANT ALL (untouched by STEP 2's REVOKE).
-- The "Allow anonymous inserts" INSERT policy from the baseline is still in force.
-- =============================================================================

grant insert on table    public.feedback             to anon, authenticated;
grant insert on table    public.mailing_list         to anon, authenticated;
grant usage  on sequence public.feedback_id_seq      to anon, authenticated;
grant usage  on sequence public.mailing_list_id_seq  to anon, authenticated;


-- =============================================================================
-- STEP 4: ENABLE RLS ON EVERY TABLE
--
-- Idempotent reinforcement — 20260525064254_capture_rls_auto_enable.sql already
-- enables RLS on these (and an event trigger enables it on future tables). Kept
-- here so this file is self-describing about the surface it governs.
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
-- For each table we either (A) grant SELECT to anon/authenticated and add an
-- RLS policy filtering visible rows, or (B) grant nothing (PostgREST returns
-- 42501 regardless of RLS). No INSERT/UPDATE/DELETE grants anywhere — all writes
-- are Worker-only. (feedback/mailing_list in STEP 3b are the landing exception.)
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

grant select on table taxonomy_categories  to anon, authenticated;
grant select on table taxonomy_disciplines to anon, authenticated;
grant select on table taxonomy_phases      to anon, authenticated;

drop policy if exists "taxonomy_categories: public read" on taxonomy_categories;
create policy "taxonomy_categories: public read"
  on taxonomy_categories
  for select to anon, authenticated
  using (true);

drop policy if exists "taxonomy_disciplines: public read" on taxonomy_disciplines;
create policy "taxonomy_disciplines: public read"
  on taxonomy_disciplines
  for select to anon, authenticated
  using (true);

drop policy if exists "taxonomy_phases: public read" on taxonomy_phases;
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

drop policy if exists "product_categories: public read when product promoted" on product_categories;
create policy "product_categories: public read when product promoted"
  on product_categories
  for select to anon, authenticated
  using (exists (select 1 from products p where p.id = product_id and p.promotion_status = 'promoted'));

drop policy if exists "product_disciplines: public read when product promoted" on product_disciplines;
create policy "product_disciplines: public read when product promoted"
  on product_disciplines
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
--
-- SELECT granted to authenticated only — anon has no grant and no policy.
-- The RLS policies filter authenticated requests to own row + admin-sees-all.

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
-- These tables have NO grant to anon or authenticated, so PostgREST returns
-- 42501 before RLS is consulted. The admin-read policies below are
-- belt-and-braces: if a grant is ever added by mistake, the policies still
-- restrict access to admins.
-- =============================================================================

-- vendor_requests -------------------------------------------------------------
drop policy if exists "vendor_requests: admin read" on vendor_requests;
create policy "vendor_requests: admin read"
  on vendor_requests
  for select to authenticated
  using (public.is_admin());

-- workflow_instances ----------------------------------------------------------
drop policy if exists "workflow_instances: admin read" on workflow_instances;
create policy "workflow_instances: admin read"
  on workflow_instances
  for select to authenticated
  using (public.is_admin());

-- workflow_transitions --------------------------------------------------------
drop policy if exists "workflow_transitions: admin read" on workflow_transitions;
create policy "workflow_transitions: admin read"
  on workflow_transitions
  for select to authenticated
  using (public.is_admin());

-- audit_log -------------------------------------------------------------------
drop policy if exists "audit_log: admin read" on audit_log;
create policy "audit_log: admin read"
  on audit_log
  for select to authenticated
  using (public.is_admin());

-- page_views ------------------------------------------------------------------
drop policy if exists "page_views: admin read" on page_views;
create policy "page_views: admin read"
  on page_views
  for select to authenticated
  using (public.is_admin());

commit;

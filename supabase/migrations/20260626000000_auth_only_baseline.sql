-- AECI-278: consolidated AUTH-ONLY baseline for the Supabase project.
--
-- ADR 0016 moved the application database to Cloudflare D1 + Drizzle; ADR 0017
-- made auth a single shared Supabase project across all environments. This
-- Supabase project is now Auth-only — it holds NO application tables (products,
-- vendors, reviews, taxonomy, …), which live in D1.
--
-- This migration consolidates the three retained auth migrations into one
-- baseline. The original 15 migrations (incl. the full pre-D1 app schema, its
-- GRANT/RLS surface, and the landing-baseline tables) are kept for history under
-- `supabase/archive/migrations/` — they are no longer part of the active
-- migration set the Supabase CLI applies. This file defines only the auth
-- surface: a minimal `public.profiles` row keyed to `auth.users`, plus the
-- create/delete sync triggers. It is the net state of:
--   - 20260515052617_auth_integration.sql                  (handle_new_user + on_auth_user_created)
--   - 20260522000000_pin_handle_new_user_search_path.sql   (pinned search_path)
--   - 20260526083101_drop_profiles_auth_fk_add_delete_trigger.sql
--                                                          (no FK; handle_auth_user_delete + on_auth_user_deleted)
--
-- NOTE: under ADR 0016 the Worker creates/erases the AUTHORITATIVE profile in D1
-- (`POST /api/auth/profile/ensure` + the Supabase Admin API for GDPR erasure);
-- this Postgres `profiles` row + triggers are retained per AECI-278's
-- MUST-RETAIN list but are not read by the application.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP … IF EXISTS) so it can be
-- repaired onto the existing shared auth project (`supabase migration repair`)
-- without dropping live `auth.users` data, and replayed cleanly on a fresh local
-- stack (`supabase db reset`). Source of truth: docs/AUTH_AND_RLS.md §8.1.

-- Minimal profile row, keyed 1:1 to a Supabase Auth user. No FK to auth.users:
-- the original cross-schema FK was replaced by the AFTER DELETE trigger below
-- (AECI-69) so this migration set never needs to mirror the auth.* schema.
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY
);

-- Auto-create a profile row on Supabase Auth signup. SECURITY DEFINER with a
-- pinned search_path (AECI-44 hardening for every SECURITY DEFINER function).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Delete the matching profile row when an auth.users row is deleted (replaces
-- the original ON DELETE CASCADE FK; AECI-69).
CREATE OR REPLACE FUNCTION public.handle_auth_user_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.profiles WHERE id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_deleted ON auth.users;
CREATE TRIGGER on_auth_user_deleted
  AFTER DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_delete();

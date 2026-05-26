-- AECI-69: replace cross-schema FK profiles_id_fkey -> auth.users(id)
-- with a sibling AFTER DELETE trigger on auth.users.
--
-- The original FK (see 20260515052617_auth_integration.sql) used
-- ON DELETE CASCADE to clean up the public.profiles row when its
-- auth.users counterpart was deleted. We replace that with a trigger
-- so apps/api/prisma/schema.prisma no longer needs to mirror the
-- entire auth.* schema (forced by Prisma's multiSchema requirement
-- when a cross-schema FK is present).
--
-- Source of truth: docs/AUTH_AND_RLS.md "Auth -> public sync triggers"
-- and ADR 0007 (docs/adr/0007-prisma-migrate-dev-unsupported.md) §5.3.
-- Sibling of public.handle_new_user() in auth_integration migration.

-- 1. Drop the cross-schema FK. Cascade-on-delete is replaced by the trigger below.
ALTER TABLE "profiles" DROP CONSTRAINT IF EXISTS "profiles_id_fkey";

-- 2. Function that deletes the matching profiles row when an auth.users row
-- is deleted. SECURITY DEFINER with pinned search_path follows the AECI-44
-- hardening rule for every SECURITY DEFINER function in the project.
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

-- 3. AFTER DELETE trigger on auth.users. Mirrors the on_auth_user_created
-- INSERT trigger in shape and lifecycle.
DROP TRIGGER IF EXISTS on_auth_user_deleted ON auth.users;
CREATE TRIGGER on_auth_user_deleted
  AFTER DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_delete();

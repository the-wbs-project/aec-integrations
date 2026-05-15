-- AECI-29: wire profiles to Supabase Auth.
--
-- Deferred from the AECI-39 baseline migration (see its header comment,
-- lines 14-18). These statements reference Supabase's `auth` schema, which
-- does not exist on vanilla Postgres — keeping them out of the baseline let
-- that migration apply against any PG 13+ during early scaffolding.
--
-- Source of truth: docs/DATABASE_SCHEMA.md §7.1 and docs/AUTH_AND_RLS.md §8.

-- 1. FK so deleting a Supabase Auth user cascades to the profile row.
ALTER TABLE "profiles"
  ADD CONSTRAINT "profiles_id_fkey"
  FOREIGN KEY ("id") REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. Trigger to auto-create a profile row on Supabase Auth signup.
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id) VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- AECI-77: idempotent test-account seed for staging.
--
-- Run AFTER scripts/scrub-auth-credentials.sql by the refresh-staging workflow
-- (step 8). Safe to re-run by hand against any non-prod environment.
--
-- Seeds four accounts:
--
--   email                       | profiles.role | purpose
--   ----------------------------+---------------+-------------------------------
--   chrisw@thewbsproject.com    | admin         | primary operator
--   billh@thewbsproject.com     | admin         | secondary operator
--   reviewer@aeci.local         | reviewer      | normal-user test account
--   admin@aeci.local            | admin         | dedicated admin test account
--
-- All four authenticate with password `staging-test-password`. Do NOT change
-- the password here without coordinating with whoever owns the test fixtures
-- (today: Chris). Per AECI-71's "Auth users in staging" decision, this
-- password is shared across staging accounts — staging is never public and
-- is fronted by Cloudflare Access (docs/access.md).
--
-- Implementation notes:
--   - `pgcrypto` is already enabled via supabase/migrations/20260515024116_baseline_schema.sql
--     so crypt()/gen_salt('bf') are available without a CREATE EXTENSION here.
--   - GoTrue requires more than just email + encrypted_password to authenticate
--     a row inserted via raw SQL: instance_id, aud='authenticated', role='authenticated',
--     email_confirmed_at, raw_app_meta_data, and raw_user_meta_data all need
--     plausible values or the login flow rejects the row.
--   - The `on_auth_user_created` trigger
--     (supabase/migrations/20260515052617_auth_integration.sql:23-26)
--     fires only AFTER INSERT. The ON CONFLICT (id) DO UPDATE path skips it,
--     so each auth.users UPSERT is followed by an explicit public.profiles
--     UPSERT keyed on the same UUID.
--   - UUIDs are pinned per account (not gen_random_uuid()) so that re-runs
--     and FK references in other test data remain stable across refreshes.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- auth.users
-- ---------------------------------------------------------------------------

INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
) VALUES
    ('00000000-0000-0000-0000-000000000000',
     '00000000-0000-0000-0000-00000000c001',
     'authenticated', 'authenticated',
     'chrisw@thewbsproject.com',
     crypt('staging-test-password', gen_salt('bf')),
     now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     '{}'::jsonb,
     now(), now()),
    ('00000000-0000-0000-0000-000000000000',
     '00000000-0000-0000-0000-00000000c002',
     'authenticated', 'authenticated',
     'billh@thewbsproject.com',
     crypt('staging-test-password', gen_salt('bf')),
     now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     '{}'::jsonb,
     now(), now()),
    ('00000000-0000-0000-0000-000000000000',
     '00000000-0000-0000-0000-00000000c003',
     'authenticated', 'authenticated',
     'reviewer@aeci.local',
     crypt('staging-test-password', gen_salt('bf')),
     now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     '{}'::jsonb,
     now(), now()),
    ('00000000-0000-0000-0000-000000000000',
     '00000000-0000-0000-0000-00000000c004',
     'authenticated', 'authenticated',
     'admin@aeci.local',
     crypt('staging-test-password', gen_salt('bf')),
     now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     '{}'::jsonb,
     now(), now())
ON CONFLICT (id) DO UPDATE
   SET email              = EXCLUDED.email,
       encrypted_password = EXCLUDED.encrypted_password,
       email_confirmed_at = EXCLUDED.email_confirmed_at,
       raw_app_meta_data  = EXCLUDED.raw_app_meta_data,
       raw_user_meta_data = EXCLUDED.raw_user_meta_data,
       updated_at         = now();

-- ---------------------------------------------------------------------------
-- public.profiles
--
-- INSERT-then-UPDATE because the on_auth_user_created trigger only fires on
-- INSERT into auth.users; when we UPSERT auth.users above, the trigger
-- doesn't run, so the profile row may not exist yet (first-time seed) OR may
-- already exist with a stale role (subsequent runs).
-- ---------------------------------------------------------------------------

INSERT INTO public.profiles (id, display_name, role) VALUES
    ('00000000-0000-0000-0000-00000000c001', 'Chris Walton',   'admin'),
    ('00000000-0000-0000-0000-00000000c002', 'Bill Hartmann',  'admin'),
    ('00000000-0000-0000-0000-00000000c003', 'Test Reviewer',  'reviewer'),
    ('00000000-0000-0000-0000-00000000c004', 'Test Admin',     'admin')
ON CONFLICT (id) DO UPDATE
   SET display_name = EXCLUDED.display_name,
       role         = EXCLUDED.role;
       -- updated_at is maintained by the profiles_updated_at trigger
       -- (supabase/migrations/20260515024116_baseline_schema.sql:767-769)

COMMIT;

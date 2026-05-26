-- AECI-77: scrub auth credentials in staging post-prod-restore.
--
-- Preserves auth.users rows (IDs and FKs intact for RLS debugging) per the
-- AECI-71 "Auth users in staging" decision. Real users from prod remain
-- enumerable in staging but cannot authenticate against it because their
-- password and every outstanding token is nulled and all sessions/refresh
-- tokens are deleted.
--
-- Invoked by .github/workflows/refresh-staging.yml step 7, against the
-- staging Supabase Postgres via `psql $DIRECT_URL_STAGING -v ON_ERROR_STOP=1
-- -f scripts/scrub-auth-credentials.sql`.
--
-- Run order in the workflow:
--   1-5: pg_dump prod / wipe staging / pg_restore staging  (data is prod's)
--   6:   supabase db push --linked                          (schema is current)
--   7:   THIS SCRIPT                                        (credentials nulled)
--   8:   scripts/seed-staging-users.sql                     (test accounts seeded)

\set ON_ERROR_STOP on

BEGIN;

UPDATE auth.users
   SET encrypted_password     = NULL,
       confirmation_token     = NULL,
       recovery_token         = NULL,
       email_change_token_new = NULL,
       phone_change_token     = NULL;

DELETE FROM auth.sessions;
DELETE FROM auth.refresh_tokens;

COMMIT;

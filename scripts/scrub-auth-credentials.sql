-- AECI-77: scrub auth credentials in staging post-prod-restore.
--
-- Preserves auth.users rows (IDs and FKs intact for RLS debugging) per the
-- AECI-71 "Auth users in staging" decision. Real users from prod remain
-- enumerable in staging but cannot authenticate against it because their
-- password is nulled, every outstanding token is cleared, and all
-- sessions/refresh tokens are deleted.
--
-- IMPORTANT: token columns are cleared to '' (empty string), NOT NULL. GoTrue
-- scans confirmation_token / recovery_token / email_change* / phone_change* /
-- reauthentication_token as NON-NULL Go strings — a NULL value makes the NEXT
-- magic-link login fail with `500 unexpected_failure "Database error finding
-- user"` for that email. '' is GoTrue's "no token" sentinel and grants no auth,
-- so the scrub's intent is preserved. (encrypted_password stays NULL — GoTrue
-- treats it as a nullable pointer, and NULL there is what disables password
-- login.) The previous version set these to NULL and broke staging sign-in.
--
-- Invocation: run manually against a Postgres auth database that holds a COPY of
-- another environment's `auth.users` (e.g. a local Supabase stack seeded from a
-- dump), to disable login on the copied accounts:
--   psql "$PGURL" -v ON_ERROR_STOP=1 -f scripts/scrub-auth-credentials.sql
--
-- NOTE (ADR 0017 / AECI-278): every environment now shares ONE Supabase Auth
-- project, so staging auth is no longer sourced from a prod dump and the original
-- refresh-staging.yml scrub step (with its pg_dump/wipe/restore/`supabase db push`
-- preamble) was removed. This script is retained for the manual local-copy case
-- only — NEVER run it against the shared auth project; it would disable real
-- logins. The companion test-account seed is `scripts/seed-staging-users.sql`.

\set ON_ERROR_STOP on

BEGIN;

UPDATE auth.users
   SET encrypted_password         = NULL,
       confirmation_token          = '',
       recovery_token              = '',
       email_change                = '',
       email_change_token_new      = '',
       email_change_token_current  = '',
       phone_change                = '',
       phone_change_token          = '',
       reauthentication_token      = '';

DELETE FROM auth.sessions;
DELETE FROM auth.refresh_tokens;

COMMIT;

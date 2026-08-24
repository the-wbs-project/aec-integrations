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
--   - ADOPT-OR-MINT, keyed on EMAIL. chrisw@ and billh@ are real prod operators
--     AS WELL AS seed accounts, so the prod restore (refresh-staging step 5)
--     carries auth.users rows for those emails under their REAL prod UUIDs,
--     plus matching profiles and audit_log FK references. We must NOT
--     create a second row for the same email (auth.users enforces a partial
--     unique index on email — `users_email_partial_key` — so a pinned-UUID
--     INSERT collides: "duplicate key value ... email=chrisw@..."), and we must
--     NOT delete the existing row (profiles is referenced by audit_log /
--     workflow_* via ON DELETE NO ACTION FKs, so deleting an operator's profile
--     can itself fail). `page_views` no longer belongs on that list: AECI-585
--     dropped its `user_id` column, so it holds no reference to profiles at all.
--     So: if a row with the email already
--     exists, ADOPT it — set the shared test password and reset its tokens in
--     place — otherwise MINT a fresh row under its pinned fallback UUID.
--   - Pinned UUIDs are used only when minting a brand-new account, so re-runs
--     and any future FK references to the .local test accounts stay stable.
--     An adopted account keeps whatever UUID the restore gave it, which is what
--     preserves the operator's existing FK references.
--   - The on_auth_user_created / on_auth_user_deleted triggers
--     (supabase/migrations/20260515052617_auth_integration.sql,
--      supabase/migrations/20260526083101_drop_profiles_auth_fk_add_delete_trigger.sql)
--     are DROPPED by the refresh's `DROP SCHEMA public CASCADE` (they depend on
--     public functions) and NOT recreated by the restore (`--schema=public`
--     omits triggers living on auth.users) nor by `db push` (their migration
--     row is already in the restored history). So this seed cannot rely on the
--     INSERT trigger to create profiles — it UPSERTs public.profiles explicitly
--     for each account's UUID.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- auth.users + public.profiles (adopt-or-mint per account; see header)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    acct      RECORD;
    target_id uuid;
BEGIN
    FOR acct IN
        SELECT *
        FROM (VALUES
            ('chrisw@thewbsproject.com', 'Chris Walton',  'admin',    '00000000-0000-0000-0000-00000000c001'::uuid),
            ('billh@thewbsproject.com',  'Bill Hartmann', 'admin',    '00000000-0000-0000-0000-00000000c002'::uuid),
            ('reviewer@aeci.local',      'Test Reviewer', 'reviewer', '00000000-0000-0000-0000-00000000c003'::uuid),
            ('admin@aeci.local',         'Test Admin',    'admin',    '00000000-0000-0000-0000-00000000c004'::uuid)
        ) AS t(email, display_name, role, fallback_id)
    LOOP
        SELECT id INTO target_id FROM auth.users WHERE email = acct.email;

        IF target_id IS NULL THEN
            -- MINT: no row for this email (the .local accounts, or chrisw/billh
            -- when prod has none). Pin the UUID for stable re-runs.
            target_id := acct.fallback_id;
            INSERT INTO auth.users (
                instance_id, id, aud, role, email, encrypted_password,
                email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                -- GoTrue scans these token columns as NON-NULL Go strings.
                -- Left to their nullable default, a later magic-link login
                -- 500s ("Database error finding user") on the user lookup.
                -- '' is GoTrue's "no token" sentinel — never NULL.
                confirmation_token, recovery_token, email_change,
                email_change_token_new, email_change_token_current,
                phone_change, phone_change_token, reauthentication_token,
                created_at, updated_at
            ) VALUES (
                '00000000-0000-0000-0000-000000000000',
                target_id,
                'authenticated', 'authenticated',
                acct.email,
                crypt('staging-test-password', gen_salt('bf')),
                now(),
                '{"provider":"email","providers":["email"]}'::jsonb,
                '{}'::jsonb,
                '', '', '', '', '', '', '', '',
                now(), now()
            );
        ELSE
            -- ADOPT: a row already exists for this email (a restored prod
            -- operator, or a prior seed run). Give it the shared test password
            -- and clear any outstanding tokens; leave its UUID and FK refs be.
            UPDATE auth.users
               SET encrypted_password         = crypt('staging-test-password', gen_salt('bf')),
                   email_confirmed_at          = COALESCE(email_confirmed_at, now()),
                   aud                         = 'authenticated',
                   role                        = 'authenticated',
                   raw_app_meta_data           = '{"provider":"email","providers":["email"]}'::jsonb,
                   -- Clear outstanding tokens to '' — NOT NULL. GoTrue scans
                   -- these as NON-NULL Go strings; a NULL (e.g. carried in from
                   -- the restored prod row) makes the next magic-link login 500
                   -- ("Database error finding user"). '' is the cleared sentinel.
                   confirmation_token          = '',
                   recovery_token              = '',
                   email_change                = '',
                   email_change_token_new      = '',
                   email_change_token_current  = '',
                   phone_change                = '',
                   phone_change_token          = '',
                   reauthentication_token      = '',
                   updated_at                  = now()
             WHERE id = target_id;
        END IF;

        -- Profile keyed on the account's effective UUID. INSERT-or-UPDATE
        -- because the on_auth_user_created trigger is absent during a refresh
        -- (see header) and an adopted prod profile may carry a stale role.
        INSERT INTO public.profiles (id, display_name, role)
        VALUES (target_id, acct.display_name, acct.role)
        ON CONFLICT (id) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               role         = EXCLUDED.role;
        -- updated_at is maintained by the profiles_updated_at trigger
        -- (supabase/migrations/20260515024116_baseline_schema.sql:767-769)
    END LOOP;
END $$;

COMMIT;

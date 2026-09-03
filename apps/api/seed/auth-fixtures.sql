-- Auth fixtures for local + CI e2e (AECI-235).
--
-- Seeds the D1 `profiles` row for the e2e test user so a real minted Supabase
-- session authorizes against the API Worker's requireAuth / requireAdmin guards,
-- which re-read `profiles.role` from D1 on every request (`apps/api/src/lib/authz.ts`).
-- The e2e D1 otherwise has ZERO profiles (taxonomy/catalog/phase2-fixtures seed
-- none; seed-reviews is anonymous), so a hydrated render of /admin* (and /account)
-- in `authed-console.spec.ts` would 401/404 without this row.
--
-- No `auth.users` row is needed — under ADR 0016 `profiles.id` is a plain text PK
-- in D1, keyed by convention to the Supabase `auth.users.id` (the JWT `sub`). The
-- id below is the Supabase user id for the e2e test user `test@thewbsproject.com`
-- (`SUPABASE_TEST_USER_EMAIL`); it MUST match the `sub` that account's
-- password-grant JWT carries — re-mint and update it here if the account is ever
-- recreated (decode `sub` via `apps/web/scripts/mint-dev-session.mjs`). The user is
-- seeded as `admin` so one session covers all four gated pages (admin is also an
-- authed user, so /account and the review form render too).
--
-- Idempotent: INSERT OR REPLACE on the text PK. Applied via `pnpm db:seed:auth:local`
-- (part of `db:seed:local`, run by `dev:bound`). created_at/updated_at are NOT NULL
-- with no DB default, so they are set explicitly; the role/flag columns use defaults.
INSERT OR REPLACE INTO "profiles" ("id", "display_name", "role", "created_at", "updated_at") VALUES
  ('519f1e77-6e60-440e-81a9-3354d06be0b6', 'E2E Test Admin (test@thewbsproject.com)', 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- AECI-522 — the `vendor_admin` persona for `vendor-dashboard.spec.ts`. Seats a
-- `role='vendor_admin'` profile with a NON-NULL `vendor_id` so `requireVendor()`
-- authorizes it (a null vendor_id is a 403 — the half-granted-seat case). The
-- `vendor_id` points at the fixture vendor `...061` (`fixture-procore-technologies`,
-- verified) seeded by `phase2-fixtures.sql`, which runs BEFORE this file in
-- `db:seed:local` (so the FK resolves) and carries a `product_vendors` link to
-- product `...062` (`fixture-procore`) — giving `GET /api/vendor/me` an owned
-- product and `PATCH /api/vendor/products/:id` a target.
--
-- The `id` below is the real Supabase `sub` of the vendor test account
-- (`SUPABASE_VENDOR_TEST_USER_EMAIL`); the API re-reads `profiles.role`/`vendor_id`
-- from D1 per request, so this row is what authorizes the minted vendor session. If
-- that account is ever recreated, re-mint and update the id to the new `sub` (decode
-- via `apps/web/scripts/mint-dev-session.mjs`). The vendor spec still skips-green
-- until the `SUPABASE_VENDOR_TEST_USER_*` creds are present (GH secrets in CI,
-- `apps/web/.dev.vars` locally). Single-valued role/vendor per §8.3(3): one vendor
-- per account, distinct from the admin persona above.
INSERT OR REPLACE INTO "profiles" ("id", "display_name", "role", "vendor_id", "created_at", "updated_at") VALUES
  ('e1a8f812-b123-4b4a-8d3f-e1e76822a1df', 'E2E Test Vendor (vendor@thewbsproject.com)', 'vendor_admin', '00000000-0000-4000-8000-000000000061', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

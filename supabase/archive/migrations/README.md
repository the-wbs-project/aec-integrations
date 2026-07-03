# Archived Supabase migrations (pre-D1)

These are the original 15 Supabase Postgres migrations from before the
application database moved to **Cloudflare D1 + Drizzle** (ADR 0016). They are
**no longer part of the active migration set** — the Supabase CLI only reads
top-level `supabase/migrations/*.sql`, not this archive — and are kept here for
history only.

The active migration set is now a single consolidated **auth-only** baseline:
`supabase/migrations/20260626000000_auth_only_baseline.sql` (AECI-278). The
Supabase project is Auth-only; all application tables (products, vendors,
reviews, taxonomy, landing lead-capture) live in D1.

What was in these files:

- **App schema** (products / vendors / integrations / taxonomy / reviews /
  vendor-requests / workflow / audit / page-views / stats / translations) and
  its evolution — now defined in Drizzle at `apps/api/src/db/schema.ts` and
  migrated via drizzle-kit + `wrangler d1 migrations apply`.
- **PostgREST GRANTs + RLS policies** for the public app tables — dead under D1
  (the Worker guard is the only authorization layer; see `docs/AUTH_AND_RLS.md`).
- **Landing baseline** (`feedback` / `mailing_list`) — cut over to D1 (AECI-257).
- **Auth integration** (`handle_new_user`, the `auth.users` create/delete sync
  triggers, the pinned `search_path` hardening) — consolidated into the
  auth-only baseline above.

Reconciling the live shared auth project's migration history with the new
baseline (`supabase migration repair` / re-baseline) is part of the manual
decommission — see `docs/migrations.md` and the AECI-278 runbook.

# Database migrations

How to write, test, and ship a schema change in this repo.

> **✅ The application database is now Cloudflare D1 + Drizzle (ADR 0016 / AECI-248).**
> The Prisma→Drizzle query rewrite (AECI-253) is complete — the Worker reads and
> writes **D1** through `getDb(env)` (`apps/api/src/db/client.ts`), the schema is
> authored in **Drizzle** (`apps/api/src/db/schema.ts`), and migrations are applied
> with `wrangler d1 migrations apply`. **[§0](#0-d1--drizzle-the-target-workflow) is
> the only workflow for the app database — start there.**
>
> **Everything below §0 (§§1–10) is the legacy Supabase-CLI / Prisma workflow.** It
> no longer governs the app tables (vendors, products, reviews, …), and as of the
> AECI-257 landing cut-over no longer governs the lead-capture tables (`feedback`,
> `mailing_list`) either — those are now D1 tables written via the API Worker. It is
> retained, scoped down, only for the surface still on Supabase Postgres: **Supabase
> Auth** (`auth.users`), which keeps its `supabase/migrations/` + `schema.prisma`
> drift gate. Caveat: the local Supabase Postgres still *physically* contains the old
> app + landing tables (from the baseline migrations); they are now **stale — D1 is
> the source of truth**. Removing Prisma + the legacy sections lands with the
> Supabase-DB decommission (AECI-256 removes Prisma; AECI-257 the rest).

The legacy migration system below is **Supabase CLI**, now scoped to Supabase Auth. Migration files live in `supabase/migrations/` as numbered SQL files. Prisma is not involved in migration generation; `prisma generate` is still used to produce the typed client for the CI `schema.prisma` drift gate (AECI-77) — which, as of AECI-264, runs only in the `refresh-staging.yml` Postgres-Auth check, no longer at PR time (the PR-time gate moved to D1/Drizzle; see [§0](#0-d1--drizzle-the-target-workflow)) and no longer in `promote-to-prod.yml` (AECI-256 dropped its Postgres steps) — but `prisma migrate` is not. Application code no longer imports `@prisma/client` (AECI-256).

This document is the source of truth for the workflow. The constraints in [`CLAUDE.md`](../CLAUDE.md) ("Constraints that aren't negotiable") incorporate the rules below by reference.

---

## 0. D1 + Drizzle: the target workflow

The schema source of truth is `apps/api/src/db/schema.ts` (Drizzle SQLite). The
flow is **generate → apply → seed**, all from `apps/api/`:

```bash
# 1. Edit apps/api/src/db/schema.ts, then generate migration SQL into apps/api/migrations/
pnpm --filter @aeci/api db:generate          # drizzle-kit generate

# 2. Apply to the LOCAL D1 (per-workspace SQLite in .wrangler/state — no shared DB)
pnpm --filter @aeci/api db:migrate:local     # wrangler d1 migrations apply aeci-app-preview --local

# 3. Seed local data (idempotent): taxonomy reference data + a sample catalog
pnpm --filter @aeci/api db:seed:local

# Convenience: migrate + seed in one step
pnpm --filter @aeci/api db:setup:local
```

Rules:

- **Drizzle generates, `wrangler d1 migrations apply` applies.** Never
  `drizzle-kit migrate`/`push` — that mirrors the old "CLI owns apply" split.
  Generated SQL is committed under `apps/api/migrations/` (flat layout = wrangler's
  default `migrations_dir`, so no `migrations_pattern` is needed).
- **Reference data** (taxonomy, ADR 0008) lives in `apps/api/seed/taxonomy.sql`
  as idempotent `INSERT … ON CONFLICT(slug) DO UPDATE` with deterministic
  UUIDv5 ids. The local catalog fixture is `apps/api/seed/catalog.sql`
  (local-dev only; staging/prod re-promote from Airtable via `POST /api/promote`).
- **Per-env apply** (preview/staging/production) is wired into CI in Phase 5
  (AECI-256): `wrangler d1 migrations apply aeci-app-<env> --env <env>`.
- **No RLS / GRANTs / triggers.** D1/SQLite has none; authorization is app-layer
  (ADR 0016 §4, `docs/AUTH_AND_RLS.md`), and `updated_at` is refreshed app-side
  (Drizzle `$onUpdate`), not by a DB trigger.
- **Drift is CI-gated.** `.github/workflows/drift-check.yml` (AECI-264) fires on any PR
  touching `apps/api/src/db/schema.ts`, `apps/api/drizzle.config.ts`, or
  `apps/api/migrations/**`. It runs `pnpm --filter @aeci/api db:generate` and fails if that
  leaves the tree dirty under `apps/api/migrations/` — i.e. you edited `schema.ts` but forgot
  to generate + commit the migration. Fix by running `db:generate` and committing the new
  `apps/api/migrations/*` (including `meta/`).

### Read replication (D1 Sessions API — AECI-250)

The Worker reads/writes D1 through the **Sessions API**: `getDb(env, opts?)`
(`apps/api/src/db/client.ts`) wraps `env.DB.withSession(anchor)`. Reads use the
`'first-unconstrained'` anchor (served by the nearest replica — the read-latency
win); write handlers anchor `'first-primary'` and round-trip the `x-d1-bookmark`
header (inbound via `writeDb(c, dbFor)`, outbound via `bookmark-middleware.ts`) so
read-your-writes holds. This is **API-Worker-internal** — no schema/migration
change and no `wrangler.jsonc` change.

- **Enabling the win is an ops step, not code.** Read replication is turned on
  **per-database** in the Cloudflare dashboard (D1 → *your db* → Settings → Enable
  Read Replication) or the REST API (`read_replication: {"mode": "auto"}`). Enable
  it on the **staging + production** D1s; the code is inert-safe before that
  (`withSession` serves from primary when no replicas exist).
- **Local dev / tests are single-DB.** `wrangler dev`'s local SQLite and the
  in-memory test harness have no `withSession`, so `getDb` falls back to the plain
  binding (`getBookmark()` → `null`); read-your-writes is automatic there. The
  perf win is **prod-only** and appears only after the per-database flip above.

---

> **⚠️ Legacy — Supabase-CLI / Prisma workflow (Supabase Auth Postgres only).**
> Sections §§1–10 below predate the D1 cut-over. They **do not apply to the app
> database** (now D1 — see [§0](#0-d1--drizzle-the-target-workflow)), nor to the
> `feedback` / `mailing_list` lead-capture tables (moved to D1 in AECI-257). They
> remain only for Supabase Auth, and are removed at decommission (AECI-256/257).

## 1. When to write a migration

Write a migration when any of these change in Postgres:

- A table, column, index, constraint, trigger, or sequence.
- A function, view, or extension.
- An RLS policy, PostgREST GRANT, or `is_admin()`/`is_active_user()`-style helper. As of AECI-87 the whole authorization surface lives in numbered migrations (see [§5](#5-rls-and-the-public-schema)); there is no separate apply step.
- A row in a config-shaped table that staging and production must both have (rare). Taxonomy vocabulary → the code-managed reference file `supabase/reference-data/taxonomy.sql` (ADR 0008), not a migration; other curator content → Airtable sync (`docs/DATABASE_SCHEMA.md` §13).

**Don't** write a migration for:

- Local test fixtures or seed data — put those in `supabase/seed.sql` (local-dev only; `db push` does not apply seed). Cross-environment reference data (e.g. the taxonomy vocabulary) goes in `supabase/reference-data/` instead, which *is* applied to every environment (ADR 0008).
- One-off data backfills — use a script under `apps/api/scripts/` and run it explicitly per environment.
- Anything Airtable owns (curator-managed content; vendors, products, integrations, reviews — see `docs/DATABASE_SCHEMA.md` §13). *(Taxonomy is no longer in this set — it's code-managed reference data per ADR 0008.)*

---

## 2. File naming

Migration files are named `YYYYMMDDHHMMSS_short_description.sql`. Generate the timestamp via the CLI rather than hand-typing it:

```bash
pnpm db:new add_vendor_logo_column
```

This produces `supabase/migrations/<utc-timestamp>_add_vendor_logo_column.sql` (empty). The CLI uses UTC. Don't rename the file after creation — the timestamp is the migration's identity in the `supabase_migrations.schema_migrations` history table.

`short_description` is snake_case, ≤6 words, describes the *what* (`add_vendor_logo_column`, `drop_unused_reviews_index`), not the why (the why belongs in a comment block at the top of the file).

---

## 3. Authoring rules

These constraints are non-negotiable.

### 3.1 Forward-only

No `down.sql`. No rollback migrations. If a migration is wrong:

- Catch it in the PR review.
- If it landed in staging and broke something, write a *new* migration that fixes it forward.
- Never edit a migration after it's been merged.

### 3.2 Backward-compatible during expand/contract

If the live API code can't tolerate the schema after the migration applies but before the new code deploys (and CI applies migrations *before* code deploys — see `docs/CICD_PLAN.md` §5), break the change into phases:

1. **Expand** migration — add the new column / table / column nullable.
2. Code change — start reading the new shape while still tolerating the old.
3. **Backfill** migration or script (if needed).
4. Code change — switch writes to the new shape.
5. **Contract** migration — drop the old column / constraint.

Each migration must leave the DB in a state the previously-deployed Worker code can still run against.

### 3.3 Destructive changes require explicit approval

`DROP TABLE`, `DROP COLUMN`, type-narrowing (`varchar(255)` → `varchar(64)`), `ADD COLUMN ... NOT NULL` without a backfill, and any change that loses data without a migration path — these require explicit approval in the issue **before** you write the SQL. Not in the PR. In the issue.

### 3.4 Idempotency where cheap

Prefer `CREATE INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS ... CREATE POLICY ...`, `CREATE OR REPLACE FUNCTION`. Postgres migrations don't *have* to be idempotent (the migration system tracks what ran), but idempotent SQL is easier to recover from when something goes wrong mid-apply.

### 3.5 Keep `schema.prisma` in sync

Prisma still generates the typed client. After your migration applies locally, run `pnpm db:pull` from the repo root to introspect the local DB into `apps/api/prisma/schema.prisma` and regenerate the Prisma client in one step. The migration SQL and the resulting `schema.prisma` diff must describe the same change; PR review verifies they do.

See `docs/prisma.md` for the full contract — why `schema.prisma` is treated as derived-from-DB, why `db:pull` targets the local container by hard-coded URL, and the forward reference to AECI-71's drift detection.

---

## 4. Local test loop

The local stack runs the same Postgres image as production (`supabase/postgres:17.x`). Use it.

```bash
# One-time: start local stack (Postgres + GoTrue + PostgREST + Storage + Studio)
pnpm db:start

# Create a new migration file
pnpm db:new add_vendor_logo_column

# Open the new file under supabase/migrations/, write the SQL.

# Reset local DB to a clean state, apply ALL migrations + seed.sql
# (the GRANT/RLS surface is itself a migration — see §5 — so this is all it takes)
pnpm db:reset

# Smoke-test against the now-baselined local DB
pnpm --filter @aeci/api test:integration

# Optional: diff your local schema against the linked remote project
pnpm db:diff
```

A migration is "ready" when `pnpm db:reset` applies it without errors *from scratch* (not just on top of the previous state), and the integration suite still passes.

---

## 5. RLS and the `public` schema

As of AECI-87, the **entire** PostgREST authorization surface lives in
`supabase/migrations/`, so `supabase db push` / `db reset` apply it to every
environment — there is no separate apply step:

- **`20260525064254_capture_rls_auto_enable.sql`** owns the `ensure_rls` event trigger and `public.rls_auto_enable()` function — they make every newly-created public table RLS-enabled by default.
- **`20260602051513_rls_grants_and_policies.sql`** owns the policy bodies, the PostgREST GRANTs, and the `public.is_admin()` / `public.is_active_user()` helpers. It is idempotent (`DROP POLICY IF EXISTS` + `CREATE POLICY`, `CREATE OR REPLACE FUNCTION`, idempotent REVOKE/GRANT).

The three-layer model is in `docs/AUTH_AND_RLS.md` §1. When a migration adds a
new public-schema table that PostgREST should expose, add its GRANT + policy to
a new migration (or alongside the table's migration) and add a deny/allow
assertion to `scripts/verify-rls.sql` (run by the refresh/promote workflows).
Helpers must live in `public`, not `auth` — the
migration role (`postgres`) cannot CREATE in the `auth` schema; see
`docs/AUTH_AND_RLS.md` §6.1.

---

## 6. Commit + PR rules

Single PR contains:

- The migration file(s) under `supabase/migrations/`.
- Any corresponding update to `docs/DATABASE_SCHEMA.md` (the source of truth for table inventory and column intent).
- A GRANT + RLS policy migration (and a `scripts/verify-rls.sql` assertion) if the change adds a public-schema table PostgREST should expose.
- Any `schema.prisma` model change so the generated client mirrors the migration.

PR review verifies these are all aligned. CI applies the migration to staging at merge-to-main; production application requires a separate approval (see `docs/CICD_PLAN.md` §5 — wiring deferred to AECI-71).

---

## 7. What does not belong in a migration

- **Seed data**: use `supabase/seed.sql` (local-dev only — `supabase db reset` runs it; `supabase db push` does not).
- **Reference data** (applied to *all* environments): the taxonomy vocabulary lives in `supabase/reference-data/taxonomy.sql` (idempotent upserts), applied on `db reset` locally and via a `psql -f` step after `db push` in the deploy workflows. See ADR 0008.
- **Curator-managed data**: vendors, products, integrations, reviews come in from the Airtable sync (`docs/DATABASE_SCHEMA.md` §13).
- **One-off backfills**: write a script (`apps/api/scripts/<name>.ts`), run it explicitly per environment with the right `DIRECT_URL`. Keep migrations declarative.
- **RLS policies**: see §5.

---

## 8. CI / CD

The current pipeline does **not** auto-apply migrations against staging or production — that wiring is AECI-71. Until then, migrations applied via `supabase db push --linked` from a developer machine (against staging) or via a manual approval flow (against production). Don't run `supabase db push --linked` against the production project from a PR branch.

When AECI-71 lands, this section will reference `docs/CICD_PLAN.md` §5 for the canonical apply-on-merge sequence.

---

## 9. Connection URLs

The two-URL split in `docs/DATABASE_SCHEMA.md` §1a still holds:

- **`DATABASE_URL`** — Prisma Accelerate `prisma://` URL, read by the Worker runtime (and by `prisma generate`). Never used by the Supabase CLI.
- **`DIRECT_URL`** — Supabase pooler `postgresql://` URL. Used by `supabase db push`, `supabase db pull`, `supabase db diff`. Not bound to the Worker.

The CLI's link state (project ref, pooler URL, db password if cached) lives under `supabase/.temp/` and is gitignored.

---

## 10. Common pitfalls

- **Editing a migration after merge.** Never. Write a new forward migration.
- **Forgetting to update `schema.prisma`.** Causes type drift between the typed client and the actual DB shape. Run `pnpm db:pull` after every `pnpm db:reset` — it introspects local and regenerates the client. See `docs/prisma.md` §3. PR reviewer should also catch this.
- **Creating authz helpers in the `auth` schema.** `auth.is_admin()` etc. fail to apply under `supabase db push` (the `postgres` migration role has no CREATE on `auth`). Put helpers in `public` — see `docs/AUTH_AND_RLS.md` §6.1.
- **Running `supabase db push --linked` from a feature branch against staging or prod.** That's an out-of-band write; only the AECI-71 CI flow should do that (when wired).
- **Running `supabase migration repair`.** Only useful when reconciling a brand-new project's empty history with a repo that already has migrations. Don't repair against shared staging or prod without coordination.

# Database migrations

How to write, test, and ship a schema change in this repo.

The migration system is **Supabase CLI**. Migration files live in `supabase/migrations/` as numbered SQL files. Prisma is not involved in migration generation; `prisma generate` is still used to produce the typed client, but `prisma migrate` is not.

This document is the source of truth for the workflow. The constraints in [`CLAUDE.md`](../CLAUDE.md) ("Constraints that aren't negotiable") incorporate the rules below by reference.

---

## 1. When to write a migration

Write a migration when any of these change in Postgres:

- A table, column, index, constraint, trigger, or sequence.
- A function, view, or extension.
- An RLS policy that lives **inside** a migration (note: most policies in this repo live in `docs/rls_policies.sql`, applied separately via `pnpm --filter @aeci/api db:apply-rls`; see [§5](#5-rls-and-the-public-schema)).
- A row in a config-shaped table that staging and production must both have (rare — generally use Airtable curator sync per `docs/DATABASE_SCHEMA.md` §13).

**Don't** write a migration for:

- Local test fixtures or seed data — put those in `supabase/seed.sql` (local-dev only; `db push` does not apply seed).
- One-off data backfills — use a script under `apps/api/scripts/` and run it explicitly per environment.
- Anything Airtable owns (curator-managed content; vendors, products, integrations, taxonomy, reviews — see `docs/DATABASE_SCHEMA.md` §13).

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
pnpm db:reset

# Apply RLS policies on top (these live outside migrations — see §5)
pnpm --filter @aeci/api db:apply-rls

# Smoke-test against the now-baselined local DB
pnpm --filter @aeci/api test:integration

# Optional: diff your local schema against the linked remote project
pnpm db:diff
```

A migration is "ready" when `pnpm db:reset` applies it without errors *from scratch* (not just on top of the previous state), and the integration suite still passes.

---

## 5. RLS and the `public` schema

RLS in this repo is split across two locations:

- **`supabase/migrations/`** owns the `ensure_rls` event trigger and `public.rls_auto_enable()` function — they make every newly-created public table RLS-enabled by default (see `20260525064254_capture_rls_auto_enable.sql`).
- **`docs/rls_policies.sql`** owns the actual policy bodies and PostgREST GRANTs. Apply with `pnpm --filter @aeci/api db:apply-rls` after every migration that adds a new public-schema table. The script is idempotent (`DROP POLICY IF EXISTS` + `CREATE POLICY`).

The three-layer model is in `docs/AUTH_AND_RLS.md` §1. Don't put policy bodies in migration files unless they are tightly scoped to a single feature being added in the same PR — even then, prefer the central `rls_policies.sql` and update it alongside the migration.

---

## 6. Commit + PR rules

Single PR contains:

- The migration file(s) under `supabase/migrations/`.
- Any corresponding update to `docs/DATABASE_SCHEMA.md` (the source of truth for table inventory and column intent).
- Any `docs/rls_policies.sql` change if the migration adds a public-schema table.
- Any `schema.prisma` model change so the generated client mirrors the migration.

PR review verifies these are all aligned. CI applies the migration to staging at merge-to-main; production application requires a separate approval (see `docs/CICD_PLAN.md` §5 — wiring deferred to AECI-71).

---

## 7. What does not belong in a migration

- **Seed data**: use `supabase/seed.sql` (local-dev only — `supabase db reset` runs it; `supabase db push` does not).
- **Curator-managed data**: vendors, products, integrations, taxonomy, reviews come in from the Airtable sync (`docs/DATABASE_SCHEMA.md` §13).
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
- **`DIRECT_URL`** — Supabase pooler `postgresql://` URL. Used by `supabase db push`, `supabase db pull`, `supabase db diff`. Not bound to the Worker. The local-dev fallback for `db:apply-rls` connects through Docker to the local container directly and doesn't read either.

The CLI's link state (project ref, pooler URL, db password if cached) lives under `supabase/.temp/` and is gitignored.

---

## 10. Common pitfalls

- **Editing a migration after merge.** Never. Write a new forward migration.
- **Forgetting to update `schema.prisma`.** Causes type drift between the typed client and the actual DB shape. Run `pnpm db:pull` after every `pnpm db:reset` — it introspects local and regenerates the client. See `docs/prisma.md` §3. PR reviewer should also catch this.
- **Putting RLS policy bodies in a migration.** Spreads policy definitions across multiple files. Keep them in `docs/rls_policies.sql`.
- **Running `supabase db push --linked` from a feature branch against staging or prod.** That's an out-of-band write; only the AECI-71 CI flow should do that (when wired).
- **Running `supabase migration repair`.** Only useful when reconciling a brand-new project's empty history with a repo that already has migrations. Don't repair against shared staging or prod without coordination.

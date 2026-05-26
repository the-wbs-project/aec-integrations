# Prisma in this repo

Prisma is a **query-builder and typed client**. It is not a migration tool here.
The Supabase CLI owns schema changes; `schema.prisma` is downstream of
`supabase/migrations/`. This file is the contract.

For migration authoring itself, see `docs/migrations.md`. For DB shape and
column intent, see `docs/DATABASE_SCHEMA.md`.

---

## 1. Role of Prisma

| Tool | What we use it for | What we never use it for |
|---|---|---|
| `prisma generate` | Generate the typed Prisma client from `schema.prisma`. Runs in dev, build, CI. | — |
| `prisma db pull` | Introspect the local Supabase DB and rewrite `schema.prisma` to match. | — |
| `prisma studio` | Local DB browser (rare). | — |
| `@prisma/client/edge` + `withAccelerate()` | Runtime query path from the Worker. See `docs/DATABASE_SCHEMA.md` §1a. | — |
| `prisma migrate dev` | — | Writing or applying migrations. |
| `prisma migrate deploy` | — | Applying migrations in CI. |
| `prisma migrate reset` | — | Resetting the dev DB. |
| `prisma migrate resolve` | — | Marking migrations applied. |
| `prisma migrate diff` | — (used by AECI-71 drift checker only) | Authoring migrations. |

---

## 2. The contract

1. **`supabase/migrations/` is the source of truth.** Every schema change
   begins as a `.sql` file there.
2. **`apps/api/prisma/schema.prisma` is derived.** It mirrors whatever the
   migrations produce. If the two disagree, `schema.prisma` is wrong.
3. **The Prisma client is regenerated from `schema.prisma`** after every
   change, never directly from the DB.
4. **Drift between `schema.prisma` and the DB is a bug** — caught
   mechanically by AECI-71's three-layer `prisma migrate diff` checks in CI.

---

## 3. Workflow (every schema change)

```bash
# 1. Author the migration SQL
pnpm db:new add_vendor_logo_column        # creates supabase/migrations/<ts>_*.sql
$EDITOR supabase/migrations/<ts>_add_vendor_logo_column.sql

# 2. Apply it to the local Supabase DB
pnpm db:reset                              # rebuilds local DB from all migrations + seed.sql

# 3. (Only if the migration adds a public-schema table) reapply RLS
pnpm --filter @aeci/api db:apply-rls

# 4. Refresh schema.prisma + Prisma client from the just-applied local DB
pnpm db:pull                               # runs `prisma db pull` then `prisma generate`

# 5. Commit BOTH the .sql migration AND the updated schema.prisma in one PR
git add supabase/migrations/<ts>_add_vendor_logo_column.sql apps/api/prisma/schema.prisma
git commit
```

The PR reviewer checks that the migration SQL and the schema.prisma diff
describe the same change.

---

## 4. When to regenerate the Prisma client

- After any `pnpm db:pull` — `db:pull` chains `prisma generate` for you.
- Before `pnpm typecheck` or `pnpm test` if you've edited `schema.prisma`
  by hand (rare; `db:pull` is the supported path).
- Already wired into CI: `.github/workflows/deploy.yml` runs
  `pnpm --filter @aeci/api exec prisma generate` in lint-and-types,
  unit-tests, e2e-tests-local, integration-runner-local, and
  deploy-production. Adding `prisma generate` to a new CI job is fine; we
  prefer over-generation to typecheck-against-a-stale-client.

---

## 5. Connection URLs

| Variable | Form | Used by |
|---|---|---|
| `DATABASE_URL` | `prisma://accelerate.prisma-data.net/?api_key=…` | Worker runtime (`@prisma/client/edge` + `withAccelerate()`) and `prisma generate`. |
| `DIRECT_URL` | `postgresql://…@aws-0-REGION.pooler.supabase.com:6543/postgres?…` | Ad-hoc CLI introspection of remote envs (`prisma db pull --url=$DIRECT_URL`, `prisma studio`). **Not** read by the deployed Worker. |

`pnpm db:pull` intentionally targets the **local Supabase container**
(`postgresql://postgres:postgres@127.0.0.1:54322/postgres`) by hard-coded URL
rather than reading `DIRECT_URL`. Rationale:

- The workflow in §3 introspects the DB the developer just `db:reset`'d, which
  is local. `DIRECT_URL` conventionally points at the linked remote.
- Pulling against the linked remote bakes whatever shape staging happens to
  have into `schema.prisma`, masking drift instead of catching it.
- Matches the precedent of `db:apply-rls`, which also targets the local
  container explicitly.

For the rare "what does staging actually look like?" task, run
`prisma db pull --url="$DIRECT_URL"` by hand; no committed script.

Full URL semantics live in `docs/DATABASE_SCHEMA.md` §1a. Local Supabase
defaults are in `supabase/config.toml`.

---

## 6. Drift detection (forward reference)

AECI-71 introduces three layers of `prisma migrate diff` in CI:

1. **schema.prisma ⇆ migrations** — does replaying every SQL migration on an
   empty DB produce the schema described by `schema.prisma`?
2. **schema.prisma ⇆ staging** — does what's deployed match what's committed?
3. **migrations ⇆ staging** — has someone applied SQL out of band?

Any non-empty diff fails CI. The drift checker treats `schema.prisma` as the
expected shape and the DB as the introspected shape, which is the contract
this document codifies.

---

## 7. Resolved: cross-schema FK via `multiSchema`

Historically, `pnpm db:pull` failed with Prisma error **P4002** because of
the cross-schema FK `profiles.id → auth.users.id`:

```
The schema of the introspected database was inconsistent: Cross schema
references are only allowed when the target schema is listed in the schemas
property of your datasource. `public.profiles` points to `auth.users` in
constraint `profiles_id_fkey`.
```

**Fixed in AECI-80** by enabling Prisma's `multiSchema` feature
(GA in Prisma 6+ — no `previewFeatures` flag needed) and listing both
`public` and `auth` in the datasource:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
  schemas   = ["public", "auth"]
}
```

`apps/api/prisma/schema.prisma` now models the full `auth.*` shape
(produced by `prisma db pull`) at the bottom of the file. The Worker does
not query auth tables via Prisma client — Supabase gotrue owns them — but
they live in the schema so:

1. The cross-schema FK on `Profile.id → auth.users(id)` resolves.
2. The AECI-80 PR-time drift check covers the entire DB, not just `public.*`.

`pnpm db:pull` is now the canonical way to regenerate `schema.prisma`
after a migration. See §3 ("Workflow"). The AECI-71 drift checks (PR,
post-refresh-staging, post-promote-to-prod) verify schema.prisma stays in
sync with the migrations.

---

## 8. What never to run

```bash
# All of these are bugs. CI does not run them. Local dev does not run them.
prisma migrate dev
prisma migrate deploy
prisma migrate reset
prisma migrate resolve
```

Per `CLAUDE.md` "Constraints that aren't negotiable": *"Supabase CLI owns
migrations. … `prisma migrate` is not used. Do not reintroduce
`apps/api/prisma/migrations/` or any `prisma migrate deploy` script."*

If you find yourself reaching for `prisma migrate`, the answer is `pnpm db:new`
followed by hand-written SQL, then `pnpm db:reset && pnpm db:pull`.

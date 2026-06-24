# @aeci/api

Private Cloudflare Worker exposing the AEC Integrations API. Reads and writes the
application database — Cloudflare D1 (SQLite) — through its `DB` binding via
Drizzle ORM (ADR 0016, `docs/DATABASE_SCHEMA.md`, `CLAUDE.md` "Constraints").

Reached only over a Cloudflare service binding — the SSR Worker's `env.API`, and
the landing Worker's `env.API` for lead-capture — so it has no public ingress.

## Constraints (do not break)

- The app DB is **Drizzle over the `DB` D1 binding**. Get a request-scoped client
  via `getDb(env)` (`src/db/client.ts`) — no Prisma, no Accelerate, no pg adapter,
  no TCP pooler from the Worker.
- **D1 has no interactive transactions.** Atomic multi-statement writes go through
  `db.batch([...])`, and every state-changing write emits its `audit_log`
  (+ `workflow_transitions`) row into the SAME batch via the `src/lib/audit.ts`
  builders (the §26.1 invariant). The §26.5 Datadog forwards run post-commit in
  `ctx.waitUntil`.
- No `nodejs_compat` on this Worker — the native D1 binding needs no Node polyfills.
- Supabase is retained for **Auth only**: JWKS user-JWT verification
  (`src/lib/user-auth.ts`) and the Admin-API split-identity seams
  (`src/lib/supabase-admin.ts`). No app data lives in Supabase.

## Local development

The app DB is a per-workspace local SQLite D1 that `pnpm dev` migrates + seeds
automatically. Migrations are generated from `src/db/schema.ts` with drizzle-kit
and applied with `wrangler d1 migrations apply` (see `docs/migrations.md` §0).

```bash
cp .dev.vars.example .dev.vars              # SUPABASE_URL (auth) etc.; no app-DB secret

pnpm install
pnpm --filter @aeci/api dev                  # runs db:setup:local (migrate + seed), then wrangler dev
curl -i http://localhost:8787/api/health
# Expect: 200, { ok: true, db: "ok", latencyMs: <int> }
```

After editing `src/db/schema.ts`, run `pnpm --filter @aeci/api db:generate` to
write a new migration under `migrations/`, then `pnpm --filter @aeci/api
db:migrate:local`. See `docs/migrations.md`.

## Tests

```bash
pnpm --filter @aeci/api typecheck
pnpm --filter @aeci/api test:unit
pnpm --filter @aeci/api test:coverage
```

Handler specs run against a real in-memory D1 (better-sqlite3 + the generated
migrations) via `src/test/d1.ts`. Unit-test conventions live in
`docs/UNIT_TESTING_GUIDE.md`.

## Deploy

```bash
# Preview (workers.dev)
pnpm --filter @aeci/api deploy

# Staging / production
pnpm --filter @aeci/api deploy:staging
pnpm --filter @aeci/api deploy:production
```

D1 binds per-env (`aeci-app-{preview,staging,production}`); apply migrations to a
deployed DB with `wrangler d1 migrations apply aeci-app-<env> --env <env> --remote`.
Environment topology + the Worker secret set live in `docs/environments.md`.

## Layout

```
src/
  index.ts              Hono app, route registration only
  env.ts                Env type binding (incl. the `DB` D1 binding)
  db/
    client.ts           getDb(env) — request-scoped Drizzle/D1 client factory
    schema.ts           Drizzle schema — source of truth for the app DB
  lib/
    audit.ts            auditInsert / workflowTransitionInsert batch builders
    drizzle-helpers.ts  shared read configs + mappers
  http.ts               json / noContent (BigInt-safe)
  routes/               one factory per endpoint (injectable DbFactory for tests)
  test/
    d1.ts               in-memory D1 harness (better-sqlite3 + real migrations)
migrations/             drizzle-kit-generated SQL, applied by `wrangler d1`
```

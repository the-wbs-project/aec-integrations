# @aeci/api

Private Cloudflare Worker exposing the AEC Integrations API. Reads and writes Supabase via Prisma using the **per-request Accelerate pattern** (`docs/DATABASE_SCHEMA.md` §1a, `CLAUDE.md` "Constraints").

## Constraints (do not break)

- `PrismaClient` imported from `@prisma/client/edge`
- `withAccelerate()` applied **per request**, never cached on a module-level singleton
- `DATABASE_URL` is the Prisma Accelerate URL (`prisma://...`) — Worker runtime secret
- `DIRECT_URL` is the Supabase pooler URL — **only** the Prisma CLI uses it (migrations); the deployed Worker does not read it
- Do not install the pg-worker Prisma adapter. No TCP pooler from the Worker.
- No `nodejs_compat` — Accelerate is HTTPS and does not need it

## Local development

Schema migrations are owned by the Supabase CLI (`supabase/migrations/`), not
Prisma. Prisma is used here only to generate the typed client. See
`docs/migrations.md` and `docs/prisma.md` for the full contract.

```bash
cp .dev.vars.example .dev.vars
# Fill in real DATABASE_URL (Accelerate) and DIRECT_URL (Supabase pooler)

pnpm install
pnpm db:start                                 # local Supabase stack
pnpm db:reset                                 # apply supabase/migrations + seed
pnpm --filter @aeci/api db:apply-rls          # apply RLS policies on top
pnpm --filter @aeci/api prisma:generate       # produce typed client

pnpm --filter @aeci/api dev
curl -i http://localhost:8788/api/health
# Expect: 200, { ok: true, db: "ok", latencyMs: <int> }
```

After authoring a new migration with `pnpm db:new <name>` and applying it via
`pnpm db:reset`, run `pnpm db:pull` from the repo root to refresh
`prisma/schema.prisma` against the local DB and regenerate the client.

## Tests

```bash
pnpm --filter @aeci/api typecheck
pnpm --filter @aeci/api test:unit
pnpm --filter @aeci/api test:coverage
```

Unit-test conventions live in `docs/UNIT_TESTING_GUIDE.md`. This package establishes the per-app Vitest pattern future apps will copy.

## Deploy

```bash
# Preview (workers.dev)
pnpm --filter @aeci/api deploy

# Staging / production
pnpm --filter @aeci/api deploy:staging
pnpm --filter @aeci/api deploy:production
```

## Secrets (one-time per environment)

```bash
# DATABASE_URL is the only secret the deployed Worker reads at runtime.
wrangler secret put DATABASE_URL --env preview
wrangler secret put DATABASE_URL --env staging
wrangler secret put DATABASE_URL --env production

# DIRECT_URL is intentionally NOT set as a Worker secret — it is only needed
# by the Prisma CLI when running migrations from a workstation or CI.
```

## Layout

```
src/
  index.ts              Hono app, route registration only
  env.ts                Env type binding
  prisma.ts             getPrisma(env) per-request client factory (injected via prismaFor)
  http.ts               json / noContent (BigInt-safe)
  routes/
    health.ts           createHealthHandler factory (injectable for tests)
  test/
    factories/prisma.ts makeMockPrisma helper for handler tests
prisma/
  schema.prisma         baseline (HealthCheck placeholder; replaced in Phase 2)
```

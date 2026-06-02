# AECi Review — prisma-test

> **⚠️ FROZEN REFERENCE — not part of the build (AECI-118).**
> This is an archived Phase-1 probe that validated Prisma Accelerate from a
> Cloudflare Worker (HTTPS, no TCP pooler). It lives under `spikes/`,
> **outside** the `pnpm-workspace.yaml` `apps/*` glob, so it is **not
> installed, built, linted, or deployed** by any workspace script or CI job.
> It is **not runnable as-is** — to exercise it again, temporarily add
> `spikes/prisma-test` to `pnpm-workspace.yaml` and run `pnpm install`.
>
> It is retained only because the docs cite its source as historical
> "validated pattern" line anchors. **Do not edit the files here** — those
> anchors assume the line numbers are frozen. The patterns it pioneered now
> ship in live code in `apps/api`:
>
> - `getPrisma` (PrismaClient from `@prisma/client/edge` + `withAccelerate`
>   per request), BigInt JSON replacer, and Prisma-error → HTTP mapping
>   → `apps/api/src/prisma.ts`
> - The `DATABASE_URL` (Accelerate) / `DIRECT_URL` (pooler, migrations-only)
>   two-URL split → `apps/api/prisma/schema.prisma`
> - `nodejs_compat` rationale + wrangler config → `apps/api/wrangler.jsonc`

A throwaway probe for the Phase 1 foundation stack. The validated reference
implementation now lives in `apps/api` (see anchors above); `docs/DATABASE_SCHEMA.md`
and `docs/adr/0002-prisma-accelerate-over-tcp-pooler.md` are the source of truth.

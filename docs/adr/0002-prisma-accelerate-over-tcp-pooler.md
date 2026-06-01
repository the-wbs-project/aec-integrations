# ADR 0002: Prisma Accelerate (HTTPS) over a TCP pooler / pg adapter from Workers

> _Renamed from the placeholder `0002-no-prisma-accelerate` — that title was inverted. The actual decision is to **use** Accelerate._

**Status:** Accepted (a CLAUDE.md non-negotiable)
**Date:** Phase 1 · **Recorded:** 2026-06-01
**Context owner:** _unset — confirm_

---

## Context

The API Worker must reach Supabase Postgres. Cloudflare Workers run as short-lived isolates with no durable connection pool and limited raw-TCP support, so the classic "long-lived pg pool" pattern does not fit. Two broad options: (a) route Prisma through a TCP pooler / `@prisma/adapter-pg-worker`, or (b) use **Prisma Accelerate**, which is HTTPS-based and pools/caches outside the Worker.

## Decision

Use **Prisma Accelerate** for all Worker → DB access:

- Instantiate `PrismaClient` from `@prisma/client/edge` and apply `.$extends(withAccelerate())` **per request**. Validated pattern: `apps/api/src/prisma.ts`, `apps/prisma-test/src/index.ts`.
- `DATABASE_URL` is the `prisma://` Accelerate URL (Worker runtime).
- `DIRECT_URL` (Supabase pooler) is used **only** by the Supabase CLI for migrations — never by Worker runtime code.
- Do **not** install `@prisma/adapter-pg-worker`; do **not** route Prisma through a TCP pooler from a Worker.

## Consequences

- ➕ DB access is HTTPS, so it works independently of `nodejs_compat` and the Workers TCP limitations.
- ➕ Connection pooling + optional query caching are handled by Accelerate at the edge.
- ➖ A hard runtime dependency on Accelerate (and its `prisma://` URL); an Accelerate outage is a DB outage.
- ➖ Two URLs to keep straight (`DATABASE_URL` runtime vs `DIRECT_URL` migrations) — a recurring source of confusion, which is why this is also a CLAUDE.md non-negotiable.

## Related

- `docs/DATABASE_SCHEMA.md` §1a, `docs/prisma.md` (Prisma-as-query-builder contract).
- ADR 0007 (why Supabase CLI owns migrations, not `prisma migrate`).

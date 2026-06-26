# 0016 — Application data on Cloudflare D1 (Drizzle), Supabase for Auth only

- **Status:** Accepted (AECI-257) — the API Worker runtime is Drizzle/D1 only; Supabase retained for Auth (and the separately-tracked landing-Postgres path).
- **Date:** 2026-06-13 (proposed), 2026-06-22 (accepted)
- **Context owner:** chrisw@thewbsproject.com
- **Note:** the proposal was filed 2026-06-13 with the AECI-248 issue tree and the
  `docs/adr/README.md` index entry, but this document body was never committed.
  Reconstructed 2026-06-22 from the issue set + a full codebase survey, then
  reconciled against the canonical README index entry (which it matches on every
  decision).
- **Spec anchor:** `docs/DATABASE_SCHEMA.md`, `docs/AUTH_AND_RLS.md`, `STAGE_1_SPEC.md` §26
- **Supersedes (for the DB path):** ADR 0002 (Prisma Accelerate), ADR 0007 (Supabase CLI migrations)
- **Retains:** ADR 0015 (Supabase Auth on Workers) — **unchanged**

---

## Context

The application database is Supabase Postgres, reached from the API Worker over
**Prisma Accelerate** (ADR 0002, HTTPS `prisma://`). That works, but it has two
structural costs:

1. **Read latency.** Every read is Worker → Accelerate edge → a single Postgres
   primary (one region). For a read-heavy, globally-served directory, the slow
   leg is the Worker→origin hop, which Accelerate pools but does not move closer
   to the user. Smart Placement can't help (the primary is single-region); see
   the note in `apps/api/wrangler.jsonc`.
2. **Two vendors + a connection model that fights the runtime.** Supabase Postgres
   is used almost entirely as a plain relational store (the survey below shows
   **0 enums, 0 scalar arrays, no Postgres-only query features in app code**),
   yet it carries the full Postgres operational surface (pooler URLs, Accelerate
   dependency, the `DATABASE_URL` vs `DIRECT_URL` footgun, the shared-dev-DB
   footgun in local dev).

**Cloudflare D1** is SQLite at the edge with **read replication via the Sessions
API** (GA path: bookmarks for read-your-writes), bound directly into the Worker
(`env.DB`) with no `nodejs_compat` and no external proxy. For this workload it is
a better fit: reads can be served from a replica near the user, writes remain
strongly consistent, and local dev becomes a real per-workspace SQLite file
instead of a shared remote database.

### Why not move auth too? (Option A vs Option B)

- **Option A (this ADR): keep Supabase Auth, move only app data to D1.**
- **Option B (deferred): self-host auth as well** — full Cloudflare
  consolidation (single-vendor end-state).

We choose **Option A**. Supabase Auth on Workers is a *recently proven, working*
subsystem (ADR 0015: `@supabase/ssr` cookie sessions on SSR + `jose`/JWKS
verification on the API Worker, no DB round-trip, no `nodejs_compat`). Re-platforming
auth would risk the one security-critical path for a benefit (single-vendor) that
this migration does **not** claim. So the ADR 0015 plumbing is **unchanged**, and
single-vendor consolidation is explicitly **out of scope** — a possible later
Option-B step, not a driver here.

### The cost of Option A: a permanent split-identity seam, and no RLS backstop

Keeping auth on Supabase while app data lives on D1 means `auth.users` (Supabase)
and `public.profiles`/`reviews`/audit (D1) are in **different systems**. Three
couplings that Postgres handled in-database now cross a system boundary and move
into app code (the **split-identity seam**):

1. **Provisioning** — the `handle_new_user` trigger
   (`supabase/migrations/20260515052617_auth_integration.sql`) that inserts a
   `profiles` row on signup **cannot fire cross-system**.
2. **`auth.users` email reads** — the privileged `$queryRaw` in
   `admin-reviews.ts` that reads reviewer emails crosses schemas; it must become
   a Supabase-side call.
3. **GDPR erasure** — account deletion (`account.ts`) deletes the `auth.users`
   row in the *same transaction* as the profile via `$executeRaw`; that becomes a
   two-system coordination.

Separately, D1/SQLite has **no row-level security**. Postgres RLS (28 policies +
35 GRANTs + 19 funcs/triggers) was **defense-in-depth** — the API Worker already
runs as a privileged role that bypasses RLS and **filters every read explicitly**
in its queries (`promotion_status = 'promoted'`, reviews `status = 'approved'`,
integrations require both endpoints promoted, owner reads `WHERE owner =
currentUser`). Losing RLS therefore removes a *backstop*, not the primary control.
The mitigation is to make the app-layer guards **airtight** and prove it with a
no-leakage test matrix (there is no DB backstop left if a query forgets a filter).

### Migration surface (codebase survey, 2026-06-22)

| Dimension | Count | Note |
|---|---|---|
| Models | 23 | **0 enums, 0 scalar arrays** → clean SQLite translation |
| Query call-sites | ~195 across 29 files | mechanical Prisma → Drizzle |
| `$transaction` blocks | ~19 | → atomic `db.batch()` (incl. §26.1 audit-in-tx) |
| Raw SQL sites | 10 | 8 trivial (`SELECT 1` etc.); **2 hard** = `auth.users` read + delete |
| JSON columns | 5 | `products.usefulness`, `audit_log.before/after/metadata`, `workflow_transitions.metadata`, `stats_cache.value` |
| RLS policies / GRANTs / funcs+triggers | 28 / 35 / 19 | **no D1 equivalent** → app-layer |
| Supabase Auth files | 9 | **retained** unchanged |
| Supabase migrations | 15 | re-authored as Drizzle/D1 migrations |

**Data migration is near-free pre-launch:** the catalog is re-promoted from
Airtable via `POST /api/promote`; user/review/audit tables are ~empty. There is no
bulk Postgres→D1 data copy on the critical path.

---

## Decision

Move the **application database** from Supabase Postgres (Prisma Accelerate) to
**Cloudflare D1**, accessed via **Drizzle ORM**, and keep **Supabase for Auth
only**.

### 1. Data layer

- **Schema source of truth** moves from `apps/api/prisma/schema.prisma` to a
  Drizzle SQLite schema (`apps/api/src/db/schema.ts`). Type mapping:
  - `uuid` PK → `text` with an app-generated default
    (`$defaultFn(() => crypto.randomUUID())`); SQLite has no `gen_random_uuid()`.
  - `timestamptz(6)` → `text` (ISO-8601), defaulted/refreshed in app
    (`$defaultFn`/`$onUpdate(() => new Date().toISOString())`). This **replaces
    the `set_updated_at()` triggers** with app-side behaviour and keeps the wire
    format identical, so response serializers don't change.
  - `decimal` (ratings/VQS/priority) → `real`; `smallint`/`int` → `integer`;
    `bigint` autoincrement → `integer primaryKey({ autoIncrement: true })`;
    `boolean` → `integer({ mode: 'boolean' })`.
  - 5 JSON columns → `text({ mode: 'json' }).$type<Shape>()` (SQLite stores JSON
    as text; the `Prisma.JsonNull` workaround disappears).
  - Enum-style CHECK constraints, composite PKs, FK `onDelete` cascade/set-null,
    partial indexes (`WHERE … IS NOT NULL`), and unique constraints all translate
    directly to Drizzle's SQLite builders. Zod validation in `@aeci/shared` stays
    the first line of enum enforcement.
- **Client factory** `getPrisma(env)` (`apps/api/src/prisma.ts`) is replaced by a
  Drizzle/D1 factory `getDb(env, opts?)` (`apps/api/src/db/client.ts`) that wraps
  `env.DB.withSession(anchor)` so reads are replica-served and **read-your-writes**
  is preserved across the request via the session bookmark (AECI-250, now wired —
  see Risk #1). Reads default to the `'first-unconstrained'` anchor (nearest
  replica = the latency win); write paths pass `{ constraint: 'first-primary' }`
  and any inbound `x-d1-bookmark` via the `writeDb(c, dbFor)` helper, and the
  bookmark is emitted on the response by `bookmark-middleware.ts`. A
  `typeof withSession !== 'function'` guard falls back to the plain binding on
  local dev + the in-memory test harness (single DB → read-your-writes is
  automatic), so the perf win is prod-only.
- **Migrations** move from the Supabase CLI to `drizzle-kit generate` →
  `wrangler d1 migrations apply`. The D1 binding uses
  `migrations_pattern: "migrations/*/migration.sql"` to consume Drizzle's nested
  layout directly (wrangler ≥ 4.x). `prisma migrate` stays unused (it always was —
  ADR 0007); now `prisma generate`/`db pull` and the Supabase CLI migration
  workflow go too.
- **Reference data** (taxonomy, ADR 0008) is re-applied as idempotent SQLite
  upserts (`INSERT … ON CONFLICT(slug) DO UPDATE`).

### 2. Transactions → `db.batch()` (the §26.1 invariant)

D1 has **no interactive transactions** — only atomic `db.batch([...])` (all
statements known up front; no read-decide-write mid-transaction). The pattern:
**read outside the batch, decide, then submit one atomic array of writes.** For
optimistic concurrency, gate with `UPDATE … WHERE <expected>` and check
rows-affected.

The audit-in-transaction invariant (Spec §26.1, "no state change commits without
a corresponding audit row") is preserved by including the audit insert **in the
same batch** as the state-change write. `appendAuditLog()`
(`packages/shared/src/audit-log.ts`) is refactored from "await `auditLog.create`
inside a tx" to a builder that **returns a Drizzle insert statement** for the
caller's batch array; the best-effort Datadog forward (§26.5) runs *after* the
batch commits via `ctx.waitUntil`.

### 3. The split-identity seam (auth stays Supabase)

- **Seam #1 — provisioning.** The existing `POST /api/auth/profile/ensure`
  backstop (`auth-profile.ts`) becomes the **primary** profile creator: an
  idempotent D1 upsert on first authenticated request, optionally fronted by a
  Supabase Auth Hook on signup. No DB-level FK/trigger required.
- **Seam #2 — `auth.users` email reads.** Replaced by a Supabase **Admin API**
  call (service-role key, auth project only), degrading to `null` on failure
  exactly as today.
- **Seam #3 — GDPR erasure.** Account deletion does a D1 batch (null inbound FKs,
  delete `profiles`, insert audit) **then** calls the Supabase Admin API to delete
  the `auth.users` row (replacing the cross-schema `$executeRaw`). Ordering,
  idempotency, and partial-failure handling are documented in `AUTH_AND_RLS.md`.

### 4. Authorization (RLS → app-layer)

The 28 RLS policies are re-expressed as **app-layer ownership/visibility filters**
over the existing `requireAuth`/`requireAdmin` Worker guards (`lib/authz.ts`,
which already read role + ban state from the DB row). There is **no DB backstop**,
so every public read must carry its visibility filter and every owner read must
filter by the authenticated user. A no-leakage test matrix is the acceptance gate.
`AUTH_AND_RLS.md` is rewritten from "RLS + GRANTs" to "app-layer guards".

### 5. Promotion, jobs, cache (unchanged topology)

- `POST /api/promote` upserts into D1 via the Drizzle client + `batch()`; the
  Airtable→store logic and `supabaseId` idempotency are unchanged.
- The daily jobs (Algolia sync/drift, home-stats, moderation metrics,
  request→Linear reconcile) keep the **cron → queue → consumer** topology
  (ADR 0013); only their reads/writes move to Drizzle. The watermark stays in
  `stats_cache`.
- Cache-Tag purge (ADR 0010) is **DB-independent** and unchanged.

### 6. Environments & local dev

- A per-env D1 database is bound as `DB` on the API Worker (preview / staging /
  production). `wrangler dev` uses a **local SQLite** D1 by default, so each
  Conductor workspace gets an **isolated local database** — retiring the
  "app reads the shared dev DB" footgun.
- Staging/prod backup & promotion move from R2 snapshots to D1 **Time Travel**
  (30-day PITR) + `wrangler d1 export`.
- Secrets: drop `DATABASE_URL` / `DIRECT_URL` / Accelerate keys; **keep
  `SUPABASE_*`** (auth-only) and add a `SUPABASE_SERVICE_ROLE_KEY` for the Admin
  API seams (auth project, API Worker).

### Phasing & the go/no-go gate

Phase 0 (spikes AECI-249/250/251) is the **go/no-go gate**. The spike patterns are
folded into the build, but each "blocker if…" remains an acceptance test: if the
audit invariant can't be made atomic under `batch()`, if read-your-writes can't be
guaranteed, or if provisioning can't be made reliably idempotent, the migration is
**shelved, not shipped**. Phases: 0 spikes → 1 schema/tooling → 2 query rewrite →
3 identity/authz → 4 promote/jobs/cache → 5 env/CI/ops → 6 docs/decommission.

---

## Consequences

- ➕ Reads can be served from an edge replica near the user (the primary driver);
  the DB binding is in-Worker, with no Accelerate dependency and no `nodejs_compat`.
- ➕ Local dev is a real per-workspace SQLite file — no shared-dev-DB cross-talk,
  no `DATABASE_URL`/`DIRECT_URL` split.
- ➕ Supabase drops to the **free auth-only tier**; one fewer runtime DB dependency.
- ➖ **Permanent split-identity seam:** provisioning, email reads, and erasure are
  cross-system and must be coded + tested (no in-DB FK/trigger guarantees them).
- ➖ **No RLS backstop:** an app-layer query that forgets its visibility filter
  leaks data with nothing behind it. Mitigated by the no-leakage test matrix.
- ➖ **No interactive transactions:** read-decide-write logic must be restructured
  around `batch()` + rows-affected checks; the `appendAuditLog` contract changes.
- ➖ D1 read replication is **prod-only** — the latency win does not appear in
  local dev (which proves correctness, not the perf thesis), and is a public-beta
  feature to monitor.
- ➖ Decimal→`real` and timestamptz→ISO-text are lossless for this schema's uses
  (averages/scores; no equality compares found) but are a behavioural change to
  keep in mind.

## Risks / open questions

1. **Drizzle × D1 Sessions API.** ✅ **Resolved (AECI-250, 2026-06-26).** `getDb`
   wraps `drizzle(env.DB.withSession(anchor) as unknown as D1Database, …)`:
   Drizzle's relational query builder and `db.batch([...])` only call `.prepare()`
   / `.batch()`, both present on `D1DatabaseSession`, so the cast is a runtime-shape
   contract (no raw-session fallback was needed — native Drizzle session support,
   drizzle-team/drizzle-orm #2226/#4522, is still open). The inbound/outbound
   `x-d1-bookmark` round-trip is threaded API-Worker-only (write handlers ↔
   `bookmark-middleware.ts`); cross-client public-render freshness stays owned by
   cache-tag purge (ADR 0010) + sub-second replica lag, and a global server-side
   bookmark store is a deferred follow-up. Read replication is still a Cloudflare
   **public beta** (no GA as of 2026-06) and must be enabled per-database
   (dashboard/REST `read_replication:{mode:"auto"}`) for the win to appear; the
   code is inert-safe until then. **Local dev is unaffected** (single DB).
2. **`batch()` atomicity for the audit invariant** (AECI-249) — validated before
   the query rewrite leans on it.
3. **Scale of the one-shot rewrite** (~195 sites) — mitigated by reaching a
   **local-Run milestone** (Phases 1–4 + local wiring) before any cloud cutover.

## Related

- ADR 0002 (Prisma Accelerate) — **retired for the DB path** by this ADR.
- ADR 0007 (Supabase CLI migrations) — **superseded** by drizzle-kit + `wrangler d1`.
- ADR 0015 (Supabase Auth on Workers) — **retained, unchanged**.
- ADR 0013 (Algolia jobs via queue), ADR 0010 (promote purges Cloudflare directly),
  ADR 0008 (taxonomy reference data) — topology unchanged; reads move to Drizzle.
- `docs/migrations.md` (rewritten), `docs/prisma.md` (retired),
  `docs/AUTH_AND_RLS.md` (rewritten), `docs/REVIEW_APP_PROMOTE_API.md` (updated).

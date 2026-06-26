# `apps/api/scripts/`

Maintenance / ops scripts run from a developer machine (or CI) against the app
database. **Not deployed to the Worker.** The app database is **Cloudflare D1**
(SQLite) + Drizzle (ADR 0016); a plain Node process reaches a *deployed* D1 only
through `wrangler d1 execute --remote`, not a Worker `env.DB` binding. None of
these use Prisma or a Postgres `DATABASE_URL`/`DIRECT_URL` — that path was retired
with the D1 migration (ADR 0016 / AECI-278).

| Script | npm script | What it does |
|---|---|---|
| `seed-reviews.ts` | `db:seed-reviews` | **Dev/demo only.** Inserts ~150–200 realistic, anonymous, approved reviews across the existing catalog so an operator can preview a "fully going" site (rating summaries, the 5-review threshold, pagination). The deterministic plan + SQL lives in `@aeci/shared/seed-reviews` (so `apps/datatool` can reuse it against a D1 binding); this is the Node CLI shell (arg parsing + `wrangler d1 execute` I/O). Not wired into `db:seed:local` on purpose. |
| `reconcile-product-counts.ts` | `db:reconcile-counts` | Denormalized product-count drift guard. Recomputes `integration_count` / `review_count` / `rating_*_avg` from source rows and compares to stored values. The rule lives in `src/lib/recompute-counts.ts`; this is the CLI/CI caller. Scheduled daily, report-only, against staging + production by `.github/workflows/reconcile-counts.yml`. |
| `reconcile-algolia-drift.ts` | `db:reconcile-algolia-drift` | Algolia index-drift report + orphan sweep for a deployed D1 (AECI-266). Builds the authoritative promoted-id sets from D1, browses each Algolia index, and (with `--apply`) deletes objects with no promoted D1 row. The rule lives in `src/lib/algolia-orphans.ts`. Dry-run by default. |
| `purge-algolia-orphans.ts` | `ops:purge-algolia-orphans` | One-off ops CLI (AECI-267) that deletes specific orphaned Algolia objects **by objectID** from an env's indexes. Core: `src/lib/algolia-orphan-purge.ts`. Dry-run by default; `--apply` deletes. |
| `lib/airtable.ts` | — | Minimal dependency-free Airtable REST gateway, originally for the one-time Airtable bulk migration (AECI-83). The steady-state curator → app-DB path is `POST /api/promote` into D1 (see `docs/API_CONTRACTS.md`). |

See each script's file header for its full flag set, required environment
variables (`CLOUDFLARE_API_TOKEN` for `--remote`; `ALGOLIA_APP_ID` /
`ALGOLIA_ADMIN_KEY` for the Algolia tools), and runbook.

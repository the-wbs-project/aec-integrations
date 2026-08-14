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
| `retract-product.ts` | `ops:retract-product` | Remove a promoted product from a deployed D1 (there is no product-delete path in the app — `promote` only upserts). The usual case is a duplicate/stub that disambiguated to a `-N` slug (`box` existed → the dupe became `box-2`). Reads the product's full footprint, then on `--apply` deletes it child→parent (FK-safe regardless of D1 cascade), de-indexes the Algolia `products` object, and purges the affected Cache-Tags. Core: `src/lib/retract-product.ts`. Dry-run by default; **refuses** a product with integrations/reviews unless `--force`, and `production` unless `--allow-production`. Writes **no** `audit_log` row (Tier-0; the audited path is the future `retract` endpoint). |
| `backfill-entitlements.ts` | `ops:backfill-entitlements` | One-off §2.4 backfill for the AECI-515 entitlement model: inserts a perpetual, termless `active` `vendor_entitlements` row for every `vendors.verified = 1` with no row, restoring the §2.1 mirror invariant on a deployed tier (the fixture seeds never run remotely, so deployed tiers get their rows from here). Core: `src/lib/backfill-entitlements.ts`. **Never writes `vendors.verified`** — only `src/lib/vendor-entitlement.ts` moves the mirror, so reverse drift (an `active` entitlement on a `verified = 0` vendor) is reported and **refused** rather than repaired. Dry-run by default; `--apply` writes; `production` needs `--allow-production`; idempotent (`WHERE NOT EXISTS` re-guard). Writes **no** `audit_log` row (Tier-0; `notes` carries the provenance). Run it on **every** deployed tier — the `entitlement_mirror_drift` data-quality check is the proof it landed. |
| `lib/airtable.ts` | — | Minimal dependency-free Airtable REST gateway, originally for the one-time Airtable bulk migration (AECI-83). The steady-state curator → app-DB path is `POST /api/promote` into D1 (see `docs/API_CONTRACTS.md`). |

See each script's file header for its full flag set, required environment
variables (`CLOUDFLARE_API_TOKEN` for `--remote`; `ALGOLIA_APP_ID` /
`ALGOLIA_ADMIN_KEY` for the Algolia tools), and runbook.

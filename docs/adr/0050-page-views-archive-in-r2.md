# ADR 0050: A permanent page_views archive in R2, gzip NDJSON, before the prune

- Status: Accepted. Built.
- Date: 2026-10-29
- Issue: AECI-1228
- Relates to: ADR 0041 (the raw page-view store); ADR 0045 (the edge request log); ADR 0022 (log-class writes, amended 2026-10-29); `docs/ADMIN_PANEL_SPEC.md` §7.4 rule 5; `docs/VENDOR_PERFORMANCE_SPEC.md` §3.7; `docs/DATABASE_SCHEMA.md` §9.15; `docs/ANALYTICS.md` §11c

## Context

The 03:00 UTC retention job deletes `page_views` rows older than 400 days. D1 Time Travel recovers about 30 days, so a pruned row is gone for good. The first real delete is around 2027-07-28. `metrics_daily` keeps the daily totals, but not the rows behind them. A per-vendor question older than 400 days, or a reclassification of old traffic, would have nothing to read.

Two R2 stores already hold traffic history. Neither can stand in for the D1 row. The raw page-view store (ADR 0041) holds the capture envelope, not the D1 row with its classification fields, and it has a 400-day lifecycle rule. The edge request log (ADR 0045) holds Cloudflare's view of each request, also for 400 days.

AECI-1228 asked for a Basin Iceberg table in "the catalog AECI-1196 sets up". That catalog was never built. ADR 0041 item 7 and ADR 0045 item 7 both chose plain files in R2 read with DuckDB instead.

## Decision

Chris ruled on 2026-10-29.

1. **The retention job writes gzip NDJSON to R2.** No Basin, no Iceberg, no Pipelines. One object per UTC day per table: `page_views/day=YYYY-MM-DD/page_views.ndjson.gz` and `page_view_classifications/day=YYYY-MM-DD/page_view_classifications.ndjson.gz`. Each line is one `SELECT *` row, with D1 column names and D1 values. DuckDB reads it with `read_json` and a glob. A catalog adds a service and a schema to maintain, and nothing here needs one.
2. **The full D1 row, kept indefinitely.** The buckets `aeci-page-views-archive-{staging,production}` have no lifecycle rule. `page_views` holds no user linkage (`AUTH_AND_RLS.md` §8), so erasure has nothing to reach in the archive. The privacy policy says the visit record is archived indefinitely.
3. **A day is archived at 371 days old.** That is `BACKFILL_MAX_AGE_DAYS + 1` (`PAGE_VIEWS_ARCHIVE_AGE_DAYS` in `@aeci/shared`). No backfill reclassifies a day past that age, and the only later update, the Turnstile verdict, closes after 10 minutes. So the copy matches D1 at prune time, and a failed night has 29 more nights to recover. Staging overrides the age to 2, so the path runs every night.
4. **A ledger, and a gate on the prune.** A day's `page_views_archive_days` row is written only after R2 confirmed both objects and a recount in D1 equalled the rows written. The prune refuses any `page_views` day with no ledger row (`archive_gap`), or with more rows in D1 than the ledger counted (`archive_mismatch`). A refusal aborts the whole run, the same posture as a `metrics_daily` gap.
5. **Fail closed in production.** The gate is on when the `PAGE_VIEWS_ARCHIVE` binding is present, and in production even when it is not. A production deploy that lost the binding refuses to prune instead of pruning unarchived. Demo and local dev have no bucket and no gate.
6. **`notification_sends` is not archived.** Its question, "what did we send this person last year", has a one-year horizon that the 400-day window already covers. An indefinite copy of who we emailed would be a new personal-data store with no reader.

## Consequences

- **Rows outlive the prune.** History older than 400 days is read ad hoc from the archive. No live request reads it. `VENDOR_PERFORMANCE_SPEC.md` §3.7's rollup trigger now starts with "read the archive".
- **The prune gains a precondition that can stall it.** A broken archive stops all pruning, `job_runs` included. The alert `pageviews-archive-failed` fires on any failed day or a missing production binding. The runbook is `RUNBOOKS.md` "page_views archive failed".
- **A partial prune is not a mismatch.** A truncated run leaves part of a day in D1. The ledger then counts more rows than D1 holds, which the gate allows. Nothing else deletes `page_views` rows.
- **Cost.** One day is about 1,000 rows, under 100 KB gzipped. Each row is read once more, at 371 days. R2 storage grows by tens of MB a year.
- **Two operator steps before merge.** Both buckets must exist before the deploy, because a deploy with a bound bucket that does not exist fails.
- **Log-class ledger.** `page_views_archive_days` writes no `audit_log` row (ADR 0022, 2026-10-29 amendment). The prune's one `retention.pruned` row is unchanged.

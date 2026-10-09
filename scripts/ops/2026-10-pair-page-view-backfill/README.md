# Pair-page view backfill (AECI-929)

Sets `page_views.pair_product_a_id` and `pair_product_b_id` on integration pair-page
rows written before migration 0067. Since 0067, ingest derives both endpoint products
from the concrete path (`ADMIN_PANEL_SPEC.md` §13 D25). This script applies the same
rule to the rows that came before it.

**Not run on production in AECI-929.** Production data work waits for the standing
post-go-live rule. Until it runs, every per-product view figure counts pair pages only
from the switch date recorded in `ADMIN_PANEL_SPEC.md` §7.3.

```bash
scripts/ops/2026-10-pair-page-view-backfill/run.sh --env local
```

```bash
scripts/ops/2026-10-pair-page-view-backfill/run.sh --env production --apply --allow-production
```

The first command is a dry run against the local D1. The second writes production, and
needs the post-go-live go-ahead first.

## What it does

- Reads every row whose `concrete_path` has the shape `/products/<a>/integrations/<b>`,
  case-sensitive, with no further segment and `a` not equal to `b`. That is the same
  shape `parsePairPagePath` in `@aeci/shared` accepts at ingest.
- Resolves each slug against `products.slug` as it stands today.
- Stores the two ids lower-first, comparing BINARY. That is the order
  `canonicalPairIds` uses at ingest.
- When one slug no longer resolves, it stores the other in side A and leaves side B
  NULL. When neither resolves, it leaves the row alone.

## What it never does

- It only writes rows where both pair columns are NULL. A re-run changes nothing.
- It never touches `product_id` or any other column, and never deletes a row.
- It writes no audit row. `page_views` is log-class.

## Rows it cannot reach

`concrete_path` exists since AECI-585. Pair-page rows older than that have only the route
pattern in `path`, which names no product. They stay unattributed.

A retired slug is not followed through `slug_redirects`. At ingest a retired slug 301s
before the page renders, so the counted view always names a live slug. A historical row
whose slug was later retired stays NULL on that side.

## Files

| File | Role |
|---|---|
| `backfill.sql` | The `UPDATE`. One statement. |
| `projection.sql` | The dry-run count. Same `WITH` block, byte for byte. |
| `run.sh` | Preflight, before counts, projection, `--apply`, after counts. |

`apps/api/src/lib/pair-page-view-backfill.spec.ts` runs both SQL files against the
migrated test harness. It checks that the two files share one parse, that the result
matches ingest row for row, and that a re-run changes nothing.

## After a run

Record the printed `first_created_at` / `last_created_at` window and the
resolved / unresolved counts in `ADMIN_PANEL_SPEC.md` §7.3 and on AECI-929.
`metrics_daily` needs no recompute because it stores no per-product figure.

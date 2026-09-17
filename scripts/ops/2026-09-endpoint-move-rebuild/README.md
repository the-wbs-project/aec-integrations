# AECI-991 — rebuild `integration_endpoint_moves` from `audit_log`

One-time, idempotent repair. The move rows that AECI-953 wrote were deleted by a
foreign-key cascade when the product they pointed **away from** was retracted. The
`integration.endpoint_moved` audit rows survived, so this script reads them back.

> **Status: run against production 2026-09-17 (44 rows, see Run log).** Re-running is a
> no-op. It writes nothing without `--apply`, and nothing to production without
> `--allow-production` on top of it. It must run **after** migration
> `0041_shocking_maggott.sql`, which is what makes the table accept a retired endpoint.

---

## What was lost

`integration_endpoint_moves.from_product_a_id` / `from_product_b_id` each carried
`REFERENCES products(id) ON DELETE CASCADE`. A redirect is keyed on the pair an edge
moved *away* from, so deleting that product deleted the redirect.

[AECI-809](https://linear.app/aec-integrations/issue/AECI-809) re-pointed **44** edges
off Autodesk Construction Cloud onto Autodesk Forma, then retracted the ACC record —
the correct order for the retraction consumer, and precisely what triggers the cascade.
Production held **44** `integration.endpoint_moved` audit rows dated 2026-09-15/16 and
**0** move rows. Every `/products/autodesk-construction-cloud/integrations/*` URL 404ed.

## Why the audit log is enough, and where it is not

Each audit row carries `entity_id` (the edge), `before_state.productIds` (the pair it
left) and `created_at`. That is everything the move row needs **except one thing**: the
table is keyed on slugs now, and a pre-AECI-991 audit row names product **ids**. Once
the product row is deleted, no query recovers the slug that id held.

`retired-products.json` is the operator ruling that closes that gap — one sourced entry
per retired id. An id that resolves in neither `products` nor that file prints
`UNRESOLVED` and writes nothing. **Never add an entry from memory**: a wrong slug writes
a redirect that sends readers to the wrong page and nothing downstream can tell.

Audit rows written from AECI-991 onward carry `before_state.productSlugs` outright, and
the script prefers it. That file should stop growing.

## What it writes

One `integration_endpoint_moves` row per recorded move that does not already have one,
plus **one summary `audit_log` row per run** (`integration.endpoint_moves_rebuilt`).

Not one audit row per move, deliberately: the move events are already in the log — they
are this script's entire input — and a second row per move would assert a move that
never happened and would double on every future reconstruction. ADR 0022 wants the
repair audited, not the history rewritten.

Both go in one file applied through `wrangler d1 execute --file`, which routes via D1's
import pipeline and does promise all-or-nothing.

Re-running writes nothing: the `INSERT` is `OR IGNORE` against the composite primary
key, rows already present are filtered out before the file is generated, and the summary
`INSERT` carries a `NOT EXISTS` guard on its run id.

## What it does not do

- **It does not purge the edge cache.** `demo` and `production` run uncached today
  (`CACHE_STRATEGY.md` §1). On a cached tier, purge one `pair:<a>__<b>` per written row.
- **It never writes to `integrations`, `connector_evidenced_pairs` or `products`.**
- **It is not the ACC fix on its own.** Those 44 URLs 301 from `slug_redirects` once
  AECI-991 ships, because the ACC *slug* is retired and the pair route now rewrites its
  path prefix. What these rows answer is the other case: a pair whose two endpoints both
  still exist and whose edge moved elsewhere.

## Run it

```
scripts/ops/2026-09-endpoint-move-rebuild/rebuild.sh --env production
scripts/ops/2026-09-endpoint-move-rebuild/rebuild.sh --env production --apply --allow-production
scripts/ops/2026-09-endpoint-move-rebuild/rebuild.sh --env production --rollback --apply --allow-production
```

Needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The first form is a dry run:
it reads the cohort, prints the per-URL projection and writes `rebuild.sql` +
`rollback.sql` under `backups/<stamp>-<env>/` without applying either.

Non-production environments hold none of these edges, so the cohort resolves empty there
and the script exits early. That is the expected result, not a failure.

## Sibling script

`scripts/ops/2026-09-pair-endpoint-move-backfill/` seeds the **52 Procore** moves that
predate the promote recording them at all — no audit rows, so its cohort is a committed
list of pair-URL slug triples resolved against live data. The two cohorts do not
overlap. Run both.

## Run log

- **2026-09-17, production, run `20260917T025705Z`** (prod SHA `2b01ea40`). Dry run
  `20260917T025654Z` planned 44 rows, 0 already present, 0 unresolved. Apply wrote 44
  `integration_endpoint_moves` rows plus one `integration.endpoint_moves_rebuilt` summary
  row (`rebuilt: 44`). Matches the 44 `integration.endpoint_moved` audit rows, one per
  distinct edge. No purge: production runs uncached.

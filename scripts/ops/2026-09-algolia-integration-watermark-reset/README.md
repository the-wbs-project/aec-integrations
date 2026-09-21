# Algolia watermark reset — AECI-880, extended for AECI-636

Operator script. Forces **one** full sweep of **one** entity in the nightly Algolia
incremental sync, by resetting that entity's watermark field to the epoch sentinel. It
touches one field of one `stats_cache` row and nothing else.

It was written for `integrations` (AECI-880, the record of that run is below). **Since
AECI-636 it takes `--entity products|vendors|integrations`**, so the same path can backfill
`listing_tier` onto the product and vendor records without emptying either index. The
directory keeps its original name so existing links still resolve.

Linear: [AECI-880](https://linear.app/aec-integrations/issue/AECI-880) (parent AECI-885,
project Stage 2.5 Hardening).

---

## The defect

The daily `data-quality` cron reported, unchanged across runs:

```
algolia_index_drift | warn | production_integrations: database 1228 vs algolia 951 (+277)
```

Records existed in production D1 and not in the production `integrations` Algolia index.
The count fell 277 → 62 → 45 → 24 → 22 as AECI-882, AECI-909, AECI-889 and AECI-916 deleted
rows, and never because indexing improved.

**Cause: a permanent watermark gap, not a measurement error.** Migration `0027` moved the
connector-evidenced-pair population between tables with their ids *and* their `updated_at`
verbatim. Every one of those rows therefore sits behind the `integrations` watermark, and
the nightly window has never reached them and never would. `buildIntegrationRequests` does
read `connector_evidenced_pairs` — the sync is not excluding the table — it simply never
sees a row whose `updated_at` predates the fence.

`drizzleDriftCounter` and `buildIntegrationRequests` share one membership rule (both tables,
both endpoints promoted), so the counter was right and the index was short. Excluding the
table from the count would have made the check lie.

## The fix

`algolia-sync.ts` treats a never-synced entity as `EPOCH_ISO` and sweeps it whole
(`readWatermark`). Write that sentinel into the `integrations` field and let the 08:00 UTC
cron do one catch-up pass. `stats_cache` is derived state, so ADR 0022 owes **no** `audit_log`
row.

The datatool's `POST /api/reindex` is the equivalent alternative, but it CLEARS the index
before repopulating, so search returns zero hits for the duration. This path never empties
the index.

## Usage

```
node scripts/ops/2026-09-algolia-integration-watermark-reset/reset-watermark.mjs --env staging --entity products
node scripts/ops/2026-09-algolia-integration-watermark-reset/reset-watermark.mjs --env staging --entity products --apply
```

`--entity` is **required** and takes exactly one of `products`, `vendors` or `integrations`.
To reset two entities, run the script twice, once per entity. There is no default, so the
AECI-880 command without `--entity` now fails instead of resetting `integrations` again.

Dry run by default. `--apply` writes; `--allow-production` is required on top of it for
`--env production`. A production dry run needs no extra flag, because it only reads. Unknown
flags are refused rather than ignored. The rules live in `args.mjs` and are unit-tested in
`apps/api/src/test/watermark-reset-args.spec.ts`. Needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (or a
`wrangler login`) with D1 read+write.

The write is a **compare-and-swap**: the `UPDATE` carries a `WHERE "value" = '<the exact JSON
we read>'` predicate, so if the 08:00 sync rewrites the row between the read and the write it
matches nothing and the script stops rather than clobbering a newer fence. Re-running after a
successful apply is a no-op ("already at the epoch sentinel").

## What it deliberately does not do

| | Why |
|---|---|
| Reset more than one entity per run | Each run is one compare-and-swap on one field. The other two fields are rewritten byte-identically. |
| Stamp `computed_at` | That column is the admin panel's derived "when did `algolia-sync` last run" signal (`CRON_DERIVATIONS`, `routes/admin-system.ts`). Stamping it reports a sync that never happened. |
| Write an `audit_log` row | `stats_cache` is derived state — ADR 0022. |
| Create the row if absent | A missing row already reads as epoch for all three entities, so the next run sweeps everything. The script refuses rather than resetting products and vendors as a side effect. |
| Run the sync | There is none to run. See below. |

## There is no way to invoke the sync on demand

The only producer of the `sync` job is the cron dispatch in `apps/api/src/scheduled.ts`
(`enqueueOrRun(env, ctx, 'sync')` on the 08:00 UTC trigger). No HTTP route enqueues it, no
route calls `runDailySync`, and `wrangler` cannot trigger a deployed Worker's cron. So the
reset schedules the repair; it does not perform it.

## Measured state (production, 2026-09-14)

Watermark row before and after:

```
before  {"products":"2026-09-14T08:01:06.058Z","vendors":"2026-09-14T08:01:06.058Z","integrations":"2026-09-14T08:01:06.058Z"}
after   {"products":"2026-09-14T08:01:06.058Z","vendors":"2026-09-14T08:01:06.058Z","integrations":"1970-01-01T00:00:00.000Z"}
```

Drift before (`pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env production`):

| entity | indexed | promoted | drift |
|---|---|---|---|
| products | 260 | 260 | 0 |
| vendors | 169 | 169 | 0 |
| **integrations** | **950** | **972** | **+22** |

Row census confirming the shape of the 22:

| | total | eligible (both endpoints promoted) |
|---|---|---|
| `integrations` | 950 | 950 |
| `connector_evidenced_pairs` | 22 | 22 |

950 + 22 = 972, and the index holds exactly 950. So the 22 missing records are precisely the
evidenced-pair population, none of which was ever indexed. The sweep will emit **972
`updateObject` requests and zero `deleteObject` requests** — there are no ineligible rows in
either table — which also means the nightly orphan sweep's safety cap
(`maxDeletes: 50` / `maxFraction: 0.2`, `lib/algolia-orphans.ts`) is not in play.

## One measured D1 fact worth keeping

The single-row `UPDATE` reported `meta.changes: 2` against production D1 on 2026-09-14.
**D1's `meta.changes` is not SQLite's `changes()`** — the same divergence AECI-581 hit, where
an upsert reported no `meta.changes` at all. Gating on `changes === 1` fails a write that
succeeded, and the operator then re-runs a mutation they already applied. The script uses
`meta.changed_db` as the "something was written" signal and a verification **read** as the
authority on what.

## Closing

Not closed by this script. AECI-880 closes when the `algolia_index_drift` check reports zero
drift on `production_integrations` for **two consecutive** daily `data-quality` runs (04:00
UTC). Note the cron ordering: `data-quality` runs at 04:00 and the sync at 08:00, so the first
DQ run that can be clean is the one on the day **after** the sweep.

Interim confirmation, any time after the sweep:

```
pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env production
```

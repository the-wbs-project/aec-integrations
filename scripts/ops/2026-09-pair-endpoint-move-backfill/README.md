# AECI-953 — seed `integration_endpoint_moves` for 52 pre-existing endpoint moves

One-time, idempotent backfill. Writes the moved-from record for the 52 Procore edges
that changed endpoint **before** the promote learned to record it, so their old pair
URLs start serving a 301 instead of an empty page.

> **Status: run against production 2026-09-17 (52 rows, see Run log).** Re-running is a
> no-op. The script writes nothing without `--apply`, and nothing to production without
> `--allow-production` on top of it.
>
> **The resolve step reads with `--command`, not `--file` (fixed 2026-09-17).** `--file`
> returns only an import summary and no rows, so the first production dry run could not
> resolve anything. The write step still uses `--file`, which is correct for writes.
>
> **Updated for AECI-991 (2026-09-16).** `integration_endpoint_moves` is keyed on the
> two old pair **slugs** now, not on two product ids, so the resolution query no longer
> looks up the retired product at all and the generated `INSERT`s name slugs. Nothing
> else about the cohort or the procedure changed. If you are looking for the **44 ACC**
> moves instead, they are a different cohort with a different source — see
> `scripts/ops/2026-09-endpoint-move-rebuild/`, which rebuilds from `audit_log`.

---

## Why these 52 need a script

[AECI-726](https://linear.app/aec-integrations/issue/AECI-726) moved **37** live edges
off Procore Project Management onto the new `Procore` platform record on 2026-09-14.
[AECI-950](https://linear.app/aec-integrations/issue/AECI-950) moved **15** more the
next day, onto `procore`, `procore-project-financials` and `procore-quality-safety`.

A re-pointed edge keeps its id and updates its public row in place. The pair page,
though, is keyed by the two product **slugs** — so the URL moved and the old one was
left serving 200 + `noindex` with no redirect. AECI-726's own verification confirmed
it: `/products/procore-project-management/integrations/okta` returned 200 with a
`noindex` meta and no `Location`.

The promote now records every such move as it happens. These 52 predate that code,
so they are the only cohort that needs writing by hand.

## The cohort is slugs, not ids

`moves.json` holds 52 `(from, to, other)` **slug triples**, not edge ids.

The Linear comments do name per-edge ids, but those are the review app's `rec…` record
ids. The promote mints its own app-DB ids, so a cohort keyed on `rec…` resolves to
nothing here and there is no mapping to recover it from.

Keying on pair URLs is also the more honest shape, because the URLs are what the
ticket is about. The script resolves each triple against the **live** database: it
finds the edge currently sitting on the destination pair — in either anchor table,
either orientation — and writes a move row naming the old pair. A triple that resolves
to nothing prints `UNRESOLVED` and writes nothing, which is the correct outcome for an
edge that has since moved again or been retracted.

## One row will be inert, on purpose

`smartsheet` is in the cohort and its old pair page does **not** redirect.
[Smartsheet](https://www.aecintegrations.com/products/smartsheet) held two Procore
Project Management edges; AECI-726 moved one and left the other, so
`/products/procore-project-management/integrations/smartsheet` still has content.

That is correct and needs no special case: the redirect gate is *"this pair has no
mechanisms"*, never *"a move row exists"*. A pair that lost one edge of two is smaller,
not moved, and redirecting it would hide live rows.

## Run it

```
scripts/ops/2026-09-pair-endpoint-move-backfill/backfill.sh --env production
scripts/ops/2026-09-pair-endpoint-move-backfill/backfill.sh --env production --apply --allow-production
scripts/ops/2026-09-pair-endpoint-move-backfill/backfill.sh --env production --rollback --apply --allow-production
```

Needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The first form is a dry run:
it resolves the cohort, prints the per-URL projection and writes `backfill.sql` +
`rollback.sql` under `backups/<stamp>-<env>/` without applying either.

Non-production environments hold none of these products, so every triple resolves to
nothing there and the script exits early. That is the expected result, not a failure.

### What it writes

One `integration_endpoint_moves` row per resolved edge — `(integration_id,
from_product_a_slug, from_product_b_slug)` — plus one `integration.endpoint_moved`
`audit_log` row — the same action the promote ingest
emits for the same mutation (§26.1 / ADR 0022). Both go in one file applied through
`wrangler d1 execute --file`, which routes via D1's import pipeline and does promise
all-or-nothing; a `--command` rollback is only observed behaviour of an endpoint that
never stated it. Same reasoning as the AECI-706 `powered_by` backfill next door.

Re-running writes nothing: the `INSERT` is `OR IGNORE` against the composite primary
key and the audit `INSERT` carries a `NOT EXISTS` guard.

### What it does not do

- **It does not purge the edge cache.** `demo` and `production` currently run uncached
  (`CACHE_STRATEGY.md` §1), so production needs no purge today. On a cached tier the
  old 200s are still stored and the script prints the tag list to purge.
- **It does not re-promote anything, and it never writes to `integrations`.**

## Run log

- **2026-09-17, production, run `20260917T030226Z`** (prod SHA `2b01ea40`). First dry
  run `20260917T030139Z` failed at the resolve step on the `--file` read and wrote
  nothing; fixed as above. Dry run `20260917T030157Z` resolved 52 of 52 triples, one edge
  each: exactly the 37 AECI-726 and 15 AECI-950 old URLs, none missing, none extra.
  Apply wrote 52 `integration_endpoint_moves` rows and 52 `integration.endpoint_moved`
  audit rows. The table went from 44 rows (the AECI-991 ACC rebuild) to 96. Verified
  301 in both path orientations for `okta` (AECI-726) and `clearstory` (AECI-950);
  `smartsheet` stays 200 as designed. No purge: production runs uncached.

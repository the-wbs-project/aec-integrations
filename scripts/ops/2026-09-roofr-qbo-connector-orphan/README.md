# 2026-09 Roofr → QuickBooks Online connector orphan

**Status: RUN — complete.** Applied to `aeci-app-production` 2026-09-07, verified live.

## What was removed

One stranded `connector_evidenced_pairs` row plus its cascade:

| | |
|---|---|
| `connector_evidenced_pairs` | `3d3709e1-e8ef-47f3-ae90-3ff8e8ab76e7` (Roofr → QuickBooks Online, `mechanism_name = 'Agave'`, connector = `agave-erp-sync`) |
| `claims` | 2 (`directory-contacts`, `invoices-payments`, both `a_to_b`, `origin = aeci`) |
| `attestations` | 2 (both `source = aeci`, `asserted = 1`, `ai_seed` notes) |

The surviving, correct row is the `integrations` row
`4943884a-5741-43a7-9d1f-1a335736e18a` — `native`, one-way, beta, 2 claims, 2
attestations. It was left untouched.

## Why it was stranded

The review app corrected this integration from `iPaaS` + `powered_by = Agave ERP Sync`
to `native` with `powered_by` cleared, and re-promoted. Since migration `0027`,
`powered_by` is what **routes** a promoted edge between the two tables: a powered edge
lands in `connector_evidenced_pairs`, an unpowered one in `integrations`. Clearing
`powered_by` therefore did not *update* the existing row — the promote inserted a fresh
`integrations` row, the review app's `supabase_integration_id` was repointed at it, and
the old connector-evidenced row became unreachable (no future promote can address it).

Public symptom: both pair page and product page rendered the integration twice — once
Native (correct) and once "Powered by Agave ERP Sync" with a `useagave.com` listing URL.
`/products/roofr` showed "Integrations (13)".

## Divergence from the original brief

The brief expected the orphan to carry **no** claims. It carried **two** — but they are
exact mirrors of the surviving row's claims (same two data objects, same direction, same
`origin = aeci`, AECi-sourced attestations only, no vendor attestation). Nothing unique
to the orphan was lost.

## What was run

```
DELETE FROM attestations WHERE claim_id IN (SELECT id FROM claims WHERE connector_evidenced_pair_id = '3d3709e1-…');  -- 2
DELETE FROM claims WHERE connector_evidenced_pair_id = '3d3709e1-…';                                                  -- 2
DELETE FROM connector_evidenced_pairs WHERE id = '3d3709e1-…';                                                        -- 1
RECONCILE_ENV=production pnpm --filter @aeci/api db:reconcile-counts -- --fix --allow-production
```

Backups of all three row sets are in this directory (`pair.json`, `claims.json`,
`attestations.json`, raw `wrangler d1 execute --json` output). Note that a rollback
INSERT for `claims` must omit `anchor_id` — it is a STORED generated column.

Like the 2026-08 orphan cleanup, this went through raw SQL rather than the API's
`db.batch` + audit builders, so it left **no `audit_log` row**.

## Count reconcile

`db:reconcile-counts --fix` repaired **7** products' `integration_count`. Three were
caused by this delete (`quickbooks-online` 38→37, `roofr` 13→12, `agave-erp-sync` 12→11);
the other four were pre-existing drift the same run picked up
(`334d5475` 0→1, `414fed91` 1→3, `90c32951` 1→3, `3c627b1d` 0→2) — the script has no
per-product filter. A follow-up run reports clean.

## Known residue

`reconcile-product-counts.ts` does **not** bump `products.updated_at`, so the daily 08:00
Algolia incremental sync (watermark on `updated_at`) will not repush the four
pre-existing-drift products or `agave-erp-sync`; their indexed `integration_count` may
stay stale until something else touches those rows. `roofr` and `quickbooks-online` were
touched by the promote itself and will sync normally.

## Verification (2026-09-07, prod, cache-busted)

- `/products/quickbooks-online/integrations/roofr` — one card, labelled **Native**, zero
  occurrences of "Agave" or `useagave.com`.
- `/products/roofr` — "Integrations (12)", QuickBooks Online listed once under Direct
  integrations as Native; the "Via Agave ERP Sync (1)" section is gone.

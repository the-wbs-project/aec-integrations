# 2026-08 orphan-integration cleanup

Remove **22 orphaned `integrations` rows** (+ their 63 claims and 63 attestations) from
production D1. They render as duplicate mechanism cards on the public pair pages.

**Status: RUN — complete.** Verified 2026-08-13 (AECI-568): all 22 ids in
`orphan-ids.txt` are absent from `aeci-app-production`. The delete left no `audit_log`
rows, which is expected — it went through the datatool, whose prune issues raw SQL
outside the API's `db.batch` + audit builders. This runbook is kept for the diagnosis
and the rollback recipe; there is nothing left to apply.

> **Production is not orphan-free.** The 2026-08-13 sweep found **2** unreferenced
> `integrations` rows, both Polycam (`polycam→autocad`, `polycam→arcgis`). They are a
> *different* failure — **no twin**, so they are the only copy of their mechanism and
> the `orphans_without_a_twin` guard below will correctly refuse them. Do not reach for
> this script. See `scripts/ops/2026-08-promote-strand-audit/`.

## What an "orphan" is here

An integration row that **no Airtable record points at** — no
`Integrations.supabase_integration_id` in the AEC Integrations base
(`appy81IdGJY6Fngf9` / `tbl6PBPsGJuPcrZZi`) holds its id.

Because promote keys identity **solely** on the caller-supplied `supabaseId`
(`apps/api/src/routes/promote.ts:28` — "Present → update; absent → insert"), a row Airtable
does not reference is unreachable: no future promote will ever update it, and nothing will
ever delete it. It is permanently stranded.

## Evidence (measured 2026-08-04)

| | |
|---|---|
| D1 `integrations` rows | 436 |
| Airtable records carrying a `supabase_integration_id` | 414 |
| **Orphans** (in D1, unreferenced by Airtable) | **22** |
| Dangling (Airtable id with no D1 row) | 0 |

Re-measured 2026-08-13 after the run, by
`scripts/ops/2026-08-promote-strand-audit/audit.mjs`: 496 D1 rows / 494 Airtable
pointers / **2** orphans (none of them from this batch) / 0 dangling.

Worked example — Smartsheet ↔ Procore. Airtable holds exactly **two** records
(`recLidKj1VUMFR5XT`, `rectnbqtS4V2xexTH`); D1 holds **four**. Airtable's two ids point at
the rows created `2026-07-25T15:56:48`. The rows from `15:50:53` are referenced by nothing.

The public symptom, still live:
<https://www.aecintegrations.com/products/procore-project-management/integrations/smartsheet>
renders each mechanism twice.

## Root cause

The `15:50:53` promote inserted rows but its `supabase_integration_id` write-back never
reached Airtable. Six minutes later the promote was retried; with no `supabaseId` in the
payload it took the insert branch (`promote.ts:1174`) and created a **second** set of rows.
Airtable kept only the retry's ids.

This is **not** duplicate Airtable records — the base is clean at 414/414. Correcting an
earlier hypothesis: these rows will *not* be recreated by a future promote, precisely
because Airtable already holds the surviving ids and will `UPDATE` those.

**Follow-up worth filing:** promote has no natural-key guard on
`(source, target, mechanism)`, so a dropped write-back silently duplicates rather than
failing. That is the durable fix; this runbook only clears the existing residue.

**Update (2026-08-13, AECI-561/568).** The *upstream* cause is fixed: promote is now
asynchronous (AECI-563), the review app stamps a `promote_job_id` ledger before pushing
and collects the ids afterwards (AECI-567), and an hourly cron sweeps abandoned jobs
(AECI-570) — so a lost response no longer strands ids at all. A natural-key guard is
still unfiled; it would now only defend against a curator deleting an Airtable record
that D1 still holds, which is exactly the residual the promote-strand audit reports.

## Safety guards (all verified 0 against production)

`cleanup.sh` re-checks these on every run and **refuses** unless all three are zero. Each
means "this row is not actually a duplicate":

| Guard | Meaning if non-zero |
|---|---|
| `claims_unique_to_orphans` | A claim exists only on the orphan; the `ON DELETE CASCADE` would destroy curation |
| `orphans_without_a_twin` | No surviving row with the same (source, target, mechanism) — it's the only copy |
| `orphans_richer_than_twin` | The orphan's `description`/`notes` are longer than its twin's — editorial content would be lost |

`claims.integration_id` and `attestations.claim_id` both cascade
(`apps/api/src/db/schema.ts:327`, `:355`), so the delete reaches 148 rows in total. The
script deletes child → parent explicitly rather than leaning on the cascade, so the
footprint is auditable rather than implicit.

## Run it

Two ways. **Prefer the datatool** unless you specifically want files on disk.

### A. datatool (recommended)

The guards, ordered delete, and rollback are ported into the Access-gated admin
Worker as `POST /api/prune-integrations` + a "Prune orphaned integrations" UI panel
(`apps/datatool/README.md`). Paste the ids from `orphan-ids.txt`, dry-run, **save the
returned `rollbackSql`**, then execute.

It does strictly more than this script: it also repairs `integration_count` and
reindexes in the same operation, so follow-ups 1 and 2 below are already handled.
What it can't do is write a backup file (a Worker has no filesystem) — the rollback
comes back in the response body instead, which is why saving it is a manual step.

### B. this script

Needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

```bash
# dry-run: guards + footprint + backup + rollback.sql, no writes
scripts/ops/2026-08-orphan-integration-cleanup/cleanup.sh --env production

# apply (production needs the extra guard flag)
scripts/ops/2026-08-orphan-integration-cleanup/cleanup.sh --env production --apply --allow-production
```

A backup and a generated `rollback.sql` are written **before** any delete, on every run
including dry-run, to `backups/<UTC-stamp>-<env>/` (gitignored — it holds full catalog
content).

## Rollback

D1 has no undo; the backup is the undo.

```bash
apps/api/node_modules/.bin/wrangler d1 execute aeci-app-production --remote \
  --file=scripts/ops/2026-08-orphan-integration-cleanup/backups/<stamp>-production/rollback.sql
```

`build-rollback.mjs` emits parent → child (`integrations` → `claims` → `attestations`) so
the FKs hold on replay, and uses `INSERT OR IGNORE` so a partial replay is safe to re-run.

## Follow-ups after `--apply`

**Only needed for path B** — the datatool does 1 and 2 inside the operation. This script
prints them; it does **not** run them.

1. **Counts** — `integration_count` is denormalized and will now be high by one per deleted
   edge:
   `RECONCILE_ENV=production pnpm --filter @aeci/api db:reconcile-counts -- --fix`
2. **Algolia** — the deleted ids linger as orphan objects in the `integrations` index.
   ⚠️ A bare `ops:purge-algolia-orphans` does **not** work here: that script defaults to a
   hard-coded AECI-267 target set, not our ids. It needs the `--ids` override:
   ```bash
   IDS=$(sed 's/^/integrations:/' orphan-ids.txt | paste -sd, -)
   pnpm --filter @aeci/api ops:purge-algolia-orphans -- --env production --ids "$IDS" --apply
   ```
   (Or just run a reindex, which rebuilds the index from D1 and evicts them wholesale.)
3. **Edge cache** — `POST /admin/purge` with `product:<slug>` tags for every slug in the
   generated `affected-slugs.txt` (22 products, Procore-heavy).

## Ordering note

Three of the 22 orphans are `Agave ERP Sync` rows that also appear in the separate
`powered_by_product_id` FK gap. **Run this cleanup first, then re-promote Procore Project
Management** — otherwise the re-promote writes against rows that are about to be deleted.

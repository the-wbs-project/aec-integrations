# Preview D1 catch-up: 14 migrations behind → head (AECI-828)

Run 2026-09-09. **No script lives here** — the run used existing tooling only
([`scripts/d1-apply-migrations.sh`](../../d1-apply-migrations.sh) and the two page-view
backfills beside it). This directory is the run log, following the convention of the dated
directories next to it.

`aeci-app-preview` is **one shared remote D1 that every PR preview binds to** (the
`env.preview` block in `apps/api/wrangler.jsonc`; `docs/environments.md` §"PR previews",
Option 1). Nothing in CI had ever migrated it. It reached **14 migrations behind** — `0015`
against a repo head of `0029` — so `page_views.is_operator` did not exist and every surface
downstream of it failed on preview: `NOT_INTERNAL`, the digest, `/admin/overview`,
`/admin/traffic`, the swarm detectors, `/admin/connectors`, and both page-view backfills.

**The reason it survived so long is the shape of the failure.** A PR touching one of those
surfaces got a green deploy and a broken preview, and the breakage read as a code bug on the
PR rather than an environment one. AECI-688 lost time to exactly that, and could not run its
`metrics_daily` backfill on preview at all.

## Two things the issue got wrong, both found by the census

1. **The gap was 14 files, not 13.** `0029_many_red_shift.sql` (AECI-826) landed after the
   issue was written. `docs/migrations.md` already warns: check `apps/api/migrations/` rather
   than trusting a number written in prose.
2. **The ledger was not clean at `0015`.** It held **18** rows where `0000`–`0015` is 16
   files. Two were pre-AECI-750 names applied 2026-08-14, which is why a plain
   `migrations apply` would have failed loudly on the first renamed file. This is the repair
   `docs/migrations.md` §0 had recorded as "PENDING on remote `aeci-app-preview`".

## Ledger census — all four tiers

The issue asked to check the other tiers before assuming only preview drifted. Only preview had.

| Tier | Ledger rows | Head recorded | State |
|---|---|---|---|
| preview | 18 (2 stray) | `0015_fine_outlaw_kid.sql` | **14 behind** |
| staging | 30 | `0029_many_red_shift.sql` | current |
| demo | 30 | `0029_many_red_shift.sql` | current |
| production | 30 | `0029_many_red_shift.sql` | current |

## Step 1 — ledger repair (2 rows)

The generic seven-pair loop in `docs/migrations.md` §0 would have reported `changes: 0` on
five of its pairs, which is correct and not a failure. Preview had only ever applied two of
the renumbered set:

| recorded name | rewritten to |
|---|---|
| `0016_lyrical_leper_queen.sql` | `0021_lyrical_leper_queen.sql` |
| `0017_slim_iron_lad.sql` | `0022_slim_iron_lad.sql` |

**The ledger was truthful before the rewrite, and that was verified rather than assumed** —
`claims.origin` + `claims.created_by_vendor_id` (`0021`) and `product_versions` +
`attestations.introduced_version_id` (`0022`) were all already present. So these were renames
to record, not migrations to re-run. Rewritten descending, per the procedure.

## Step 2 — pre-flights, before anything was written

| Check | Why | Result |
|---|---|---|
| `attestations` duplicate live `(claim_id, source)` | `0021`'s `attestations_slot_key` aborts mid-file on a populated tier | n/a — `0021` already applied |
| `integrations.mechanism_kind` vs the widened CHECK | `0027`'s `INSERT … SELECT` fails on an out-of-enum value | clean: `native` 82, `iPaaS` 16, `api` 5, `partner` 3, NULL 1 |
| `integrations.direction` vs its CHECK | same | clean: `bidirectional` 65, `one-way` 20, NULL 22 |
| `source_product_id = target_product_id` | `integrations_distinct_endpoints_check` | 0 |
| Stray `__carry_claims` / `__carry_attestations` | a past partial `0027` would break `CREATE TABLE … AS SELECT` | absent |
| `PRAGMA foreign_key_check` | the recreate re-declares every FK | 0 violations |
| Time Travel bookmark | the rollback | `00000090-00000000-000050e1-7d106336141fc49841ee0dcd76c52221` |

**The finding that de-risked the whole run: preview held 0 claims and 0 attestations, and 0
edges matched `0027`'s routing predicate.** `0027`'s two-level cascade — the thing the issue
was rightly careful about — had nothing to destroy here, and its data-move steps (8, 9, 11)
were no-ops. The migration reduced to two table recreates over 107 integrations.

## Step 3 — rehearsal against a copy of the real data

`docs/migrations.md` §3.3a rule 3: verify against non-empty data, not a fresh DB. Preview was
exported with `wrangler d1 export` (1.2 MB, 5 s), loaded into a scratch SQLite, and the 12
pending files applied in filename order with `foreign_keys = ON`, splitting on
`--> statement-breakpoint` exactly as `apps/api/src/test/d1.ts` does.

All 12 applied cleanly. Every count conserved, 0 FK violations after. The rehearsal predicted
the real run exactly.

## Step 4 — the apply

`scripts/d1-apply-migrations.sh aeci-app-preview preview` — the same helper the staging, demo
and prod lanes use, so it also reconciled the three reference-data seeds. 20 s. Ledger went
18 → **30 rows, head `0029_many_red_shift.sql`**; tables 33 → 43.

### Row census, before and after

| Table | Before | After |
|---|---|---|
| `integrations` | 107 | 107 |
| `claims` | 0 | 0 |
| `attestations` | 0 | 0 |
| `connector_evidenced_pairs` | (absent) | 0 |
| `products` | 61 | 61 |
| `vendors` | 43 | 43 |
| `page_views` | 713 | 713 |

## Step 5 — the three backfills, in AECI-688's fixed order

The order is load-bearing: step 3 aggregates what steps 1 and 2 leave behind, and
`metrics_daily` is retained indefinitely, so running it early freezes a wrong answer.

1. **`is_bot`** — `2026-08-page-view-bot-backfill/run.sh --env preview --apply`. 15
   unclassified rows, all swept to human. 0 remaining.
2. **`is_operator`** — `2026-08-operator-page-view-backfill/run.sh --env preview --apply`.
   Its own `0016` preflight now passes. 51 rows flagged across 2 ASNs; the human-public
   figure fell 125 → 93.
3. **`metrics_daily`** — `ops:backfill-metrics-daily -- --env preview --from 2026-06-23 --to
   2026-09-08 --apply`. 12 statements, **624 rows across 78/78 days**, 234 `reconstructed`.
   Every value was `(none) → N`: preview's `metrics_daily` was entirely empty, so this was
   pure gap fill and overwrote nothing.

**Self-verification:** the re-run reports `no change` on all eight series — the mechanical
form of "the chart has no step at the boundary".

## Acceptance (both from the issue)

```
select count(*) from page_views where is_operator = 1   →  51
pnpm --filter @aeci/api ops:backfill-metrics-daily -- --env preview --to 2026-09-08   →  completes
```

## What stops it recurring

`deploy.yml` gained a **`migrate-preview`** job (push to `main` only). It is a separate job
from `deploy-staging` because that one is gated on `vars.STAGING_ENABLED` and preview's schema
must not hang off the staging gate; it `needs: [unit-tests]` so nothing touches a real database
while `migration-0027.spec.ts` is red; and it is fail-closed, because silent drift is the
defect being fixed.

It deliberately tracks `main`'s head rather than running ahead of it. Applying a PR branch's
migrations would push unmerged schema into the database every *other* PR preview reads — the
Option-1 trade-off in `docs/environments.md` is preserved on purpose.

**The transferable lesson:** the old rule was a sentence in `docs/migrations.md` telling humans
to apply preview by hand on any migration-bearing PR. It failed 14 times in a row. A convention
nobody executes is not a control.

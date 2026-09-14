# 2026-09 retraction-feed consumer (AECI-882 / AECI-811 / AECI-878 / AECI-889)

**Status: RUN — three tranches, all complete.** Applied to `aeci-app-production` on
2026-09-13 (214 rows), 2026-09-14 (the 2 held back), and 2026-09-14 again (17 rows, AECI-889
batch 1). **The feed is at zero pending and no hold is active.**

The third tranche is the first one this lane took from a *routine* upstream batch rather than
from a one-off cleanup, which is what it was built for. Expect more: AECI-889 has three
catalogues left.

Consumes the review app's retraction journal: reads `list_retractions`, deletes the live
AECi rows it names, verifies they are gone in **both** delivered-tier tables, and only then
calls `confirm_retractions`.

Unlike the four retraction lanes before it, this one is **re-runnable and not row-specific**.
It takes whatever the feed holds. It stays here rather than becoming a `pnpm ops:*` CLI
because `docs/CICD_PLAN.md` §7.1 says `AECI_MCP_TOKEN` never reaches a Worker and no runtime
code here talks to the review app — keeping it in `scripts/ops/` keeps that literally true.

## What ran — 2026-09-13, 214 rows (AECI-882)

```
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production --apply --allow-production --confirm-count 214
```

| | before | after | delta |
|---|---|---|---|
| `integrations` | 951 | 950 | −1 |
| `connector_evidenced_pairs` | 277 | 64 | −213 |
| `claims` | 1873 | 1872 | −1 |
| `attestations` | 1873 | 1872 | −1 |
| `audit_log` rows from this lane | 0 | 214 | +214 |
| feed, pending | 216 | 2 | −214 |

The 1 `integrations` row is AECI-878 (`6a5fbeab-…`, Viewpoint Spectrum → Unanet CRM AEC),
executed by this consumer rather than by hand as that issue asked. The 213 pairs are the
AECI-852 reach-edge retirement.

**47 products** had `integration_count` repaired and `updated_at` bumped.
`db:reconcile-counts -- --fix` afterwards reported **no drift**, independently.

## The two rows held back — released and executed 2026-09-14 (AECI-909)

They were held because deleting them would have cascaded 21 curator rulings away with nowhere
to put them back:

| `supabaseId` | journal entry | pair | claims | attestations |
|---|---|---|---|---|
| `a96bb827-c0e2-4842-ad54-f25e40b04c81` | `rec4kywfVTBXovqBd` | Autodesk Build ↔ Foundation Software | 9 | 9 |
| `a3eb9e45-4c06-409c-a95d-caa91e15f0bd` | `recDOZmV8n5VmPAyP` | Procore Project Management ↔ Foundation Software | 12 | 12 |

Both are Agave ERP Sync connector pairs and between them they carried **all 21 claims** in the
215-row pairs population — the figure AECI-882 named, confirmed by measurement rather than taken
on trust.

### The release condition, and how each half was checked

The hold named two conditions. Neither was accepted on a status field:

| Condition | Evidence |
|---|---|
| AECI-891 live in **production** | `promote-to-prod` succeeded on `b5a75c93`, 2026-09-13 23:31 UTC |
| The 21 claims re-anchored and **stored** | AECI-910's apply returned `claims created 0, updated 0, unchanged 21, deleted 0, skipped 0`, with zero `kind: claim` entries in `skipped[]` |

Then re-counted here against production D1 before touching anything:

| `connector_pairs` id | pair | claims | attestations |
|---|---|---|---|
| `recR26YP4tgDvNj6V` | Procore Project Management ↔ Foundation Software | 12 | 12 |
| `reczhKqHUJZTSlUI2` | Autodesk Build ↔ Foundation Software | 9 | 9 |

Same two product pairs, same 9 / 12 split. So the cohort was **superseded**, not lost: the
delivered-tier copies went and the reach-tier copies stayed.

**Check step 2 this way or not at all.** A `claims[]` entry naming a pair AECi does not hold lands
in `skipped[]` and the job still reports `complete`. That looks exactly like success and is the
one failure mode that would have made this delete destroy 21 rulings.

### What ran — 2026-09-14, 2 rows (AECI-909)

```
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production --apply --allow-production --confirm-count 2
```

| | before | after | delta |
|---|---|---|---|
| `integrations` | 950 | 950 | 0 |
| `connector_evidenced_pairs` | 64 | 62 | −2 |
| `claims` | 1893 | 1872 | −21 |
| `attestations` | 1893 | 1872 | −21 |
| `claims` on `connector_pairs` (reach tier) | 21 | 21 | **0 — untouched** |
| `audit_log` rows from this lane | 214 | 216 | +2 |
| feed, pending | 2 | 0 | −2 |

Time Travel bookmark captured immediately before the delete, expires ~2026-10-14:

```
wrangler d1 time-travel restore aeci-app-production --bookmark=00005819-0000001a-000050e6-63be007bb4c3509272952ec27b1ffd00
```

**4 products** had `integration_count` repaired and `updated_at` bumped — `agave-erp-sync` 17,
`autodesk-build` 23, `foundation-software` 15, `procore-project-management` 98.
`db:reconcile-counts` afterwards reported **no drift**, independently.

### The three guards that refused first, and what each was changed to

The lane is written to refuse rather than adapt, so a second cohort cannot inherit the first
cohort's authorisation. All three had to be re-pinned, and the diff is the record of the ruling:

| Constant | 2026-09-13 run | 2026-09-14 run | Now, in the file | Why |
|---|---|---|---|---|
| `HOLD` | the 2 Agave ids | `{}` | `{}` | conditions met and checked above |
| `EXPECTED` | `216 / 215 / 1` | `2 / 2 / 0` | `0 / 0 / 0` | the feed is empty, and zero is the only shape that fails closed |
| `MAX_CASCADE` | `1 / 1` | `21 / 21` | `0 / 0` | the 21 were authorised for two named ids, and that authorisation is spent |

`MAX_CASCADE` is the one to read twice. Raising it from 1 to 21 was not a relaxation **only
because** the 21 superseding claims were verified present first. Without that check it is the
single guard standing between a run and 21 rulings that exist nowhere else on earth.

**Both numbers are back to zero now, and that is the resting state, not a leftover.** A
spent authorisation left in the file stops being a guard: a later cohort of two pair entries
carrying claims would have matched `2 / 2 / 0` by coincidence and cleared a `21 / 21` ceiling
without anyone ruling on it. Zero refuses every non-empty plan, so the next operator has to
measure the cohort in front of them. An empty feed is unaffected — the run returns at the
`feed.length === 0` check long before the shape gate.

**Re-measure all three before the next run.** AECI-889's I24 batches are expected to start
journalling deletes, which is exactly the cohort the zero pin is there to stop from
inheriting this one's clearance.

### Live verification (2026-09-14, browser UA)

- `/products/procore-project-management/integrations/foundation-software` → **200 with
  `<meta name="robots" content="noindex">`**, no mention of Agave ERP Sync.
- `/products/autodesk-build/integrations/foundation-software` → same.
- `/products/viewpoint-vista/integrations/unanet-crm-aec` → 200, indexable. The AECI-878 negative
  sentinel, asserted present in both orientations before and after.

**Both pair pages losing their delivered edge is the expected outcome, not a regression.** The
reach-tier render is AECI-716 and is unbuilt, so the 21 claims sit in D1 with no public surface.
That is the same state the other 213 AECI-852 rows are in, and it is correct: a `connector_pairs`
row asserts reach, never delivery, so rendering it as a delivered integration would turn reach back
into a delivery claim.

### Algolia, second run

```
products      production_products        indexed 260   promoted 260    orphans 0
vendors       production_vendors         indexed 169   promoted 169    orphans 0
integrations  production_integrations    indexed 950   promoted 1012   orphans 0
```

**Zero orphans**, because the 2 evidenced pairs were never in the index — the same finding as the
first run. For AECI-880: drift is now **62 missing**, down from 63. This run did not close it.

### Cache, second run

Still nothing to purge. Production has no `exports` block in `apps/web/wrangler.jsonc`, so it
serves uncached. Re-verified on 2026-09-14 rather than assumed.

## What ran — 2026-09-14, 17 rows (AECI-889 batch 1, Agave ERP Sync)

The first batch of the I24 sweep. Upstream re-anchored 169 claims onto reach-tier
`connector_pairs` rows, re-sent the Agave catalogue, then deleted 17 integration records and
journalled each one with the reason `I24 / AECI-889 batch 1 (Agave)`. This half deleted the 17
live AECi rows those entries name.

```
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production --apply --allow-production --confirm-count 17
```

| | before | after | delta |
|---|---|---|---|
| `integrations` | 950 | 950 | 0 |
| `connector_evidenced_pairs` | 62 | 45 | −17 |
| `claims` | 2041 | 1872 | −169 |
| `attestations` | 2041 | 1872 | −169 |
| `claims` on `connector_pairs` (reach tier) | 190 | 190 | **0 — untouched** |
| `audit_log` rows from this lane | 216 | 233 | +17 |
| feed, pending | 17 | 0 | −17 |

**13 products** had `integration_count` repaired and `updated_at` bumped.
`db:reconcile-counts -- --fix` afterwards reported **no drift**, independently.

Time Travel bookmark captured immediately before the delete, expires ~2026-10-14:

```
wrangler d1 time-travel restore aeci-app-production --bookmark=00005854-00000068-000050e6-40e79eebe660187bed73a054a942e359
```

### All 17 resolved to `connector_evidenced_pairs`, none to `integrations`

`resolve: integrations 0, connector_evidenced_pairs 17`. Upstream these are integration
records; here they are evidenced pairs, because migration `0027` moved every connector-powered
edge into that table with its id verbatim. That is the same split the 2026-09-13 tranche saw
(215 of 216 in pairs), and it is why verify reads both tables — see "Why both tables".

### The cascade was proved superseded before `MAX_CASCADE` moved

The plan cascaded **169 claims and 169 attestations**, by far the largest this lane has
authorised. Raising the ceiling to `169 / 169` was only safe because every one of those claims
was counted on a reach-tier row *first*, per evidenced pair rather than in aggregate:

| product pair | delivered claims (deleted) | reach `connector_pairs` id | reach claims (kept) |
|---|---|---|---|
| acumatica ↔ autodesk-build | 9 | `rectp91679rbueRBY` | 9 |
| acumatica ↔ procore-project-management | 11 | `recX6kmGA9owPzELr` | 11 |
| autodesk-build ↔ cmic | 9 | `rec8JIZreUjts6mhB` | 9 |
| autodesk-build ↔ deltek-computerease | 9 | `reckB1a5K0g7BhmuU` | 9 |
| autodesk-build ↔ quickbooks-online | 8 | `recftTf7M0eXnRIhn` | 8 |
| autodesk-build ↔ sage-100-contractor | 9 | `rec2keYiupa85WwFk` | 9 |
| autodesk-build ↔ sage-intacct | 9 | `rec4ksgzYcrlxXpIn` | 9 |
| autodesk-build ↔ viewpoint-spectrum | 9 | `recqC1Vi5OpuoE2nU` | 9 |
| autodesk-build ↔ viewpoint-vista | 9 | `recH4f2WSCCaG28y4` | 9 |
| procore-project-management ↔ deltek-computerease | 12 | `rec6tLIcESrgKt2Po` | 12 |
| procore-project-management ↔ quickbooks-desktop | 11 | `rec5JErj623cLlM8T` | 11 |
| procore-project-management ↔ sage-100-contractor | 12 | `rec0sYX06TIhwi3DX` | 12 |
| procore-project-management ↔ sage-intacct | 11 | `rece0nL1VldLBc53l` | 11 |
| procore-project-management ↔ viewpoint-spectrum | 12 | `recdDKc84x6qv2pYE` | 12 |
| procore-project-management ↔ viewpoint-vista | 12 | `recnhsQbS8NZrdIjT` | 12 |
| quickbooks-desktop ↔ autodesk-build | 8 | `recLMhwcniRoSAZQM` | 8 |
| sage-300-cre ↔ autodesk-build | 9 | `recvVNxzdjXkLCsdP` | 9 |
| **total** | **169** | 17 pairs, all matched | **169** |

Zero rows came back without a reach counterpart, and no counterpart was short. Then the whole
population was re-counted after: `claims WHERE connector_pair_id IS NOT NULL` read **190 before
and 190 after**, so the delete took the delivered copies and left the reach copies untouched.

**Do not raise `MAX_CASCADE` on an aggregate.** 169 total claims on 169 total reach claims would
also have been true if one pair had 12 spare and another had 12 missing. The per-pair match is
what rules out that shape, and it is the only check that does.

### The two guards, pinned and reset

| Constant | Pinned for this run | Now, in the file |
|---|---|---|
| `EXPECTED` | `{ total: 17, inPairs: 17, inIntegrations: 0 }` | `{ 0, 0, 0 }` |
| `MAX_CASCADE` | `{ claims: 169, attestations: 169 }` | `{ 0, 0 }` |

Both reset in the same change as the run that spent them, per the standing rule. Batch 2 is
App Xchange and its cohort is a different size, so it re-measures from zero.

### Algolia, third run

```
products      production_products        indexed 260   promoted 260    orphans 0
vendors       production_vendors         indexed 169   promoted 169    orphans 0
integrations  production_integrations    indexed 950   promoted 995    orphans 0
```

**Zero orphans** again, and for the third time the reason is that evidenced pairs have never
been indexed. For AECI-880: drift is now **45 missing**, down from 62. Deleting evidenced pairs
keeps shrinking that number without anyone closing it, which is worth saying out loud — the
gap is narrowing because the unindexed population is being deleted, not because indexing
improved.

### Cache, third run

Still nothing to purge. Re-checked in `apps/web/wrangler.jsonc` rather than assumed: the
`exports` block exists in the `preview` and `staging` env blocks only, so `demo` and
`production` serve uncached.

### Verification, live (2026-09-14, browser UA)

- `/products/procore-project-management/integrations/viewpoint-spectrum` → **200 with
  `<meta name="robots" content="noindex">`**, zero occurrences of "Agave".
- `/products/autodesk-build/integrations/sage-intacct` → same.
- `/products/viewpoint-vista/integrations/unanet-crm-aec` → 200, **indexable**, no robots meta.
  The AECI-878 negative sentinel, asserted present in both orientations before and after.

Both retired pair pages losing their delivered edge is the expected outcome. Their 169 claims
now sit on reach-tier `connector_pairs` rows with no public surface, because AECI-716's reach
render is unbuilt. Same state as the 213 AECI-852 rows and the 2 AECI-909 rows.

### Daily audit after this run

`pendingRetractions` **0**. Six of the seven stranded buckets **0**. The seventh,
`evidencedPairSourceGone`, holds **2** — the Aquifer HeavyJob pairs already filed as
**AECI-916**. Both were created 2026-09-09 and never updated, so they predate this run and are
not its residue. Exit **1**, correctly, and it will stay 1 until AECI-916 is ruled.

## The order, and why it is not negotiable

Delete → verify → confirm. Always.

`confirm_retractions` stamps `synced_at`, which drops the entry out of the default feed. An
entry confirmed but never deleted is a live public row that **nothing in either system can
find again**: the curation record is gone, so the journal entry holds the only copy of its
`supabaseId`, and confirming discards it. The opposite mistake is harmless — an unconfirmed
entry is simply re-reported, and re-deleting a deleted row is a no-op.

Enforced structurally: `confirmRetractions()` takes only the object `verifyDeleted()`
returns, `verifyDeleted()` only returns one after re-reading **both** tables and seeing zero
rows, and there is exactly one call site. **`scripts/ops/**` has no test harness**, so this
is a structural guarantee, not a unit-tested one. Do not add a second call site.

## Why both tables

A journal entry carries a `supabaseId` and nothing that says which table holds it. Migration
`0027` (AECI-721) moved connector-powered edges out of `integrations` into
`connector_evidenced_pairs` **with their ids verbatim**, so the same id can be in either.
215 of the 216 were in the pairs table.

A single-table consumer would therefore have cleared 1 row, concluded the other 215 were
already gone, and confirmed them — destroying the only pointer to 215 live, incorrect public
rows. That is the failure this lane is shaped to prevent, and it is why verify reads both.

## Why only those two tables

The feed journals `entity: 'product' | 'integration' | 'vendor'`, not just edges. This lane
handles the **integration class only**. Everything else is **parked**: printed with its
`entity`, then neither deleted nor confirmed, including under `--confirm-already-gone`.

The reason is the same asymmetry the order rests on. A `product` entry resolves against
neither delivered-tier table, so to this script it looks exactly like an edge that is already
gone. Confirming it would stamp `synced_at` and discard the curator's `reason` and upstream
record id forever, while the live `products` row it names stayed up. The row would still be
findable — the daily sweep's `productDeletedUpstream` bucket is a stock check and sees
products — but the ruling would not be, and preserving the ruling is the whole point of one
audit row per deleted row. Leaving the entry pending is harmless: it is re-reported until
`pnpm --filter @aeci/api ops:retract-product` takes it.

An entry with a **missing** `entity` is parked too. If the upstream projection ever drops the
field, this run does nothing at all and says so, rather than deleting rows whose class it can
no longer establish. `vendor` never appears — AECI-685 refuses the upstream delete while a
supabase id is attached.

This is also the **first code path in the repo that deletes from
`connector_evidenced_pairs`**. Neither the datatool prune (which only counts the table for
the count repair) nor `apps/api/src/lib/retract-product.ts` can touch it; the only precedent
was one row by hand in `scripts/ops/2026-09-roofr-qbo-connector-orphan/`.

## Two things the 2026-09-13 run got wrong, both recorded rather than smoothed over

**1. The confirm step died on a stale MCP session.** The first `--apply` read the feed, spent
~4 minutes deleting 214 rows across 9 batches, then failed `fetch failed` on the first
`confirm_retractions`: the `mcp-session-id` minted before the delete phase had expired.

This landed on the safe side by design — nothing was confirmed, the feed still listed all
216, and the recovery run recognised this lane's own `audit_log` rows (`metadata.tool`),
routed the 214 through the `goneWithOurAudit` bucket and confirmed them. Fixed since:
`confirmRetractions()` opens its **own** session, so the write no longer depends on how long
the delete took.

**2. The recovery run overwrote the rollback.** Artifacts were written to stable names, so
the recovery run — whose plan was empty — replaced a 214-row `rollback.sql` with a 13-line
stub. Fixed since: artifacts are timestamped and never overwritten, and no rollback is
written for an empty plan.

**The consequence stands and is not undone.** The full row bodies of the 214 deleted rows are
no longer on disk. Each `audit_log` row carries the id, name, slugs, mechanism, endpoints and
the curator's reason, but **not** the full record (description, `listing_url`, `notes`,
`maturity`, timestamps). The remaining recovery path is **Cloudflare D1 Time Travel**, which
keeps a 30-day window and restores the whole database rather than selected rows:

```
wrangler d1 time-travel restore aeci-app-production --bookmark=00005711-00000070-000050e5-d05d0849af2b3c247a2720f40e5e59b6
```

That bookmark is `2026-09-13T06:40:00Z`, immediately before the delete. It expires around
**2026-10-13**. Restoring it reverts every write to the database since, not just this one.

## Algolia — 2026-09-13 run

Measured after the delete, and it corrected an assumption worth recording:

```
integrations  production_integrations   indexed 951   promoted 1014   orphans 1
```

**One** orphan, not 214 — `6a5fbeab-…`, the AECI-878 row. The 213 connector pairs were
**never in the index**, which is exactly what AECI-880's "+277" drift was measuring: the
evidenced-pair population has never been indexed. Removed with:

```
pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env production --apply --allow-production
```

The nightly sweep's safety cap (`maxDeletes: 50`, `maxFraction: 0.2`, `override: false` in
`apps/api/src/lib/algolia-orphans.ts`) would have **refused the whole pass** had there been
214 orphans — it skips entirely rather than partially cleaning. It did not bind here, but it
would on a larger tranche, so check the count before assuming the cron will tidy up.

For AECI-880: drift is now `promoted 1014` vs `indexed 951`, i.e. **63 missing**, down from
277. It is not closed, and this run did not close it.

## Cache — 2026-09-13 run

**No purge was needed, and none is possible.** Native Workers Cache is live on `preview` and
`staging` only — the `exports` block exists in those two env blocks of
`apps/web/wrangler.jsonc` and in neither `demo` nor `production`. Production serves uncached,
so there was no stale window and nothing to invalidate. Re-check that before assuming the
same on a future run; enabling production caching is a deliberate future step.

## Verification, live (2026-09-13, browser UA)

`curl` with its default UA gets a Cloudflare **403 bot challenge** whose body carries
`<meta name="robots" content="noindex,nofollow">` — which looks exactly like a legitimate
noindexed page. Send a browser UA or you will verify the challenge page instead of the site.

- `/products/viewpoint-spectrum/integrations/unanet-crm-aec` → **200 with
  `<meta name="robots" content="noindex">`**, not a 404. Expected: a retracted pair leaves a
  noindexed empty pair page (AECI-795).
- `/products/viewpoint-vista/integrations/unanet-crm-aec` → 200, indexable, **Native**. The
  AECI-878 negative sentinel, asserted present in both orientations before and after.
- `/products/viewpoint-vista` → zero occurrences of "Microsoft Fabric". The deleted
  Kroo-powered pair is gone. Kroo Connector still appears there via a separate
  `integrations` row (`Viewpoint Vista → Kroo Connector`, `iPaaS`) that was never in the
  feed — correct, and not residue.
- 64 evidenced pairs survive across 7 connectors (Aquifer 22, Agave 19, Trimble AppXchange
  16, and four with 1–2). Kroo Connector has none left.

## Daily audit

`scripts/ops/2026-09-stranded-row-audit/audit.mjs` gained a **`pendingRetractions`** bucket,
because the six stock buckets exclude `connector_evidenced_pairs` and so read green on
2026-09-13 while 215 retracted pairs were live. Its own `HELD_RETRACTIONS` list carried the
two Agave ids so the job did not sit red while they waited — a permanently red guard is one
nobody reads, which would hide the *next* retraction behind these two.

**That list is now empty**, emptied in the same change as the run that released the holds. Do
the same with any future hold. A discharged hold left in place recreates the exact blind spot
the bucket was added to remove: the count looks familiar, the job stays green, and the next
retraction hides behind ids nobody re-reads.

Post-run 2026-09-13: all six stranded buckets **0**, `pendingRetractions` **2, both held**,
exit **0**.

Post-run 2026-09-14 (AECI-909 tranche): all six stranded buckets **0**, `pendingRetractions`
**0**, zero publicly reachable stranded rows, 260 products reconciled with no unresolved reads,
exit **0**.

Post-run 2026-09-14 (AECI-889 batch 1): `pendingRetractions` **0**, and every stranded bucket
**0** except `evidencedPairSourceGone` at **2**, which is AECI-916 and predates this run. Exit
**1** on those two. The seventh bucket did not exist when the lines above were written —
AECI-897 added it, which is why "six" is correct for them and wrong for this one.

## Re-running this lane

```
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production
```

Dry-run by default; writes timestamped `preflight-*.json` and `rollback-*.sql` and changes
nothing. **Both are gitignored** — they hold production catalog content, and this lane is
re-runnable, so committing them would put a few hundred KB of catalog rows in the repo every
run. That means the rollback is not in git: keep it, or record a Time Travel bookmark,
before you need it. To execute, add `--apply --allow-production --confirm-count <the planned count>`.
The count must match the resolved plan exactly, which is the human gate AECI-881 asked for:
if the feed moved between the dry run and the apply, the run refuses.

Guards that refuse rather than adapt: the shape gate (`EXPECTED`, which binds only when there
is something to delete), the cascade ceiling (`MAX_CASCADE`), a held id missing from the plan,
an id present in **both** tables, and the sentinel edge moving. Entries that are not
integration-class are parked before any of that — see "Why only those two tables".

**`EXPECTED` and `MAX_CASCADE` read `0 / 0 / 0` and `0 / 0`, so the next run refuses until
you measure the cohort and re-pin them.** That is the design: an authorisation is spent by
the run that used it, and a second cohort must never inherit the first cohort's clearance —
including by matching its shape coincidentally. Raising `MAX_CASCADE` is the one edit in this
lane that can destroy data, so raise it only after confirming, by count, that every claim it
will cascade away already exists somewhere else. Reset both to zero in the same change as the
run that used them, exactly as you would empty a discharged `HOLD`.

Exit codes are `0` clean, `1` refusal, `2` could-not-check — and 2 outranks 1.

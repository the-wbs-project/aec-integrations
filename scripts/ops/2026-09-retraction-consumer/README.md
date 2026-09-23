# 2026-09 retraction-feed consumer (AECI-882 / AECI-811 / AECI-878 / AECI-889 / AECI-916 / AECI-957 / AECI-1024 / AECI-1020)

**Status: RUN — eleven tranches, all complete.** Applied to `aeci-app-production` on
2026-09-13 (214 rows), 2026-09-14 (the 2 held back), 2026-09-14 again (17 rows, AECI-889
batch 1), 2026-09-14 a third time (21 rows, AECI-889 batches 2 + 3), 2026-09-14 a
fourth time (2 rows, **AECI-916 — the first operator-ruling run**), 2026-09-15
(1 row, **AECI-957 — the first cohort since AECI-878 to resolve in `integrations`**), and
2026-09-16 (3 rows, **AECI-809 — the first cohort that is a product MERGE rather than a
retirement, and the first to cascade claims that no surviving row holds**), and 2026-09-18
(4 rows, **AECI-1024 — the first cohort removed under the owner ruling's admission test**), and
2026-09-18 twice more (6 rows then 1, **the AECI-1020 cleanup window**), and 2026-09-21
(1 row, **the ADP Workforce Now ↔ Sage 100 Contractor leftover of that same AECI-1020
window, ruled withdrawn**).
**The feed is at zero pending and no hold is active.** The AECI-1024 vendor half ran the same
day through the new `ops:retract-vendor` lane (8 vendor rows), and Nemetschek Group followed on
the same lane in the AECI-1020 window (1 vendor row). The daily audit is green.

Tranches three and four are the routine upstream batches this lane was built for, rather
than one-off cleanups. Expect more: AECI-889 has **Kroo** left plus the MindCloud check, with
Zapier deferred. Kroo's 119 rows are unpromoted and carry zero claims, so that batch may
journal nothing at all and leave this lane with nothing to do.

Consumes the review app's retraction journal: reads `list_retractions`, deletes the live
AECi rows it names, verifies they are gone in **both** delivered-tier tables, and only then
calls `confirm_retractions`.

**Since AECI-916 it has a second cohort source.** `--ruling <file>` takes the ids from a
committed operator ruling instead of the journal, for stranded rows no journal entry can
ever name. Every guard stays; `confirm_retractions` is never called. See
[Operator-ruling mode](#operator-ruling-mode---ruling-aeci-916).

**Since AECI-1005 it refuses to delete a vendor-held row.** A row its owner has claimed
(`claimed_at` set) or a vendor created (`origin = 'vendor'`) belongs to the
vendor. That holds in both tables: `integrations` since migration `0044`, and
`connector_evidenced_pairs` since migration `0049` (AECI-1088). An upstream delete of its
curation record is not a ruling on it (ADR 0035). If
any resolved row in the cohort is vendor-held and not on `HOLD`, the run prints the rows,
writes nothing to either side, and exits `1`, in dry-run and apply alike. To proceed, put
each such id on `HOLD` with the reason; a held entry is never deleted and never confirmed,
so it stays pending on the journal until someone rules on it. The columns are probed from
the live DDL of each table (`vendor-held.mjs`), so the run still works on a database that
has not yet applied migration `0044` or `0049`, where no row of that table can be vendor-held. An EMPTY table-definition read is not that case: it throws and the run exits `2` (could not check), because falling back to an empty definition would switch the protection off silently. The DELETEs on both tables also carry `AND claimed_at IS NULL AND origin <> 'vendor'` when that table has the columns, so a row claimed between the plan and the write survives, and the verify step reports it as a leftover rather than confirming its entry. Before AECI-1088 the `connector_evidenced_pairs` DELETEs carried no such guard. Both tables now build their DELETEs through one helper, `guardedAnchorDeleteSql` in `vendor-held.mjs`.

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

## What ran — 2026-09-14, 21 rows (AECI-889 batches 2 + 3, App Xchange and Aquifer)

Batches 2 and 3 taken in **one** run, because they landed in the feed together. Upstream
retired 42 records across Trimble App Xchange (5) and Aquifer (37); only 21 of those carried a
`supabase_integration_id` and so journalled anything. This half deleted those 21 live AECi rows.

```
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production --apply --allow-production --confirm-count 21
```

| | before | after | delta |
|---|---|---|---|
| `integrations` | 950 | 950 | 0 |
| `connector_evidenced_pairs` | 45 | 24 | −21 |
| `claims` | 1884 | 1880 | −4 |
| `attestations` | 1884 | 1880 | −4 |
| `claims` on `connector_pairs` (reach tier) | 202 | 202 | **0 — untouched** |
| `audit_log` rows from this lane | 233 | 254 | +21 |
| feed, pending | 21 | 0 | −21 |

**16 products** had `integration_count` repaired and `updated_at` bumped.
`db:reconcile-counts -- --fix` afterwards reported **no drift**, independently.

Time Travel bookmark captured immediately before the delete, expires ~2026-10-14:

```
wrangler d1 time-travel restore aeci-app-production --bookmark=0000585a-00000010-000050e6-1916c11bba44215b009a1563a2afcb21
```

### The split: 1 App Xchange row, 20 Aquifer rows, all in `connector_evidenced_pairs`

`resolve: integrations 0, connector_evidenced_pairs 21`. Third run in a row where nothing
landed in `integrations` — migration `0027` moved every connector-powered edge into the pairs
table with its id verbatim, and every connector-lane retraction since has been one of those.

| batch | catalogue | journal entries | rows carrying claims |
|---|---|---|---|
| 2 | Trimble App Xchange | 1 | 1 |
| 3 | Aquifer | 20 | 0 |

### `MAX_CASCADE` moved to 4 / 4, and only after the per-pair proof

The cascade was **4 claims and 4 attestations**, all on one row. That is two orders of
magnitude below batch 1's 169, and the ceiling was still proved the same way rather than
waved through as small.

The join ran over **all 21 rows, not just the one believed to carry claims.** Each evidenced
pair was joined to its `connector_pairs` twin through `connector_stub_mappings` on both stubs,
same catalogue, same two products, and the two claim counts compared:

| catalogue | pair | delivered claims (deleted) | reach `connector_pairs` id | reach claims (kept) |
|---|---|---|---|---|
| Trimble App Xchange | procore-project-financials ↔ viewpoint-vista | 4 | `reci5soEoFe0HPOfq` | 4 |
| Aquifer | arcgis ↔ chatgpt | 0 | `recWDnqWLw1sivgo3` | 0 |
| Aquifer | arcgis ↔ microsoft-dynamics-365 | 0 | `recZ42bDglYBn1xUx` | 0 |
| Aquifer | autodesk-construction-cloud ↔ oracle-primavera-p6 | 0 | `rechjZUmr6BE6csVj` | 0 |
| Aquifer | autodesk-construction-cloud ↔ viewpoint-vista | 0 | `recuJIQn4XxCE6gER` | 0 |
| Aquifer | coupa ↔ microsoft-dynamics-365 | 0 | `recP3qvtQUOAXUQKf` | 0 |
| Aquifer | coupa ↔ snowflake | 0 | `recMimAGlxp4NP8MM` | 0 |
| Aquifer | oracle-fusion-cloud-erp ↔ arcgis | 0 | `reczc6yciqEg3cKZM` | 0 |
| Aquifer | oracle-fusion-cloud-erp ↔ coupa | 0 | `recht3Z97QtE2botp` | 0 |
| Aquifer | oracle-fusion-cloud-erp ↔ oracle-primavera-p6 | 0 | `rec6zoTXGKjSBQ4uI` | 0 |
| Aquifer | oracle-fusion-cloud-erp ↔ salesforce | 0 | `recHErNzuKBcAy4cb` | 0 |
| Aquifer | procore-project-management ↔ microsoft-dynamics-365 | 0 | `rec3qnJqr8DFPeFQi` | 0 |
| Aquifer | procore-project-management ↔ sap-s-4hana | 0 | `recTaDEMjSaY1Wx6P` | 0 |
| Aquifer | sage-300-cre ↔ autodesk-construction-cloud | 0 | `recWBiaZkqsPdzuUh` | 0 |
| Aquifer | sage-300-cre ↔ chatgpt | 0 | `recpfz0LajOEArhkE` | 0 |
| Aquifer | sage-300-cre ↔ oracle-primavera-p6 | 0 | `recmH0ZhWQGp9Iyvl` | 0 |
| Aquifer | sage-300-cre ↔ viewpoint-vista | 0 | `rec6AzyIPpOjjtrAh` | 0 |
| Aquifer | sap-s-4hana ↔ arcgis | 0 | `rec8EjecbRcj2o8Mu` | 0 |
| Aquifer | sap-s-4hana ↔ snowflake | 0 | `recv4tVhY9uClrk5t` | 0 |
| Aquifer | snowflake ↔ arcgis | 0 | `recjI13YVdtgEovYm` | 0 |
| Aquifer | viewpoint-vista ↔ oracle-primavera-p6 | 0 | `recCQDGqMr15rOK4U` | 0 |
| | **total** | **4** | 21 pairs, all matched | **4** |

**Run the join over every row, not just the ones you expect to carry claims.** Filtering to
the rows you already believe carry claims assumes the delivered count you are checking. Twenty
rows reading `0 delivered / 0 reach` is evidence; twenty rows never queried is not.

The one live row was then compared claim by claim rather than by count alone, because 4 = 4
could be four different objects:

| data object | delivered direction | reach direction |
|---|---|---|
| `budgets` | `both` | `both` |
| `commitments` | `both` | `both` |
| `cost-codes` | `both` | `both` |
| `invoices-payments` | `both` | `both` |

The whole reach population was re-counted after the delete and read **202 before and 202
after**, and the App Xchange twin still holds its 4.

### The upstream cascade figure is not the AECi cascade figure

The upstream half of this batch reported **0 claims cascaded** and said `MAX_CASCADE` could
stay low. That is true upstream and wrong here, and the difference is worth stating because
the next batch will hit it again.

`reanchor_claims` moved the review app's own claims off the integration record before deleting
it, so the upstream delete cascaded nothing. On this side the promote then **created** the
reach copies as new rows and left the delivered copies in place — a promote cannot delete. So
the AECi row still carried its 4 delivered claims at delete time, and the cascade was 4, not 0.

**Take the cascade from the dry run against production, never from the upstream report.**
The two numbers answer different questions and only one of them is about this database.

### The two guards, pinned and reset

| Constant | Pinned for this run | Now, in the file |
|---|---|---|
| `EXPECTED` | `{ total: 21, inPairs: 21, inIntegrations: 0 }` | `{ 0, 0, 0 }` |
| `MAX_CASCADE` | `{ claims: 4, attestations: 4 }` | `{ 0, 0 }` |

Both reset in the same change as the run that spent them. The resting state was already zero
going in, so the net `consume.mjs` diff for this run is the doc comments only — the pinned
values live here, in the record, which is where a future operator will look for them.

### Algolia, fourth run

```
products      production_products        indexed 260   promoted 260    orphans 0
vendors       production_vendors         indexed 169   promoted 169    orphans 0
integrations  production_integrations    indexed 950   promoted 974    orphans 0
```

**Zero orphans** for the fourth time, same reason: evidenced pairs have never been indexed.
For AECI-880: drift is now **24 missing**, down from 45. It keeps narrowing because the
unindexed population is being deleted, not because indexing improved. 24 is now the entire
surviving `connector_evidenced_pairs` population, so the drift number and the table count have
converged — that is a coincidence of arithmetic, not a fix.

### Cache, fourth run

Nothing to purge. Re-checked `apps/web/wrangler.jsonc` rather than assumed: the `exports`
block sits in the `preview` and `staging` env blocks only, so `demo` and `production` serve
uncached.

### Verification, live (2026-09-14, browser UA)

- `/products/procore-project-financials/integrations/viewpoint-vista` → **200 with
  `<meta name="robots" content="noindex">`**, zero occurrences of "AppXchange". The one App
  Xchange row.
- `/products/sage-300-cre/integrations/viewpoint-vista` → same, zero occurrences of "Aquifer".
- `/products/viewpoint-vista/integrations/unanet-crm-aec` → 200, **indexable**, no robots meta.
  The AECI-878 negative sentinel, asserted present in both orientations before and after.

The App Xchange pair page losing its delivered edge is the expected outcome. Its 4 claims now
sit on `reci5soEoFe0HPOfq` with no public surface, because AECI-716's reach render is unbuilt.
Same state as every retraction on this lane since AECI-852.

### Daily audit after this run

`pendingRetractions` **0**. Six of the seven stranded buckets **0**. The seventh,
`evidencedPairSourceGone`, still holds the same **2** Aquifer HeavyJob rows filed as
**AECI-916**. Exit **1** on those two and nothing else, which is the expected result.

**AECI-916's repair path closed during this batch and the audit cannot see that.** The upstream
half deleted both HeavyJob records as unpromoted rows, so there is no longer an upstream record
to delete into the journal — the "confirm upstream → journal → consumer" route those two were
waiting on no longer exists. They need a tool that reaches `connector_evidenced_pairs`
directly. The bucket will keep reporting them, unchanged, until that is built.

## Operator-ruling mode (`--ruling`, AECI-916)

**The journal cannot reach every stranded row, and this is the mode for the ones it cannot.**

A journal entry is written only when the deleted upstream record carried a
`supabase_integration_id`. If that pointer was never stored, deleting the record upstream
journals **nothing**. The live AECi row is then unreachable from both sides at once: no
upstream record claims it, and no feed entry names it. The daily strand audit's
`evidencedPairSourceGone` bucket can *see* such a row; until this mode existed, nothing in
the repo could remove it.

```bash
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production \
  --ruling scripts/ops/2026-09-retraction-consumer/rulings/aeci-916-heavyjob-aquifer.json
```

### The ruling file

JSON, and **committed** under `rulings/` — it is the ruling record. Everything else this lane
writes is gitignored; this is the exception, and the lane `.gitignore` says so, because the
file plus the `audit_log` rows are the only surviving account of why the rows went. It holds
uuids and prose, not row bodies, so it does not carry the catalog content the other artifacts
are ignored for.

| Field | Required | Meaning |
|---|---|---|
| `issue` | yes, `AECI-\d+` | the ticket; lands in `metadata.issue` and names the run |
| `reason` | yes, non-empty | the ruling in full prose, copied verbatim into every audit row |
| `rulingSource` | yes, non-empty | where the decision came from and how it was established |
| `noUpstreamRuling` | yes, **a real boolean** | `false` = an upstream ruling exists and just never reached the journal. `true` = nobody recorded one anywhere and the operator is making it (the AECI-795 shape) |
| `ids` | yes, non-empty uuids | the AECi row ids, de-duplicated case-insensitively |

`noUpstreamRuling` has **no default**, deliberately. `?? false` would be wrong in the one
direction that matters: it would silently claim an upstream ruling exists for a row whose
deletion nobody recorded, which is the exact assertion AECI-795 refused to make. A malformed
ruling file exits **2** (could not check), never 1.

### What stays, and the four things that differ

Everything: both tables on resolve **and** on verify, the `EXPECTED` shape pin, the
`MAX_CASCADE` ceiling with its per-pair proof, the `HOLD` list, the AECI-878 sentinel, one
`audit_log` row per deleted id, the `integration_count` repair with the `updated_at` bump, and
the timestamped rollback + preflight. The differences are all refusals:

1. **`confirm_retractions` is never called.** There is nothing upstream to acknowledge, so no
   write session is opened at all — the MCP token is read-only for the whole run.
   `verifyDeleted()` still runs and still has to pass; its token feeds the report rather than a
   confirm. There is still exactly one `confirmRetractions()` call site, now behind an `if`,
   and the function itself throws if handed a non-string entry id.
2. **A ruled id that resolves in neither table is a refusal**, not an `alreadyGone` bucket
   entry. In journal mode an absent row is ordinary — the feed records the past, and the row
   may already have been taken. A ruling is a statement about rows the operator measured just
   now, so an unresolvable id means the file was written against a state that has moved, or
   the id is wrong. Same reasoning as a `HOLD` entry missing from the plan, with more force:
   a stale hold merely fails to protect a row, while a stale ruling authorises a delete whose
   target the operator cannot see.
3. **`--ruling` with a non-empty journal is a refusal.** The two cohorts must never mix. The
   feed is still read in ruling mode purely to prove it is empty. Drain it with an ordinary
   run first — otherwise a ruling run would delete rows while entries were pending, leaving
   those entries un-confirmable against rows that no longer exist, and the next journal run
   would route them into `goneUnexplained`, clearable only by `--confirm-already-gone`, which
   is the one flag this mode forbids.
4. **`--ruling` with `--detect-only` or `--confirm-already-gone` is a refusal.** Both are
   journal verbs. Ignoring them silently would be worse: an operator who typed
   `--confirm-already-gone` believes something upstream is being acknowledged.

The audit `metadata` swaps its provenance block rather than thinning it. `retraction_journal`
would be a block of nulls, which reads like a *lost* record instead of an *absent* one, so
ruling mode writes `operator_ruling` (`issue`, `reason`, `ruling_source`, `ruling_file`) and
sets `metadata.source` to `operator-ruling`. Query that field to tell the two cohorts apart:

```sql
SELECT json_extract(metadata,'$.source'), COUNT(*) FROM audit_log
 WHERE json_extract(metadata,'$.tool') = 'scripts/ops/2026-09-retraction-consumer/consume.mjs'
 GROUP BY 1;
```

### This is not a licence to hand-rule a strand

The bar has not moved. `evidencedPairSourceGone` findings are still a curation judgement, and
the RUNBOOKS escalation path still applies: establish the ruling first, then execute it here.
What changed is only that executing it no longer requires raw SQL. AECI-916's ruling took an
hour of evidence-gathering across `promote_jobs`, `audit_log`, all 254 journal entries and two
upstream 404s before a single row was touched, and the one thing it could not establish is
recorded as an absence in the file rather than guessed at.

Use this mode when the journal route is **structurally closed** — no upstream record, no
journal entry. If the record still exists upstream, delete it there and let the journal carry
it; that path preserves the curator's own words, which is strictly better evidence than an
operator's reconstruction.

## What ran — 2026-09-14, 2 rows (AECI-916, the first ruling run)

The two Aquifer-powered HeavyJob evidenced pairs the AECI-897 two-table strand audit found on
its first production run. Both publicly reachable, both with zero cascade.

```
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production --ruling scripts/ops/2026-09-retraction-consumer/rulings/aeci-916-heavyjob-aquifer.json
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production --ruling scripts/ops/2026-09-retraction-consumer/rulings/aeci-916-heavyjob-aquifer.json --apply --allow-production --confirm-count 2
```

| | before | after | delta |
|---|---|---|---|
| `integrations` | 950 | 950 | 0 |
| `connector_evidenced_pairs` | 24 | 22 | −2 |
| `claims` | 1880 | 1880 | **0** |
| `attestations` | 1880 | 1880 | **0** |
| `claims` on `connector_pairs` (reach tier) | 202 | 202 | 0 — untouched |
| `audit_log` rows from this lane | 254 | 256 | +2 |
| feed, pending | 0 | 0 | 0 — **nothing confirmed, by design** |

`resolve: integrations 0, connector_evidenced_pairs 2, already gone 0`. Fourth run in a row
where nothing landed in `integrations`.

Time Travel bookmark captured immediately before the delete, expires ~2026-10-14:

```
wrangler d1 time-travel restore aeci-app-production --bookmark=0000586c-00000000-000050e6-2b1f1114778e945bd27e1d95cefccd3d
```

**4 products** had `integration_count` repaired and `updated_at` bumped:

| slug | before | after |
|---|---|---|
| `aquifer` | 36 | 34 |
| `heavyjob` | 17 | 15 |
| `procore-project-management` | 89 | 88 |
| `sage-300-cre` | 26 | 25 |

`db:reconcile-counts -- --fix` afterwards reported **no drift**, independently.

### Why the journal could never have carried these two

Established from evidence before the run, not inferred:

| Fact | Where it came from |
|---|---|
| Both rows created by one promote, `2026-09-09T07:46:32.644Z` | `audit_log` `connector_evidenced_pair.created`, `metadata.source: review-app-promote` |
| That job is HeavyJob's product promote | `promote_jobs.job_id = rec8tPLsT5ezww4L3-mttso2i2-5379ce2d` |
| They were the **only two** `operation: 'created'` rows in it | the stored job result: 23 integrations, 21 `updated`, 2 `created`, `skipped: []` |
| Their upstream record ids | `recG6U43cBIdH48zh` (→ Procore Project Management), `recmuxzxBjSnSG1LG` (→ Sage 300 CRE) |
| The ID map **was** served, with both ids in it | same job result |
| The pointer was never stored | 11 of the 13 evidenced pairs created that morning carry a journal entry; these 2 do not |
| Both upstream records now gone | `get_integration` → `Integration not found` on both |
| No journal entry names either id | all **254** entries read, pending *and* confirmed |
| No later HeavyJob promote ran | that job is the last of six for `rec8tPLsT5ezww4L3` |

So the sequence is: the promote created the rows and returned their ids, the write-back of
those two ids did not land, and AECI-889 batch 3 then deleted both upstream records — which
journalled nothing, because a journal entry needs the pointer. The 20 sibling Aquifer records
in that same batch *did* carry pointers, journalled, and were consumed hours earlier.

**Why the write-back did not land is not known, and is recorded as an absence.** The ruling
file says so in those words. The rows' own `notes` show they were materialised by the review
app's AECI-670 pair-surface lane on 2026-09-09, which is where to look if it recurs, but
nothing in either system says what failed, and no later promote gave it a second chance.
`no_upstream_ruling` is **false**: the upstream ruling exists — AECI-889's I24, the same one
applied to the 20 siblings — it simply never reached the journal.

### Algolia, fifth run

```
products      production_products        indexed 260   promoted 260    orphans 0
vendors       production_vendors         indexed 169   promoted 169    orphans 0
integrations  production_integrations    indexed 950   promoted 972    orphans 0
```

**Zero orphans** for the fifth time, same reason: evidenced pairs have never been indexed.
For AECI-880: drift is now **22 missing**, down from 24 — and 22 is again exactly the
surviving `connector_evidenced_pairs` count. The two numbers have tracked each other since the
batches 2 + 3 run and that is arithmetic, not a fix.

### Cache, fifth run

Nothing to purge. Re-checked `apps/web/wrangler.jsonc` rather than assumed: the `exports`
block sits in the `preview` and `staging` env blocks only (lines 109 and 176, under the blocks
opening at 85 and 155), so `demo` and `production` serve uncached.

### Verification, live (2026-09-14, browser UA)

- `/products/procore-project-management/integrations/heavyjob` → **200 with
  `<meta name="robots" content="noindex">`**, zero occurrences of "Aquifer".
- `/products/sage-300-cre/integrations/heavyjob` → same.
- `/products/viewpoint-vista/integrations/unanet-crm-aec` → 200, **indexable**, no robots meta.
  The AECI-878 negative sentinel, asserted present in both orientations before and after.

A retracted pair leaving a noindexed empty pair page rather than a 404 is the expected
outcome (AECI-795).

### Daily audit after this run

**Exit 0. Every bucket empty**, including `evidencedPairSourceGone` and `pendingRetractions`,
`orphanChildren` 0c / 0a, **0 publicly reachable stranded rows**, and edge reconciliation
**972/972 accounted** (950 integrations + 22 evidenced pairs). Catalogue at the time: upstream
1,543 products / 2,521 integrations (972 carry an id), prod 260 products / 169 vendors.

That is the first clean run since AECI-897 put `connector_evidenced_pairs` in scope.

### The guard, pinned and reset

| Constant | Pinned for this run | Now, in the file |
|---|---|---|
| `EXPECTED` | `{ total: 2, inPairs: 2, inIntegrations: 0 }` | `{ 0, 0, 0 }` |
| `MAX_CASCADE` | `{ claims: 0, attestations: 0 }` — **unchanged** | `{ 0, 0 }` |

`MAX_CASCADE` did not move, and that is the point of taking the cascade from the dry run: it
read `0 claims, 0 attestations`, which the resting ceiling of `0 / 0` already permits. A run
that needs no raise is the only kind that should not get one.

`EXPECTED` binds in ruling mode too, and it is not redundant with `--confirm-count`. The count
gate proves the operator knows how many rows the plan holds; the shape gate proves the rows
are in the **table** the ruling was measured against. A ruling written against two evidenced
pairs that had since become one pair and one `integrations` row would clear
`--confirm-count 2` and fail the shape gate, correctly.

## What ran — 2026-09-15, 1 row (AECI-957, Utopia CDE Sync ↔ Aconex)

One journal entry, `reckuwP85y3nVbMtm`, `supabaseId`
`b87dcde4-ad83-4f98-a108-f600293bac7b` — `Oracle Aconex (via Utopia Digital CDE Sync)`,
the Autodesk Construction Cloud ↔ Oracle Aconex edge retired under AECI-957 as not
shipped. Zero cascade.

```
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production --apply --allow-production --confirm-count 1
```

| | before | after | delta |
|---|---|---|---|
| `integrations` | 955 | 953 | −2, **only −1 of it ours** |
| `connector_evidenced_pairs` | 24 | 25 | +1, **none of it ours** |
| `claims` | 1911 | 1911 | 0 |
| `attestations` | 1911 | 1911 | 0 |
| `claims` on `connector_pairs` (reach tier) | 202 | 202 | 0 — untouched |
| `audit_log` rows from this lane | 256 | 257 | +1 |
| feed, pending | 1 | 0 | −1 |

**Two promotes landed inside the measurement window, so the raw table snapshots are not a
clean −1.** `review-app-promote` audit rows at `05:54:55Z` and `05:55:22Z` created 2 products,
1 integration, 3 claims and 13 attestations and moved one edge between the two delivered-tier
tables; this lane's delete ran at `05:55:44Z`. Our own effect is the single
`integration.deleted` audit row and `verify: integrations left 0, pairs left 0, orphan claims
0`. Read the lane's own numbers, not the table totals, when the catalogue is being promoted
underneath you — and take a fresh baseline immediately before the apply if you want the
totals to reconcile.

Time Travel bookmark captured immediately before the delete, expires ~2026-10-15:

```
wrangler d1 time-travel restore aeci-app-production --bookmark=000059ce-00000050-000050e7-e866380391bc9f819617791caac26693
```

**2 products** had `integration_count` repaired and `updated_at` bumped —
`autodesk-construction-cloud` (48 before) and `oracle-aconex` (13 before).
`db:reconcile-counts -- --fix` afterwards reported **no drift**, independently.

### The first cohort since AECI-878 to resolve in `integrations`

`resolve: integrations 1, connector_evidenced_pairs 0, already gone 0`. The four runs before
this one resolved entirely into `connector_evidenced_pairs`, because every one of them was a
connector-lane retraction and migration `0027` moved those edges out of `integrations`. This
row is a **native** edge that migration never touched, so it stayed put. That is why
`EXPECTED` was pinned `1 / 0 / 1` rather than `1 / 1 / 0`, and it is a direct demonstration
of why the shape gate is not redundant with `--confirm-count`: a count of 1 would have been
satisfied by either table.

### `MAX_CASCADE` did not move

The dry run read `0 claims, 0 attestations`, which the resting ceiling of `0 / 0` already
permits, so no raise was ruled on and none was made. Second run in a row where that is true.

| Constant | Pinned for this run | Now, in the file |
|---|---|---|
| `EXPECTED` | `{ total: 1, inPairs: 0, inIntegrations: 1 }` | `{ 0, 0, 0 }` |
| `MAX_CASCADE` | `{ claims: 0, attestations: 0 }` — **unchanged** | `{ 0, 0 }` |

### Algolia, sixth run — and the first orphan since 2026-09-13

```
products      production_products        indexed 265   promoted 265    orphans 0
vendors       production_vendors         indexed 171   promoted 171    orphans 0
integrations  production_integrations    indexed 964   promoted 978    orphans 1
```

**One orphan, and it is ours** — `b87dcde4-…`, removed with:

```
pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env production --apply --allow-production
```

The five runs before this one all reported **zero** orphans, and the reason was always the
same: evidenced pairs have never been indexed, so deleting one cannot orphan an index record.
This row was in `integrations`, which **is** indexed, so it did. **Expect an orphan whenever
the cohort resolves in `integrations`, and expect none when it resolves in pairs.** For
AECI-880: drift is **14 missing**, and it is no longer tracking the
`connector_evidenced_pairs` count, because the concurrent promotes moved both numbers.

### Cache, sixth run

Nothing to purge. Re-checked `apps/web/wrangler.jsonc` rather than assumed: the `exports`
block sits at lines 109 and 176, inside the `preview` and `staging` env blocks only (opening
at 85 and 155). `demo` and `production` have none, so they serve uncached.

### Verification, live (2026-09-15, browser UA)

- `/products/autodesk-construction-cloud/integrations/oracle-aconex` → **200 with
  `<meta name="robots" content="noindex">`**, zero occurrences of "Utopia".
- `/products/oracle-aconex/integrations/autodesk-construction-cloud` → same. Checked in
  **both** orientations, because the pair route renders either way round.
- `/products/viewpoint-vista/integrations/unanet-crm-aec` → 200, **indexable**, no robots
  meta. The AECI-878 negative sentinel, asserted present before and after.

### Daily audit after this run

**Exit 0. Every bucket empty**, `pendingRetractions` 0, `orphanChildren` 0c / 0a, **0 publicly
reachable stranded rows**, and edge reconciliation **978/978 accounted** (952 integrations +
26 evidenced pairs). Catalogue at the time: upstream 1,550 products / 2,524 integrations (978
carry an id), prod 265 products / 171 vendors.

## What ran — 2026-09-16, 3 rows (AECI-809, the Autodesk Construction Cloud → Forma merge)

The app-repo half of the ACC → Forma merge. Upstream re-pointed 80 ACC edges onto
[Autodesk Forma](https://review.aecintegrations.com/products/rec2KtJeJUzqih3ad), merged the 2
that collided with an existing Forma edge, deleted the ACC ↔ Forma self-edge, and journalled
all three deletes. This half deleted the three live AECi rows those entries name.

```
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production --apply --allow-production --confirm-count 3
```

| | before | after | delta |
|---|---|---|---|
| `integrations` | 953 | 950 | −3 |
| `connector_evidenced_pairs` | 26 | 26 | 0 |
| `claims` | 1914 | 1907 | −7 |
| `attestations` | 1914 | 1907 | −7 |
| `claims` on `connector_pairs` (reach tier) | 202 | 202 | 0 — untouched |
| `audit_log` rows from this lane | 257 | 260 | +3 |
| feed, pending | 3 | 0 | −3 |

**4 products** had `integration_count` repaired and `updated_at` bumped.
`db:reconcile-counts -- --fix` afterwards reported **no drift**, independently.

Time Travel bookmark captured immediately before the delete, expires ~2026-10-16:

```
wrangler d1 time-travel restore aeci-app-production --bookmark=00005b3b-00000012-000050e8-b34d221893bcf8664201b107f00f1ef2
```

### All 3 resolved in `integrations`, and this is the first cohort to be a MERGE

`resolve: integrations 3, connector_evidenced_pairs 0, already gone 0`. Second run in a row to
land wholly in `integrations`, for the same reason AECI-957 did: these are native edges that
migration `0027` never moved.

What is new is the cohort's *shape*. Every run before this one retired an edge outright. Two of
these three are **collision losers in a product merge** — the same integration continues to
exist, on the surviving product's edge — and the third is a self-edge that stops being
expressible at all once the two products become one.

| Journal entry | Row | What it was | Claims |
|---|---|---|--:|
| `recBK9YHVBZVcGnvE` | `62c896ec-346e-4b22-b244-fb5707c79e9c` | ACC ↔ ArcGIS, merged into Forma's edge | 2 |
| `recimXWYb5hu6c96h` | `c93f4e04-725e-4583-9af0-4401e14e9a77` | VIKTOR ↔ ACC, merged into Forma's edge | 2 |
| `recXjJ6KOIFBBeUbX` | `64da4f10-af1f-4841-9139-72a1dc692e51` | the ACC ↔ Forma self-edge | 3 |

### `MAX_CASCADE` moved to 7 / 7, and the proof is NOT the same for all three rows

The cascade was **7 claims and 7 attestations**. The ceiling had to be pinned at the plan
total, so `7 / 7` — but two of the three rows are proved superseded and the third is proved
**deleted by ruling**. Those are different arguments and this run needed both.

**The two merged rows: proved superseded, per pair, before the ceiling moved.** Each was joined
to the surviving Forma edge and the claims compared object by object and direction by
direction, not by count:

| deleted row | claims | surviving Forma edge | claims |
|---|--:|---|--:|
| `62c896ec` ACC ↔ ArcGIS | 2 | `f8affbc4-2053-49ce-9214-96a12082fc46` Forma ↔ ArcGIS | 2 |
| `c93f4e04` VIKTOR ↔ ACC | 2 | `c6a332f5-00dc-43a5-9478-39a0e2b3b2d8` VIKTOR ↔ Forma | 2 |

| pair | data object | deleted direction | surviving direction |
|---|---|---|---|
| ArcGIS | `documents` | `both` | `both` |
| ArcGIS | `models` | `both` | `both` |
| VIKTOR | `documents` | `both` | `both` |
| VIKTOR | `models` | `b_to_a` | `both` |

**One direction is not identical and it is a widening, not a loss.** The deleted VIKTOR row
claimed `models` as `b_to_a` (ACC → VIKTOR); the survivor claims it as `both`. `both` subsumes
`b_to_a`, so the assertion being deleted still stands on the survivor. Worth recording rather
than smoothing over: the merge made one claim broader than either input, which is an upstream
curation effect and not something this lane can see from counts alone. **Compare directions,
not just counts** — a 2 = 2 match would have hidden it.

**The self-edge: no counterpart, and none should exist.** `64da4f10` carried 3 claims
(`directory-contacts`, `documents`, `models`, all `both`). There is no surviving row holding
them, deliberately: the boundary those claims crossed was ACC ↔ Forma, and after the merge
there is no boundary. Chris ruled them **deleted as rename artifacts, not superseded**, on
AECI-809 (approval comment, 2026-09-15). **For that row the per-pair proof IS the ruling.**

That is the one case where "confirm every claim exists somewhere else" cannot be satisfied and
must not be faked. A self-edge between two records being merged has no post-merge home by
construction. The check that replaces it is narrower and has to be met exactly: the row is a
self-edge **of the merge itself**, and a named human ruled its claims away. Do not generalise
it to any row whose counterpart you failed to find.

| Constant | Pinned for this run | Now, in the file |
|---|---|---|
| `EXPECTED` | `{ total: 3, inPairs: 0, inIntegrations: 3 }` | `{ 0, 0, 0 }` |
| `MAX_CASCADE` | `{ claims: 7, attestations: 7 }` | `{ 0, 0 }` |

Both reset in the same change as the run that spent them, per the standing rule.

### Algolia, seventh run — 3 orphans, all ours

```
products      production_products        indexed 265   promoted 265    orphans 0
vendors       production_vendors         indexed 171   promoted 171    orphans 0
integrations  production_integrations    indexed 979   promoted 976    orphans 3
```

Removed with:

```
pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env production --apply --allow-production
```

Three orphans, one per deleted row, exactly as the AECI-957 rule predicts: **expect an orphan
whenever the cohort resolves in `integrations`, and expect none when it resolves in pairs.**
For AECI-880: drift closed to **0 missing** on this measurement, because `indexed 979` and
`promoted 976` reconcile once the 3 orphans go. That is the first zero this lane has recorded
and it is a measurement, not a fix — do not read it as AECI-880 being closed.

### Cache, seventh run

Nothing to purge. Re-checked `apps/web/wrangler.jsonc` rather than assumed: the `exports` block
sits at lines 109 and 176, inside the `preview` and `staging` env blocks only (opening at 85 and
155). `demo` and `production` have none, so they serve uncached.

### Verification, live (2026-09-16, browser UA)

- `/products/autodesk-forma/integrations/arcgis` → **200, indexable**, zero occurrences of
  "Construction Cloud". The survivor.
- `/products/viktor/integrations/autodesk-forma` → same.
- `/products/autodesk-construction-cloud/integrations/arcgis` → 200 + `noindex` at this point,
  then **404** after the product retraction below. See the finding.
- `/products/viewpoint-vista/integrations/unanet-crm-aec` → 200, **indexable**, no robots meta.
  The AECI-878 negative sentinel, asserted present before and after.

### Daily audit after this run

`pendingRetractions` **0**, `orphanChildren` 0c / 0a, seven of the eight buckets **0**. The
eighth, `productRejectedUpstream`, held **1** — the ACC product row itself, which is the second
run below. The sweep also warned that it could not read `recUSx3EmOX3YCb6G` (the MCP refuses a
`rejected` record), so that measurement is marked INCOMPLETE and was re-run after the
retraction. **A merge leaves the audit red between the two halves, and that is expected** —
consume first, retract the product second, re-run the audit last.

## What ran — 2026-09-18, 4 rows (AECI-1024, the first admission-test removals)

The app-repo half of the AECI-1024 owner re-triage. Chris's 2026-09-18 ruling (AECI-1020 /
AECI-1022) redefined `built_by_vendor_id` as the vendor that OWNS an integration, and added an
admission test ahead of it: an integration that is not offered to anyone who needs it is not a
catalog row. Upstream re-ruled the 14 AECI-1016 rows against both questions, re-owned 10, and
deleted 4 that failed admission, journalling all four.

```
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production --apply --allow-production --confirm-count 4
```

| | before | after | delta |
|---|---|---|---|
| `integrations` | 951 | 947 | −4 |
| `connector_evidenced_pairs` | 36 | 36 | 0 |
| `claims` | 1932 | 1929 | −3 |
| `attestations` | 1932 | 1929 | −3 |
| feed, pending | 4 | 0 | −4 |

**6 products** had `integration_count` repaired and `updated_at` bumped. `db:reconcile-counts`
afterwards reported **no drift**, independently. No Time Travel bookmark was captured by the
script; the timestamped `rollback-2026-09-18T03-53-13-533Z.sql` is the local rollback.

### All 4 resolved in `integrations`, all four were `integrator` rows

`resolve: integrations 4, connector_evidenced_pairs 0, already gone 0`. Every row carried
`mechanism_kind = 'integrator'` — the kind the retired R5 rule assigned to services firms.
After this run and the upstream re-kinding of the survivors, that kind may hold zero live
rows; it stays in the enum because removing it is a destructive recreate across six spellings
(AECI-735).

| Journal entry | Row | Edge | Ruled | Claims |
|---|---|---|---|--:|
| Skyway GeoSync | `1092051f-2ec7-49c4-8629-469f59127be6` | Smartsheet ↔ ArcGIS | not shipped | 1 (Inspections, both) |
| SYSTEC | `c9fcd5dc-c337-4ce1-b588-6ca1bd323415` | Smartsheet ↔ Oracle Primavera P6 | listing unpublished | 1 (Schedules, both) |
| Juiced | `2669ac24-d168-4a87-9084-4d28e9218c90` | Egnyte ↔ Quickbase, named "Quickbase (web)" | existing customers only after the Quickbase acquisition | 1 (Documents, both) |
| Optimum | `988df397-83de-433e-b1db-ac58e3597e93` | Bluebeam Revu → Smartsheet Takeoff & Estimation | a tailored build service | 0 |

### `MAX_CASCADE` moved to 3 / 3, by ruling and not by twin-count

Three rows carried one claim and one attestation each. Unlike the AECI-889 runs there is no
`connector_pairs` twin to compare against, and unlike two of the AECI-809 rows there is no
surviving edge to prove supersession against: these edges were ruled out of the catalog, so
nothing supersedes them by construction. That is the AECI-809 *self-edge* shape, and the proof
is the same kind — a named human's ruling that the claims go with the edge. Chris ruled it on
2026-09-18 in the session that ran this, after seeing the three claims listed. Do not
generalise: it applies to rows that fail the admission test, not to rows whose counterpart you
merely failed to find.

### The two guards, pinned and reset

`EXPECTED` was pinned to `4 / 0 / 4` and `MAX_CASCADE` to `3 / 3` for the run, and both are
reset to zero in this same change. `HOLD` was already empty and stayed empty.

### Algolia, eighth run — 4 orphans, all ours

```
products      production_products        indexed 278   promoted 278    orphans 0
vendors       production_vendors         indexed 187   promoted 187    orphans 0
integrations  production_integrations    indexed 987   promoted 983    orphans 4
```

The four orphan objectIDs were exactly the four deleted rows. Removed with:

```
pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env production --apply --allow-production
```

### Cache, eighth run

Nothing to purge. Re-checked `apps/web/wrangler.jsonc`: the `production` env block has no
`exports`, so it serves uncached.

### Verification, live (2026-09-18, browser UA)

- `/products/smartsheet/integrations/arcgis` → **200 + `noindex`**. The edge is gone and the
  pair page has nothing to render, which is the documented no-edge state, not a 404.
- `/api/vendors/skyway-consulting`, `juiced-technologies`, `optimum-consultancy-services`,
  `systec` → each now `product_count 0, integration_count 0`. Before the run the four read
  `integration_count 1`, because `integrations.built_by_vendor_id` still pointed at them.
- The AECI-878 sentinel read present before and after.

### Daily audit after this run — RED between the two halves, green after

`pendingRetractions` **0**, `orphanChildren` 0c / 0a, every stranded bucket **0** except
**`vendorNoLiveProducts 8`**, exit **1**. The eight are the AECI-1016 vendor rows that own
nothing after the re-triage: Availent, Juiced, Incture, Skyway, Cyberco, Rego, Optimum, SYSTEC.
All eight are live pages and in search. **They cannot come down through this lane today**: the
review app refuses to delete a vendor that is live in production, and the retraction journal
accepts only products and integrations, so there is no feed entry to consume. The route is a
decision on AECI-1024 (a vendor arm on the journal + this consumer, or a one-off `ops` delete by
id). Until it lands the audit stays red on this bucket, which is the right pressure — do not
add the eight to a hold list to make it green.

**Route chosen 2026-09-18 (AECI-1024): a one-off `ops` lane, not a journal arm.**
`pnpm --filter @aeci/api ops:retract-vendor` removes a vendor from a deployed D1 when, and only
when, it owns nothing — zero products and zero rows in **both** `integrations.built_by_vendor_id`
and `connector_evidenced_pairs.built_by_vendor_id`. There is no `--force`. It detaches `claims`,
`attestations` and `page_views`, deletes the vendor and writes one `audit_log` row
(`action = 'vendor.deleted'`) in the same batch, then de-indexes the `<env>_vendors` Algolia
object. `--apply` needs `--confirm-count N` matching the resolved plan, and one refusing vendor
refuses the whole run. Clearing the upstream `supabase_vendor_id` and deleting the review-app
record stays a separate manual step. That is what takes `vendorNoLiveProducts` to 0 for these
eight, by deleting them rather than by holding them.

## What ran — 2026-09-18, 6 rows then 1 (AECI-1020 cleanup window)

The app-repo half of the AECI-1020 cleanup window, run twice on the same day and recorded as
one entry. Upstream re-read the leftovers of the 18-window owner run against the 2026-09-18
admission test and deleted seven edges: six in the cleanup window itself, then Unanet ERP ↔
SAP S/4HANA, which that window deliberately left for a separate ruling. All seven were
journalled, so both cohorts came down this lane rather than through `--ruling`.

### Run 1 — the six cleanup-window rows

```
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production --apply --allow-production --confirm-count 6
```

| | before | after | delta |
|---|---|---|---|
| `integrations` | 942 | 936 | −6 |
| `connector_evidenced_pairs` | 43 | 43 | 0 |
| `claims` | 1931 | 1926 | −5 |
| `attestations` | 1931 | 1926 | −5 |
| feed, pending | 6 | 0 | −6 |

`resolve: integrations 6, connector_evidenced_pairs 0, already gone 0`. **10 products** had
`integration_count` repaired and `updated_at` bumped. `db:reconcile-counts` afterwards
reported **no drift**, independently. The local rollback is
`rollback-2026-09-18T09-45-40-373Z.sql`; no Time Travel bookmark was captured.

| Journal entry | Row | Edge | Ruled | Claims |
|---|---|---|---|--:|
| `rec9s72rPLVSrMwML` | `eb52264d-6d38-47e2-81eb-9b1172bb0bf6` | Illoca → Autodesk Revit, named "Autodesk Revit export" | roadmap, not shipped: illoca.com lists .rvt / .ifc export under "More features coming soon" | 2 |
| `recDn156ZVuieE6xK` | `9d43b9f4-883a-461e-a095-8e1c0349be8d` | InspectMind AI → Fieldwire, named "Fieldwire (manual)" | absent from inspectmind.ai/integrations/, the row's only cited source, and fieldwire.com never names InspectMind | 1 |
| `rec0xiv250p9cl4iL` | `6f55c08d-0793-411e-a20a-036633b6cc6b` | InspectMind AI → Smartsheet, named "Smartsheet (manual)" | absent from the same page; the only other source is a third-party directory describing a generic Excel handoff | 1 |
| `recSPFBDa0RMXsDEq` | `cb8f303e-0f62-43db-84f5-6a58130a741c` | Sage Intacct → AppFolio, named "AppFolio (manual)" | absent from AppFolio's integrations page and the Sage Intacct marketplace; `listing_url` is the bare marketplace root | 1 |
| `recIx2U8nCQOr12nV` | `75aac9e2-4183-4a96-97fc-0a818f5d17ff` | Tenderd ↔ Tableau | sole source is Tenderd's vendor-supplied Capterra profile; Tenderd's own /integration/ index is a "Coming Soon..." placeholder | 0 |
| `recHG4iVCBpQEfCBM` | `7ebb247a-76db-47f9-94f3-781f3271db1d` | Sage Intacct Real Estate ↔ Autodesk Forma | duplicate of `recahFmiH6BOIb2Zm`, which absorbed it under AECI-441; Real Estate is the lease/property module, the wrong endpoint | 0 |

### Run 2 — Unanet ERP ↔ SAP S/4HANA

Deleted upstream in its own AECI-881 writer slot, then consumed here.

```
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production --apply --allow-production --confirm-count 1
```

| | before | after | delta |
|---|---|---|---|
| `integrations` | 936 | 935 | −1 |
| `connector_evidenced_pairs` | 43 | 43 | 0 |
| `claims` | 1926 | 1925 | −1 |
| `attestations` | 1926 | 1925 | −1 |
| feed, pending | 1 | 0 | −1 |

`resolve: integrations 1, connector_evidenced_pairs 0, already gone 0`. **2 products** had
`integration_count` repaired. `db:reconcile-counts` reported **no drift**. Local rollback:
`rollback-2026-09-18T09-48-42-005Z.sql`.

| Journal entry | Row | Edge | Ruled | Claims |
|---|---|---|---|--:|
| `rec2NaxPUJwkF6d6v` | `269145b2-c52a-4dd1-904c-00701c960ded` | Unanet ERP ↔ SAP S/4HANA | fails admission: no Unanet page names SAP. The 2026-08-26 I5 finding read both first-party surfaces end to end and found zero occurrences of "SAP" | 1 |

### `MAX_CASCADE` moved on a ruling, and only for AECi-origin claims

Run 1 raised it to `5 / 5`, run 2 to `1 / 1`. Neither figure came from a twin-count. These
edges were ruled out of the catalog under the admission test, so nothing supersedes them by
construction — the AECI-809 self-edge / AECI-1024 shape. The authorisation is Chris Walton's
in-session ruling of 2026-09-18 and nothing else.

What was checked before each raise: every cascading claim reads `origin = 'aeci'` with an
`aeci`-source attestation and a NULL `attested_by_vendor_id`, so no vendor authored any of
them. The Unanet claim was read directly out of production before the guard moved. **Do not
generalise this.** It applies to rows that fail the admission test with no vendor authorship
behind their claims, not to a row whose counterpart you merely failed to find.

### The two guards, pinned and reset

`EXPECTED` was pinned to `6 / 0 / 6` and then `1 / 0 / 1`; `MAX_CASCADE` to `5 / 5` and then
`1 / 1`. Both are reset to zero in this same change. `HOLD` was already empty and stayed
empty.

### Algolia, ninth and tenth runs — 6 orphans then 1, all ours

```
products      production_products        indexed 282   promoted 282    orphans 0
vendors       production_vendors         indexed 185   promoted 185    orphans 0
integrations  production_integrations    indexed 985   promoted 979    orphans 6
```

The six orphan objectIDs were exactly the six deleted rows, and after run 2 the single
orphan was `269145b2-c52a-4dd1-904c-00701c960ded`. Both sweeps removed with:

```
pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env production --apply --allow-production
```

### Cache, both runs

Nothing to purge. Re-checked `apps/web/wrangler.jsonc`: the `production` env block still has
no `exports`, so it serves uncached.

### Verification, live (2026-09-18, browser UA)

- `/products/tenderd/integrations/tableau` → **200 + `noindex`**.
- `/products/inspectmind-ai/integrations/fieldwire` → **200 + `noindex`**.
- `/products/unanet-erp/integrations/sap-s-4hana` → **200 + `noindex`**.

All three are the documented no-edge state, not a 404. Product slugs were resolved from the
endpoint ids in the rollback file rather than guessed.

### Daily audit after these runs — RED, and not on this lane

`node scripts/ops/2026-09-stranded-row-audit/audit.mjs --env production --refresh-cache`,
exit **1**:

```
productRejectedUpstream            0
productDeletedUpstream             0
vendorNoLiveProducts               2
vendorSourceGone                   0
integrationSourceGone              0
integrationEndpointStranded        7
evidencedPairSourceGone            0
pendingRetractions                 0
orphanChildren                6c / 6a
```

**`pendingRetractions` is 0, so this lane is clean.** The red is a different cohort, and it
is not the AECI-1024 eight — those cleared. The two stranded vendors are **Bluebeam, Inc.**
(`6e8b3c88`) and **Graphisoft** (`e5f3b345`), both live and in search with zero live
products. The seven stranded edges all read `built_by vendor stranded` pointing at one of
those two:

| Row | Edge | Vendor |
|---|---|---|
| `93e4e165` | AutoCAD ↔ Bluebeam Revu ("Bluebeam Revu (manual)") | Bluebeam |
| `6c134332` | Microsoft SharePoint ↔ Bluebeam Revu | Bluebeam |
| `c2f77d3c` | Navisworks → Bluebeam Revu | Bluebeam |
| `4d967bbc` | Bluebeam Revu ↔ Microsoft Excel | Bluebeam |
| `024a5c21` | Egnyte ↔ Bluebeam Revu (Bluebeam-built) | Bluebeam |
| `10f65857` | Graphisoft Archicad ↔ Autodesk Revit | Graphisoft |
| `d8fea008` | Graphisoft Archicad ↔ Bluebeam Revu | Graphisoft |

`orphanChildren 6c / 6a` is derived from those seven rows, not from anything these runs
deleted — the consumer's own verify read `orphan claims 0` on both applies. The cohort needs
a ruling on AECI-1020; it cannot come down through this lane, because nothing about it is in
the retraction journal.

### The vendor half — Nemetschek Group (`ops:retract-vendor`)

**Why.** The AECI-1020 holding-company ruling moved Nemetschek Group's two live products,
Bluebeam Revu and Graphisoft Archicad, to their operating companies Bluebeam, Inc. and
Graphisoft, and re-pointed three owned edges with them. That left the holding-company vendor
row owning nothing, live, and in search, and it is what turned the daily audit's
`vendorNoLiveProducts` bucket red. Chris's standing rule is that a vendor with no products and
no edges is removed.

```
pnpm --filter @aeci/api ops:retract-vendor -- --env production --id 8c83a9d5-b6c4-4117-be00-a02eebf9fee6
pnpm --filter @aeci/api ops:retract-vendor -- --env production --id 8c83a9d5-b6c4-4117-be00-a02eebf9fee6 --apply --allow-production --confirm-count 1
```

Dry-run footprint, all six refusal counters zero:

| Counter | Rows |
|---|---|
| products (`product_vendors`) | 0 |
| integrations built | 0 |
| connector-evidenced pairs built | 0 |
| profiles attached | 0 |
| entitlements | 0 |
| seat invites | 0 |
| claims → `created_by_vendor_id` NULLed | 0 |
| attestations → `attested_by_vendor_id` NULLed | 0 |
| `page_views` → `vendor_id` NULLed | 48 |

**Result.** D1 reported 50 rows changed across 5 statements, with one `audit_log` row
(`action = 'vendor.deleted'`, `entity_id = 8c83a9d5-b6c4-4117-be00-a02eebf9fee6`) in the same
batch. Algolia removed `8c83a9d5-…` from `production_vendors`. The cache step printed its
manual command and had nothing to do, because production serves uncached.
`/api/vendors/nemetschek-group` now returns **404** to a browser User-Agent.

**Daily audit after this run.** `--refresh-cache` against production read every bucket **0** —
`productRejectedUpstream`, `productDeletedUpstream`, `vendorNoLiveProducts`, `vendorSourceGone`,
`integrationSourceGone`, `integrationEndpointStranded`, `evidencedPairSourceGone`,
`pendingRetractions`, and `orphanChildren 0c / 0a` — with 0 publicly reachable stranded rows and
exit **0**.

The review-side record still exists, still holds five unpromoted products (Allplan, Solibri,
Vectorworks Architect, Vectorworks Landmark, Verifi3D), and still carries a now-dead
`supabase_vendor_id`, because the review app's pointer-clear tool (AECI-1026) refuses while
product links remain — so the next promote of any of those five will take the AECI-568 stale-id
insert path and re-create the vendor here.

## What ran — 2026-09-21, 1 row (AECI-1020 leftovers, the ADP row)

**Why.** Chris Walton ruled on 2026-09-21 that ADP Workforce Now ↔ Sage 100 Contractor is
**withdrawn**. ADP Marketplace app 298612, "Sage 100 Contractor Connector for ADP Workforce
Now", returns ADP's 401 not-found page to both `curl` and Chrome, and is absent from
`apps.adp.com/sitemap.xml`, which lists 789 apps. The sibling Sage Intacct app 321819 returns
200 and is in that sitemap, so this is a delisting rather than a bot wall. Wayback holds no
snapshot. The only other evidence was a 2021 ADP Professional Services data sheet hosted on a
partner's site. Upstream deleted the record and journalled it, so the row came down this lane
rather than through `--ruling`.

```
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production
node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production --apply --allow-production --confirm-count 1
```

| | before | after | delta |
|---|---|---|---|
| `integrations` | 935 | 934 | −1 |
| `connector_evidenced_pairs` | 44 | 44 | 0 |
| `claims` | 1925 | 1923 | −2 |
| `attestations` | 1925 | 1923 | −2 |
| feed, pending | 1 | 0 | −1 |

`resolve: integrations 1, connector_evidenced_pairs 0, already gone 0`. Verify read
`integrations left 0, pairs left 0, orphan claims 0`, and confirm read `requested 1,
confirmed 1`. **2 products** had `integration_count` repaired and `updated_at` bumped —
ADP Workforce Now to 17 and Sage 100 Contractor to 18. `db:reconcile-counts` afterwards
reported **no drift**, independently. The local rollback is
`rollback-2026-09-21T02-08-17-845Z.sql`; no Time Travel bookmark was captured.

| Journal entry | Row | Edge | Ruled | Claims |
|---|---|---|---|--:|
| `recDwYDTIqG1sTyq9` | `9f7884dd-8ab6-403c-ba53-c6f1852d224a` | ADP Workforce Now ↔ Sage 100 Contractor, named "ADP Marketplace connector" | withdrawn: ADP Marketplace app 298612 is delisted — 401 not-found to browser and `curl`, absent from a sitemap that lists 789 apps, while the sibling Sage Intacct app resolves | 2 |

### `MAX_CASCADE` moved on a ruling, and only for AECi-origin claims

Raised to `2 / 2`. That figure did not come from a twin-count. The edge was ruled **withdrawn**
under the admission test, so nothing supersedes it by construction — the AECI-809 self-edge /
AECI-1024 shape. The authorisation is Chris Walton's in-session ruling of 2026-09-21 and
nothing else.

What was checked before the raise: both cascading claims were read directly out of production
before the guard moved, and both read `origin = 'aeci'` with a `source = 'aeci'` attestation
and a NULL `attested_by_vendor_id`, so no vendor authored either.

| Claim | Data object | Direction | Origin | Attestation source |
|---|---|---|---|---|
| `56b86ad6` | Time & Labor | `a_to_b` | `aeci` | `aeci` |
| `3e7bbcfb` | Directory & Contacts | `both` | `aeci` | `aeci` |

**Do not generalise this.** It applies to a row ruled withdrawn with no vendor authorship
behind its claims, not to a row whose counterpart you merely failed to find.

### The two guards, pinned and reset

`EXPECTED` was pinned to `1 / 0 / 1` and `MAX_CASCADE` to `2 / 2`. Both are reset to zero in
this same change. `HOLD` was already empty and stayed empty.

### Algolia, eleventh run — 1 orphan, ours

```
products      production_products        indexed 283   promoted 283    orphans 0
vendors       production_vendors         indexed 187   promoted 187    orphans 0
integrations  production_integrations    indexed 979   promoted 978    orphans 1
```

The single orphan objectID was `9f7884dd-8ab6-403c-ba53-c6f1852d224a`, the row just deleted.
Removed with:

```
pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env production --apply --allow-production
```

### Cache

Nothing to purge. Re-checked `apps/web/wrangler.jsonc`: the `production` env block still has
no `exports`, so it serves uncached.

### Verification, live (2026-09-21, browser UA)

- `/products/adp-workforce-now/integrations/sage-100-contractor` → **200 + `noindex`**.
- `/products/sage-100-contractor/integrations/adp-workforce-now` → **200 + `noindex`**.

Both are the documented no-edge state, not a 404, and the pair was checked in **both**
orientations. Product slugs were resolved from the endpoint ids in the rollback file rather
than guessed.

### Daily audit after this run — clean, exit 0

`node scripts/ops/2026-09-stranded-row-audit/audit.mjs --env production --refresh-cache`,
exit **0**:

```
productRejectedUpstream            0
productDeletedUpstream             0
vendorNoLiveProducts               0
vendorSourceGone                   0
integrationSourceGone              0
integrationEndpointStranded        0
evidencedPairSourceGone            0
pendingRetractions                 0
orphanChildren                0c / 0a
```

Every bucket zero, 0 publicly reachable stranded rows, 978/978 edges accounted. The
`vendorNoLiveProducts` red this run was warned about — BIMLauncher and ProjectReady, whose
connector products are not promoted yet — **did not appear**. That bucket reads 0.

## The second half — `ops:retract-product` for the ACC product row (AECI-809)

Run **after** the consumer, per the AECI-809 ruling. Footprint read first, nothing forced:

```
pnpm --filter @aeci/api ops:retract-product -- --id 463d5f20-a73a-4776-b26a-fcdf3818accd --env production
pnpm --filter @aeci/api ops:retract-product -- --id 463d5f20-a73a-4776-b26a-fcdf3818accd --env production --apply --allow-production
```

`integrations` 0, `claims` 0, `reviews` 0 — so no `--force`, which is the point of running the
consumer first. 126 rows removed across 12 statements (69 `page_views`, 1 `product_vendors`,
1 `product_categories`, 2 `product_audiences`, 4 `product_phases`, the product, and the
cascade). Algolia object removed from `production_products`. No cache purge: production is
uncached.

`/products/autodesk-construction-cloud` now **301s to `/products/autodesk-forma`** via
AECI-978's `slug_redirects`. Forma renders **Integrations (50)** — 47 in `integrations` plus 3
in `connector_evidenced_pairs`. **That is 50, not the 88 the upstream record holds**: 38 of
Forma's edges have an unpromoted counterpart and are dark. The strand audit then ran **clean,
exit 0**, every bucket 0, 976/976 edges accounted.

### The AECI-978 gate cannot be checked the way it reads

The instruction was to confirm `/products/autodesk-construction-cloud` already 301s before
retracting. **It cannot, and that is by design** — `slug_redirects` is read only after the
product lookup misses, so while the ACC row is live the URL serves the page. The equivalent
check, and the one AECI-809's own comment prescribes, is to exercise the map on a slug whose
row is already gone:

```
curl -sI https://www.aecintegrations.com/vendors/bluebeam
```

`301` → `/vendors/nemetschek-group` proves the table is populated and the resolver reads it.
The ACC seed row was also read directly out of `slug_redirects` before the retraction.

## FINDING — the pair-page 301s did not survive the merge, and 44 URLs now 404

**What is wrong.** Every `/products/autodesk-construction-cloud/integrations/*` URL returns
**404**. AECI-809's ruling assumed AECI-953's `integration_endpoint_moves` would 301 them for
free once the edges re-pointed onto Forma. It does not, and `integration_endpoint_moves` is
**empty** in production.

**Why it matters.** 44 edges moved — there are 44 `integration.endpoint_moved` audit rows dated
2026-09-15/16, so the mechanism fired correctly. These are indexed pair pages losing their
equity to a 404 rather than a 301, which is the exact loss AECI-953 exists to prevent.

**Two independent causes, and both have to be fixed:**

1. **The move rows cascade away with the retired product.**
   `integration_endpoint_moves.from_product_a_id` / `from_product_b_id` are
   `references(() => products.id, { onDelete: 'cascade' })`. The redirect is keyed on the
   product it points AWAY from, so deleting that product deletes the redirect. Retracting ACC
   took all 44 rows with it.
2. **Even surviving rows could not be read.** `resolveMovedPair()` takes
   `contextProduct: { id, slug }`, so the pair route has to resolve the old slug to a product
   **id** before the move lookup runs. Once the product row is gone there is no id, and the
   lookup is unreachable. `slug_redirects` is not consulted on the pair route.

**What to do.** Do not re-insert the 44 rows as they stand — the FK would reject them, ACC no
longer exists. The fix is a schema change (store slugs, or drop the cascade) plus a pair-route
read that can resolve a retired slug. The data is **fully recoverable**: all 44 audit rows carry
`before_state.productIds` and `after_state.productIds`.

**This fires on every merge-then-retire, not just this one.** The AECI-809 order — consume,
then retract the product last — is correct for the consumer and is exactly what triggers the
cascade. Filed separately; see the Linear issue linked from AECI-809.

## The order, and why it is not negotiable

Delete → verify → confirm. Always. (In ruling mode the third step does not exist, because
there is no journal entry to acknowledge — but the first two are unchanged and the verify is
still what gates the run to completion.)

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
was one row by hand in `scripts/ops/2026-09-roofr-qbo-connector-orphan/`. *(Since AECI-687,
2026-09-21, `retract-product.ts` does delete — and tombstone, in this consumer's
`integration.deleted` shape — the evidenced pairs of a product it retracts. Since AECI-904 that
takes `--delete-evidenced-pairs`; `--force` alone refuses them.
Per-pair retraction is still this consumer's job.)*

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
integration-class are parked before any of that — see "Why only those two tables". Ruling mode
adds four more, all listed under
[Operator-ruling mode](#operator-ruling-mode---ruling-aeci-916), and parks nothing: a ruled id
that is not in a delivered-tier table stops the run instead.

**`EXPECTED` and `MAX_CASCADE` read `0 / 0 / 0` and `0 / 0`, so the next run refuses until
you measure the cohort and re-pin them.** That is the design: an authorisation is spent by
the run that used it, and a second cohort must never inherit the first cohort's clearance —
including by matching its shape coincidentally. Raising `MAX_CASCADE` is the one edit in this
lane that can destroy data, so raise it only after confirming, by count, that every claim it
will cascade away already exists somewhere else. Reset both to zero in the same change as the
run that used them, exactly as you would empty a discharged `HOLD`.

Two things the batches 2 + 3 run learned about that measurement, both worth carrying forward.
**Take the cascade from the dry run against production, never from the upstream report** —
upstream said 0 and the real figure here was 4, because `reanchor_claims` moves the review
app's claims while the AECi delivered copies stay until this lane deletes them. And **run the
per-pair join over every row in the plan**, not only the rows you expect to carry claims:
filtering to those assumes the count you are checking.

Exit codes are `0` clean, `1` refusal, `2` could-not-check — and 2 outranks 1.

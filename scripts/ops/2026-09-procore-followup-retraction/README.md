# 2026-09 `procore-project-management → followup-crm` retraction (AECI-794)

**Status: RUN — complete.** Applied to `aeci-app-production` 2026-09-08T01:44:22Z, verified
live. Detection, ruling and execution all happened inside 24 hours, which is the first time
that has been true for a stranded row.

## What was removed

| | |
|---|---|
| `integrations` | `8f5365f9-b759-4605-8aab-b6aac352512d` — procore-project-management → followup-crm, `partner`, `direction: one-way`, `mechanism_name: NULL` |
| `claims` | 2 — Documents (`a_to_b`), Directory & Contacts (`a_to_b`) |
| `attestations` | 2 |
| `audit_log` | 1 written — `f4e73a75-b17a-4329-9be9-8d6ffd532124`, `action = integration.deleted` |

## Why it was stranded, and why the exit was DELETE

It is duplicate residue from a deliberate upstream merge, not an editorial retraction. Two
records existed; one was merged away under **AECI-699** because both cited the same evidence
page. The ruling is recorded on the **surviving** upstream record `rec1HRURkiFzAPUkn`:

> Merged the mirror row `rec4hd0vorc4G2ljN` (Procore Project Management → Followup CRM) into
> this one under AECI-699. Both rows cited the same evidence page,
> `marketplace.procore.com/apps/followup-crm` — **one artifact filed twice, not two.**
> Orientation kept as Followup CRM → Procore per I1: Followup CRM built and lists the app.
> Claim merge: Directory & Contacts and Documents widened `a_to_b` → `both`.

That record's `supabaseId` is `111ed9fc-5f1c-4041-8c83-05427dc35588`, the reverse-orientation
row still live in D1. So `8f5365f9-…` is the deleted mirror, and per
`docs/REVIEW_APP_PROMOTE_API.md` §5.1 no promote could ever have reached it again.

**The strand window was about eleven days, and it is measurable.** The mirror carries 9
`audit_log` rows: `integration.created` on 2026-07-25T15:43:40.949Z and promote-driven
`integration.updated` rows through **2026-08-27T06:48:35.338Z**. So the upstream record was
alive and being promoted until at least that date, and the merge deleted it afterwards.
Everything after that date was unreachable by any promote.

## Both guards tripped, and the issue predicted they would not

| Guard | Value |
|---|---|
| `claimsUniqueToOrphans` | **2** |
| `orphansWithoutATwin` | **1** |
| `orphansRicherThanTwin` | 0 |

AECI-794 was written expecting `orphansWithoutATwin` to read **0**, and treated that as the
evidence for the duplicate-residue reading. It reads 1.

**The guard is structurally incapable of confirming this case.** The datatool's twin test
matches on `(source_product_id, target_product_id, mechanism_name)`. It is orientation-blind,
so a reverse-orientation twin is invisible to it. This pair also disagrees on `mechanism_name`:

| Field | `8f5365f9-…` (deleted) | `111ed9fc-…` (kept) |
|---|---|---|
| Orientation | procore → followup-crm | followup-crm → procore |
| `mechanism_kind` | `partner` | `partner` |
| `mechanism_name` | `NULL` | `FollowUp CRM "Push to Procore"` |
| `direction` | `one-way` | `bidirectional` |
| `created_at` | 2026-07-25T15:43:40.949Z | 2026-07-25T15:43:40.949Z |
| description / notes length | 229 / 350 | 249 / 973 |
| claims | 2 | 4 |

`claimsUniqueToOrphans` reads 2 for the same reason plus an exact `direction` match, and
`a_to_b` is not `both`.

**So the content check the guard stands in for was done directly instead, and it passes.** The
mirror asserts Documents and Directory & Contacts `a_to_b`. The survivor asserts those same
two data objects as `both`, plus RFIs and Bids & Tenders. The mirror's claims are strictly
subsumed. Nothing was lost.

That is the AECI-699 merge note reproduced from D1 alone, with no reliance on the upstream
text — which is the strongest form this evidence can take, because the two sources are
independent. Both readings are in `preflight.json`.

**Read this as a note about the guards, not about the ruling.** `orphansWithoutATwin` answers
"is there another row with this exact shape". For a reverse-orientation duplicate the honest
answer is "the guard cannot tell", and it reports that as "no". A future operator meeting a
reverse-orientation pair should expect the same false positive and go to the claim data.

## What was run

`POST /api/prune-integrations` on the datatool is the exit `docs/REVIEW_APP_PROMOTE_API.md`
§5.1 prescribes. It is Cloudflare-Access-gated (or `TOOL_TOKEN`-bearer) and neither credential
is provisioned in an operator workspace, so this is the **second** consecutive retraction to
route around it (`apps/datatool/README.md`). It ran instead through `retract.mjs` here, a
transcription of `apps/datatool/src/prune-integrations.ts` (`prunePlan` + `pruneExecute`) over
`wrangler d1 execute --remote`. Divergence from that module is a bug here.

```
node scripts/ops/2026-09-procore-followup-retraction/retract.mjs --env production
node scripts/ops/2026-09-procore-followup-retraction/retract.mjs --env production --apply --allow-production
pnpm --filter @aeci/api ops:purge-algolia-orphans -- --env production \
  --ids integrations:8f5365f9-b759-4605-8aab-b6aac352512d --apply --allow-production
node scripts/ops/2026-09-stranded-row-audit/audit.mjs --env production
```

### Two deliberate improvements on the Polycam lane

1. **The `audit_log` row is written in the same `wrangler d1 execute` call as the delete,
   ahead of it.** Polycam wrote its two rows by hand afterwards, and its own README calls that
   weaker: "nothing forced it to exist, and it would simply be missing if the operator had
   forgotten." This follows the Bluebeam pattern
   (`scripts/ops/2026-09-bluebeam-vendor-retraction/apply.sql`) instead, which is the closest
   raw SQL gets to the `STAGE_1_SPEC.md` §26.1 in-batch invariant. It is still not the same
   thing: a single `--command` is not a `db.batch`, and D1 does not roll the statements back
   together. The real fix is the retract endpoint AECI-595 describes.
2. **The guards are enforced, not printed.** Polycam computed the three guards and then
   deleted regardless. Here the blocked set must equal `ACK_GUARDS` exactly, mirroring the
   datatool's `acknowledgeGuards` contract: naming a guard that reads zero proves the plan
   being acknowledged is not the plan that just ran, so the run refuses. If someone re-points
   this script at a different row, it stops.

### The audit insert was rehearsed first

`created_at` is `NOT NULL` with no SQL-level `DEFAULT` — `createdAt()` uses Drizzle's
`$defaultFn`, which never runs outside application code. A constraint failure inside a
multi-statement execution surfaces as an opaque `{"D1_RESET_DO":true}` with no statement and
no constraint name (the Bluebeam trap). So the exact generated INSERT was run against
`aeci-app-preview` with sentinel ids first, checked with `json_valid()` on both JSON columns,
and deleted again. Two minutes, and it removes the only failure mode that is hard to diagnose
after the fact.

## Count repair and the Algolia path

`integration_count` was repaired in the same run using the AECI-721 rule, which counts
delivered edges across **both** `integrations` and `connector_evidenced_pairs`:
**procore-project-management 96 → 95, followup-crm 14 → 13.** Stored equalled computed for
both products beforehand, so the delete is the only thing that moved them.

The datatool would have followed the prune with a clean Algolia reindex. A Node process has no
reindex path, so instead:

- the mirror's integration **object** was deleted from `production_integrations` by the
  targeted `ops:purge-algolia-orphans` run above (verified **404** on the write host, with the
  survivor still **200**);
- `retract.mjs` **bumps `products.updated_at`** on both products, putting them inside the
  08:00 incremental sync's watermark window so the corrected `integration_count` reaches their
  Algolia records. This is the step `reconcile-product-counts.ts` omits.

The bumped `updated_at` also moves each page's sitemap `<lastmod>`, which is correct.

**Do not reach for `db:reconcile-algolia-drift` here.** Its CLI builds the authoritative
integration id-set from `integrations` only (`apps/api/scripts/reconcile-algolia-drift.ts`),
while the Worker-side counterpart, `algolia-sync.ts` and the datatool reindex all include the
`connector_evidenced_pairs` arm. Run with `--apply` against production it would classify all
26 evidenced-pair records in `production_integrations` as orphans, and the safety cap is the
only thing standing in the way. The targeted `--ids` route has no such exposure.

### One thing in the purge output that looks alarming and is not

The purge run prints a wall of `⚠ EXTRA <uuid> — (no name)` warnings. That is not an orphan
claim. `runPurge` (`apps/api/src/lib/algolia-orphan-purge.ts:400`) runs generic search probes
after the delete and flags every hit **not in the `--ids` target list**, which for a targeted
single-object purge is every other object the probe returns. Spot-checked
`c8ab3edc-ca5e-490d-9a78-9c3f6dad316f`: it has a live `integrations` row. The warning is
completeness signalling for the AECI-267 bulk-sweep use case, and it is noise here.

## No cache purge was needed

`production` runs **uncached**. `apps/web/wrangler.jsonc` declares an `exports` block for
`preview` (L108) and `staging` (L175) only, not `demo` (L201) or `production` (L296), so there
is no native Workers Cache holding a stale render. The live response carries
`cache-control: private, no-store` with no `Cf-Cache-Status`, no `Age` and no `Cache-Tag`.
Verified by fetching all four affected URLs immediately after the delete and seeing the new
state. Same conclusion the Polycam run reached.

Had it been cached, the tags would have been
`pair:followup-crm__procore-project-management`, `product:procore-project-management` and
`product:followup-crm` (`followup-crm` sorts first, and the pair tag is orientation-independent).

## Verification (2026-09-08, prod)

- `/products/procore-project-management/integrations/followup-crm` — **200**, **one** Partner
  card, only `111ed9fc-…` present, still indexable. It rendered **two** Partner cards before.
- `/products/followup-crm/integrations/procore-project-management` — identical. Both
  orientations fixed by one delete, because the pair page is orientation-independent.
- `/products/followup-crm` — **Integrations (13)**.
- `/products/procore-project-management` — **Integrations (95)**.
- `sitemap.xml` — still carries the pair, at the canonical `followup-crm → …` orientation.
- `production_integrations` — `8f5365f9-…` **404**, `111ed9fc-…` **200**.
- D1 — 0 rows for the id, 0 orphan claims, survivor present with all 4 claims intact.
- `audit_log` — exactly one `integration.deleted` row for the entity, out of 9 total.
- `audit.mjs --env production` — `integrationSourceGone` is **1**, down from 2, and the id is
  gone. Publicly reachable stranded rows: **1**, down from 5. The audit still exits 1, which is
  correct: **AECI-795** (`microsoft-dynamics-365 → monday-com`) was the last one and its ruling
  was open at the time. It was **ruled and retracted later the same day**
  (`scripts/ops/2026-09-dynamics-monday-retraction/`), and the sweep has read clean and exited
  0 ever since.

**The pair page does not 404, and was never going to.** The survivor keeps the edge, so the
page stays fully populated. Even with no edge at all it would return 200 with a noindexed
empty state, which is what the AECI-593 run established.

## The retraction channel already exists upstream, and nothing here consumes it

Found while working this issue. The review-app MCP exposes **`list_retractions`** and
**`confirm_retractions`**. `list_retractions` describes itself as the retraction feed, carries
the `supabaseId` AECi needs, the record id and name as they stood, the curator's `reason`, and
`carrierProductIds` — "the products whose next promote could carry the retraction". It says it
is "the surface to poll on a schedule".

Neither tool is referenced anywhere in this repo: not in docs, not in `.mcp.json`, not in code.

**It is empty.** `list_retractions` with `include_confirmed: true` and no entity filter returns
0 entries, so it journals deletions going forward only. It could not have caught this strand,
and it did not catch AECI-795 either — the one row of the seven whose deletion is recorded
nowhere on either side.

That matters twice over. **AECI-595 is already Done** — it closed 2026-09-07 on the upstream
side shipping exactly this (review-repo PR #93). So the protocol question is settled and only
the AECi consumer is missing. And this is the right transport for **AECI-796**, whose current
script points at a decommissioned Airtable endpoint. Filed as **AECI-811**.

## Rollback

`rollback.sql` in this directory recreates all 5 rows parent → child with `INSERT OR IGNORE`
(`claims.anchor_id` stripped — it is a STORED generated column since AECI-721, and SQLite
refuses an INSERT that supplies it):

```
pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-production --env production --remote --file=../../scripts/ops/2026-09-procore-followup-retraction/rollback.sql
```

It restores rows, **not** `integration_count` — follow it with
`RECONCILE_ENV=production pnpm --filter @aeci/api db:reconcile-counts -- --fix --allow-production`.

Committed on purpose, but note what replaying it would actually achieve: it recreates the
**stranded** state, not curator control. The upstream mirror record `rec4hd0vorc4G2ljN` was
deleted deliberately, so restoring the D1 row would just re-create an unreachable duplicate.
If the merge itself ever needs undoing, that is an upstream decision first.

## Related

- **AECI-699** — the upstream merge that produced the residue.
- **AECI-593** / `scripts/ops/2026-09-polycam-retraction/` — the lane this forks, and the
  editorial-retraction shape this one is deliberately *not*.
- **AECI-595** — promote has no retract semantics. **Done**, on the upstream half shipping.
- **AECI-811** — the AECi consumer for that feed, which is the half that was never built.
- **AECI-796** — the daily strand audit that has never run. `list_retractions` is its transport.
- **AECI-795** / `scripts/ops/2026-09-dynamics-monday-retraction/` — the last stranded edge,
  retracted the same day. Both guards tripped there too, and there they were **true**: same
  guard sheet, opposite meaning.
- **AECI-712** — both rows carry the retired `partner` marker. The survivor is still in that
  backfill population, and the upstream note says re-keying it deliberately is AECI-712's job,
  not a dedupe side effect.
- `scripts/ops/2026-09-stranded-row-audit/` — the sweep that found it and confirmed it gone.

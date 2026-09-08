# 2026-09 `microsoft-dynamics-365 → monday-com` retraction (AECI-795)

**Status: RUN — complete.** Applied to `aeci-app-production` 2026-09-08T04:15:39Z, verified
live. This was the **last** stranded row from the AECI-767 sweep, and the sweep now exits **0**
for the first time since it was written.

## What was removed

| | |
|---|---|
| `integrations` | `2e6ad5bf-5590-4222-9710-23d43a625f12` — microsoft-dynamics-365 → monday-com, `monday.com (ipaas)`, `mechanism_kind: iPaaS`, `mechanism_name: Zapier connector`, `direction: bidirectional` |
| `claims` | 1 — Directory & Contacts (`both`, origin `aeci`) |
| `attestations` | 1 |
| `audit_log` | 1 written — `6272cc1d-d65c-43c1-9ac6-adbf72732941`, `action = integration.deleted` |

## Why it was stranded, and why the exit was DELETE

**Because nothing can defend it. No ruling exists on either side.** That is the whole point of
this row, and it is what makes it a different class from the two lanes before it:

| Lane | Where the ruling was recorded |
|---|---|
| AECI-593 (polycam) | A curator note on the product, `tool_integration_check_notes` + `research_notes` |
| AECI-794 (procore) | A merge note on the **surviving** upstream record |
| **AECI-795 (this one)** | **Nowhere.** An operator ruling taken after escalating |

There is no such edge upstream today — Microsoft Dynamics 365 has 14 integrations, none to
monday.com; monday.com has 49, none to Dynamics. But it *was* materialised: the 2026-07 D365
sweep note lists **monday** among what it seeded. It then vanished between two systems with no
trace on either side.

`docs/RUNBOOKS.md` prescribes exactly one exit for that shape — *"a `stray` with no recorded
ruling and no obvious curator action is a real unknown; do not delete to make the audit green.
Capture the ids and the affected pair pages, and raise it with whoever owns the catalog."* That
is what happened. The review app was asked directly on 2026-09-07 and recommended deletion:

> It has no upstream record and no defence; if the edge is real it should be re-materialised
> deliberately with current evidence, not adopted from a stranded row.

Adopting would mint an upstream record to justify a D1 row whose only evidence is that it
exists. The ruling is recorded on AECI-795 and in `ACK_REASON` in `retract.mjs`, and the audit
row carries `no_upstream_ruling: true` so the absence is queryable rather than merely narrated.

### The suspected cause, and why it is still not asserted

The row is a **per-pair Zapier tile on its own data**, not just by its `iPaaS` kind:

| Field | Value |
|---|---|
| `mechanism_name` | `Zapier connector` |
| `listing_url` | `https://zapier.com/apps/microsoft-dynamics-crm/integrations/monday` |
| `notes` | `sources=ipaas \| evidence=https://zapier.com/apps/microsoft-dynamics-crm/integrations/monday \| …` |
| attestation note | `ai_seed: Dynamics 365 CRM ↔ monday.com via Zapier …` |

That is precisely the shape the **AECI-700 / AECI-701** convention change replaces — one
`target=Zapier` edge instead of N auto-generated per-pair tiles. The review app raised the same
hypothesis and **explicitly declined to assert it**, because it cannot be proven from the data.
Neither does this lane. `preflight.json` and the audit row both carry it as
`suspectedCause.asserted: false` with the corroboration spelled out.

**Consistency is not causation, and the honest finding here is the absence, not the
hypothesis.** Recording the guess as a cause would manufacture exactly the ruling whose absence
makes this row worth pointing at.

**The strand window was about twelve days, and it is measurable.** `audit_log.entity_id`
carries no foreign key, so the row's promote history survives its own deletion — 9 rows now,
8 before: `integration.created` on 2026-07-25T15:45:54.139Z and seven promote-driven
`integration.updated` rows through **2026-08-27T09:48:19.054Z**. So the upstream record was
alive and being promoted until at least that date, and was removed afterwards.

**Worth noting, as an observation and not a claim:** AECI-794's mirror was last touched
**2026-08-27T06:48:35.338Z** — the same day, three hours earlier. Two rows, two different stated
causes, one window. Nothing records what happened that day.

## The guards tripped, and this time they were right

| Guard | Value |
|---|---|
| `claimsUniqueToOrphans` | **1** |
| `orphansWithoutATwin` | **1** |
| `orphansRicherThanTwin` | 0 |

Both tripped guards are **true** positives here, the mirror image of AECI-794 where both were
false. `orphansRicherThanTwin` needs a twin to JOIN against, so it reads 0 by construction.

That reading is still not the evidence. `orphansWithoutATwin` is orientation-blind and
`mechanism_name`-sensitive, so it cannot distinguish "only copy" from "reverse-orientation
duplicate" on its own (`apps/datatool/README.md`). So the direct check was run instead, and it
is the one recorded: **a query for any other `integrations` row whose two endpoints are
`microsoft-dynamics-365` and `monday-com`, in either orientation, returns 0 rows.** The guard
and the direct check agree. See `preflight.json`.

`retract.mjs` **refuses** if that query returns anything, rather than printing it and carrying
on. A twin that differs in orientation or in `mechanism_name` leaves `orphansWithoutATwin`
reading 1 exactly as it does here, so the exact-match `ACK_GUARDS` check would pass unchanged.
This is the only check that holds up `ACK_REASON`'s "there is no twin on this pair" and the
audit row's `twin: null`.

### The row this is NOT

The single most likely operator error on this issue is deleting the wrong `monday.com (ipaas)`.

| | Deleted | Kept |
|---|---|---|
| id | `2e6ad5bf-…` | `048952ee-15b8-4437-9146-df40061e9484` |
| pair | microsoft-dynamics-365 → monday-com | **adp-workforce-now → monday-com** |
| upstream record | none | `recgbcRYqUf2OvSZf`, also named `monday.com (ipaas)` |
| reachable by promote | no | yes |

The upstream record carrying that *name* points at `048952ee-…`, not at the deleted row. So
where AECI-794 asserted a **positive** sentinel (its reverse twin must survive), this lane
asserts a **negative** one: `048952ee-…` must still be present, still on the ADP pair, with its
claim count unchanged. `retract.mjs` refuses if it moves, and it was verified intact after the
run.

## What was run

`POST /api/prune-integrations` on the datatool is the exit `docs/REVIEW_APP_PROMOTE_API.md`
§5.1 prescribes. It is Cloudflare-Access-gated (or `TOOL_TOKEN`-bearer) and neither credential
is provisioned in an operator workspace, so this is the **third consecutive** retraction to
route around it (`apps/datatool/README.md`). It ran instead through `retract.mjs` here, a
transcription of `apps/datatool/src/prune-integrations.ts` (`prunePlan` + `pruneExecute`) over
`wrangler d1 execute --remote`. Divergence from that module is a bug here.

```
node scripts/ops/2026-09-dynamics-monday-retraction/retract.mjs --env production
node scripts/ops/2026-09-dynamics-monday-retraction/retract.mjs --env production --apply --allow-production
pnpm --filter @aeci/api ops:purge-algolia-orphans -- --env production \
  --ids integrations:2e6ad5bf-5590-4222-9710-23d43a625f12 --apply --allow-production
node scripts/ops/2026-09-stranded-row-audit/audit.mjs --env production --refresh-cache
```

Both AECI-794 improvements are kept: the `audit_log` INSERT runs in the **same**
`wrangler d1 execute` call as the DELETE, ahead of it, and `ACK_GUARDS` is **enforced** by
exact match rather than printed — the run refuses if the blocked set is not the acknowledged
set. This lane adds a third refusal: the direct both-orientations pair query must return
nothing, because a twin the guards are blind to would otherwise pass them. It is still not a
`db.batch`: a single `--command` does not roll its statements back together. The real fix is
the retract endpoint AECI-595 describes.

The audit insert was rehearsed against `aeci-app-preview` with sentinel ids before the
production run, `json_valid()` checked on both JSON columns, then deleted. `created_at` is
`NOT NULL` with no SQL-level `DEFAULT` — `createdAt()` uses Drizzle's `$defaultFn`, which never
runs outside application code — and a constraint failure inside a multi-statement execution
surfaces as an opaque `{"D1_RESET_DO":true}` with no statement and no constraint name.

## Count repair and the Algolia path

`integration_count` was repaired in the same run using the AECI-721 rule, which counts
delivered edges across **both** `integrations` and `connector_evidenced_pairs`:
**microsoft-dynamics-365 10 → 9, monday-com 16 → 15.**

`powered_by_product_id` was `NULL` on this row, and it would not have mattered either way:
`computeExpected` (`apps/api/src/lib/recompute-counts.ts`) counts `integrations` rows where the
product is source or target, plus `connector_evidenced_pairs` — never the edges a connector
powers. So only the two endpoints move, even for an `iPaaS` edge.

The datatool would have followed the prune with a clean Algolia reindex. A Node process has no
reindex path, so instead:

- the integration **object** was deleted from `production_integrations` by the targeted
  `ops:purge-algolia-orphans` run above (verified **404** on the write host, with `048952ee-…`
  still **200**);
- `retract.mjs` **bumps `products.updated_at`** on both products, putting them inside the 08:00
  incremental sync's watermark window so the corrected `integration_count` reaches their
  Algolia records. This is the step `reconcile-product-counts.ts` omits.

The bumped `updated_at` also moves each page's sitemap `<lastmod>`, which is correct.

**Do not reach for `db:reconcile-algolia-drift` here.** Its CLI builds the authoritative
integration id-set from `integrations` only, while `algolia-sync.ts` and the datatool reindex
include the `connector_evidenced_pairs` arm. Run with `--apply` against production it would
classify all 26 evidenced-pair records in `production_integrations` as orphans.

The purge run prints a wall of `⚠ EXTRA <uuid> — (no name)` warnings. That is not an orphan
claim: `runPurge` runs generic search probes after the delete and flags every hit not in the
`--ids` target list, which for a targeted single-object purge is every other object the probe
returns. Noise here, completeness signalling for the AECI-267 bulk-sweep case.

## No cache purge was needed

`production` runs **uncached**. `apps/web/wrangler.jsonc` declares an `exports` block for
`preview` and `staging` only, so there is no native Workers Cache holding a stale render.
Verified directly before the write: the live pair page carried `cache-control: private,
no-store` with no `Cf-Cache-Status`, no `Age` and no `Cache-Tag`. Same conclusion the Polycam
and Procore runs reached.

Had it been cached, the tags would have been `pair:microsoft-dynamics-365__monday-com`,
`product:microsoft-dynamics-365` and `product:monday-com` (`microsoft-` sorts before `monday-`,
and the pair tag is orientation-independent).

`stats_cache` home-page totals read one high until the next promote of any product runs
`refreshHomeStatsAfterPromote`. Harmless and self-healing — not chased.

## Verification (2026-09-08, prod)

- `/products/microsoft-dynamics-365/integrations/monday-com` — **200**, the "We don't have any
  integrations documented between these two products yet" empty state, and
  `<meta name="robots" content="noindex">`. It was indexable and rendered the edge before.
- `/products/monday-com/integrations/microsoft-dynamics-365` — identical. Both orientations
  fixed by one delete, because the pair page is orientation-independent.
- `/products/adp-workforce-now/integrations/monday-com` — unchanged, still renders
  `monday.com (ipaas)`, still indexable.
- `/products/microsoft-dynamics-365` — **Integrations (9)**, was 10.
- `/products/monday-com` — **Integrations (15)**, was 16, and still lists the ADP edge.
- `sitemap.xml` — **1472 → 1471** URLs; the target pair **absent**, the ADP pair still present.
- `production_integrations` — `2e6ad5bf-…` **404**, `048952ee-…` **200**.
- D1 — 0 rows for the id, 0 orphan claims, sentinel present. `audit_log` holds **9** rows for
  the entity (8 promote-era + the deletion), and exactly **1** `integration.deleted`, out of 4
  in production.
- `audit.mjs --env production` — **every bucket 0, publicly reachable stranded rows 0,
  `RESULT: clean`, exit 0.** First clean run since the sweep was written.

**The pair page does not 404, and was never going to.** `/products/{a}/integrations/{b}` exists
for any two promoted products, edge or not. The SEO outcome the retraction is for is achieved
by the noindex plus the sitemap drop, not by the URL disappearing. The AECI-795 issue body
carries a correction saying so; its later ruling comment still says "will 404" and is wrong on
that point alone.

## What this row costs, and why it is the argument for AECI-811

AECI-794 could be reconstructed after the fact because a curator wrote the merge down. **This
one could not.** The edge vanished between two systems and the only trace is a passing mention
in an unrelated sweep note. The review app's `list_retractions` feed — shipped under AECI-595,
consumed by nothing here, and **empty**, because it journals deletions going forward only —
could not have caught it either. When AECI-811 is sized, this is the row to point at: not the
ones with good notes, the one without.

## Rollback

`rollback.sql` in this directory recreates all 3 rows parent → child with `INSERT OR IGNORE`
(`claims.anchor_id` stripped — it is a STORED generated column since AECI-721, and SQLite
refuses an INSERT that supplies it):

```
pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-production --env production --remote --file=../../scripts/ops/2026-09-dynamics-monday-retraction/rollback.sql
```

It restores rows, **not** `integration_count` — follow it with
`RECONCILE_ENV=production pnpm --filter @aeci/api db:reconcile-counts -- --fix --allow-production`.

Committed on purpose, but note what replaying it would achieve: it recreates the **stranded**
state, and unlike AECI-794 there is not even an upstream record to point back at — no record
has ever carried this uuid. If the edge turns out to be real, re-materialise it upstream with
current evidence and promote it, rather than replaying this file.

## Related

- **AECI-767** / `scripts/ops/2026-09-stranded-row-audit/` — the sweep that found it, and which
  now runs clean.
- **AECI-794** / `scripts/ops/2026-09-procore-followup-retraction/` — the lane this forks.
  Duplicate residue with a written ruling; both guards were false positives there.
- **AECI-593** / `scripts/ops/2026-09-polycam-retraction/` — editorial retraction with a
  curator note.
- **AECI-700 / AECI-701** — the Zapier-convention change this row's shape matches. Suspected,
  never asserted.
- **AECI-595** — promote has no retract semantics. Done, on the upstream half shipping.
- **AECI-811** — the AECi consumer for that feed, which is the half that was never built.

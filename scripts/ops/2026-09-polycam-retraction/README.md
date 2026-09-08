# 2026-09 Polycam editorial retraction (AECI-593)

**Status: RUN — complete.** Applied to `aeci-app-production` 2026-09-07T07:11Z, verified
live. This is the execution half of AECI-593; PR #510 shipped the tooling half in August
and the data operation was held for a go-ahead that arrived four weeks later.

## What was removed

| | |
|---|---|
| `integrations` | `4dc9d4bb-494f-4735-8ebb-7cc5389048ce` — polycam → autocad, `native`, "DXF export (layered floor plan + point cloud)" |
| | `74099c42-e67a-4bab-9053-f6320b17e5ef` — polycam → arcgis, `native`, "Georeferenced LAS/LAZ export" |
| `claims` | 3 (2 on the AutoCAD edge, 1 on the ArcGIS edge) |
| `attestations` | 3 |

Both rows were minted by the same 2026-08-09T03:03:40.553Z Polycam promote as the
surviving `polycam ↔ sketchup` edge (`34a08c6e-…`), which was untouched.

## Why they were stranded, and why the exit was DELETE

A curator retracted both edges upstream ~5 minutes after that promote committed. Promote
has no delete semantics (`docs/REVIEW_APP_PROMOTE_API.md` §5.1), so the D1 rows stayed
live, indexed and un-addressable: no future promote could ever update or remove them.
Polycam was in fact **re-promoted on 2026-08-25** and both rows were still live on
2026-09-07 — the cleanest available demonstration that a re-promote does not heal a
retraction, and the evidence AECI-595 is sized on.

The ruling itself is recorded verbatim on the review app's Polycam record, in both
`tool_integration_check_notes` and `research_notes`:

> **INTEGRATION BAR — SETTLED 2026-08-09 (curator decision):** the bar is a PURPOSE-BUILT
> MECHANISM, not merely a documented product-specific data path. A manual file hand-off
> ("export a DXF, open it in X") is NOT an integration however well the vendor documents
> it. Applied consistently: Polycam↔AutoCAD and Polycam↔ArcGIS were created earlier that
> day and have been DELETED along with their 3 claims […]

That note also preserves the full evidence for both edges "for easy re-materialization if
the bar ever loosens", which is why adopting them back upstream would have re-litigated a
settled decision rather than restoring curator control.

## Both prune guards tripped, and were overridden deliberately

| Guard | Value |
|---|---|
| `claimsUniqueToOrphans` | 3 |
| `orphansWithoutATwin` | 2 |
| `orphansRicherThanTwin` | 0 |

Exactly what AECI-593 predicted in August, and exactly why the datatool's named-guard
acknowledgment (PR #510) was built. A tripped guard means "this is not a redundant copy"
— true here, and still not a reason to keep the rows: the content was editorially
retracted, and nothing else will ever remove it.

## Divergence from the brief: the pair pages do not 404

AECI-593 predicted the two pair pages would "begin 404ing". They don't — they return
**200 with the empty state** ("We don't have any integrations documented between these
two products yet"), `<meta name="robots" content="noindex">`, and they are **out of the
sitemap**. That is the Stage 1.5 product-PAIR page behaving as designed: the page exists
for any two promoted products, not only for pairs with an edge. The SEO outcome the issue
wanted (no indexable page asserting a retracted integration) is achieved by the noindex +
sitemap drop, not by a 404. Nothing to fix; the prediction was written before the pair
page's empty state was a thing.

## What was run

The prescribed exit is the datatool's `POST /api/prune-integrations` with
`acknowledgeGuards`. That endpoint is Cloudflare-Access-gated (or `TOOL_TOKEN`-bearer),
and neither credential is provisioned in an operator workspace — so it ran instead
through `retract.mjs` in this directory, which is a transcription of
`apps/datatool/src/prune-integrations.ts` (`prunePlan` + `pruneExecute`) driven over
`wrangler d1 execute --remote`. Divergence from that module is a bug here.

```
node scripts/ops/2026-09-polycam-retraction/retract.mjs --env production
node scripts/ops/2026-09-polycam-retraction/retract.mjs --env production --apply --allow-production
pnpm --filter @aeci/api ops:purge-algolia-orphans -- --env production \
  --ids integrations:4dc9d4bb-494f-4735-8ebb-7cc5389048ce,integrations:74099c42-e67a-4bab-9053-f6320b17e5ef \
  --apply --allow-production
node scripts/ops/2026-09-stranded-row-audit/audit.mjs --env production
```

plus the two hand-written `audit_log` inserts described below.

Like the 2026-08 orphan cleanup and the Roofr connector orphan, this went through raw SQL
rather than the API's `db.batch` + audit builders, so **no `audit_log` row was emitted in
the same batch** — the §26.1 invariant has no way to hold for a delete run from a laptop.

Unlike those two, the row was then **written by hand afterwards**, the AECI-685 workaround
and an explicit AECI-791 acceptance criterion. Two rows, one per integration:
`action = 'integration.deleted'`, `actor_type = 'system'`, `entity_type = 'integration'`,
`before_state` carrying the deleted row and its cascade counts, and `metadata` carrying the
issue, the operator, the tool, the acknowledged guards, the quoted ruling, and a pointer to
`rollback.sql`. Verified present as `7dd61c27-…` and `dc32acd9-…`.

An after-the-fact audit row is weaker than an in-batch one — nothing forced it to exist,
and it would simply be missing if the operator had forgotten. That is an argument for the
retract *endpoint* AECI-595 describes, not against writing the row.

This README, `rollback.sql`, the audit rows and the Linear issue together are the durable
record — the equivalent of the datatool's mandatory `acknowledgeReason`.

## Count repair and the Algolia path

`integration_count` was repaired in the same run, using the AECI-721 rule (delivered edges
across **both** `integrations` and `connector_evidenced_pairs`): **polycam 3 → 1,
autocad 12 → 11, arcgis 18 → 17**. The figures in the AECI-593 description (8→7, 14→13)
were stale — both products gained edges between August and the execution.

The datatool would have followed the prune with a clean Algolia reindex; a Node process
has no reindex path, so instead:

- the two integration **objects** were deleted from `production_integrations` by the
  targeted `ops:purge-algolia-orphans` run above (verified gone on the write host);
- `retract.mjs` **bumps `products.updated_at`** on the three affected products, putting
  them inside the 08:00 incremental sync's watermark window so the corrected
  `integration_count` reaches their Algolia records. This is the step
  `reconcile-product-counts.ts` omits — see the Roofr cleanup's "Known residue".

The bumped `updated_at` also moves each page's sitemap `<lastmod>`, which is correct: the
content genuinely changed.

**No cache purge was needed.** `production` runs uncached — it ships the WC-4
two-entrypoint code but declares no `exports` block (`apps/web/wrangler.jsonc`), so there
is no native Workers Cache holding a stale render. Verified by fetching all four Polycam
URLs immediately after the delete and seeing the new state.

## Verification (2026-09-07, prod)

- `/products/polycam` — **"Integrations (1)"**, SketchUp only.
- `/products/polycam/integrations/{autocad,arcgis}` — empty state, `noindex`.
- `/products/polycam/integrations/sketchup` — unchanged, still 200 with its edge.
- `sitemap.xml` — the only Polycam pair entry left is `…/integrations/sketchup`.
- `production_integrations` — both objectIDs verified absent.
- `audit_log` — two `integration.deleted` rows present (`7dd61c27-…`, `dc32acd9-…`).
- `scripts/ops/2026-09-stranded-row-audit/audit.mjs --env production` — both ids are gone
  from `integrationSourceGone`. The bucket still reads **2**, and that is the correct
  answer: the survivors are AECI-794 (`procore-project-management → followup-crm`) and
  AECI-795 (`microsoft-dynamics-365 → monday-com`), which are separate open rulings. The
  audit exits 1 until those are resolved. **Both were ruled and retracted the next day,
  2026-09-08** — AECI-794 at `scripts/ops/2026-09-procore-followup-retraction/` and
  AECI-795 at `scripts/ops/2026-09-dynamics-monday-retraction/`. The bucket went 2 → 1 → 0
  and the sweep now exits 0.

## Rollback

`rollback.sql` in this directory recreates all 8 rows parent → child with
`INSERT OR IGNORE` (`claims.anchor_id` stripped — it is a STORED generated column since
AECI-721, and SQLite refuses an INSERT that supplies it):

```
pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-production --env production --remote --file=../../scripts/ops/2026-09-polycam-retraction/rollback.sql
```

It restores rows, **not** `integration_count` — follow it with
`RECONCILE_ENV=production pnpm --filter @aeci/api db:reconcile-counts -- --fix --allow-production`.
Committed on purpose (the Roofr precedent): if the integration bar ever loosens, this file
plus the preserved upstream evidence is what re-materializes the two edges. Note that replaying it
would recreate the *stranded* state, not curator control — the upstream records would
still need recreating with these uuids in `supabase_integration_id`.

## Related

- **AECI-595** — the durable gap: promote has no retract semantics. This is its
  motivating instance and now its best-evidenced one.
- **AECI-796** — the daily strand audit that was supposed to catch this has never run
  (never credentialed, and its Airtable transport is decommissioned).
- **AECI-794** — same class, ruled DELETE and executed 2026-09-08
  (`scripts/ops/2026-09-procore-followup-retraction/`).
- **AECI-795** — the last stranded edge, ruled DELETE and executed 2026-09-08
  (`scripts/ops/2026-09-dynamics-monday-retraction/`). Same editorial shape as this lane,
  but with **no** curator note to cite — the ruling came from escalating.
- `scripts/ops/2026-08-promote-strand-audit/` — where the ruling was first recorded.
- `scripts/ops/2026-09-stranded-row-audit/` — the sweep that found the rows still live.

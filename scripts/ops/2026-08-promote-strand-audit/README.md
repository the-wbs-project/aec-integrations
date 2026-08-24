# 2026-08 promote strand audit

Cross-reference production D1 against the AEC Integrations Airtable base and report
every row on either side without a valid counterpart link (AECI-568).

**Read-only.** There is no `--apply` flag and no write path. Healing is a separate,
deliberate operator action — see [Healing](#healing).

## Why the link can break at all

Promote keys identity **solely** on the caller-supplied `supabaseId`
(`apps/api/src/routes/promote.ts` — "Present *and still resolvable* → update; absent →
create"). D1 stores no Airtable record id, by decision (AECI-562 was canceled: no
curation-tool key in the public schema). So the **only** link between the two sides is
the `supabase_*_id` column Airtable holds, and before AECI-563 made promote
asynchronous a timed-out push could commit on the AECi side while the response carrying
those ids was lost. See `docs/adr/0021-async-promote-ingest-via-workflows.md`.

## What each bucket means

| Bucket | Meaning | Why it matters |
|---|---|---|
| `stranded` | Airtable record looks promoted (`last_promoted_at` set, or `promotion_status` ∈ promoted/verified/retracted) but carries **no** id | The classic timeout strand: the commit landed, the ids were lost. The row is live and unreachable. |
| `stray` | A D1 row **no** Airtable record points at | Unreachable in the other direction: no future promote will ever update or delete it, and a re-promote of its product mints a duplicate. |
| `dangling` | An Airtable id whose D1 row is **gone** (retracted, pruned, deleted) | Airtable asserts a link that does not exist. Since AECI-568 the ingest falls back to CREATE rather than silently no-op-updating, so these self-heal on the next promote — but until then the pointer is a lie. |
| `duplicatePointers` | One D1 id claimed by **more than one** Airtable record | Two curation records fighting over one public row; the second promote silently overwrites the first. |
| `pendingJobMarkers` | A product row still carrying `promote_job_id` | An uncollected job. The hourly reconcile sweep (AECI-570) should have taken it; a persistent marker means the sweep is not running. |

### Claims are deliberately out of scope

`integration_claims` has a `supabase_claim_id` field, and **zero records carry one**.
That is not damage. The ingest replaces an integration's claims wholesale on every
promote — `db.delete(claims).where(eq(claims.integrationId, …))` then re-insert with
fresh `crypto.randomUUID()`s (`apps/api/src/routes/promote.ts`, §6.2) — so a
written-back `supabase_claim_id` is invalidated by the very next re-promote. Claim rows
are wholly owned by their integration and cannot be orphaned independently of it.
Auditing them would report all 915, every time. The write-back itself is dead weight;
tracked separately.

## Run it

```bash
# needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID + AIRTABLE_TOKEN
node scripts/ops/2026-08-promote-strand-audit/audit.mjs            # production
node scripts/ops/2026-08-promote-strand-audit/audit.mjs --json     # machine-readable
```

Exits **0** when every axis is clean, **1** when any mismatch is found, **2** on a
usage/credential error. Every run also writes
`report-<UTC>.json` next to the script with the full id lists — gitignored, because it
holds production catalog content. Use `--out <path>` to put it elsewhere.

`AIRTABLE_TOKEN` is **not** in this repo's `.dev.vars` — this repo has no Airtable
credentials at all. It lives in the review app
(`apps/review-app/.dev.vars` in `aec-integrations-review`), or mint a read-only PAT
scoped to `data.records:read` on the AEC Integrations base.

> **Only `--env production` is meaningful.** Airtable's `supabase_*_id` columns hold
> production uuids — there is one curation base, not one per tier — so pointing this at
> staging/demo/preview compares them against an unrelated seeded catalog and reports
> near-total mismatch. The script warns when you do.

### Runs daily in CI

`.github/workflows/promote-strand-audit.yml` runs this against production every day at
09:00 UTC (and on `workflow_dispatch`), so drift surfaces the next morning rather than at
the next manual audit — which is what AECI-593 needed: two editorially-retracted edges sat
live for four days because nothing was watching. The job **skips green** until the
`AIRTABLE_TOKEN` repo secret is set (the script hard-exits 2 without it, and a
red-on-arrival cron just teaches people to ignore the cron). It writes its report to
`$RUNNER_TEMP` and uploads nothing.

## Measurement — 2026-08-13, production

`aeci-app-production` vs base `appy81IdGJY6Fngf9`.

| Axis | D1 rows | Airtable pointers | stranded | stray | dangling | dup | pending |
|---|---|---|---|---|---|---|---|
| Products | 172 | 175 | **0** | **0** | **3** | 0 | 0 |
| Vendors | 127 | 127 | **0** | **0** | **0** | 0 | 0 |
| Integrations | 496 | 494 | — | **2** | **0** | 0 | — |

**The timeout bug did far less damage than feared: zero stranded products, zero
duplicate products, zero vendor drift.** Every one of the 172 D1 products is pointed at
by exactly one Airtable record, and no product carries a pending job marker.

### The 3 dangling product pointers

| Airtable record | Name | `promotion_status` | Dead `supabase_product_id` |
|---|---|---|---|
| `rec9SeNhtbNxclzWo` | Acumatica Connector by Agave | `rejected` | `ba5632b0-5cc1-4931-8368-efb7c54fe8d8` |
| `recQNfuGRQlg4e6z3` | Box | `rejected` | `226817bb-25d1-4d10-90fa-f346638df821` |
| `recv8jhHWhbg8B66i` | Cost+ by Smoothx | `rejected` | `e4f4ef8d-db47-4ec7-8cfd-b01775a50c7d` |

Residue of the reject→retract flow, **not** the timeout bug: each was promoted, later
rejected, retracted from D1, and its Airtable row kept the now-dead id. Healed on
2026-08-13 by clearing `supabase_product_id` + `supabase_slug` on all three (status left
at `rejected` — these products are intentionally not live).

### The 2 stray integrations — RESOLVED 2026-08-13 (AECI-593)

| D1 id | Pair | Mechanism | Created |
|---|---|---|---|
| `4dc9d4bb-494f-4735-8ebb-7cc5389048ce` | polycam → autocad | DXF export (layered floor plan + point cloud) | `2026-08-09T03:03:40.553Z` |
| `74099c42-e67a-4bab-9053-f6320b17e5ef` | polycam → arcgis | Georeferenced LAS/LAZ export | `2026-08-09T03:03:40.553Z` |

Both were created in the same promote as the surviving `polycam ↔ sketchup` row
(`34a08c6e-…`), which did get its id back.

**Cause: an editorial retraction, not the timeout bug.** The Airtable `Products` record
for Polycam (`rec48GUZjzwxczUui`) records the ruling in `research_notes` and
`tool_integration_check_notes`: on 2026-08-09, minutes after this promote committed, a
curator settled the integration bar as a **purpose-built mechanism** — a manual file
hand-off ("export a DXF, open it in X") is not an integration however well the vendor
documents it — and **deleted both Airtable records plus their 3 claims**, leaving SketchUp
(first-party extension) and Xactimate (paid ESX export) as Polycam's only edges. The base
corroborates it on every axis: only those two records survive, the AutoCAD record id named
in the D1 `notes` (`recx2Fe7vQTmi0Rv2`) is gone, the 3 claims are gone from
`integration_claims`, and no Polycam↔Revit record was added. Full evidence for both removed
edges is preserved verbatim in `tool_integration_check_notes` for re-materialization if the
bar ever loosens.

A partial write-back was the original hypothesis and is **not** needed to explain this.
Deleting an Airtable record strands its D1 row whether or not the id was ever written back,
because promote has no delete semantics. Whether these two ids reached Airtable is now
unfalsifiable — the records are gone.

**Exit: DELETE** — honoring the ruling. Both guards trip (`orphansWithoutATwin: 2`,
`claimsUniqueToOrphans: 3`; `orphansRicherThanTwin: 0`, since a no-twin row has nothing to
compare against), so the retraction goes through the datatool prune with **both**
acknowledged by name — see §Healing below. Footprint: 2 integrations + 3 claims + 3
attestations; `integration_count` repairs to polycam 1, autocad 7, arcgis 13. Two live
indexable pair pages (`/products/{arcgis,autocad}/integrations/polycam`) begin 404ing and
drop out of the sitemap, which is correct — the content is retracted.

> **Status: decided, not yet executed.** Update this section and add a Measurement row once
> the production prune has run and the audit reports `Integrations → stray: 0`.

> **The generalizable lesson.** These rows were not duplicate residue and the guards were
> right to refuse them — but the exit was still a delete. A tripped guard means "not a
> redundant copy", which is a reason to *stop and check*, not proof that the row must
> survive. Look for a recorded editorial ruling before assuming either.

## Healing

The audit never writes. Once it reports a mismatch:

- **`dangling`** — clear `supabase_product_id` + `supabase_slug` on the Airtable record
  (via the Airtable MCP or the review app). Do **not** invent a replacement id. Since
  AECI-568 a re-promote with a dead id also self-heals by creating a fresh row and
  returning the new id, so clearing is belt-and-braces for records that will not be
  re-promoted soon.
- **`stranded`** — recover the public uuid into Airtable (match by slug/name against the
  D1 row), then re-promote through the normal playbook. The push goes out with the
  recovered `supabaseId`, so it must come back **`updated`**, not `created` — that is
  the convergence check.
- **`stray`** — a curation judgment, never a mechanical delete. Decide from the
  **content**, and check the product's Airtable `research_notes` /
  `tool_integration_check_notes` first: a curator who retracted an edge on purpose usually
  said so there. Then either recreate the Airtable record and write the existing uuid into
  `supabase_*_id` (**adopt**), or delete the D1 row via the datatool's
  `POST /api/prune-integrations` (guards, ordered delete, rollback SQL, count repair,
  reindex — see `apps/datatool/README.md`).

  A tripped guard means it is **not** redundant residue — so stop and find the ruling
  rather than reaching for the override. If a ruling *does* exist (as in AECI-593), pass
  `acknowledgeGuards` naming **exactly** the guards the dry run reported, plus an
  `acknowledgeReason` citing it; the prune writes no `audit_log` row, so that reason and
  the operator identity in the Workers log line are the only record. Save `rollbackSql`
  first. Without a ruling, escalate — never override to make a red audit go green.
- **`duplicatePointers`** — merge per the AECI-403 pattern: keep the richer record,
  re-point edges, delete the duplicate, re-promote.
- **`pendingJobMarkers`** — never clear the marker by hand; it is the recovery handle.
  Collect the job (`get_promote_status` in the review app) and let collect clear it.

Re-run the audit after any heal. `dangling: 0` / `stranded: 0` is the convergence proof.

## Related

- `docs/REVIEW_APP_PROMOTE_API.md` — the promote contract, including the async
  kick-off/poll/collect protocol and the upsert rule this audit tests.
- `docs/adr/0021-async-promote-ingest-via-workflows.md` — why promote went async.
- `scripts/ops/2026-08-orphan-integration-cleanup/` — the earlier, larger stray-integration
  sweep (22 rows, run; all confirmed absent from production on 2026-08-13).
- `apps/datatool/README.md` — the Access-gated Worker that owns the dangerous half of a
  prune (guards + rollback + count repair + reindex), including the `acknowledgeGuards`
  override contract.
- `.github/workflows/promote-strand-audit.yml` — the daily scheduled run of this script.
- `docs/REVIEW_APP_PROMOTE_API.md` §5 — why promote has no delete semantics, and what a
  curator must do after deleting a curated integration record.

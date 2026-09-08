# 2026-08 promote strand audit — SUPERSEDED, HISTORY ONLY

> **This lane no longer exists as a runnable thing. `audit.mjs` was deleted on 2026-09-08
> (AECI-796); this file is kept for its §Healing recipes and its 2026-08-13 measurement.**
>
> It read `api.airtable.com/v0/appy81IdGJY6Fngf9` directly. The review app has since moved
> off Airtable onto its own D1, so that base is decommissioned and the script pointed at
> nothing. **Do not look for an `AIRTABLE_TOKEN` and do not mint an Airtable PAT** — the
> instructions that used to be in this file asking you to are gone for that reason, not
> because the credential was hard to get. There is nothing to authenticate against.
>
> **The live detector is `scripts/ops/2026-09-stranded-row-audit/`**, which asks the same
> question of the same catalog over the review app's MCP with `AECI_MCP_TOKEN`, and sub-
> classifies a missing claim as *deleted* vs *rejected* upstream. Since AECI-796 it is also
> what `.github/workflows/promote-strand-audit.yml` runs daily at 09:00 UTC.
>
> **Two cautions when reading below.** Its bucket names (`stray`, `dangling`, `stranded`,
> `duplicatePointers`, `pendingJobMarkers`) are **this lane's**, not the successor's — the
> live six are listed in the successor's README and in `docs/RUNBOOKS.md`. And its Airtable
> vocabulary ("the Airtable record", "the base") is systematically stale across every promote
> doc; AECI-797 owns that sweep. The *reasoning* in §Healing survives both, which is why it
> is still linked from `docs/RUNBOOKS.md` and three sibling ops lanes.

Cross-referenced production D1 against the AEC Integrations Airtable base and reported
every row on either side without a valid counterpart link (AECI-568).

**Was read-only.** There was no `--apply` flag and no write path. Healing is a separate,
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
That is not damage — though the reason has changed since this was written. The ingest
**used to** replace an integration's claims wholesale on every promote (delete-by-
integration, then re-insert with fresh `crypto.randomUUID()`s), which invalidated any
written-back `supabase_claim_id` on the very next re-promote. Since AECI-604 that is no
longer the mechanism: `apps/api/src/lib/promote-claims.ts` matches on the
`(integration_id, data_object_id, direction)` identity triple and **reuses** the row, so
claim ids are now stable.

The conclusion is unaffected. Claim rows are wholly owned by their integration —
`claims.integration_id` and `attestations.claim_id` both cascade — and cannot be
orphaned independently of it, so auditing them as their own axis would report all of
them, every time. `scripts/ops/2026-09-stranded-row-audit/` reports them as **cascade
weight** on a stranded integration instead, which is the form the number is useful in.
The write-back itself is dead weight; tracked separately.

## How to run it — you can't, and that is the point

`audit.mjs` was deleted on 2026-09-08. The run instructions and the "mint a read-only
Airtable PAT scoped to `data.records:read`" line that used to sit here were removed with it,
so that nobody follows a recipe for authenticating against a system that is gone.

**Run this instead:**

```bash
AECI_MCP_TOKEN=<token> CLOUDFLARE_API_TOKEN=<token> \
  node scripts/ops/2026-09-stranded-row-audit/audit.mjs --env production --refresh-cache
```

### The lesson this lane paid for

Worth keeping even though the code is gone, because it cost four weeks of live retracted
rows and it is the reason the successor workflow has no skip branch.

This lane shipped with a daily CI job — `.github/workflows/promote-strand-audit.yml`, the
same file, since re-pointed — that **skipped green** when `AIRTABLE_TOKEN` was absent. The
reasoning was defensible in isolation: the script hard-exits 2 without the credential, and a
red-on-arrival cron teaches people to ignore the cron. The secret was then never added.

All **25** scheduled runs between 2026-08-13 and 2026-09-06 reported `success` having
audited nothing (verified on run `34033166656`). AECI-593's two Polycam edges were supposed
to be caught by this job the next morning. They stayed live and indexed for four weeks under
an issue marked Done, and that issue's own Verify step — *"the audit returns `stray: 0`"* —
could never have passed **or** failed. They were eventually found by a human running a
script by hand.

Underneath the skip branch, the audit had *also* gone obsolete: the review app moved off
Airtable, so adding the secret would have turned 25 green runs into 25 red ones rather than
25 real audits. That is almost certainly why "just add the secret" never happened.

**Two things came out of it (AECI-796), and both are now enforced elsewhere:**

1. A guard that cannot fail is not a guard. The successor exits **2** on a missing
   credential and goes red. "Unchecked" is not "clean" — the same 1-vs-2 line
   `scripts/ci/posthog-liveness-sweep.sh` draws.
2. A green run has to prove it ran. The successor prints its per-bucket counts and its
   upstream/prod totals on every run, including the clean one.

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

### The 2 stray integrations — DECIDED 2026-08-13, RETRACTED 2026-09-07 (AECI-593)

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

> **Status: EXECUTED 2026-09-07.** For four weeks this section read "decided, not yet
> executed": PR #510 shipped the *tooling* (the datatool named-guard acknowledgment and the
> daily workflow) in August, the issue read as Done, and the prune itself was never
> performed — the AECI-767 sweep found both rows still live, indexed and rendering four
> weeks later, and a 2026-08-25 re-promote of Polycam had not healed them (it cannot; §5.1).
> Both rows, their 3 claims and 3 attestations were deleted from `aeci-app-production` on
> 2026-09-07, `integration_count` repaired (polycam 3→1, autocad 12→11, arcgis 18→17) and
> the two Algolia objects removed. Full record, including why the pair pages return a
> noindexed empty state rather than the 404 this section predicted:
> `scripts/ops/2026-09-polycam-retraction/README.md`.

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

  A tripped guard means "stop and find the ruling" — but it does **not** reliably mean
  "not redundant residue". `orphansWithoutATwin` matches on `(source, target,
  mechanism_name)`, so it is blind to a **reverse-orientation** twin and to an unequal
  `mechanism_name`; `claimsUniqueToOrphans` inherits that and adds an exact `direction`
  match. AECI-794 tripped both on a row that was redundant residue
  (`scripts/ops/2026-09-procore-followup-retraction/`). Go to the claim data and the
  surviving sibling's notes, not to the guard sheet. If a ruling *does* exist (as in
  AECI-593 and AECI-794), pass
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
- `scripts/ops/2026-09-stranded-row-audit/` — the **successor** sweep (AECI-767), and
  since AECI-796 the lane the daily workflow actually runs. This audit was meant to detect
  the drift cheaply and daily; it never ran and its transport is dead. It
  reaches the same catalog over the review-app MCP instead of Airtable, sub-classifies a
  missing claim as **deleted** vs **rejected** upstream (`find_product` with
  `include_rejected` is the only read that can see a rejected record), walks the
  transitive damage into claims and attestations, and reports public reachability and the
  retraction cascade per row. Measured 2026-09-07: 0 stranded products, 1 vendor,
  6 integrations.
- `scripts/ops/2026-08-orphan-integration-cleanup/` — the earlier, larger stray-integration
  sweep (22 rows, run; all confirmed absent from production on 2026-08-13).
- `apps/datatool/README.md` — the Access-gated Worker that owns the dangerous half of a
  prune (guards + rollback + count repair + reindex), including the `acknowledgeGuards`
  override contract.
- `.github/workflows/promote-strand-audit.yml` — the daily 09:00 UTC job. It used to run
  this script; since AECI-796 it runs the successor over `AECI_MCP_TOKEN`, with no
  skip-green branch. Its header carries the full contract.
- `docs/REVIEW_APP_PROMOTE_API.md` §5 — why promote has no delete semantics, and what a
  curator must do after deleting a curated integration record.

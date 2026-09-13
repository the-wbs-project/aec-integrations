# ADR 0029: The curation store is the review app's own D1, not Airtable

**Status:** Accepted
**Date:** 2026-09-13 (recording an upstream change that cut over **2026-08-25**)
**Context owner:** chrisw@thewbsproject.com
**Issue:** AECI-797
**Upstream change:** `aec-integrations-review` PR **#73**, Linear **AECI-655**, commit `3d9ea0f`

---

## Context

AECi's catalog is curated upstream in the **review app** (`aec-integrations-review`) and pushed
into this repo's Cloudflare D1 one-way, via `POST /api/promote` (`docs/REVIEW_APP_PROMOTE_API.md`).
For the first year of the project that review app stored its catalog in an **Airtable base**,
`appy81IdGJY6Fngf9`. Every doc in this repo that described where curated data comes from said so.

On **2026-08-25** the review app migrated off Airtable onto **its own Cloudflare D1** — database
`aeci-review`, binding `DB`, schema in Drizzle at their `server/db/schema.ts`. The narrative record
is their `docs/migrations/README.md` (every table, row count, disposition, the three archived
tables and the 59 columns left behind); the pre-cutover base is archived at their
`docs/migrations/airtable-base-archive-2026-08-25.tar.gz`.

**Nothing in this repo recorded that**, for two and a half weeks, and the cost was real:

1. Roughly 47 present-tense statements across our docs described Airtable as the live curation
   store — including the promote contract that `spec-anchor` sends every promote task to, the
   operator runbook, and two vocabulary-change procedures.
2. **AECI-796's first diagnosis was wrong because of it.** The daily promote-strand audit was
   failing to run, and the obvious reading — "provision the missing `AIRTABLE_TOKEN` PAT" — was
   wrong twice over: the secret had never existed, *and* the base it would have authenticated
   against was decommissioned. The audit had to be re-pointed at the review app over MCP instead.
3. The `rec…` id format survived the migration, so the single strongest visual cue in the data
   still says "Airtable" to anyone who has not been told otherwise.

This ADR exists because the change happened in a sibling repo and therefore left no trace in ours.
Without it, the next person to read a `rec…` id re-derives the wrong conclusion.

## Decision

**The curation store is the review app's own Cloudflare D1.** Airtable is not in the catalog path
at all — not as a source, not as a mirror, not as a fallback.

**Upstream record ids keep the `rec…` format, and that is not evidence of Airtable.** They are the
review app's own D1 ids, minted by their `server/db/ids.ts`, which kept Airtable's shape
deliberately so that ids already persisted on both sides stayed valid across the cutover. This repo
mirrors the note at `apps/api/src/db/schema.ts` (the connector-lane primary keys) — those keys are
the review app's own ids, which merely keep Airtable's format.

**"Airtable is retired" is true of the catalog, not absolutely.** A marketing **Outreach tracker**
(48 rows) still lives in base `appy81IdGJY6Fngf9`. **No deployed code reads it**, nothing in this
repo touches it, and it is out of scope for this repo's docs. Do not write "Airtable is gone."

## Consequences

- **No Airtable credential is required anywhere in this repo.** `AIRTABLE_TOKEN` was retired by
  AECI-796 and `AIRTABLE_PAT` / `AIRTABLE_BASE_ID` by AECI-797, along with the dead gateway module
  they fed. Every surviving mention of either name is an explicit retirement notice. **Do not mint
  an Airtable PAT** — there is nothing to authenticate against.
- **The strand audit reads the review app over MCP.** `scripts/ops/2026-09-stranded-row-audit/`
  runs daily on `AECI_MCP_TOKEN`, fail-closed (AECI-796).
- **ADR 0021's `airtable_record_id` veto is unaffected.** AECI-562 rejected storing a curation-tool
  key in our public schema, and that still holds — which is exactly why the ID mapping the review
  app persists (`supabase_product_id`, `supabase_vendor_id`, `supabase_integration_id`) remains the
  **only** link between the two systems, and why deleting an upstream record strands the live D1
  row forever (`REVIEW_APP_PROMOTE_API.md` §5.1).
- **`promotion_status` is two different vocabularies.** Upstream has **seven** values
  (`unreviewed` / `needs_attention` / `approved` / `on_hold` / `promoted` / `retracted` /
  `rejected`, with a blank meaning `unreviewed`); AECi's own D1 CHECK has **five**
  (`pending` / `ready` / `promoted` / `retracted` / `rejected`), of which promote only ever writes
  `'promoted'`. Neither list is wrong. Reading one as a description of the other is.
  `REVIEW_APP_PROMOTE_API.md` §3.3 states both.
- **Historical records keep saying Airtable, and should.** `docs/adr/0008`, `0016`, `0018`, `0021`,
  `DATABASE_SCHEMA.md` §13.2 (the retired initial-load plan), `docs/handoffs/*`,
  `docs/stage-1-5-review-app-handoff.md`, `STAGE_1_5_SPEC.md` §4.1 and the 2026-08 ops run records
  are correct for their dates. Several now carry a dated note pointing here; none were rewritten.

## Related

- `docs/adr/0021-async-promote-ingest-via-workflows.md` — the async promote protocol and the
  AECI-562 ruling against storing a curation key.
- `docs/adr/0008-taxonomy-reference-data.md` and `docs/adr/0016-d1-over-supabase-postgres.md` —
  their Airtable references describe the store as it was on their dates; superseded as to the
  store by this record, unchanged as to their decisions.
- `docs/REVIEW_APP_PROMOTE_API.md` — the promote contract.
- `docs/DATABASE_SCHEMA.md` §13 — promotion from the review app.

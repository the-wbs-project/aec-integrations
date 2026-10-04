# ADR 0039: AECi field corrections with a lock

- Status: Accepted
- Date: 2026-10-04
- Issue: AECI-1237 (epic AECI-1190), split from AECI-1159 by Chris's ruling of 2026-10-04
- Amends: ADR 0035 decision 8 ("No moderation. Vendor edits and creates go live.")

## Context

ADR 0035 made a claimed record the vendor's. Promote writes nothing to it, and the owner's edits go live with no review. The same holds for a company or product with an active seat (the AECI-520 claimed-vendor block in `routes/promote.ts`).

That left AECi with no way to fix a wrong fact on a vendor-held record when the vendor disagrees or does not answer. AECi could ask the owner. An AECi contest accept writes the column (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.6), but the owner's next save could write the old value straight back, with nothing to stop it and nobody told.

## Decision

1. **AECi may correct one factual field on a vendor-held record, and the correction is locked.** `POST /api/admin/field-overrides` writes the column and a `field_overrides` row in one batch, with the `<entity>.field_overridden` audit row and a notice to the holding vendor.
2. **A lock stops every vendor write to that field.** Profile, product and integration edits, on both anchor tables, answer `409 FIELD_LOCKED_BY_AECI`. So do a contest submit on the field and any contest accept that would write it. The rule lives in one helper, `apps/api/src/lib/field-overrides.ts`, and each writer's batch carries a sentinel, so a lock set mid-save aborts the save.
3. **An admin lifts the lock, with a reason the vendor reads.** The column keeps AECi's value. The vendor may edit it again.
4. **Factual fields only.** Company contact and profile facts, the three product links, and the integration owner-edit fields. Never the logo (ADR 0032 has its own path), narrative copy (descriptions, ADR 0033's "How teams use it"), the taxonomy facets, or names.
5. **Vendor-held records only.** Anything else is promote's to write, so the correction goes upstream (`409 FIELD_OVERRIDE_NOT_VENDOR_HELD`). Promote is unchanged.
6. **The reason rule is AECI-1159's.** A required vendor-visible reason, an optional internal note never shown, `reasonVisibility: 'vendor'` on the audit row. Every plan gets the notice; there is no tier rule.

## Why a separate table, not a column

A lock is per field, carries its own reason and history, and must survive the value moving. A `locked_fields` JSON column on four tables would need four migrations, would lose history on lift, and on `integrations` or `connector_evidenced_pairs` a CHECK or default change risks a D1 table recreate, which is a measured data-loss hazard (`docs/migrations.md` §0). A new table is one `CREATE TABLE`.

The table has no FK into the entity tables and no CHECK. A lock row is history: an FK would cascade it away with a retraction or block the retraction. A CHECK change would later force a recreate. `AdminSetFieldOverrideSchema` holds the vocabulary.

## Consequences

- The owner's freedom to edit (ADR 0035 decision 8) now has one named exception, set and lifted only by an AECi admin, always with a reason the owner reads and an audit row.
- **Known limit.** When a record stops being vendor-held, for example when the last-seat hand-back clears `claimed_at`, promote writes the column again and the lock row stays. It still blocks a re-claimed vendor's edit of that field until an admin lifts it. Clearing locks on hand-back was not built, because a lock is AECi's statement about a fact, not about who holds the record.
- **The legal text is not changed here.** The Listing Accuracy Policy says AECi takes a supported correction up with the owner. The wording that matches this power needs counsel. The proposed change is on AECI-1237.
- The contract is `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.5. The table is `DATABASE_SCHEMA.md` §8.9. The routes and the error rows are `API_CONTRACTS.md` §4, §6.10 and §6.14.

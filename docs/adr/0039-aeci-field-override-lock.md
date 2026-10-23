# ADR 0039: AECi field corrections with a lock

- Status: Accepted
- Date: 2026-10-04
- Issue: AECI-1237 (epic AECI-1190), split from AECI-1159 by Chris's ruling of 2026-10-04
- Amends: ADR 0035 decision 8 ("No moderation. Vendor edits and creates go live.")

## Context

ADR 0035 made a claimed record the vendor's. Promote writes nothing to it, and the owner's edits go live with no review. The same holds for a company or product whose vendor owns its record (the AECI-520 block in `routes/promote.ts`, which keyed on an active seat until AECI-1415 and has read `vendors.owned_at` since, ADR 0042).

That left AECi with no way to fix a wrong fact on a vendor-held record when the vendor disagrees or does not answer. AECi could ask the owner. An AECi contest accept writes the column (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.6), but the owner's next save could write the old value straight back, with nothing to stop it and nobody told.

## Decision

1. **AECi may correct one factual field on a vendor-held record, and the correction is locked.** `POST /api/admin/field-overrides` writes the column and a `field_overrides` row in one batch, with the `<entity>.field_overridden` audit row and a notice to the holding vendor.
2. **A lock stops every vendor write to that field.** Profile, product and integration edits, on both anchor tables, answer `409 FIELD_LOCKED_BY_AECI`. So do a contest submit on the field and any contest accept that would write it. The rule lives in one helper, `apps/api/src/lib/field-overrides.ts`, and each writer's batch carries a sentinel, so a lock set mid-save aborts the save.
3. **An admin lifts the lock, with a reason the vendor reads.** The column keeps AECi's value. The vendor may edit it again.
4. **Factual fields only.** Company contact and profile facts, the three product links, and the integration owner-edit fields. Never the logo (ADR 0032 has its own path), narrative copy (descriptions, ADR 0033's "How teams use it"), the taxonomy facets (lockable since the 2026-10-23 amendment, AECI-1382). Company and product names are not offered; an integration's name is, because a wrong integration name is a factual error.
5. **Vendor-held records only.** Anything else is promote's to write, so the correction goes upstream (`409 FIELD_OVERRIDE_NOT_VENDOR_HELD`). Promote is unchanged.
6. **The reason rule is AECI-1159's.** A required vendor-visible reason, an optional internal note never shown, `reasonVisibility: 'vendor'` on the audit row. Every plan gets the notice; there is no tier rule.

## Why a separate table, not a column

A lock is per field, carries its own reason and history, and must survive the value moving. A `locked_fields` JSON column on four tables would need four migrations, would lose history on lift, and on `integrations` or `connector_evidenced_pairs` a CHECK or default change risks a D1 table recreate, which is a measured data-loss hazard (`docs/migrations.md` §0). A new table is one `CREATE TABLE`.

The table has no FK into the entity tables and no CHECK. A lock row is history: an FK would cascade it away with a retraction or block the retraction. A CHECK change would later force a recreate. `AdminSetFieldOverrideSchema` holds the vocabulary.

## Consequences

- The owner's freedom to edit (ADR 0035 decision 8) now has one named exception, set and lifted only by an AECi admin, always with a reason the owner reads and an audit row.
- **Known limit.** When a record stops being vendor-held, for example when the admin return of records to AECi clears `claimed_at` (the last-seat hand-back did until AECI-1415), promote writes the column again and the lock row stays. It still blocks a re-claimed vendor's edit of that field until an admin lifts it. Clearing locks on hand-back was not built, because a lock is AECi's statement about a fact, not about who holds the record.
- **The legal text changes with it (Chris, 2026-10-05).** The Listing Accuracy Policy now says AECi asks the vendor first and holds the right to correct a factual detail itself when the vendor does not respond or disagrees. Disputes go to support@aecintegrations.com. The policy stays a draft pending counsel review (AECI-308).
- The contract is `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.5. The table is `DATABASE_SCHEMA.md` §8.9. The routes and the error rows are `API_CONTRACTS.md` §4, §6.10 and §6.14.

## Amendment 2026-10-19 (AECI-1415): vendor-held reads ownership

The "vendor-held" test for a company or product now reads `vendors.owned_at` (`loadOwnedVendorIds`), not seat presence. A frozen owned record whose vendor has no seat left is still vendor-held, because seat loss no longer returns it to promote (ADR 0042). Promote does not write it, so this override is AECi's only way to correct it. A product is vendor-held if any joined vendor is owned. Integrations and pairs are unchanged (`claimed_at` or `origin = 'vendor'`).

## Amendment 2026-10-23 (AECI-1382): the four taxonomy facets are lockable

Rule 4 no longer excludes the taxonomy facets. An admin may lock a product's categories, audiences, phases or trades under their vendor wire keys (`category_slugs`, `audience_slugs`, `phase_slugs`, `trade_slugs`). Vendors self-assign all four (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4.3), so before this an AECi reset of a facet was undone by the vendor's next save.

- **The value is the whole term set.** It is a sorted, de-duplicated array of existing term slugs, at most 10. `[]` removes every term. It is stored in the same JSON `value` column, so there is no migration.
- **The correction is a join rewrite, not a column write.** The batch is the lock row first, a `products.updated_at` stamp, the facet's join `DELETE` and `INSERT`, the audit row with the before and after slug sets (and `usefulness` when a removed audience or phase took its points), and the notice with the term names.
- **The vendor screen compares sets.** The same slugs in any order are dropped. A different set is `409 FIELD_LOCKED_BY_AECI`. The batch sentinel guards the facet keys.
- **The purge is the vendor edit's own.** `productEditTags` covers the term pages, and a trade change also purges `index:trades`, `taxonomy` and `sitemap`. No recrawl, as for every correction.
- **A lift is unchanged.** The terms keep AECi's set.

The §4.3 "challenge recently-changed trades" workflow stays deferred. This amendment gives AECi a correction power, not a review queue. Names, descriptions, the logo and "How teams use it" stay excluded. A facet's "How teams use it" points stay editable while its terms are locked. A removed audience or phase takes its points with it, in the same batch, as the vendor editor's removal does.

# ADR 0033: "How teams use it" is vendor-authored and promote-fenced

- Status: Accepted
- Date: 2026-09-16
- Issue: AECI-963

## Decision

`products.usefulness` moves from AECi-owned to vendor-writable. A vendor edits the narrative in the vendor portal, it publishes live with no moderation, and from the first save promote no longer writes that column for that product. The complete contract is STAGE_2_5_SPEC.md §12.

Ownership is arbitrated by a nullable `products.usefulness_source`, tested inside the SQL UPDATE rather than read during planning. This is ADR 0032's `logo_source` mechanism applied to a second column. Promote never writes the provenance column, an explicit clear claims ownership, and nothing clears it back to null, so the transition is one-way.

Gate it on a new `product.usefulness.edit` capability rather than the existing `product.edit`. The wire shape carries the term slug and the points, never the display name, which the server resolves from the taxonomy row on every write. An unknown slug is a 400.

## Why the ownership moved

The section describes what a product does for the people who use it. The vendor knows that and we are reconstructing it. Leaving it upstream meant nobody could correct a word without a re-promote, which is why an operator asked for an editor at all.

Two alternatives were considered. Building the editor in the review app is correct by the data-direction rule, costs nothing here, and was rejected because it puts the author two hops from the page and leaves every edit waiting on a promote. Building an admin editor here was rejected as the wrong author: we would still be writing the vendor's copy for them.

## What this decision does not settle

Publishing vendor-written copy unmoderated into a section a reader parses as our description is a real trust cost, accepted with eyes open and paid for in editor copy rather than in a queue. Two named re-open triggers: the section reading as marketing rather than description, and the first vendor dispute about a competitor's block.

Diverges from ADR 0032 in exactly one respect. Promote emits a `preserved[]` receipt naming the fenced product, because a curator who keeps maintaining narrative copy that no longer ships should be told, and a URL did not warrant the same. The receipt is derived from a planning read while the guard is in SQL, so it is advisory and one-sided: it can be missing for a value that was preserved, never present for one that was not.

## Consequences

The review app's copy of `usefulness` is dead for any product a vendor has edited, and there is no control to hand it back. The catalogue has two writers for one column where it had one. A future admin editor needs no migration, since `usefulness_source` already accepts `admin`.

Revisit if moderation becomes necessary, if the public page needs to attribute the section, or if a second content column wants the same treatment — at which point the per-column `*_source` pattern should probably become a general mechanism rather than a third copy.

## Amendment 2026-10-14 (AECI-1316): the public page attributes the section

The trigger "if the public page needs to attribute the section" fired. The home page said "no vendor marketing" while vendors wrote this section and product descriptions, with nothing on the page to say so.

Two changes, decided by Chris on 2026-10-14. The home hero, the home meta description and `/about` no longer say "no vendor marketing". And `GET /api/products/:slug` now returns `usefulness_source`, so the product page says "Written by {vendor}" under the section heading when the value is `'vendor'`. AECi's own copy carries no label.

The mechanism is unchanged. `usefulness_source` is still written only by a vendor save and still never cleared. Product descriptions have no provenance column, so they stay unlabelled; dropping the home claim is what keeps the copy true for them. STAGE_2_5_SPEC.md §12.1 carries the reversed bullet.

## Amendment 2026-10-19 (AECI-1407, E6.4): the fence lasts only while a license does

The decision said the transition is one-way and nothing clears `usefulness_source`. That is no longer true. Writing this section is a Managed right (`STAGE_2_PAID_TIERS_SPEC.md` §13.3), and `VENDOR_SIGNUP_PROCESS.md` decision 14 says the Managed fields go back to AECi when Managed ends. The text stays live and nothing reverts, but promote may write the field again.

Chris ruled on 2026-10-19 that the hand-back is checked when promote writes, not when the license ends. Promote's guard became `usefulness_source IS NULL OR NOT EXISTS (a live license assigned to the product)`. The same statement sets `usefulness_source` back to NULL when no live license exists. That is promote's first and only write to the column. Without it, the 2026-10-14 "Written by {vendor}" label would credit AECi's copy to the vendor. Nothing is written when a license ends, so a lapse, a release and an admin revoke all hand back the same way, at the next promote that sends `usefulness`.

Three consequences:

- The `preserved[]` receipt fires only when the plan read sees a live license. It is still advisory. It is no longer strictly one-sided: a license ending between the plan read and the commit lets the write through under a receipt that says it was kept. That window is rare.
- A claimed vendor's product is still blocked wholesale by promote, except for one opening. With no live license on the product, promote writes `usefulness`, `tool_integrations_url`, `api_docs_url` and AECi's claims on the product's existing, unclaimed edges (`REVIEW_APP_PROMOTE_API.md` §4a). Taxonomy and everything else stay fenced until E6b (AECI-1341).
- A vendor's words stay published, and labelled, until AECi next promotes that product with a `usefulness` value. Nothing deletes them.

`STAGE_2_5_SPEC.md` §12.2 carries the changed rule. The schema comment on `products.usefulness_source` and `DATABASE_SCHEMA.md` §4.2 say the same.

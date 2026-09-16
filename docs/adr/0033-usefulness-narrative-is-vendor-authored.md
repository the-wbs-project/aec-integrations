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

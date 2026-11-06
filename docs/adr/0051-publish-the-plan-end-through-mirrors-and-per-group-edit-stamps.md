# ADR 0051: Publish the plan end through mirrors, and date captions from per-group edit stamps

- Status: Accepted
- Date: 2026-11-05
- Issue: AECI-1614 (ruling 5 on AECI-1363)
- Relates to: ADR 0033 (the usefulness fence), ADR 0039 (field corrections), ADR 0042 (record ownership), ADR 0048 (a plan is a product with a live license); `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.8; `STAGE_2_PAID_TIERS_SPEC.md` §2.5, §7.8, §13.4

## Context

Public pages must show that vendor-maintained content is the vendor's, imply no verification by AECi, and give a freshness date. The Terms already promise it. Two forms of caption need a date nothing stored:

- "Maintained by {vendor} · updated {date}" needs when the vendor last changed that group.
- "Maintained by {vendor} until {date}" needs when the plan ended, on a public read.

Product and pair pages are edge-cached, so the answer has to be a stored fact, with no clock and no visitor in it. `STAGE_2_PAID_TIERS_SPEC.md` §2.5 bars plan tables from public reads, and `drizzle-helpers.read-path.spec.ts` enforces it.

## Decision

**1. Mirror the plan end onto the catalog row.** The public read never touches `licenses`.

- `products.managed_ended_at` is when the product lost its last live license. `reconcileManagedMirror` in `lib/license.ts` writes it, from the before and after license sets, in the same batch as the license write. An early unassign is dated at the unassign time, because the vendor's edit right ends then, not at the term's end. A carried product does not move, and a new license clears it.
- `vendors.plan_ended_at` is when the vendor last held no live license. It moves with `verified` in `reconcileVerifiedMirror`, in the same statement, so the two cannot disagree. A connector-powered row reads it, because only a licensed owner can edit such a row.
- `reconcileManagedMirror` pins `products.updated_at` to itself. The column's `$onUpdate` would otherwise move it, and a plan event must not move a public sort or the Algolia watermark.
- `plan_end_mirror_drift` (warn) compares both mirrors with `licenses`. `ranking-firewall.spec.ts` bars both from ranking.

**2. Stamp each field group on a real vendor write.** `products.description_edited_at`, `profile_edited_at`, `usefulness_edited_at` and `managed_edited_at`, plus `vendor_edited_at` on `integrations` and `connector_evidenced_pairs`. A stamp moves only when a vendor write changes a value in that group. Promote, an admin override and "Looks right" never stamp. No stamp means no caption (ruled 2026-11-05). A return to AECi clears every stamp except a `usefulness_edited_at` behind a set `usefulness_source`, because promote can write those fields again and cannot write that one. A proposal accept stamps usefulness with no source, so a return clears that stamp too.

**2a. Website and categories are their own group.** Chris ruled on 2026-11-05 that they be captioned, and in the Managed group. They stay editable on Free, so "until {date}" would be false for them. They take their own stamp and an `updated`-only line, like the description.

**3. The server picks the form.** `lib/field-captions.ts` is pure, and the page renders its answer verbatim.

## Alternatives rejected

- **Date from `updated_at`.** `$onUpdate` moves it on any write, and promote re-asserts `promotion_status` on every re-promote. Production has 60 products sharing one `updated_at` day. It would say a vendor updated text the vendor never touched. `maintenance-marker.ts` already bans it.
- **Date from `last_reviewed_at`.** It moves on "Looks right" with no content change and on any vendor-authorized write to another group. "Updated {date}" would be false, and it covers the whole record, not one group.
- **Read `licenses` on the public path.** One join would be truer in the moment, and it reverses §2.5: a plan lookup on every public request, and a plan table one query from a ranking read. A mirror keeps that wall, at the cost of a second writer, which the shared reconcile and the drift check cover.
- **A clock at read time.** "Until" could be computed from `ends_at` and now. That puts a clock into cached HTML, and `ends_at` is not when the license ended: it can be extended, released or revoked. `licenses.ended_at` is set once, so the mirror is too.

## Consequences

- Each new writer of a group's fields has to stamp it, and a new license path has to go through the shared diff. The specs cover each writer and each non-writer.
- A vendor-written group with no stamp shows no caption until `scripts/ops/2026-11-field-caption-backfill/` has run. It fills the stamps from `audit_log` and the mirrors from `licenses`, dry run first. Until then a vendor's usefulness block on production loses "Written by" with no replacement.
- A plan end is now public on any product whose vendor wrote a Managed group. That is the promise the Terms make.
- A flip of `verified` purges more pages: `vendorPurgeTags` now covers the vendor's edited connector-powered rows (`CACHE_STRATEGY.md`).

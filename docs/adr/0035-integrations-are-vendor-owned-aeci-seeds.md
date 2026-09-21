# ADR 0035: Integrations are vendor-owned; AECi seeds

- Status: Accepted
- Date: 2026-09-21
- Issue: AECI-1005 (epic AECI-1003)
- Supersedes: the rule "integrations are AECi-curated and are not vendor-editable", wherever it appeared (`routes/promote.ts`, `API_CONTRACTS.md` §6.12, `REVIEW_APP_PROMOTE_API.md` §4a)

## Decision

An integration belongs to the vendor that offers it. AECi populated the catalogue to get initial traction, and that data is a seed, not a gate. The owner can take its row, and from then on AECi's curation pipeline stops writing it.

Three columns carry this, added by migration `0044` as plain `ADD COLUMN`s with no table recreate:

- `integrations.claimed_at` records that the owner took the row by an act. NULL means unclaimed.
- `integrations.origin` records who created the row: `'aeci'` (promote, the default) or `'vendor'`.
- `integrations.retired_at` is reserved for AECI-1010. Nothing reads or writes it yet.

The owner claims with `POST /api/vendor/integrations/:id/claim`. From the moment `claimed_at` is set, the product promote arm writes nothing to that row. The contract is `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5 and `REVIEW_APP_PROMOTE_API.md` §4b.

## The epic's decisions, as this record binds them

These are AECI-1003's decisions 1 to 15 (2026-09-17 and 2026-09-18, Chris), plus the 2026-09-21 rulings. Where a sub-issue body disagrees, these win.

1. **Ownership.** The vendor recorded in `built_by_vendor_id` is the owner. It claims without approval, and it edits the standard fields (AECI-1006).
2. **Non-owners contest.** The other side names a field, a value and a reason (AECI-1008). Before a claim, the contest goes to AECi, which writes nothing here and files a `REVIEW - Apply contested field` issue. After a claim, a content contest goes to the owner. The `owner` field always goes to AECi, even on a claimed row, because the owner cannot judge whether it is the owner.
3. **No recorded owner.** AECi-side curation requires an owner before promote (AECI-1014) and suggests owners for a curator to confirm (AECI-1015). This repo never infers an owner.
4. **A declined contest** goes back to the submitter, who may protest to AECi (AECI-1009, design only).
5. **Promote.** Once a vendor claims an integration, promote can no longer write to it at all.
6. **Per-side URLs.** Each endpoint vendor stores its own listing and docs links on the integration (AECI-1007). They are web links, never routes, and imply no permission.
7. **Create and retire.** Vendors create integrations (AECI-1011) and retire ones they own (AECI-1010). Retire, not delete, and retire keeps claims and attestations. The other vendor is notified. Promote never un-retires.
8. **No moderation.** Vendor edits and creates go live.
9. **Connector-powered integrations** (a row with `powered_by_product_id` set) stay out of every vendor write: edit, per-side links, create and retire. **v1 ruling (2026-09-21):** the owner may claim such a row and do nothing else with it. A third-party owner's rows are connector-powered, so a third-party owner can claim and nothing more in v1. A carve-out for its own rows is a follow-up issue, not v1 scope.
10. **Duplicate creates are not refused yet** (AECI-1012, design only).
11. **Owner-unknown claims go through AECi approval.** A vendor says "we offer this", and an admin approves or rejects. Approval sets the owner here and flags the review app to record it upstream, by filing a `REVIEW - ` Linear issue through the mechanism AECI-1008 built.
12. **One owner column.** There is no `owner_vendor_id`. The owner is `built_by_vendor_id`, and `claimed_at IS NOT NULL` means ownership was verified by an act: a claim, or an admin approval. Promote is fenced from `built_by_vendor_id` after a claim.
13. **The fence keys on `claimed_at`, never on `maintained_by`.** `maintained_by` stays the two-value display marker. It flips to `'vendor'` when either endpoint vendor attests, so it means "a vendor touched this", not "a vendor owns this". A claim also sets it to `'vendor'` so the chip reads right. There is no `last_maintained_by`; the actor lives in `audit_log`.
14. **An owner pays.** An integration for sale means its owner is a paying vendor, and a third-party owner holds a paid seat, not the §8.9 free catalogue-maintenance seat. This amends `STAGE_2_SPEC.md` §8.8 (AECI-1017). No pay-for-placement is unchanged.
15. **A seat is the gate, for now.** A vendor seat allows whatever integration action the vendor's relationship to the row allows. There is no `integration.edit` capability and no entitlement check on these routes, the model AECI-1008 shipped for contests. Revisit when tiers differentiate.

## Why the fence is on the whole row

A claimed row is refused wholesale, the way AECI-520 refuses a blocked vendor's product, rather than column by column the way ADR 0032 fences `logo_url`. Three reasons.

- **Promote writes more than the row.** It writes the row's claims and attestations, an endpoint-move record, and on a `powered_by` routing change it DELETES the row and re-inserts it in the other table. That delete cascades into `claims`, `attestations` and `integration_field_challenges`. A per-column `CASE` protects the columns and none of that.
- **Decision 5 says "at all".** AECi-seeded claims and attestations on a claimed row freeze too.
- **There is exactly one question.** "Is this row claimed?" is one read and one test, so the receipt and the guard cannot drift apart.

The fence has the same two halves the AECI-981 `last_reviewed_at` fence has. The plan-time half is decided from the existing both-tables `locateEdge` read and reports the refusal in `skipped[]`. The commit-time half is an in-batch sentinel statement per written row that aborts the whole promote when the row was claimed after the plan read, so a claim landing mid-promote wins and the job errors with `INTEGRATION_CLAIMED_DURING_PROMOTE`. A re-push then plans against the claimed row and fences it.

## Why the ops lanes changed

Three tools treat "no upstream record points at this row" as "this row is an orphan": the daily strand audit, the datatool prune and the retraction consumer. That inference is wrong for a vendor-held row (claimed, or `origin = 'vendor'`). A claimed row's upstream record may be dropped or re-curated without that being a ruling on the vendor's row, and a vendor-created row never had one. The retraction consumer deletes by upstream id, so an upstream delete of a claimed row would otherwise have destroyed the vendor's row, its claims, its attestations and its contests. All three now exempt or refuse vendor-held rows, and the two scripts probe the live DDL for the columns because production applies `0044` only at its next promote.

## Third-party owners (AECI-1017)

> **PLACEHOLDER — AECI-1017's paragraph has not been delivered yet.** AECI-1017 records the seat model for a third-party owner and the `STAGE_2_SPEC.md` §8.8 amendment (decision 14). Its text belongs here and is to be pasted in verbatim when it lands. Until then, decisions 9 and 14 above are the binding statement.

## Consequences

- The review app is no longer the source of truth for a claimed integration. Its copy of that row is dead, and nothing hands the row back to promote.
- Every later owner write (1006 edit, 1007 per-side links, 1010 retire) must refuse a connector-powered row, and the claim route is the one place that does not.
- The contest owner path is live. The four gaps AECI-1008 listed for it are closed or structurally unreachable: promote can no longer revert an owner accept; the `integrations` freshness cursor now covers the rows themselves; a direction contest cannot see its anchor re-oriented because promote can no longer re-point a claimed row.
- `built_by_vendor_id` on a claimed row can change only through AECi's own admin path, never through promote.

## Revisit

If a third-party owner needs to edit its own connector-powered rows (decision 9's open item), if tiers start to differentiate what a seat may do (decision 15), or if a claimed row ever needs to go back to AECi, which today has no path and would need its own audited admin action.

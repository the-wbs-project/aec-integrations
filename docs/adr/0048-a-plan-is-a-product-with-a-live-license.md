# ADR 0048: A plan is a product with a live license, and Free keeps the seat-level edits

- Status: Accepted
- Date: 2026-10-28
- Issue: AECI-1524 (E10.7), epic AECI-1340
- Supersedes: ADR 0037. The Free capability set and the seat-level rule carry forward. The definition of a plan does not.
- Relates to: ADR 0042 (record ownership; hand-back is the loss of the edit right); ADR 0047 (Stripe writes licenses); `docs/VENDOR_SIGNUP_PROCESS.md` §2 and §3; `docs/STAGE_2_PAID_TIERS_SPEC.md` §13; `docs/DATABASE_SCHEMA.md` §8.6b and §8.6c

## Context

ADR 0037 made Free the `unclaimed` tier and defined a plan as a `vendor_entitlements` row. One row per vendor set the tier for every product. Admins set, renewed and cleared it. A shared pilot end date ended it for all pilot vendors.

That model is gone. AECI-1355 made licenses the truth for plan resolution. AECI-1375 retired the admin entitlement and plan-pricing routes. Migrations 0082 and 0081 dropped `vendor_entitlements` and `vendor_plan_pricing`. ADR 0037 still told readers that a plan is an entitlement row, so it needed a successor rather than another amendment.

Part of ADR 0037 still holds in code. The Free capability set, the binary `TIERS` and the seat-editable `listing_tier` inputs are unchanged. This ADR keeps them in one place.

## Decision

**A plan is per product. A product is Managed exactly when it holds a live license on a billing account.** Free is a product with no live license.

- There is no plan row. `vendor_entitlements` and `vendor_plan_pricing` no longer exist.
- Licenses sit on a billing account, one per vendor (`VENDOR_SIGNUP_PROCESS.md` decision 5).
- A co-owned product is Managed only for the vendor whose billing account holds its license. The other vendor sees it as Free.
- `GET /api/vendor/me` carries a per-product `plan`. Writes on one product gate through `requireProductCapability`.

**The pilot end is a per-license end date.** The daily lapse job ends every passed non-Stripe term (AECI-1404). There is no shared 2026-12-14 date and no admin Clear.

**Every claim approval lands on Free** (`VENDOR_SIGNUP_PROCESS.md` decision 2). A claim carries no plan question. Managed is a license, granted or paid for after approval.

**Carried forward from ADR 0037, unchanged.**

- Free is the existing `unclaimed` tier with a non-empty capability set in `TIER_CAPABILITIES`: `profile.edit`, `product.listing.edit` and `product.categories.edit`.
- `TIERS` stays `['unclaimed', 'verified']`. There is no `free` id and no migration.
- "Free" and "Managed" are copy names for `unclaimed` and `verified`. Free is never granted. It is the absence of a live license.
- Every `listing_tier` input is seat-editable. `packages/shared/src/entitlements.spec.ts` maps each input to its capability and checks it is in `TIER_CAPABILITIES.unclaimed`. `name` and `company_name` are not vendor-editable, and the test says so.

## Consequences

- **Payment cannot raise rank through edits.** Adding a Managed-only `listing_tier` input still fails the build.
- **The plan is read from licenses, not stored.** Ending the last live license drops the product to Free with no write to a plan row. The session and ranking read licenses only.
- **Hand-back is the loss of the edit right on Managed fields.** The text stays live and frozen, and the records stay vendor-owned (ADR 0042, `VENDOR_SIGNUP_PROCESS.md` decision 14). A new license gives the edit right back.
- **Stripe is one source of licenses.** Card licenses are written by the webhook (ADR 0047). Invoice and complimentary licenses are granted by an admin. All three resolve to the same plan.
- **No tier is stored per vendor.** A vendor with three products and two licenses has two Managed products and one Free. Copy and the portal must say "per product".
- **Docs that said "plan row" or "entitlement" were rewritten in E10.** `STAGE_2_PAID_TIERS_SPEC.md` §13 states the current rules.

## Alternatives considered

- **Keep amending ADR 0037.** Rejected. Its definition of a plan, an entitlement row set by an admin, is dead. An amendment would leave the title and status line true of nothing.
- **A stored per-product plan column.** Rejected. It would duplicate the license rows and could drift from them. The `license_mirror_drift` data-quality check guards the one mirror that remains, `vendors.verified`.
- **A third tier for the pilot.** Rejected. A pilot is a complimentary license with an end date, so it needs no new rung.

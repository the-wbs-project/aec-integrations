# ADR 0037: Free is the `unclaimed` tier, and every `listing_tier` input is seat-editable

- Status: Accepted
- Date: 2026-10-01
- Issue: AECI-1213 (epic AECI-1212, built by AECI-1214)
- Supersedes: nothing. It amends `STAGE_2_PAID_TIERS_SPEC.md` §3.1 and adds a fifth assertion to §3.2.

## Context

The vendor portal has a "seat", a signed-in vendor account, and a "plan", a `vendor_entitlements` row. A seat with no plan resolves to the `unclaimed` tier. That tier held no capabilities. So a seat with no plan could sign in but edit nothing.

The 2026-09-30 data-readiness audit found a ranking leak. `listing_tier` is a search-ranking signal. It is built from a product's description, website, logo and categories. Only a vendor with a plan could edit those fields. So payment could raise a product's rank through the edit path. `VENDOR_PLAN_DATA_READINESS.md` §5 records this as coupling 1.

The pilot also ends on 2026-12-14. Without a usable no-plan state, a lapsed pilot vendor would lose every edit.

## Decision

**Free is the existing `unclaimed` tier, with a non-empty capability set.**

- "Free" and "Managed" are copy names for `unclaimed` and `verified`. `TIERS` stays binary. There is no `free` id, no migration and no new firewall vocabulary.
- `unclaimed` gains `profile.edit` and two new ids, `product.listing.edit` and `product.categories.edit`. Every seat holds them.
- Free is never a granted row. `PAID_TIERS` stays `['verified']`.

**Every `listing_tier` input is seat-editable, and the firewall asserts it.**

- `entitlements.spec.ts` maps each product and vendor `listing_tier` input to its column-map capability. It checks that capability is in `TIER_CAPABILITIES.unclaimed`.
- `name` and `company_name` are not vendor-editable. The test lists them as such.

The rules are `STAGE_2_PAID_TIERS_SPEC.md` §13.2 to §13.4.

## Consequences

- **`unclaimed` no longer means "zero capabilities".** The comment in `entitlements.ts` and two tests say it does. AECI-1214 changes all three. "Fail closed" now means "fail to Free". It never means "fail to Managed".
- **The `PAID_TIERS` test must change.** It derives the grantable tiers as "tiers that hold a capability". That would now include `unclaimed`. The test must exclude `unclaimed` by name.
- **Ranking can no longer depend on payment through edits.** Adding a Managed-only `listing_tier` input fails the build.
- **Some product fields stay Managed-only.** The integrations page URL, the API docs URL, trades, audiences and phases keep their gates. None of them feeds `listing_tier`.
- **Integration routes are unchanged.** A seat is still their whole gate. Connector-powered rows keep the AECI-1040 entitlement exception. `STAGE_2_PAID_TIERS_SPEC.md` §13.5 records this.

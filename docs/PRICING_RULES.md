# Pricing rules

**Status: agreed with Chris on 2026-10-29 (AECI-1431). Pricing as of 2026-10-29.**

This is the one place that states what AECi charges vendors and on what terms. It covers the
principles, the prices, every discount, grandfathering, refunds and how a price changes. Every other
document, help page, email, screen and marketing asset links here instead of restating these
terms. If one disagrees with this file, this file wins and the other is a defect.

How a vendor claims, buys, assigns and loses a license is the process, and it lives in
`docs/VENDOR_SIGNUP_PROCESS.md`. The binding contract with a vendor is the Managed plan agreement
(`apps/web/src/content/legal/managed-plan-agreement.md`). It is a draft awaiting counsel, so quote
this file internally and the agreement to vendors.

A merge to `main` that changes this file copies it to a Linear Document for readers outside the
repo (`docs/CICD_PLAN.md` §11b). Edit it here. Edits made in Linear are overwritten.

The marketing repo (`aec-integrations-marketing`) links to this file and never restates or edits
its terms.

## 1. Principles

1. **Listing is free forever, and buyers never pay.** Claiming a company costs nothing. Every
   claimed company gets Free seats.
2. **Price never touches ranking.** No plan, discount or deal changes where a product ranks,
   whether it appears, or whether a review is published (`PRODUCT.md`, "No pay-for-placement").
3. **Managed is priced per product, not per seat or per company.** Seats have no price and no
   limit.
4. **Prices are public.** The list price is on the site. Prices are in US dollars and exclude tax.
5. **One price for everyone.** Two vendors on the same plan and volume pay the same. Every
   discount is on the list in §3 and goes to everyone who meets its rule.
6. **No one-off Stripe price for one vendor.** A deal that needs its own price is an invoice-sourced
   grant (§2).
7. **No free months.** The pilot in §3 is the only complimentary Managed time. A request for "a
   free month to get started" gets a no.
8. **Never trade price for exposure.** No discount, credit or free time in exchange for a review,
   quote, testimonial, logo or case study.

## 2. Prices and terms

| Term | Rule |
|---|---|
| Plans | Free and Managed. Insights and Enhanced (`docs/ROADMAP.md`) have no price yet. |
| Unit | One license per product, held on the vendor's billing account. |
| Price | $25 a month, or $250 a year, per license. |
| Monthly | Month to month, no commitment, cancel any time. Runs to the end of the paid month. |
| Annual | Paid up front. Renews yearly unless the vendor opts out before the renewal date. We email 30 days before. |
| Tax | Prices exclude tax. Stripe Tax adds it at checkout. |
| Volume | No volume tiers. A volume deal, a purchase order or a bespoke deal is an invoice-sourced grant recorded by AECi. Its written deal wins on price and term for those licenses. |
| Payment | Stripe: card by default, a Stripe invoice on request. |

## 3. Discounts

This is the complete list. No other discounts exist.

| Discount | Rule | Published |
|---|---|---|
| Founding pilot discount | 20% off for 12 months, for any pilot participant who converts to a paid license. Annual: the first year. Monthly: the first 12 paid months, ending early if they cancel. A Stripe coupon on the subscription, so it covers every license on that subscription while it runs. | No. Private outreach only. |
| Pilot | One month of a complimentary license on one product, no card, no obligation. The month starts at the grant. The product goes back to Free at the end date. No extensions. | No. Private outreach only (`docs/VENDOR_PROGRAM_PAGE_SPEC.md`). |

Not discounts:

- **Annual.** $250 a year against $300 for twelve monthly payments. That is the annual price, not a
  discount, and we never call it one.
- **Multi-product.** There is none. The earlier "decided in principle, schedule not set" is
  withdrawn. A vendor with many products gets an invoice-sourced deal under §2.

## 4. Grandfathering

There is none. When the list price changes, founding and pilot vendors take the new price on the
same terms as everyone else (§6). A founding discount already running keeps its 20% for the rest of
its 12 months, applied to whatever the vendor then pays. Nobody keeps an old price for life.

## 5. Refunds

| Case | Rule |
|---|---|
| First charge | Full refund if the vendor asks within 14 days of the first charge. None after. |
| Renewal charge | Not refunded. We send notice 30 days before it. |
| Our billing error | Always reversed, whenever it is found: a double charge, a wrong amount, or a charge after a cancellation took effect. This is a correction, not a refund under the 14-day rule. |
| Not refunded | A license the vendor bought twice or did not assign, unused time, a reduction before renewal, licenses ended for abuse or misrepresentation, a ban, or a company that gives up its claim. |

A refund ends the licenses it paid for, and the products move to Free. Money goes back to the
payment method used. The operator steps are `docs/RUNBOOKS.md` "Stripe: refund a card license".

## 6. Changing a price

1. **Write the memo first.** Add a dated row to §7 saying the old price, the new price, why, and the
   date it takes effect. Chris approves it before anything else moves.
2. **Never mid-term.** Annual licenses take the new price at their next renewal, in the renewal
   notice. Monthly licenses take it after at least 30 days' notice by email.
3. **Tell vendors by name.** Chris or Bill writes to every paying vendor. The old and new price are
   in the first lines. The automated 30-day email is not the announcement.
4. **Sweep for the old price.** Update every place in §8, then search for the old figure in this
   repo and the marketing repo. Fix or mark every hit:

   ```bash
   rg -n -i '\$25|\$250|25 a month|250 a year' docs apps packages PRODUCT.md
   ```

5. **At most one price change a year.**

## 7. Decision log

| Date | Decision | Source |
|---|---|---|
| 2026-10-14 | Managed is per-license: $25 a month with no commitment, or $250 a year renewing unless opted out. Full refund within 14 days of the first charge. No volume tiers. Stripe. Per-vendor price override retired. Founding discounts are Stripe coupons. | `docs/VENDOR_SIGNUP_PROCESS.md` §2 |
| 2026-10-16 | The 20% founding discount on the first paid year stands, as a Stripe coupon. | Chris |
| 2026-10-20 | Stripe Tax on. Prices exclude tax. | `docs/VENDOR_SIGNUP_PROCESS.md`, Stripe rulings |
| 2026-10-21 | Founding discount extended to further pilot participants. | Chris |
| 2026-10-29 | This file. No grandfathering. 30 days' notice of a price change. Billing errors are always reversed. Founding discount: any converting pilot participant, 12 months, unpublished. No multi-product discount. | AECI-1431 |

## 8. Where the terms are restated

These are the only places allowed to state a price or a pricing term. A price change updates all of
them (§6 step 4).

| Where | What it shows |
|---|---|
| `packages/shared/src/entitlements.ts` (`MANAGED_LIST_PRICE_CENTS`, `MANAGED_ANNUAL_PRICE_CENTS`) | The two prices every site string reads |
| `apps/web/src/app/shared/plan-cta/plan-cta.ts`, `plan-cards.ts` | `/vendor-program` and `/docs/vendors/plans` price, term, refund and FAQ copy |
| `apps/web/src/app/docs/docs-plans-comparison.ts` | Plan comparison table |
| `apps/web/src/app/vendor-program/vendor-program.ts` | `/vendor-program` per-product and cancel FAQ, and the plan's structured data (it reads the two constants above) |
| `apps/web/src/app/vendor/vendor-plan.ts` | Portal plan panel |
| `apps/web/src/content/docs/vendors/billing.md`, `plans.md`, `overview.md` | Vendor help pages |
| `apps/web/src/content/legal/managed-plan-agreement.md` | The contract |
| `apps/api/src/lib/email.ts` | The 30-day notice |
| Stripe Dashboard: prices `managed_monthly` and `managed_annual`, and the founding coupon | What is actually charged |

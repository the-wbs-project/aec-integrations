# Vendor signup, licenses and billing: the process

**Status: agreed in discussion with Chris on 2026-10-14. Mostly not yet built. Epics filed in Linear the same day (AECI-1331 to AECI-1340, project Pilot); parked items are AECI-1341 to AECI-1344.**

**Built so far (2026-10-15).** E1.1 to E1.5 (AECI-1350 to AECI-1354): the `billing_accounts` and `licenses` tables, the billing account at claim approval and seat provision, `lib/license.ts`, the dual-write from the entitlement builders, and `ops:backfill-licenses`. Plan resolution does not read licenses yet. Only the dual-write pre-read and the `license_mirror_drift` data-quality check do. `vendor_entitlements` is still the truth for plan resolution until E1.6 (AECI-1355). Schema: `DATABASE_SCHEMA.md` §8.6b and §8.6c. E2.1 and E2.2 (AECI-1359, AECI-1360): the vendor terms at `/legal/vendor-terms` and the Managed plan agreement at `/legal/managed-plan-agreement`, both v1.0 drafts awaiting counsel. E2.3 (AECI-1361): every legal document has per-version URLs (`/legal/<slug>/v<version>`), a current pointer, and an on-page `## Change history` (`STAGE_1_SPEC.md` §27.3). E2.4 (AECI-1362): the `agreement_acceptances` table (§8.6d), its write helper `lib/agreement-acceptances.ts`, and two reads, `GET /api/vendor/billing/acceptances` (owner seats) and `GET /api/admin/vendors/:id/acceptances`. E3.3 (AECI-1366) is the first writer; E9 is the second. E3.1 to E3.5 (AECI-1364 to AECI-1368), the claim: a claim is on the company and records the product page it came from in `vendor_requests.context_product_id` (E3.1); the dialog has three steps with no plan question, and detail pages say "Claim <Company>" (E3.2); a required vendor terms box on every claim form, the acceptance written in the claim's batch (also for a typed-in listing request, migration 0078), and the claimant's `claim-received` receipt, one per address per day (E3.3); every approval lands on Free with an owner seat, links the claim's acceptances to the seat, vendor and billing account, and flags a pure connector vendor (E3.4); a claim on a company with an owner seat goes to its owners first, with AECi stepping in after 7 days (E3.5). Whether the privacy policy must disclose that acceptance evidence survives erasure is open for counsel (AECI-1363, `AUTH_AND_RLS.md` §8). E3 (AECI-1333) is built end to end as of 2026-10-15: E3.1 to E3.5 are code, and E3.6 (AECI-1369) put a dated as-built note under every spec section they touch. E10 does the full rewrites of those sections and the help center.
This is the one place that describes how a vendor goes from "Claim this company" to products on
Managed and back to Free. Every other document, help page, email and screen must match this one.
A flow chart drawn before the license model was agreed exists outside the repo; it will be redrawn
around licenses, owner seats and proposals and added here under `docs/` when E5 is planned.

Terms used:

- **Seat.** A person's access to a company's vendor account. Claiming gets you a seat.
- **Owner seat.** A seat that may buy licenses, assign them, invite colleagues and change the
  billing email. The first approved claimant is an owner. A vendor may have several owners.
- **Billing account.** Where money hangs: owner seats, billing email, Stripe customer, license
  pool. One per vendor today, created at claim approval. More than one later means teams.
- **License.** One Managed slot. Assigned to one product. Comes from Stripe, an invoice, or is
  complimentary.
- **Free / Managed.** Free is what every seat can do at no cost. Managed is a product with a
  license assigned.

## 1. The deal

A vendor buys Managed licenses and assigns one to each product it wants on Managed. A license is
$250 a year, or $25 a month with no commitment. Monthly is month to month, cancel any time. Annual
renews yearly unless the vendor opts out before the renewal date. Full refund within 14 days of the
first charge, none after. Pilot vendors get complimentary licenses with an end date, no card. No
plan changes where a product ranks, whether it appears, or whether a review is published.

## 2. Decisions settled on 2026-10-14

| # | Decision |
|---|---|
| 1 | A claim is on the **company**, never a product. The form is titled "Claim <Company>". A product page pre-fills the company and names the product. |
| 2 | The claim form has no plan question. Every approved claim lands on Free. |
| 3 | The claim form has a required box: "I represent this company and accept the vendor terms." We store who, when, version, IP. |
| 4 | A claim on a company that already has seats goes to its owner seats to accept or decline. AECi steps in only if nobody answers in 7 days. |
| 5 | Managed is sold as **licenses** on a billing account, assigned to products. Several products can hold different plans under one bill and one term. |
| 6 | Licenses have a **source**: Stripe, invoice (PO or bespoke deal, recorded by AECi with an invoice reference and end date), or complimentary (pilot, end date, no card). |
| 7 | Prices: $250 a year, $25 a month. Monthly has **no commitment**. No volume tiers; a volume deal is an invoice-sourced grant. |
| 8 | Payment is **Stripe** (Checkout launched from our portal, Stripe Billing for renewals, card by default, Stripe invoice on request). Pilot and founding discounts are Stripe coupons. The per-vendor price override is retired. |
| 9 | The Managed plan agreement is accepted by the required box on the Stripe checkout page. A new version binds at the next renewal or purchase, announced in the 30-day email. Nothing is re-signed mid-term. |
| 10 | Only owner seats buy. One Stripe customer per billing account; a second purchase changes quantity. |
| 11 | A license, once assigned, stays on its product until renewal. Unassigning early is a request to AECi, approved in the admin panel. A vendor may flag a product "release license at renewal" for a sunsetting product. |
| 12 | Fewer licenses than assigned products at renewal: the vendor chooses before the date, else oldest assignment keeps the license and we email. |
| 13 | Failed card: Stripe retries on its schedule and emails the vendor. Managed stays on through retries. When Stripe cancels, the product drops to Free. |
| 14 | When Managed ends, the Managed fields are **handed back** to AECi: the text stays live, the vendor loses the edit right, and promote may update the field again. Nothing reverts, nothing is deleted. |
| 15 | A seat revoked changes nothing in billing. A banned vendor's subscription is cancelled at term end, no refund. |
| 16 | The billing account has a billing email separate from any seat, defaulted to the buyer's email at checkout. Receipts, failed-payment notices and renewal emails go there and to every seat. |
| 17 | The vendor portal gets a **Billing** tab: licenses, sources, assignments, Stripe link, term dates, acceptance records. The admin panel shows the same read-only, plus grant and approve actions. |
| 18 | Build the billing-account table now with one row per vendor so teams (several billing accounts per vendor) need no data migration later. Show nothing for it in the UI yet. |

Ruled 2026-10-14: existing grants with no end date back-fill as open-ended complimentary licenses, Chris sets dates later (E1). "Ban a vendor" is the ban of the last unbanned seat; it flags every live license cancel-at-term-end (E4). A claim on an already-seated company keeps the claim button; the form says the company's team will confirm them, with the 7-day fallback (E3). Connector-vendor claims are approved like any other; the alert and queue row carry a flag and Chris contacts them directly; the provision-connector-seat path is retired (E3, E4). Hand-back needs no new fence: promote's wholesale fence on a claimed vendor (`REVIEW_APP_PROMOTE_API.md` §4a) gets one narrow opening for the Managed-only fields on a product with no live license (E6). Every other promote change to a claimed vendor becomes a proposal the owner accepts or declines, built before the pilot (E6b, AECI-1341).

Rulings still needed: none (checked 2026-10-15, AECI-1369). The rulings the E1 to E4 planning raised were settled on 2026-10-14 and are the paragraph above.

Parked for a later discussion, each with a Linear issue (AECI-1342 to AECI-1344, in order):

- Teams within a vendor: several billing accounts, each owning products.
- Connector vendors and licenses.
- Sales tax, and whether $250 up front is recognised over twelve months (accountant).

## 3. The process

1. **Claim.** Vendor clicks "Claim <Company>" on a company or product page. Form: name, role,
   work email, LinkedIn (optional), note (optional), the terms box. On send: on-screen receipt,
   email receipt, alert to AECi. Record: claim request plus terms acceptance.
2. **Check.** AECi checks domain, LinkedIn, existing seats, competing claims. Decline sends an
   email and ends. Approve: if the company has no seats, create the account, the owner seat and
   the billing account; every product is Free. If it has seats, the owners accept or decline the
   new seat. Approval email carries the sign-in link, what Free includes and how Managed works.
3. **Portal.** Sign in by one-time link. Dashboard shows company details and the product list;
   each product carries its plan badge. Free edits work at once. Owners see the Billing tab.
4. **Buy licenses.** An owner opens Billing, picks a quantity and annual or monthly, and is sent
   to Stripe Checkout with the billing account carried along. The checkout requires the Managed
   agreement box. Stripe charges and emails a receipt. Our webhook (or, at first, an admin after
   the receipt) sets the license count and term dates on the billing account. Email: "You have N
   Managed licenses until <date>."
5. **Pilot or invoice deal.** AECi grants N licenses with source complimentary or invoice, an end
   date and a reference, in the admin panel. Same email, with the free or invoiced wording.
6. **Assign.** In Billing the owner assigns each license to a product. The product becomes Managed
   at once: Managed fields unlock and the public page updates. Products with no license stay Free.
   Mixed plans under one bill follow from this.
7. **Add later.** Buying more is a quantity change. Stripe pro-rates the current period. New
   licenses land in the pool unassigned.
8. **Thirty days before the end date** (annual, invoice and complimentary only): automatic email to
   every seat and the billing email with the date, the price, the license count, any terms change,
   and how to opt out or reduce. Reductions and early unassignments are requests to AECi.
9. **End date.** Annual with no opt-out: Stripe renews, dates move a year. Opt-out: AECi cancels
   in Stripe before the date, licenses end on it. Complimentary or invoice: licenses end unless
   replaced by a purchase. Monthly: runs until cancelled from the Stripe portal or by email.
10. **Licenses end.** Each affected product drops to Free automatically. Managed fields are handed
    back to AECi and stay live. Banner on the product with the end date and a "Get licenses"
    button. Nothing entered is removed. Email: "Managed has ended for <products>."
11. **Side paths.** Refund within 14 days on request. Abuse or misrepresentation lets AECi end
    licenses and keep or revoke seats. A chargeback drops the products to Free until settled.

## 4. The two agreements

- **Vendor terms** (at claim): who "you" means (claimant and company, authority to bind), who may
  claim, truthfulness, content rights and licence to publish (incl. name and logo permission, no
  confidential content), AECi may edit or remove content, no vendor-arranged reviews, claimed is
  not endorsed, plans never affect ranking or reviews, hand-back, seats and revocation, ending a
  claim, personal data, liability, indemnity, governing law, how changes bind (30-day email),
  general terms (precedence, notices, assignment, severability).
- **Managed plan agreement** (at checkout): what a license is and does, prices and the two
  billing options, annual renewal and 30-day notice, monthly cancel-any-time, 14-day refund,
  licenses stay assigned until renewal, hand-back on lapse, suspension for abuse or non-payment,
  liability cap at twelve months of fees (with the standard exclusions), changes bind at the next
  renewal (monthly: 30-day email), plus who accepts and authority, card authorization, price
  changes never mid-term, tax line, refund mechanics, no promise of results, term and survival,
  general terms (precedence incl. a grant's own written deal, notices, assignment, severability).

Both live at versioned URLs under `/legal/`: `/legal/vendor-terms` and `/legal/managed-plan-agreement`,
with each superseded version at `/legal/<slug>/v<version>` (`STAGE_1_SPEC.md` §27.3). The acceptance
store is `agreement_acceptances` (`DATABASE_SCHEMA.md` §8.6d). Store for each acceptance: who (the claimant's email and
request at claim time, the seat once one exists), time, version, billing account, source (claim or
checkout), and the Stripe session id for the plan agreement. IP and user agent are recorded on the
claim path only; the checkout acceptance is written from the Stripe webhook and has neither. A one-hour lawyer read before the first
paid license is recommended. This document is not legal advice.

*As built, AECI-1366 (2026-10-15).* The box reads "I represent this company and accept the vendor
terms" and links `/legal/vendor-terms`. It is required on every claim form, including a typed-in
listing request, whose acceptance names the `listing_requests` row (`listing_request_id`, migration
0078) because there is no claim. The server stamps the version, IP and user agent. The email receipt
in step 1 is `claim-received`, at most one per address per day, with no link that grants anything
(`VENDOR_PROGRAM_PAGE_SPEC.md` §15.3).

## 5. Epics

In build order. The numbers are the order. E1 to E8 are enough to seat pilot vendors on
complimentary licenses. E9 (Stripe) must land before the first pilot end date. Each is a
Linear epic. E1 to E4 have sub-issues filed 2026-10-14 (AECI-1350 to AECI-1375); each epic carries its plan and findings as a comment.

| # | Epic | What it delivers | Needed for | Depends on |
|---|---|---|---|---|
| E1 (AECI-1331) | **Billing accounts and licenses** (data model) | `billing_accounts` (billing email, Stripe customer id), `licenses` (source, start, end, reference, assigned product, release-at-renewal and cancel-at-term-end flags, terms version). The owner flag on seats already exists (`profiles.seat_owner`); invite-accepted seats stay non-owner. One billing account per vendor, created at claim approval and back-filled for existing vendors. Plan resolution reads "does this product hold a live license" instead of the vendor-wide row. The old entitlement row and the price override are retired. Audit rows for every change. | pilot | none |
| E2 (AECI-1332) | **Agreements** | Vendor terms page and Managed plan agreement page, versioned, with the acceptance store and the renewal-notice wording. Lawyer read. | pilot | none (E2.4 waits for E1.1) |
| E3 (AECI-1333) | **Claim is on the company** | Form retitled, product-page entry pre-fills the company, plan question removed, vendor-terms box with acceptance record, receipt email to the claimant, approval always Free, owner seat on first approval, "company already has seats" routed to its owners with a 7-day AECi fallback, approval email rewritten. | pilot | E1.2, E2.1, E2.3, E2.4 (E3.1, E3.2 start now) |
| E4 (AECI-1334) | **Admin: grants and approvals** | Grant complimentary or invoice licenses with end date and reference, approve early-unassign requests, read-only Billing view per vendor, cancel-at-term-end on ban. Replaces the set/renew/clear entitlement screen. | pilot | E1.1, E1.3, E1.6, E2.4 |
| E5 (AECI-1335) | **Vendor Billing tab, assignment** | Licenses with source and dates, assign and release-at-renewal, request early unassign, billing email, acceptance records. Owner-only. No buy button yet. | pilot | E1.6, E4.4 |
| E6 (AECI-1336) | **Term end and hand-back** | Daily job: 30-day email with price, count and terms-change notice; automatic lapse on the end date; hand-back of Managed fields to AECi (ownership fence lifts, content stays); cache purge; fewer-licenses-than-products rule; "ends today" panel bug gone. | pilot | E1.3, E1.7, E4.2 |
| E6b (AECI-1341) | **Proposed promotions for claimed vendors** | Promote proposes, never overwrites, once a company is claimed: a proposals store written for skipped rows (new product, changed fenced fields), a portal "Proposed changes" list for owner seats to accept or decline, acceptance applied in an audited batch with purge, review app told in `skipped[]`. Hand-back fields are the one direct write. | pilot | E1.2, E6 |
| E7 (AECI-1337) | **Emails and notifications** | New: claim received, licenses on, licenses added, 30-day notice, payment failed (ours, alongside Stripe's), Managed ended, new product added to your company (Free). Rewritten: claim approved, expiry warning. Registry and `NOTIFICATIONS.md` regenerated. | pilot | E1 (templates for E3, E4 ship inside those epics) |
| E8 (AECI-1338) | **Public copy and help center** | Vendor program page, plans page, claiming page, your-seat page, new billing page, FAQ: licenses, both prices, no commitment on monthly, 14-day refund, hand-back on lapse. Remove "invoice or purchase order", "within 48 hours", the pilot mention, the plan-interest question, the Managed inquiry dialog. Stripe-specific lines wait for E9. | pilot | E1 to E7 (Stripe lines wait for E9) |
| E9 (AECI-1339) | **Stripe** | Product and two prices in Stripe, the buy and add buttons on the Billing tab launching Checkout with the billing account carried along and the agreement box required, Customer Portal with cancel allowed on monthly only, coupons for pilot or founding discounts, webhook in the API Worker for checkout completed, invoice paid, payment failed, subscription deleted, each writing licenses in an audited batch. | first paid license | E1.1, E2.2, E2.4, E5 |
| E10 (AECI-1340) | **Spec and doc sync, retirements** | Rewrite Paid Tiers §5, §7, §8, §13; Vendor Portal claim approval and §6.18; Program Page spec §15; Stage 2.1 pilot dates; Data Readiness open questions; Database Schema; API Contracts; ADR 0037 superseded by a new ADR. Close or re-scope AECI-1114, 1157, 1294, 1313, 1324, 1325, 1326, 1327, 1328, 1290. Parking issues for proposed promotions, teams, connector vendors, sales tax. | alongside all | all |

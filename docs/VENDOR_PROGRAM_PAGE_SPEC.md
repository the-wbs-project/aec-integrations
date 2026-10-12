# AEC Integrations — Vendor Program Page Specification

**Version:** 0.1, build contract
**Date:** 2026-10-12
**Status:** Build contract. Admitted into **Stage 2.5** by operator decision on 2026-10-12, as the sixth named exception to its "no new surface area" rule (`STAGE_2_5_SPEC.md` §14). It turns the marketing review's requirements draft ("For vendors" marketing page, 2026-10-12) into a contract checked against the code. Where the draft and the code disagreed, §1.2 records the ruling.
**Supersedes:** nothing. The draft stays a marketing-side input; this doc is the build truth.
**Inherits from:** Stage 1 / 1.5 / 2. Every constraint carries. The one most at risk here is the no-pay-for-placement firewall (`STAGE_2_PAID_TIERS_SPEC.md` §3.2): this page sells a plan, and nothing on it may suggest the plan buys position (§8).
**Companion docs:** `STAGE_2_PRODUCT_DOCS_SPEC.md` §5 (the `/docs/vendors/plans` page this page sits beside), `ANALYTICS.md` §4 (the `plan_*` events, §9 here), `CACHE_STRATEGY.md` (route tag, §2), `API_CONTRACTS.md` (`POST /api/plan-inquiries`, `GET /api/vendor/me`, §5 and §7), `DESIGN.md` (navigation rule, §2.4), `docs/email.md` (the inquiry receipt and alert, §7).

> **Data-layer note.** The page adds no write and no table. Its one new read is an existing endpoint (`GET /api/vendor/me`), called from the browser only. Nothing here touches `audit_log`, promote, or the rate limiter.

---

## 1. Purpose

A public landing page for AEC software vendors at **`/vendor-program`**.

- **Primary goal:** a vendor visit ends in a claim request for a listing. Claims are free.
- **Secondary goal:** a Managed inquiry.
- **Audience:** product marketing, partnerships or integrations leads, and founders at AEC software vendors. Many arrive from their own product's listing, a LinkedIn post, or outreach, often on a phone.
- **Relationship to the docs:** `/docs/vendors/plans` stays the detailed reference. The two pages link to each other.

### 1.1 Decisions settled 2026-10-12

| # | Decision | Ruling |
|---|---|---|
| 1 | Launch timing | **Public now.** Indexable, in the sitemap, linked from the footer. |
| 2 | Founding pilot on the page | **No.** The pilot stays in private outreach. |
| 3 | Annual price | **Show it.** $25 a month per product, and $250 a year per product. |
| 4 | Reply-time promise | **No new promise.** The existing line "We reply to most messages within a couple of business days" (`PLAN_INQUIRY_REPLY_PROMISE` and its copies) is reused unchanged. No "two business days" line. |
| 5 | Inquiry routing | **Email, as built** (AECI-1279). No CRM. |
| 6 | URL | **`/vendor-program`.** `/vendors` stays a 301 to `/products` (AECI-165). |

### 1.2 Where the draft and the code disagreed

| Draft | Code | Ruling |
|---|---|---|
| URL `/vendors` | A permanent redirect to `/products` (`removedIndexRedirect`, `apps/web/src/server-runtime.ts`). The index was removed on purpose. | `/vendor-program`. |
| Claim is "sign-in, then the claim flow" | A claim needs no account. It is per listing: `/products/:slug/claim` and `/vendors/:slug/claim`, both `RequestForm` with `kind: 'claim'`. | "Claim your listing free" scrolls to Find your product (§6). A result leads to that listing's claim form. |
| "Submit your product" on a miss | No submission flow exists. | A miss links to `/contact`. A real flow is an open decision (§13). |
| Form: name, work email, company, products, message | `PlanInquirySubmitSchema` has `email`, `company` and optional `details` ("Which products, and anything we should know?"). | Reuse the form unchanged. Products go in `details`. A `name` field is an open decision (§13). |
| Nav link "For vendors" in the site nav | `DESIGN.md` Navigation: the header row is public-directory-only, and any new item needs a re-measure (AECI-669). | Footer only (§2.4). The header link is an open decision (§13). |
| New events `vendor_cta_clicked`, `managed_inquiry_submitted`, `claim_started`, `claim_completed`, `vendor_page_viewed` | `plan_cta_clicked`, `plan_inquiry_submitted` and `claim_requested` already ship. | Extend the existing events (§9). One new event. |
| Signed-in variants | No app-wide plan signal. Plan data lives in `VendorPortalStore`, which is not root-provided. | A root-level probe, browser-only (§5). |
| "Verify trades, audiences and phases drive browse pages" | They do: `/trades`, `/audiences`, `/phases` and their `:slug` pages, and the `/search` facets. | Copy may say buyers find products on those pages and filters. It may not say Managed ranks a product higher (§8). |
| Draft §9, fixes to `/docs/vendors/plans` | Most shipped on 2026-10-12: the top button row, the full-width Managed card button, the closing panel, the rail card and the phone bar (`docs/docs-plans-cta.ts`). | §10 lists only what is left. |

---

## 2. Route, caching and SEO

### 2.1 Route

- A `loadComponent` entry in `apps/web/src/app/app.routes.ts`, with no resolver, like `about`.
- Component: `apps/web/src/app/vendor-program/vendor-program.ts`.
- The page is static. Its body needs no API data at SSR time.

### 2.2 Caching

- Add `/vendor-program` to `ROUTE_CACHE_PATTERNS` in `apps/web/src/server-runtime.ts` with the `/about` TTLs.
- Add it to `cacheTagInputsForPath` in `apps/web/src/server/cache-tags.ts` as `{ route: 'index' }`, like `/about` and `/methodology`.
- The SSR HTML is visitor-neutral. Every signed-in variant is applied after hydration (§5).

### 2.3 SEO and sharing

- `MetaService.setStaticPageMeta`, indexable, with `canonicalUrl('/vendor-program')`.
- **OG image:** a dedicated 1200×630 card built for LinkedIn, emitted as an absolute URL with an `og:image:alt` pair, the way `setHomeMeta` does it. `setStaticPageMeta` takes no image today. Add an optional `ogImage` and `ogImageAlt` to it rather than adding a page-specific method.
- **Sitemap:** add the URL in `apps/web/src/server/sitemap.ts` beside `/methodology`.
- **No pricing structured data** until the price is final. The price is "agreed with you" per company (§7), so a schema.org `Offer` would overstate it.
- **Target searches**, for the title and description only: "list my software", "AEC software directory listing", "construction software integrations directory". Do not stuff them into the body.
- The page links into `/docs/vendors/*`, which stays noindex until AECI-1253. Linking an indexable page to noindex pages is correct. Do not "fix" it.

### 2.4 Inbound links

| From | Link | Note |
|---|---|---|
| Footer, Company column (`layout/site-footer.ts`) | "For vendors" | After Methodology. |
| Product detail page, beside "Claim this listing" | "Is this your product?" → `/vendor-program` | Visitor-neutral, so it stays in the cached HTML. |
| `/docs/vendors/plans` | A line in the intro | §10. |
| The `claim-approved` email | One line with the link | An approved claimant is on a plan and can act on it. `claim-rejected` gets no link, and `claim-submitted-alert` goes to support. Edit the template, then run `pnpm docs:notifications` (`apps/api/src/lib/notifications/registry.ts`). |

The header row gets no link (§1.2).

---

## 3. Page sections, in order

1. **Hero.** A headline about the buyer reality: contractors compare your integrations here. A subhead saying a listing is free to claim. Both calls to action (§4). No statistics.
2. **The problem.** Two or three sentences: buyers judge your integrations on information you may not have written.
3. **Find your product** (`id="find-your-product"`). §6.
4. **What Free gives you.** Three or four outcomes, from the docs page's "What every plan includes": keep company and product details current, claim and maintain the integrations you build, invite colleagues, work through the checklists.
5. **What Managed adds.** One outcome per line, each linking to its doc page. Take the wording from the docs page's "What Managed adds" so the two never drift:
   - How teams use it, in your own words.
   - The trades, audiences and phases each product serves. Products appear on those browse pages and in the search filters.
   - Links to your integrations page and API docs.
   - Your answer on which data each integration moves. It counts toward the agreement label, the same as your partner's.
   - The integrations you deliver through a connector.
   - Public answers to reviews, checked before they go live.
   - We tell search engines when you update a page.
6. **Plan cards.** Free and Managed side by side (§4, placement `card`). Reuse `DocsPlansComparisonComponent`'s cards. Do not copy them.
7. **How listings are sorted.** "Every listing is sorted the same way: how well it matches the search, then how complete it is. Your plan is not part of that." Link to `/docs/trust/how-ranking-works`. Write it as the reason buyers trust the directory, not as a disclaimer.
8. **Coming soon.** Performance reporting for Managed, labelled as not available yet. Reuse the docs page's wording.
9. **FAQ.** Who can claim; how long approval takes (only once §12 confirms a time); several products; invoice or purchase order; what happens when a plan ends; whether paying affects reviews or ranking. Use a native `<details>` list.
10. **Closing panel.** §4, placement `bottom`.

One `h1`, then `h2` per section, in this order.

---

## 4. Calls to action

Two actions, with the same wording everywhere.

| Action | Text | Goes to |
|---|---|---|
| Claim | "Claim your listing free" | `#find-your-product` on this page. On `/docs/vendors/plans` it stays `CLAIM_PATH`. |
| Managed | "Talk to us about Managed" | The plan inquiry dialog in place. The `href` stays `/contact?topic=managed` (`MANAGED_CONTACT_HREF`) for no-JS and new-tab clicks. |

Never "Get Managed", "Start now" or "Buy". There is no checkout.

### 4.1 Placements

| Placement | `placement` value | What |
|---|---|---|
| Hero | `top` | Both buttons side by side, on the first screen on desktop and phone. Managed is filled. Claim is outlined. |
| Plan cards | `card` | "Claim your listing free" on Free, secondary style. "Talk to us about Managed" on Managed, full card width, filled. The existing reply line sits under it. |
| Find your product | `search_result` | "Claim this listing" on a result (§6). |
| Rail | `rail` | Desktop: a small card, "Managed · $25 a month per product · Talk to us". It appears once the hero has scrolled away. |
| Phone bar | `mobile_bar` | Below `lg`: a slim bar fixed to the bottom. It hides while any full CTA is on screen, and it never covers the inquiry form or the closing panel. |
| Closing panel | `bottom` | A full-width band before the footer, with the headline "Tell the full story of your product" and the line "$25 a month per product, or $250 a year, billed by invoice or purchase order. If a plan ends, nothing you entered is removed." A large Managed button, with "Claim your listing free" as a text link beside it. Under the button, the two steps already in `DocsPlansCtaPanelComponent`. |

**Reuse, don't fork.** The rail, the phone bar and the closing panel already exist in `apps/web/src/app/docs/docs-plans-cta.ts`. Move them to `apps/web/src/app/shared/plan-cta/`, give them a `page` input (§9), and have both pages mount them. The phone bar's `IntersectionObserver` logic and its `data-plans-cta` contract stay as they are. Mount exactly one `aec-plan-inquiry-host` on the page.

**Annual price.** Add `MANAGED_ANNUAL_PRICE_CENTS = 25000` beside `MANAGED_LIST_PRICE_CENTS` in `packages/shared/src/entitlements.ts`. Format it with `formatPlanPrice`. Never hard-code "$250" in a template.

---

## 5. Signed-in vendor

The SSR HTML is always the signed-out page. After hydration:

| Visitor | Change |
|---|---|
| Signed out, or signed in without a vendor seat | None. |
| Vendor seat, Free company | "Claim your listing free" becomes "Go to your portal" (`/vendor`). The inquiry form prefills `company` with the vendor's name. |
| Vendor seat, Managed company | As Free, plus the rail card, the phone bar and the closing panel's Managed button are hidden. |

**The probe.** Add a root-provided `VendorPlanStatus` in `apps/web/src/app/vendor/`, on the `RoleStatus` pattern (`auth/role-status.ts`):

- It calls `GET /api/vendor/me` once, only when `VendorStatus.isVendor()` is true, only in the browser.
- It exposes `vendorSlug`, `vendorName` and `managed` signals, all `null` until resolved. `managed` uses `isManaged` from `vendor/vendor-plan.ts`.
- It does not reuse or provide `VendorPortalStore`. That store is portal-scoped on purpose.
- A failed call leaves the page signed-out. It never shows an error.

**Prefill.** `PlanInquiryForm` prefills `email` from the session today, one-shot. Add the same one-shot prefill for `company` from `VendorPlanStatus.vendorName`. A visitor's own edit always wins.

---

## 6. Find your product

- Reuse `aec-search-autocomplete` (`apps/web/src/app/search/search-autocomplete.ts`) with its own `inputId`, a visible label, and the placeholder "Search for your product or company". It searches in the browser only, so it does not affect the cached HTML.
- **A result.** Choosing a product or vendor hit shows a result card: the name and "Claim this listing", which links to `/products/:slug/claim` or `/vendors/:slug/claim`. It does not navigate to the listing first. The card also offers "View the listing".
- **A miss.** Copy: "Your products may already be listed, under a different name. If you cannot find them, tell us." "Tell us" links to `/contact`.
- The no-JS fallback form goes to `/search`, as it does in the header.
- Copy says "may already be listed", never "are already listed".

---

## 7. Managed inquiry

- Reuse the shipped dialog and form (`apps/web/src/app/shared/plan-inquiry/`) and `POST /api/plan-inquiries` unchanged. AECI-1279 is the contract: one row in `plan_inquiries`, a receipt to the visitor (at most one per address per UTC day), and an alert to `SUPPORT_EMAIL` with reply-to set to the visitor.
- The form's thanks line already says what happens next. It stays the single source for that copy.
- The only form change is the `company` prefill (§5).

---

## 8. Copy rules

- Sentence case. No em dashes. The brand is always "AEC Integrations". Every string is `i18n`'d or `$localize`d.
- Never say the catalog is vendor-verified. Never invent metrics, logos or testimonials.
- **The firewall.** Nothing may suggest that a plan affects ranking, placement, whether a review is published, or how an agreement label is worked out. The ranked product fields are editable on Free. Managed fields do not feed search ranking. Do not imply Managed improves position.
- "Your products may already be listed", never "are already listed".
- Catalog counts, if any appear, are read from the API at build or render time, never typed in. At launch there are none (§13).
- The page describes only what ships, except the labelled "Coming soon" section. That is the same ruling as the docs page.

---

## 9. Analytics

Extend the events that ship (`apps/web/src/app/analytics/analytics.ts`, `docs/ANALYTICS.md` §4). Do not add parallel ones.

| Event | Change |
|---|---|
| `plan_cta_clicked` | Add `page`: `docs_plans` or `vendor_program`. Add placement `search_result`. Existing values keep their meaning. `plan: 'free'` now covers "Claim your listing free" and "Claim this listing" on this page. |
| `plan_inquiry_submitted` | Add `page`, with the same values. `contact` stays a placement for the `/contact` form, with `page` absent. |
| `vendor_product_search` | **New.** Fired once per settled non-empty query in Find your product. Properties: `results_count`. Never the query text: it can name a company before it has agreed to anything. |
| `claim_requested` | No change. It fires when a claim form is sent, from any entry point. |

Not added, and why:

- `vendor_page_viewed`: `$pageview` with `pathname = /vendor-program` already counts it.
- `claim_completed`: approval is an admin action, not a page event. It lives in `audit_log` and the admin claim queue.

**UTM.** LinkedIn and outreach links carry `utm_source`, `utm_medium` and `utm_campaign`. PostHog records them on `$pageview` without code. The marketing repo owns the link convention.

---

## 10. `/docs/vendors/plans` deltas

What remains from the draft's §9, after the 2026-10-12 CTA review shipped:

1. Pass `page: 'docs_plans'` on every CTA and inquiry event (§9).
2. Mount the shared CTA components from `shared/plan-cta/` (§4.1). No visual change.
3. Add one intro line linking to `/vendor-program`.
4. Show the annual price in the closing panel's terms line, from the new constant (§4.1).
5. Update `STAGE_2_PRODUCT_DOCS_SPEC.md` §5's Plans entry in the same PR.

The top button row, the full-width Managed card button, the closing panel, the rail card and the phone bar already ship. Do not rebuild them.

---

## 11. Design and accessibility

- Follow the CLAUDE.md design checklist: critique, a Mobbin anchor, craft, polish, `npx impeccable detect` against the rendered page, axe-core.
- Use the site layout and components. Plain and trustworthy, not a SaaS hype page (`PRODUCT.md`, `DESIGN.md`). Light only.
- Mobile first. Test at 375px first.
- One heading order. Visible focus on the search box and every button. Button contrast meets WCAG AA. The phone bar reserves its height and never traps focus (WCAG 2.2, 2.4.11), as the docs bar already does.

---

## 12. Facts to verify on publication day

| Fact | Where to check |
|---|---|
| $25 a month per product is the public list price | `MANAGED_LIST_PRICE_CENTS` |
| $250 a year per product is the public annual price | Chris, then `MANAGED_ANNUAL_PRICE_CENTS` |
| A claim approval time, if the FAQ states one | The admin claim queue's real turnaround |
| What a confirmed data flow shows publicly | A pair page with a vendor attestation |
| Any catalog count | The API, on the day |

---

## 13. Open decisions

| # | Question | Default until decided |
|---|---|---|
| 1 | What proof may appear: checked catalog counts, or quotes used with permission? | None. |
| 2 | A claim approval time in the FAQ? | The FAQ says we review each claim and email the result, with no time. |
| 3 | A "For vendors" link in the header row? | Footer only. A header link needs a `DESIGN.md` change and the AECI-669 re-measure. |
| 4 | A `name` field on plan inquiries? | No. It is a schema, migration and email-template change. |
| 5 | A "Submit your product" flow for a product not in the catalog? | A miss links to `/contact`. |

---

## 14. Issue map

The epic and its children live in the Linear project **Stage 2.5 Hardening**. AECI-1290 runs last. Each issue's `**Spec section:**` line names this doc and one section.

| Issue | Section |
|---|---|
| **AECI-1281** Epic: vendor program page | §1 |
| **AECI-1283** Route, caching, SEO, OG image, sitemap, inbound links | §2 |
| **AECI-1284** Page sections and copy | §3, §8 |
| **AECI-1285** Shared CTA components, placements, annual price | §4 |
| **AECI-1286** `VendorPlanStatus` probe and signed-in variants | §5 |
| **AECI-1287** Find your product | §6 |
| **AECI-1288** Analytics: `page`, `search_result`, `vendor_product_search` | §9 |
| **AECI-1289** `/docs/vendors/plans` deltas | §10 |
| **AECI-1290** Publication-day fact check | §12 |

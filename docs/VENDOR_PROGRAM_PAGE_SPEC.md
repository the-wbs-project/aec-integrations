# AEC Integrations — Vendor Program Page Specification

**Version:** 0.2, build contract (2026-10-12 rulings: own benefit copy, the claim panel, new-tab doc links)
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
| "Submit your product" on a miss | No submission flow exists. | "Ask us to add it" links to `/contact?topic=add-product` (§6, settled 2026-10-12). A real submission flow remains a future option (§13). |
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

1. **Hero.** The headline (settled 2026-10-12): "Your products may already be listed here. Make sure buyers read your version." A subhead saying the catalog comes from public sources, a claim is free, and a listing kept current reads "Vendor maintained" with the date. Both calls to action (§4). No statistics.
2. **What changes when you claim** (settled 2026-10-12, replaces "The problem"). One or two sentences of the problem, then a before and after panel with the two real maintenance labels: "AEC Integrations maintained" before, "Vendor maintained · Updated" and a date once the vendor saves a change or confirms a page is right (`STAGE_2_ATTESTATIONS_SPEC.md` §13.9, `STAGE_2_PAID_TIERS_SPEC.md` §13.8). Both labels are drawn by the listing's own `shared/maintenance-marker` component, never retyped, so the page cannot show wording a listing does not. The example date is today, in UTC. A claim alone does not change the label, so the copy never says it does.
3. **Find your product** (`id="find-your-product"`). §6.
4. **What a free claim gets you.** Three outcomes: your listing in your words, your integrations owned by you, a complete listing at no cost. The seat and checklist links stay, in the lede and the first item.
5. **What Managed adds.** The price and terms line first, from the shared constants. Then five lines in three jobs: explain what your product does on a project (how teams use it; trades, audiences and phases), back up your integrations (more detailed information about integrations; connector integrations), and answer buyers in public (review replies). Each bold lead-in links to the docs page that explains it. Ruled 2026-10-12: the integrations page and API docs links line and the confirmed data flows line are one entry, "More detailed information about integrations (additional URLs, data flow, etc.).", which keeps both docs links. The plan cards merge the same two items into the same line. "Search engine notice" stays on the plan cards and the docs page, not in this list.
6. **Plan cards.** Free and Managed side by side (§4, placement `card`). Reuse `DocsPlansComparisonComponent`'s cards. Do not copy them.
7. **How listings are sorted.** "Every listing is sorted the same way: how well it matches the search, then how complete it is. Your plan is not part of that." Link to `/docs/trust/how-ranking-works`. Write it as the reason buyers trust the directory, not as a disclaimer.
8. **Coming soon.** Performance reporting for Managed, labelled as not available yet, framed as what it will let the vendor see. It keeps the sentence that it never changes where a listing ranks or appears.
9. **FAQ.** Who can claim; how long approval takes (generally within 48 hours, §12); several products; invoice or purchase order; what happens when a plan ends; whether paying affects reviews or ranking. Use a native `<details>` list.
10. **Closing panel.** §4, placement `bottom`.

One `h1`, then `h2` per section, in this order. What Managed adds groups its lines under three `h3`s, above the plan cards' own `h3`s.

**This page carries its own benefit copy (settled 2026-10-12).** `/docs/vendors/plans` stays the feature reference. This page is the pitch. Every Free and Managed line says three things, in order: what the vendor can do, what the vendor gains, and what the buyer or the end user gains. The end user is the person who uses the integration on a project. The facts stay aligned with the docs page. The sentences do not have to match, and no test makes them. Two things stay shared: the plan cards (item 6, one component) and the sort rule (item 7, one i18n id, `@@app.docs.plans.sortRule`, which reads the same as the Plans page). `vendor-program/vendor-program-copy.component.spec.ts` pins only the sort rule and the Plans page fragments this page links to.

**Doc links open in a new tab (settled 2026-10-12).** Every link on this page to `/docs/*` opens in a new tab: the section links, the FAQ answers, "How ranking works" and "Compare every feature side by side". So does "View the listing" on a Find your product result. Each carries `target="_blank" rel="noopener"` and `aec-new-tab-icon`, the drawn icon plus the visually hidden "(opens in a new tab)". The reason is that a vendor reading the pitch keeps the claim one tab away. Conversion links stay in the tab: every claim link, the Managed inquiry, "Ask us to add it" and "Go to your portal". This is a page-scoped exception to `DESIGN.md`'s new-tab rule. `/docs/vendors/plans` keeps its links in the tab.

**Full width at desktop (settled 2026-10-12).** No narrow column with a blank right half: fill desktop width by layout. From `lg`, every section uses the whole `max-w-7xl` container, at 1024, 1280 and 1440px alike. Prose keeps a readable measure inside its column. The layout per section:

| Section | From `lg` |
|---|---|
| Hero | The copy and both buttons in the left seven of twelve columns. "How claiming works" in the right five: three numbered steps (find, claim, we review it), facts the FAQ already states. Not a heading. Hidden below `lg`. |
| What changes when you claim, Find your product, Coming soon, FAQ | A split: the heading (and lede) in the left five columns, the content in the right seven. What changes when you claim puts the two labels side by side on the right (stacked below `sm`). Find your product puts the box, the "ask us to add it" line and the result card on the right. |
| What a free claim gets you | The three outcomes in three columns from `lg`. One column below. |
| What Managed adds | A split: heading and terms line in the left four columns, the three jobs stacked in the right eight, each job's lines as a two-column list from `md`. |
| Plan cards | The shared cards side by side across the full width. |
| How listings are sorted | The Bone panel, split: heading and sort rule left, the trust line and link right. |
| Closing panel | The Forest panel, split: heading and terms left, the buttons and next steps right (`PlanCtaPanelComponent`'s `split` input). |

Phones stay one column.

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
| Rail | `rail` | **Not on this page** (2026-10-12): it reserved an empty column beside every section (§3). The rail card stays on `/docs/vendors/plans`, so the `rail` placement value stays in analytics for that page. |
| Phone bar | `mobile_bar` | Below `lg`: a slim bar fixed to the bottom. It hides while any full CTA is on screen, and it never covers the inquiry form or the closing panel. |
| Closing panel | `bottom` | A full-width band before the footer, with the headline "Tell the full story of your product" and the line "$25 a month per product, or $250 a year, billed by invoice or purchase order. If a plan ends, nothing you entered is removed." A large Managed button, with "Claim your listing free" as a text link beside it. Under the button, the two steps already in `DocsPlansCtaPanelComponent`. |

**Reuse, don't fork.** The rail, the phone bar and the closing panel already exist in `apps/web/src/app/docs/docs-plans-cta.ts`. Move them to `apps/web/src/app/shared/plan-cta/`, give them a `page` input (§9), and have both pages mount the phone bar and the closing panel. Only the docs page mounts the rail. The phone bar's `IntersectionObserver` logic and its `data-plans-cta` contract stay as they are. Mount exactly one `aec-plan-inquiry-host` on the page.

**Annual price.** Add `MANAGED_ANNUAL_PRICE_CENTS = 25000` beside `MANAGED_LIST_PRICE_CENTS` in `packages/shared/src/entitlements.ts`. Format it with `formatPlanPrice`. Never hard-code "$250" in a template.

---

## 5. Signed-in vendor

The SSR HTML is always the signed-out page. After hydration:

| Visitor | Change |
|---|---|
| Signed out, or signed in without a vendor seat | None. |
| Vendor seat, Free company | "Claim your listing free" becomes "Go to your portal" (`/vendor`). The inquiry form prefills `company` with the vendor's name. |
| Vendor seat, Managed company | As Free, plus the phone bar and the closing panel's Managed button are hidden. |

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
- **Ask us to add it (settled 2026-10-12).** Under the box, always: "Can't find your product? Ask us to add it." The link goes to `/contact?topic=add-product`. That topic shows a panel on the contact page whose button is the support `mailto:` with the subject ("Please add my product to AEC Integrations") and a prompt filled in: product name, website, and the products it integrates with. It reaches the same support mailbox as every other contact email. No API validates the topic, because it adds no field to any request. The link fires no analytics event (§9 is unchanged).
- **A miss.** Copy: "Your products may already be listed, under a different name. If you cannot find yours, ask us to add it." "Ask us to add it" links to `/contact?topic=add-product`. The line under the box stays.
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
- **Benefit lines (2026-10-12).** Each Free and Managed line names a feature, then the vendor's gain, then the buyer's or end user's gain (§3). A gain is an outcome a reader can check on a real page. It is never a number, a ranking effect or a promise about a label's value. The trades line may say buyers browsing or filtering by a trade find the products tagged with it. It may not say they find them sooner or higher. The data flow line may say the vendor's answer counts the same as its partner's. It may not promise any label.

---

## 9. Analytics

Extend the events that ship (`apps/web/src/app/analytics/analytics.ts`, `docs/ANALYTICS.md` §4). Do not add parallel ones.

| Event | Change |
|---|---|
| `plan_cta_clicked` | Add `page`: `docs_plans` or `vendor_program`. Add placement `search_result`. Existing values keep their meaning. `plan: 'free'` now covers "Claim your listing free" and "Claim this listing" on this page. |
| `plan_inquiry_submitted` | Add `page`, with the same values. `contact` stays a placement for the `/contact` form, with `page` absent. |
| `vendor_product_search` | **New.** Fired once per settled non-empty query in Find your product. Properties: `results_count`. Never the query text: it can name a company before it has agreed to anything. |
| `claim_requested` | No change. It fires when a claim form is sent, from any entry point. |

"Ask us to add it" (§6) fires nothing. It is not a plan call to action, so `plan_cta_clicked` would be wrong. A `$pageview` on `/contact` whose `$current_url` carries `topic=add-product` already counts the arrivals.

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
- **No narrow column with a blank right half: fill desktop width by layout** (2026-10-12). At 1024, 1280 and 1440px every section reaches the right half of the `max-w-7xl` container, by split, grid or side-by-side layout, never by stretching prose to 150-character lines. §3 lists the layout per section. `apps/web/e2e/vendor-program.spec.ts` checks it at all three widths.
- One heading order. Visible focus on the search box and every button. Button contrast meets WCAG AA. The phone bar reserves its height and never traps focus (WCAG 2.2, 2.4.11), as the docs bar already does.

---

## 12. Facts to verify on publication day

| Fact | Where to check |
|---|---|
| $25 a month per product is the public list price | `MANAGED_LIST_PRICE_CENTS` |
| $250 a year per product is the public annual price | Chris, then `MANAGED_ANNUAL_PRICE_CENTS` |
| A claim approval time: "Generally within 48 hours" | Confirmed by Chris 2026-10-12, "generally within 48 hours". Recheck against the admin claim queue's real turnaround |
| What a confirmed data flow shows publicly | A pair page with a vendor attestation |
| Any catalog count | The API, on the day |

---

## 13. Open decisions

| # | Question | Default until decided |
|---|---|---|
| 1 | What proof may appear: checked catalog counts, or quotes used with permission? | None. |
| 2 | A claim approval time in the FAQ? | **Settled 2026-10-12:** "Generally within 48 hours." The FAQ leads with that line, then says a person reads every claim and we email the result. |
| 3 | A "For vendors" link in the header row? | Footer only. A header link needs a `DESIGN.md` change and the AECI-669 re-measure. |
| 4 | A `name` field on plan inquiries? | No. It is a schema, migration and email-template change. |
| 5 | A "Submit your product" flow for a product not in the catalog? | **Settled 2026-10-12:** the contact path with a topic, `/contact?topic=add-product` (§6). A real submission flow remains a future option. |

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

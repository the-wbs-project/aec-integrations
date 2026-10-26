# AEC Integrations — Vendor Program Page Specification

**Version:** 0.4, build contract (2026-10-12 rulings: own benefit copy, the claim panel, new-tab doc links; §15 the claim dialog; Find your product removed and Free and Managed made one pattern; hero and claim copy, connector integrations out of the Managed pitch)
**Date:** 2026-10-12
**Status:** Build contract. Admitted into **Stage 2.5** by operator decision on 2026-10-12, as the sixth named exception to its "no new surface area" rule (`STAGE_2_5_SPEC.md` §14). It turns the marketing review's requirements draft ("For vendors" marketing page, 2026-10-12) into a contract checked against the code. Where the draft and the code disagreed, §1.2 records the ruling.
**Supersedes:** nothing. The draft stays a marketing-side input; this doc is the build truth.
**Inherits from:** Stage 1 / 1.5 / 2. Every constraint carries. The one most at risk here is the no-pay-for-placement firewall (`STAGE_2_PAID_TIERS_SPEC.md` §3.2): this page sells a plan, and nothing on it may suggest the plan buys position (§8).
**Companion docs:** `STAGE_2_PRODUCT_DOCS_SPEC.md` §5 (the `/docs/vendors/plans` page this page sits beside), `ANALYTICS.md` §4 (the `plan_*` events, §9 here), `CACHE_STRATEGY.md` (route tag, §2), `API_CONTRACTS.md` (`GET /api/vendor/me`, §5; `POST /api/plan-inquiries` until E8.1 removed it on 2026-10-19), `DESIGN.md` (navigation rule, §2.4).

> **Data-layer note.** §1 to §14 add no write and no table. Their one new read is an existing endpoint (`GET /api/vendor/me`), called from the browser only. **§15 (the claim dialog, AECI-1293) does add data:** a nullable `vendor_requests.plan_interest` column, a `listing_requests` table, `POST /api/requests/listing` and its audit row, and the two admin endpoints for it. §15.3 to §15.5 and §15.8 own them.

---

## 1. Purpose

A public landing page for AEC software vendors at **`/vendor-program`**.

- **Primary goal:** a vendor visit ends in a claim request for a listing. Claims are free.
- ~~**Secondary goal:** a Managed inquiry.~~ **Removed 2026-10-19 (E8.1, AECI-1398):** claim is the only Managed action. A plain "Questions? Contact us" link to `/contact` replaces the inquiry.
- **Audience:** product marketing, partnerships or integrations leads, and founders at AEC software vendors. Many arrive from their own product's listing, a LinkedIn post, or outreach, often on a phone.
- **Relationship to the docs:** `/docs/vendors/plans` stays the detailed reference. The two pages link to each other.

### 1.1 Decisions settled 2026-10-12

| # | Decision | Ruling |
|---|---|---|
| 1 | Launch timing | **Public now.** Indexable, in the sitemap, linked from the footer. |
| 2 | Founding pilot on the page | **No.** The pilot stays in private outreach. |
| 3 | Annual price | **Show it.** $25 a month per product, and $250 a year per product. **Revised 2026-10-13 (Chris):** the line reads "$25 USD a month or $250 USD a year per product, billed by invoice or purchase order." USD stays on each amount, because vendors outside the US read the page. The short price lines (rail, phone bar, Managed card, comparison row) read "$25 USD a month per product". The portal's plan panel sentence is not public. *As built (AECI-1357, 2026-10-17):* it now reads "Managed is $25 a month or $250 a year per product." for every vendor. **Revised 2026-10-19 (E8.2, AECI-1399):** the terms line reads "$25 USD a month or $250 USD a year per product." It names no payment method. The comparison row reads "$25 USD a month or $250 USD a year per product", and its billing row "Monthly with no commitment, or yearly". The rail, phone bar and Managed card keep "$25 USD a month per product". |
| 4 | Reply-time promise | **No new promise.** The existing line "We reply to most messages within a couple of business days" (`PLAN_INQUIRY_REPLY_PROMISE` and its copies) is reused unchanged. No "two business days" line. **Removed 2026-10-19 (E8.1, AECI-1398):** `PLAN_INQUIRY_REPLY_PROMISE`, the inquiry's copies and the Managed card's reply line went with the inquiry. The contact page keeps its own line. |
| 5 | Inquiry routing | **Email, as built** (AECI-1279). No CRM. **Removed 2026-10-19 (E8.1, AECI-1398):** there is no inquiry to route. Questions go to `/contact`. |
| 6 | URL | **`/vendor-program`.** `/vendors` stays a 301 to `/products` (AECI-165). |

### 1.2 Where the draft and the code disagreed

| Draft | Code | Ruling |
|---|---|---|
| URL `/vendors` | A permanent redirect to `/products` (`removedIndexRedirect`, `apps/web/src/server-runtime.ts`). The index was removed on purpose. | `/vendor-program`. |
| Claim is "sign-in, then the claim flow" | A claim needs no account. It is per listing: `/products/:slug/claim` and `/vendors/:slug/claim`, both `RequestForm` with `kind: 'claim'`. | "Claim your listing free" scrolls to Find your product (§6). A result leads to that listing's claim form. **Superseded 2026-10-12 by §15:** every claim control opens the claim dialog, which starts with Find it. The Find your product section is removed. |
| "Submit your product" on a miss | No submission flow exists. | "Ask us to add it" links to `/contact?topic=add-product` (§6, settled 2026-10-12). **Superseded 2026-10-12 by §15.4:** the claim dialog's typed-in step sends a `listing_request` (`POST /api/requests/listing`). |
| Form: name, work email, company, products, message | `PlanInquirySubmitSchema` has `email`, `company` and optional `details` ("Which products, and anything we should know?"). | Reuse the form unchanged. Products go in `details`. A `name` field is an open decision (§13). **Removed 2026-10-19 (E8.1, AECI-1398):** the form and `PlanInquirySubmitSchema` are gone. |
| Nav link "For vendors" in the site nav | `DESIGN.md` Navigation: the header row is public-directory-only, and any new item needs a re-measure (AECI-669). | Footer only (§2.4). The header link is an open decision (§13). |
| New events `vendor_cta_clicked`, `managed_inquiry_submitted`, `claim_started`, `claim_completed`, `vendor_page_viewed` | `plan_cta_clicked`, `plan_inquiry_submitted` and `claim_requested` already ship. | Extend the existing events (§9). One new event. **Removed 2026-10-19 (E8.1, AECI-1398):** `plan_inquiry_submitted` no longer fires. |
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
- The page links into `/docs/vendors/*`, which is indexable and in the sitemap since AECI-1253 (2026-10-12).

### 2.4 Inbound links

| From | Link | Note |
|---|---|---|
| Footer, Company column (`layout/site-footer.ts`) | "For vendors" | After Methodology. |
| Product detail page, beside the claim button ("Claim <Company>" since AECI-1365) | "Learn more about claiming" → `/vendor-program?vendor=<vendor slug>`, in a new tab | Visitor-neutral, so it stays in the cached HTML. Renamed 2026-10-24 from "Is this your product?", which read like a second claim button. It opens a new tab (`target="_blank"`, `aec-new-tab-icon`) so the visitor can return to the product page and claim there. A product with no vendor links to `/vendor-program` with no parameter. |
| `/docs/vendors/plans` | A line in the intro | §10. |
| The `claim-approved` email | One line with the link | An approved claimant is on a plan and can act on it. `claim-rejected` gets no link, and `claim-submitted-alert` goes to support. Edit the template, then run `pnpm docs:notifications` (`apps/api/src/lib/notifications/registry.ts`). |

The header row gets no link (§1.2).

**`?vendor=<slug>` (2026-10-24).** When the page loads with a `vendor` parameter, it reads `GET /api/vendors/:slug` in the browser after hydration and seeds the claim dialog with that company (`ClaimDialogService.setSeed`). Every "Claim your listing" then opens the dialog on the You step with "Claiming <Company>" and the "Claim <Company>" title (§15.2). "Change" still goes back to Find it. An unknown slug or a failed read seeds nothing, so the dialog starts on Find it as before. The cache key drops the query string (§2.2), so the SSR HTML is the same with or without the parameter. The seed clears when the page is left.

**Links to the listing request page (AECI-1474, §2.5).**

| From | Link | Note |
|---|---|---|
| `/vendor-program`, under the FAQ, beside "Questions? Contact us" | "Not listed yet?" then "Ask us to list your product" | A plain `routerLink`, same tab. Not tracked, like the contact link. |
| `/contact?topic=add-product`, the "Ask us to add your product" panel | "Request a listing", the primary button | The support `mailto:` becomes the second, bordered button. The topic keeps working. |
| The help pages `/docs/trust/listing-submissions` and `/docs/vendors/claiming-your-listing` | "listing request form" | They named only the dialog's "Not listed? Type it in" before. |

### 2.5 The listing request page (AECI-1474)

**Ruling 2026-10-24 (Chris).** Outreach needs one link that lands on a form to ask us to list a product. It is a simple page that shows the existing form inline. It is not the vendor program page with the dialog open.

- **Route.** `/vendor-program/list-your-product`, a `loadComponent` with no resolver, listed before `vendor-program` in `app.routes.ts`. Component: `apps/web/src/app/vendor-program/list-your-product.ts`.
- **The form.** The page embeds `ClaimDialogFlow`, the dialog's step component, with `embedded` set and the opening `{ page: 'list_your_product', entry: 'list_page', start: 'typed' }`. No BrnDialog and no `aec-claim-dialog-host`. It opens on the typed-in You step, with focus in "Product or company name". Opened on the typed-in step, the indicator counts two steps: You reads "Step 1 of 2" and Comments "Step 2 of 2" (ruling 2026-10-24). The submit, the receipt and the events are the typed-in path of §15.4 and §15.7. Embedded, the receipt has no "Done", because there is no dialog to close.
- **Back.** Back from the first step goes to the Find step, inline. Find is a detour here, so it shows no step indicator. A vendor whose product is listed after all can search, choose it and send a claim (`POST /api/requests/claim`) from the page. You and Comments still read "Step 1 of 2" and "Step 2 of 2" on that path. This is a ruled exception to §15.2's "after the first one the visitor saw".
- **Copy** (§8). The `h1` "Ask us to list your product", then the lede "Listing is free. Tell us the product and its website, and we take it from there." The lede does not repeat the list below it.
- **What happens next** (ruling 2026-10-24). Under the lede, an `h2` "What happens next" and a four-item ordered list. Each item has a bold title and one line of body:
  1. "Confirm your email." / "We email you a link. Your request is sent when you click it."
  2. "We review it." / "A person on our team checks the product's public pages."
  3. "We add the listing." / "We write it from those pages and add it to the directory."
  4. "You claim it." / "We email you so you can claim the listing and keep it current."

  It is styled as §3's "How claiming works" list: an accent number badge, `aria-hidden`, beside each item, and the `<ol>` carries the order. The ids are `@@listYourProduct.next.*`.
- **Headings.** The `h1`, then the "What happens next" `h2`, then the form panel's `h2` "Request a listing", so the flow's `h3` step headings keep a correct outline.
- **Layout** (§11). The standard canvas. From `lg` a 12-column grid: the explainer and the "What happens next" list in columns 1 to 5, sticky, and the form panel in 6 to 12. The list fills the left column beside the tall form, so it is not blank. Below `lg` they stack: explainer, list, then the form.
- **Caching.** An exact row in `ROUTE_CACHE_PATTERNS` with the `/vendor-program` TTLs, and `{ route: 'index' }` in `cacheTagInputsForPath`. Both matchers are exact, so without the rows the page would fall to `private, no-store`. The HTML is visitor-neutral. The form renders empty in SSR, because the signed-in email prefill reads `SessionStatus.email()`, which is null on the server.
- **SEO.** `setStaticPageMeta`, indexable, with `canonicalUrl('/vendor-program/list-your-product')`, its own title ("Ask us to list your product · AEC Integrations") and description, and the §2.3 share card. In `sitemap.xml` right after `/vendor-program`, with the same `changefreq` and `priority`.
- **Tests.** `list-your-product.component.spec.ts`, the embedded cases in `claim-dialog-flow.component.spec.ts`, the cache, tag, sitemap and robots tables, and `e2e/list-your-product.spec.ts`.

---

## 3. Page sections, in order

1. **Hero.** The headline (settled 2026-10-12): "Your products may already be listed here. Make sure buyers read your version." The subhead (2026-10-12, Chris, copy pass): "AEC teams compare software and its integrations here before they buy. Claim your listing, free, so what they read is current, complete and in your words." Both calls to action (§4). No statistics.
2. **What changes when you claim** (settled 2026-10-12, replaces "The problem"). One or two sentences of the problem, then a before and after panel with the two real maintenance labels: "AEC Integrations maintained" before, "Vendor maintained · Updated" and a date once the vendor saves a change or confirms a page is right (`STAGE_2_ATTESTATIONS_SPEC.md` §13.9, `STAGE_2_PAID_TIERS_SPEC.md` §13.8). Both labels are drawn by the listing's own `shared/maintenance-marker` component, never retyped, so the page cannot show wording a listing does not. The example date is today, in UTC, as the server rendered it. The browser takes that value through `TransferState`, so an edge-cached copy never redraws the date after hydration. A claim alone does not change the label, so the copy never says it does. Copy pass 2026-10-12 (Chris): the lede now reads "Buyers compare your integrations on your listing, whether or not you wrote it. Until you claim it, they are reading our account of your public pages. Every listing says who keeps it current." The "before" body now reads "We wrote it from what we could find. Buyers cannot tell whether anything is missing or out of date."
3. **What a free claim gets you.** Three outcomes: your listing in your words, your integrations owned by you, a complete listing at no cost. The seat link stays in the lede, and the checklist link in the first item's body. Copy pass 2026-10-12 (Chris): each body now leads with the gain, then what you do. **Copy pass 2026-10-24 (Chris):** the "Your integrations, owned by you" body reads "Claim the integrations your company builds and keep them accurate. Add a link to your setup instructions, so the person connecting the two products on a project finds them on the integration page. Buyers see who maintains each integration. If a partner's listing describes your integration wrongly, you can request a change."
4. **What Managed adds.** Copy pass 2026-10-12 (Chris): the section lede "Managed is for products that need more than a corrected listing: your own account of what the product does on a project, who it is for, and how its integrations move data." Then the price and terms line in small text, from the shared constants. **2026-10-13 (Chris):** the one-year term follows the price in the same line, and the renewal line sits under it (`managedTermLine`, `managedRenewalLine` in `shared/plan-cta/plan-cta.ts`): renews for another year unless the vendor opts out before the renewal date, the renewal price and date in writing at least 30 days ahead, and a price change needs the vendor's agreement. **Revised 2026-10-19 (E8.2, AECI-1399):** the term line is "Monthly has no commitment: cancel any time. We refund in full if you ask within 14 days of the first charge." The renewal line is "An annual license renews each year unless you opt out before the renewal date. At least 30 days before that date, we send you the renewal price and date in writing. A new price never applies mid-term." There is no one-year term, no price-agreement sentence and no silence sentence. Then four lines: how teams use it; trades, audiences and phases; more detailed information about integrations; review replies. Ruled 2026-10-12: the integrations page and API docs links line and the confirmed data flows line are one entry, "More detailed information about integrations (additional URLs, data flow, etc.)", which keeps both docs links. The plan cards merge the same two items into the same line. Its body on this page, reworded 2026-10-12 (Chris) because the first draft was not clearly written: "Link evaluators to your integrations page and API docs. Confirm which data each integration moves, and your answer counts the same as your partner's. Buyers can check what an integration syncs before they rely on it for a project." It keeps the "Confirming integration data" link (titled "Attesting an integration" until AECI-1267) and the "Learn more" link. Copy pass 2026-10-12 (Chris): on this page only the title is now "Integration detail buyers can check". The plan cards keep "More detailed information about integrations (additional URLs, data flow, etc.)". "Search engine notice" stays on the plan cards and the docs page, not in this list. **Removed from the Managed pitch 2026-10-12 (Chris): connector integrations.** The "Connector integrations" line is gone from this list, and "The integrations you deliver through a connector" is gone from the shared plan cards, so `/docs/vendors/plans` loses that card line too. It remains a Managed capability (`STAGE_2_SPEC.md` §8.10, AECI-1040). The Markdown "What Managed adds" list on `/docs/vendors/plans` and the comparison table keep it as the feature reference. **Copy pass 2026-10-24 (Chris):** "How teams use it" now reads "Describe, in your own words, the work your product does on a real project. Buyers judge fit by the work a product does, not by a feature list. Show them the job, and they can picture it on their own project." "Trades, audiences and phases" says "rather than leaving it to our reading of public sources". "Integration detail buyers can check" drops its closing "See Confirming integration data." sentence and its in-text link, so "Learn more" is the entry's one link. The plan cards' line is now "Integration detail: extra links and the data each integration moves.", and their search engine line is "Search engines notified when you update a page". The Free card's price line reads "Available for all products", with no "$0" figure. These card lines show on `/docs/vendors/plans` too.
5. **Plan cards.** Free and Managed side by side (§4, placement `card`). Reuse `DocsPlansComparisonComponent`'s cards. Do not copy them.
6. **How listings are sorted.** "Every listing is sorted the same way: how well it matches the search, then how complete it is. Your plan is not part of that." Link to `/docs/trust/how-ranking-works`. Write it as the reason buyers trust the directory, not as a disclaimer. Copy pass 2026-10-12 (Chris): the trust paragraph reads "That is why buyers trust what they find here, and why a claimed, complete listing is worth more than a paid one that is not. Paying changes what you can say. It never changes where you appear, whether a review is published, or how an agreement label is worked out."
7. **FAQ.** Who can claim; how long approval takes (generally within 48 hours, §12); several products (softened for launch 2026-10-12, §13 row 6); invoice or purchase order; what happens when a plan ends; whether paying affects reviews or ranking. Use a native `<details>` list. **2026-10-13 (Chris):** "Can we cancel a Managed plan early?" sits after the invoice answer: "The term runs to the end of the paid year. If you opt out of renewal, you keep Managed through the current year, and we issue no further invoices." Refund, early-termination and nonpayment terms are not decided. The page states none of them. Copy pass 2026-10-12 (Chris): the approval answer reads "Generally within 48 hours. A person at AEC Integrations reviews every claim and emails the result to the address you gave." **Revised 2026-10-19 (E8.2, AECI-1399):** no claim timing and no payment method anywhere. The FAQ order is: who can claim; "What happens after we send a claim?", answered "A person reviews every claim and emails you the result."; several products, answered "No. One claim gives you a seat on your company's account, and it covers every product your company makes. Managed is licensed per product. An owner assigns a license to each product you want on Managed."; "What does Managed cost?", answered from the two price constants with monthly's no-commitment term, annual renewal and the 14-day refund (`managedCostAnswer`); "Can we cancel a Managed plan early?", answered "Yes, on monthly. Monthly has no commitment: cancel any time, and your licenses run to the end of the month you paid for. An annual license runs to its renewal date. If you opt out of renewal, it ends on that date."; what happens when a plan ends, which now opens "Each product whose license ends moves to Free." and keeps its read-only sentence until E6 (AECI-1395); and whether paying affects reviews or ranking. **Copy pass 2026-10-24 (Chris):** the second question reads "What happens after I send a claim?". The cancel answer opens "Yes, on the monthly plan." (`/docs/vendors/plans` says the same, pinned by `vendor-program-copy.component.spec.ts`). The plan-ends answer says "The Managed fields become read-only." instead of "What Managed adds becomes read-only."
8. **Closing panel.** §4, placement `bottom`.

**Removed 2026-10-13 (Chris): Coming soon** (`id="vp-coming-soon"`, formerly the seventh section). It promised performance reporting "to Managed". That named a tier before the tier was ruled (`VENDOR_PERFORMANCE_SPEC.md`), so it was a promise the first invoice could break. The page now describes only what ships, with no exception. Do not add a teaser back until the reporting has shipped on a ruled plan.

**Removed 2026-10-12 (Chris): Find your product** (`id="find-your-product"`, formerly the third section, §6). The claim dialog starts with Find it (§15.2 step 1), so the section repeated it. The hero's "How claiming works" step 1 now reads "Start your claim, then search for your product or your company." **Copy pass 2026-10-24 (Chris):** it reads "Start your claim here, or press Claim on any of your product pages, then search for your product or your company."

**Free and Managed are one pattern (settled 2026-10-12, Chris).** Both sections use the same layout and the same item, `li[aec-vendor-program-benefit]` (`vendor-program/vendor-program-benefit.ts`), so they cannot drift. An item is a plain semibold title (never a link), then the body, then, when the line has a docs page, a trailing "Learn more" link in a new tab with the new-tab cue. Its accessible name carries the title ("Learn more: How teams use it"). Neither section has subgroup headings: the three Managed `h3`s ("Explain what your product does on a project", "Back up your integrations", "Answer buyers in public") are gone. The wording of every line and every link target stayed. Only the old bold link lead-in became the plain title plus "Learn more", and the title dropped its trailing period. In-body links stay in the body: the checklists link in Free and "Confirming integration data" in Managed. No Free line has a docs page of its own, so none ends in "Learn more". **2026-10-24:** the Managed in-body "Confirming integration data" link was removed (§3 item 4). Only the checklists link stays in a body.

One `h1`, then `h2` per section, in this order. The only `h3`s are the plan cards' own.

**This page carries its own benefit copy (settled 2026-10-12).** `/docs/vendors/plans` stays the feature reference. This page is the pitch. Every Free and Managed line says three things, in order: what the vendor can do, what the vendor gains, and what the buyer or the end user gains. The end user is the person who uses the integration on a project. The facts stay aligned with the docs page. The sentences do not have to match, and no test makes them. Three things stay shared: the plan cards (item 5, one component), the sort rule (item 6, one i18n id, `@@app.docs.plans.sortRule`, which reads the same as the Plans page), and the Managed terms (item 4 and item 7, added 2026-10-13). The price and the one-year term come from the shared closing panel on both pages. Renewal and the early-cancel answer read the same as the Plans page's "Getting Managed". `vendor-program/vendor-program-copy.component.spec.ts` pins the sort rule, renewal, the early-cancel answer and the Plans page fragments this page links to.

**Doc links open in a new tab (settled 2026-10-12).** Every link on this page to `/docs/*` opens in a new tab: the section links, each "Learn more", the FAQ answers, "How ranking works" and "Compare every feature side by side". Each carries `target="_blank" rel="noopener"` and `aec-new-tab-icon`, the drawn icon plus the visually hidden "(opens in a new tab)". The reason is that a vendor reading the pitch keeps the claim one tab away. Conversion links stay in the tab: every claim link, "Questions? Contact us" (the Managed inquiry until E8.1, 2026-10-19) and "Go to your portal". This is a page-scoped exception to `DESIGN.md`'s new-tab rule. `/docs/vendors/plans` keeps its links in the tab.

**Full width at desktop (settled 2026-10-12).** No narrow column with a blank right half: fill desktop width by layout. From `lg`, every section uses the whole `max-w-7xl` container, at 1024, 1280 and 1440px alike. Prose keeps a readable measure inside its column. The layout per section:

| Section | From `lg` |
|---|---|
| Hero | The copy and both buttons in the left seven of twelve columns. "How claiming works" in the right five: three numbered steps (find, claim, we review it), facts the FAQ already states. Copy settled 2026-10-12 (Chris): step 2 reads "Claiming is free. We set up your account when we approve your claim." Step 3 reads "Generally within two days. We email you the result either way." (copy pass 2026-10-12, Chris; words, because the hero carries no digits). **Revised 2026-10-19 (E8.2, AECI-1399):** step 3 reads "A person reviews every claim and emails you the result." No claim timing. The claim dialog's subtitle uses the step 2 wording. "Needs no account" is retired everywhere: it read as if no account is needed to manage a listing. Not a heading. Hidden below `lg`. |
| What changes when you claim, FAQ | A split: the heading (and lede) in the left five columns, the content in the right seven. What changes when you claim puts the two labels side by side on the right (stacked below `sm`). |
| What a free claim gets you, What Managed adds | The same split for both (2026-10-12): the heading and lede (Free's seat line; Managed's lede, then its terms line in small text, copy pass 2026-10-12) in the left four columns, the lines in the right eight as a two-column grid from `md`. One column at 375. |
| Plan cards | The shared cards side by side across the full width. |
| How listings are sorted | The Bone panel, split: heading and sort rule left, the trust line and link right. |
| Closing panel | The Forest panel, split: heading and terms left, the buttons and next steps right (`PlanCtaPanelComponent`'s `split` input). |

Phones stay one column.

---

## 4. Calls to action

> **Superseded in part by §15 (2026-10-12, AECI-1293).** Every claim control and every Managed button now opens the claim dialog, labelled "Claim your listing" ("Start with Managed" on the Managed controls until E8.2 retired it on 2026-10-19). "Talk to us about Managed" became the text link "Questions about Managed or pricing? Talk to us", and E8.1 (2026-10-19) replaced that with "Questions? Contact us", a plain link to `/contact`. §15.1 is the current table. The placements below still name where each control sits.

Two actions, with the same wording everywhere.

| Action | Text | Goes to |
|---|---|---|
| Claim | "Claim your listing free" | `#find-your-product` on this page. On `/docs/vendors/plans` it stays `CLAIM_PATH`. (Superseded by §15.1: the claim dialog, with `/search` as the no-JS target since 2026-10-12.) |
| Managed | ~~"Talk to us about Managed"~~ | **Removed 2026-10-19 (E8.1, AECI-1398):** the plan inquiry dialog, `MANAGED_CONTACT_HREF` and the contact page's managed topic are gone. Was: the plan inquiry dialog in place, with an `href` to the contact page's managed topic for no-JS and new-tab clicks. |

Never "Get Managed", "Start now" or "Buy". There is no checkout.

### 4.1 Placements

| Placement | `placement` value | What |
|---|---|---|
| Hero | `top` | Both buttons side by side, on the first screen on desktop and phone. Managed is filled. Claim is outlined. **Removed 2026-10-19 (E8.1, AECI-1398):** the hero carries the claim button only. No contact link sits on the hero (ruled 2026-10-19). |
| Plan cards | `card` | "Claim your listing free" on Free, secondary style. "Talk to us about Managed" on Managed, full card width, filled. The existing reply line sits under it. **Removed 2026-10-19 (E8.1, AECI-1398):** the Managed card's inquiry link and reply line are gone. Its one control is "Start with Managed", which reads "Claim your listing" since E8.2 (2026-10-19, AECI-1399). |
| Find your product | `search_result` | **Removed 2026-10-12** with the section (§6), before it shipped. No production rows carry it. |
| Rail | `rail` | **Not on this page** (2026-10-12): it reserved an empty column beside every section (§3). The rail card stays on `/docs/vendors/plans`, so the `rail` placement value stays in analytics for that page. |
| Phone bar | `mobile_bar` | Below `lg`: a slim bar fixed to the bottom. It hides while any full CTA is on screen, and it never covers the closing panel. (The inquiry form it once had to clear was removed 2026-10-19, E8.1.) |
| Closing panel | `bottom` | A full-width band before the footer, with the headline "Tell the full story of your product" and the line "$25 USD a month or $250 USD a year per product, billed by invoice or purchase order. Each product on Managed is on a one-year term, whether you pay monthly or for the year upfront. Paying monthly spreads the cost. It does not make the plan month to month. If a plan ends, nothing you entered is removed." (term sentence added 2026-10-13) A large Managed button, with "Claim your listing free" as a text link beside it. Under the button, two numbered steps. **Ruled 2026-10-12 (Chris):** they describe the claim dialog the button opens, on both pages: "Find your listing and tell us which plan you want." and "We review it, generally within 48 hours, and email you the result." They replace "We agree the price and the term with you." and "We switch Managed on, and everyone with a seat sees it in the portal." The steps show only while the button opens the dialog, so a vendor seat (§5) sees neither. **Revised 2026-10-19 (E8.1, AECI-1398):** "Questions? Contact us", a plain link to `/contact` with no topic, sits beside the claim button. It replaced the plan inquiry link. **Revised 2026-10-19 (E8.2, AECI-1399):** the line reads "$25 USD a month or $250 USD a year per product. Monthly has no commitment: cancel any time. We refund in full if you ask within 14 days of the first charge. If a plan ends, nothing you entered is removed." The steps read "Find your listing and send your claim." and "A person reviews every claim and emails you the result." **Copy pass 2026-10-24 (Chris):** the line reads "$25 USD a month or $250 USD a year per product. Monthly, cancel any time. Full refund within 14 days. If a plan ends, nothing you entered is removed." The price still comes from `managedTermsLine`. The short term sentence is the panel's own string, so `managedTermLine` stays only beside the price in What Managed adds. Step 2 reads "We review it and email you the result." The hero step and the FAQ keep "A person reviews every claim and emails you the result." |

**Reuse, don't fork.** The rail, the phone bar and the closing panel already exist in `apps/web/src/app/docs/docs-plans-cta.ts`. Move them to `apps/web/src/app/shared/plan-cta/`, give them a `page` input (§9), and have both pages mount the phone bar and the closing panel. Only the docs page mounts the rail. The phone bar's `IntersectionObserver` logic and its `data-plans-cta` contract stay as they are. ~~Mount exactly one `aec-plan-inquiry-host` on the page.~~ **Removed 2026-10-19 (E8.1, AECI-1398):** no inquiry host is mounted.

**Annual price.** Add `MANAGED_ANNUAL_PRICE_CENTS = 25000` beside `MANAGED_LIST_PRICE_CENTS` in `packages/shared/src/entitlements.ts`. Format it with `formatPlanPrice`. Never hard-code "$250" in a template.

---

## 5. Signed-in vendor

The SSR HTML is always the signed-out page. After hydration:

| Visitor | Change |
|---|---|
| Signed out, or signed in without a vendor seat | None. |
| Vendor seat, Free company | "Claim your listing free" becomes "Go to your portal" (`/vendor`). The closing panel drops its two claim steps (§4.1). ~~The inquiry form prefills `company` with the vendor's name.~~ **Removed 2026-10-19 (E8.1, AECI-1398):** no inquiry form. |
| Vendor seat, Managed company | As Free, plus the phone bar and the closing panel's Managed button are hidden. |

**The probe.** Add a root-provided `VendorPlanStatus` in `apps/web/src/app/vendor/`, on the `RoleStatus` pattern (`auth/role-status.ts`):

- It calls `GET /api/vendor/me` once, only when `VendorStatus.isVendor()` is true, only in the browser.
- It exposes `vendorSlug` and `managed` signals, both `null` until resolved. `vendorName` was removed on 2026-10-19 (E8.2, AECI-1399): its only reader was the inquiry form. `managed` uses `isManaged` from `vendor/vendor-plan.ts`.
- It does not reuse or provide `VendorPortalStore`. That store is portal-scoped on purpose.
- A failed call leaves the page signed-out. It never shows an error.

~~**Prefill.** `PlanInquiryForm` prefills `email` from the session today, one-shot. Add the same one-shot prefill for `company` from `VendorPlanStatus.vendorName`. A visitor's own edit always wins.~~ **Removed 2026-10-19 (E8.1, AECI-1398):** `PlanInquiryForm` is gone, so there is nothing to prefill. E8.2 (AECI-1399) removed `VendorPlanStatus.vendorName`, which had no other reader.

---

## 6. Find your product

> **Removed 2026-10-12 (Chris). Superseded by §15.2 step 1.** The claim dialog starts with Find it, so the page section repeated it, and the section and `vendor-program-find.ts` are gone. Its analytics are retired (§9). The `/contact?topic=add-product` panel stays for links from outside the app. The text below is the record of what shipped.

> **Amended by §15 (2026-10-12, AECI-1293).** "Claim this listing" on a result opens the claim dialog at step 2 with that listing filled in. "Ask us to add it" opens it at the typed-in step. Both stay links to their old targets for no-JS and new-tab clicks. The rest of this section stands.

- Reuse `aec-search-autocomplete` (`apps/web/src/app/search/search-autocomplete.ts`) with its own `inputId`, a visible label, and the placeholder "Search for your product or company". It searches in the browser only, so it does not affect the cached HTML.
- **A result.** Choosing a product or vendor hit shows a result card: the name and "Claim this listing", which links to `/products/:slug/claim` or `/vendors/:slug/claim`. It does not navigate to the listing first. The card also offers "View the listing".
- **Ask us to add it (settled 2026-10-12).** Under the box, always: "Can't find your product? Ask us to add it." The link goes to `/contact?topic=add-product`. That topic shows a panel on the contact page whose button is the support `mailto:` with the subject ("Please add my product to AEC Integrations") and a prompt filled in: product name, website, and the products it integrates with. It reaches the same support mailbox as every other contact email. No API validates the topic, because it adds no field to any request. The link fires no analytics event (§9 is unchanged).
- **A miss.** Copy: "Your products may already be listed, under a different name. If you cannot find yours, ask us to add it." "Ask us to add it" links to `/contact?topic=add-product`. The line under the box stays.
- The no-JS fallback form goes to `/search`, as it does in the header.
- Copy says "may already be listed", never "are already listed".

---

## 7. Managed inquiry

> **Superseded 2026-10-19 (E8.1, AECI-1398).** Claim is the only Managed action (`VENDOR_SIGNUP_PROCESS.md` §2, §5). The inquiry dialog and form (`shared/plan-inquiry/`), `POST /api/plan-inquiries`, the `plan-inquiry-received` and `plan-inquiry-alert` emails and the `plan_inquiry_submitted` event are removed. Questions go through "Questions? Contact us", a plain link to `/contact` with no topic and no form, beside the closing panel's claim button and under the FAQ (§15.1). The `plan_inquiries` table stays, with no writer, until E8.6 drops it. The text below is the record.

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
- The page describes only what ships. No "Coming soon" section, no teaser and no tier named for unshipped work (2026-10-13). That is the same ruling as the docs page.
- **Benefit lines (2026-10-12).** Each Free and Managed line names a feature, then the vendor's gain, then the buyer's or end user's gain (§3). A gain is an outcome a reader can check on a real page. It is never a number, a ranking effect or a promise about a label's value. The trades line may say buyers browsing or filtering by a trade find the products tagged with it. It may not say they find them sooner or higher. The data flow line may say the vendor's answer counts the same as its partner's. It may not promise any label.

---

## 9. Analytics

Extend the events that ship (`apps/web/src/app/analytics/analytics.ts`, `docs/ANALYTICS.md` §4). Do not add parallel ones.

| Event | Change |
|---|---|
| `plan_cta_clicked` | Add `page`: `docs_plans` or `vendor_program`. Add placement `search_result` (**removed 2026-10-12** with Find your product, before it shipped). Existing values keep their meaning. `plan: 'free'` now covers "Claim your listing free" and "Claim this listing" on this page. **Since §15:** `free` is a "Claim your listing" click and `managed` a "Start with Managed" click, and both open the claim dialog. Since E8.2 (2026-10-19) every control reads "Claim your listing". `managed` still marks the Managed card, the rail and the phone bar. |
| ~~`plan_inquiry_submitted`~~ | ~~Add `page`, with the same values. `contact` stays a placement for the `/contact` form, with `page` absent.~~ **Removed 2026-10-19 (E8.1, AECI-1398):** the event no longer fires (`docs/ANALYTICS.md` §4). |
| `vendor_product_search` | **Removed 2026-10-12** with Find your product (§6), before it shipped. No production rows carry it. It was fired once per settled non-empty query, with `results_count` only. Nothing fires it now. The claim dialog's `claim_dialog_step` covers the find funnel: step `find` shown, then step `you` with `path` `found` (a listing chosen) or `typed` (not listed) (§15.7). The dialog never sent the search text and still does not. |
| `claim_requested` | No change here. §15.7 added `plan_interest` and AECI-1365 removed it (2026-10-15). It fires when a claim form is sent, from any entry point. |

"Ask us to add it" (§6, removed 2026-10-12) fired nothing. It is not a plan call to action, so `plan_cta_clicked` would be wrong. A `$pageview` on `/contact` whose `$current_url` carries `topic=add-product` already counts the arrivals.

Not added, and why:

- `vendor_page_viewed`: `$pageview` with `pathname = /vendor-program` already counts it.
- `claim_completed`: approval is an admin action, not a page event. It lives in `audit_log` and the admin claim queue.

**UTM.** LinkedIn and outreach links carry `utm_source`, `utm_medium` and `utm_campaign`. PostHog records them on `$pageview` without code. The marketing repo owns the link convention.

---

## 10. `/docs/vendors/plans` deltas

What remains from the draft's §9, after the 2026-10-12 CTA review shipped:

1. Pass `page: 'docs_plans'` on every CTA event (§9). The inquiry event went with the inquiry (E8.1, 2026-10-19).
2. Mount the shared CTA components from `shared/plan-cta/` (§4.1). No visual change.
3. Add one intro line linking to `/vendor-program`.
4. Show the annual price in the closing panel's terms line, from the new constant (§4.1).
5. Update `STAGE_2_PRODUCT_DOCS_SPEC.md` §5's Plans entry in the same PR.
6. **2026-10-13 (Chris):** the closing panel carries the price and the one-year term (§4). "Getting Managed" does not repeat them, because the panel renders inside that section. Below the panel it states renewal in prose, with the same wording as this page. "To renew" became "To opt out of renewal". A "Can we cancel a Managed plan early?" subsection carries the FAQ answer from §3 item 8. "When a Managed plan ends" is unchanged. **Revised 2026-10-19 (E8.2, AECI-1399):** the panel carries the price line and the monthly term with the 14-day refund. The Markdown repeats neither. "Getting Managed" opens with the per-product license and the hand-back rule, then the claim paragraph, then the renewal line word for word. The cancel subsection moved up under "Getting Managed" with the new answer, so "The Billing tab" holds only tab mechanics. "When a Managed plan ends" now speaks per product and drops "This applies to a pilot too." Its banner, read-only, and lapse lines stay until E6 (AECI-1395).

The top button row, the full-width Managed card button, the closing panel, the rail card and the phone bar already ship. Do not rebuild them.

---

## 11. Design and accessibility

- Follow the CLAUDE.md design checklist: critique, a Mobbin anchor, craft, polish, `npx impeccable detect` against the rendered page, axe-core.
- Use the site layout and components. Plain and trustworthy, not a SaaS hype page (`PRODUCT.md`, `DESIGN.md`). Light only.
- Mobile first. Test at 375px first.
- **No narrow column with a blank right half: fill desktop width by layout** (2026-10-12). At 1024, 1280 and 1440px every section reaches the right half of the `max-w-7xl` container, by split, grid or side-by-side layout, never by stretching prose to 150-character lines. §3 lists the layout per section. `apps/web/e2e/vendor-program.spec.ts` checks it at all three widths.
- One heading order. Visible focus on every link and button. Button contrast meets WCAG AA. The phone bar reserves its height and never traps focus (WCAG 2.2, 2.4.11), as the docs bar already does.

---

## 12. Facts to verify on publication day

| Fact | Where to check |
|---|---|
| $25 a month per product is the public list price | `MANAGED_LIST_PRICE_CENTS` |
| $250 a year per product is the public annual price | Chris, then `MANAGED_ANNUAL_PRICE_CENTS` |
| Managed is licensed per product. Monthly has no commitment. An annual license renews unless the vendor opts out, with written notice at least 30 days ahead, and a new price never applies mid-term. A full refund within 14 days of the first charge | `docs/VENDOR_SIGNUP_PROCESS.md` §1 and §2, and the Managed plan agreement (E8.2, 2026-10-19) |
| ~~A claim approval time: "Generally within 48 hours"~~ | **Retired 2026-10-19 (E8.2, AECI-1399):** no page states a claim time. Both pages say "A person reviews every claim and emails you the result." Since 2026-10-24 the closing panel step on both pages says "We review it and email you the result." The `/vendor-program` hero step and FAQ keep the longer line. |
| What a confirmed data flow shows publicly | A pair page with a vendor attestation |
| Any catalog count | The API, on the day |

---

## 13. Open decisions

| # | Question | Default until decided |
|---|---|---|
| 1 | What proof may appear: checked catalog counts, or quotes used with permission? | None. |
| 2 | A claim approval time in the FAQ? | **Settled 2026-10-12:** "Generally within 48 hours." **Reversed 2026-10-19 (E8.2, AECI-1399):** no claim timing. The FAQ asks "What happens after we send a claim?" and answers "A person reviews every claim and emails you the result." The question reads "What happens after I send a claim?" since 2026-10-24. |
| 3 | A "For vendors" link in the header row? | Footer only. A header link needs a `DESIGN.md` change and the AECI-669 re-measure. |
| 4 | ~~A `name` field on plan inquiries?~~ | **Removed 2026-10-19 (E8.1, AECI-1398):** moot. The plan inquiry form is gone. |
| 5 | A "Submit your product" flow for a product not in the catalog? | **Settled 2026-10-12:** the contact path with a topic, `/contact?topic=add-product` (§6). **Superseded the same day by §15:** the claim dialog's typed-in step, a `listing_request`. The contact topic stays for other entry points. |
| 6 | Can one company's products sit on different plans? | **Not yet.** The price is per product, but the data model holds one plan per company (`STAGE_2_PAID_TIERS_SPEC.md` §13.7). Ruled 2026-10-12 (Chris): until real per-product plans ship, the several-products FAQ answer ends "Plans are priced per product. Tell us which products you want on Managed, and we'll set it up with you." `/docs/vendors/plans` "Getting Managed" says the same. Neither promises that each product can hold its own plan. **AECI-1294** builds per-product plans and restores that wording. **Settled 2026-10-19 (E8.2, AECI-1399):** yes. Managed is licensed per product. The FAQ answer ends "Managed is licensed per product. An owner assigns a license to each product you want on Managed." `/docs/vendors/plans` says the same. |

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
| **AECI-1287** Find your product (removed 2026-10-12, §6) | §6 |
| **AECI-1288** Analytics: `page`, `search_result`, `vendor_product_search` | §9 |
| **AECI-1289** `/docs/vendors/plans` deltas | §10 |
| **AECI-1290** Publication-day fact check | §12 |
| **AECI-1293** Single claim dialog: find or type in, plan, comments | §15 |
| **AECI-1474** Listing request page, the form inline | §2.5, §15.4 |

---

## 15. Claim dialog

**Ruling 2026-10-12 (Chris), AECI-1293.** One claim workflow replaces the two parallel asks. Managed is granted at claim approval (the `/admin/claims` plan radios, `STAGE_2_PAID_TIERS_SPEC.md` §13.6), so a separate Managed form was a second form with a hidden dependency on the first. Every main call to action now opens one dialog. This section supersedes the claim rows of §4 and §4.1, the result link and "Ask us to add it" target of §6, and the `plan_cta_clicked` wording of §9. §7 governed the inquiry dialog, the pricing question's path, until E8.1 removed it on 2026-10-19.

### 15.1 Labels and entry points

| Where | Text | Opens |
|---|---|---|
| Hero (`top`), closing panel (`bottom`), Free plan card (`card`) | "Claim your listing" | The dialog at step 1. The Free card preselects Free. |
| Managed plan card (`card`) | "Claim your listing" ("Start with Managed" until E8.2, 2026-10-19) | The same dialog as every other control. |
| Phone bar (`mobile_bar`), docs rail (`rail`) | "Claim your listing" ("Start with Managed" until E8.2, 2026-10-19) | The same as the Managed card. Both sit on Managed-labelled surfaces: the bar's region is "Managed plan" and it already hides for a Managed company (§5). |
| ~~Beside the hero's "Claim your listing", under the Managed card's button, beside the closing panel's button~~ | ~~"Questions about Managed or pricing? Talk to us" (text link)~~ | **Removed 2026-10-19 (E8.1, AECI-1398):** the plan inquiry dialog (§7) and `MANAGED_CONTACT_HREF` are gone. |
| Beside the closing panel's claim button (both pages), and under the FAQ on `/vendor-program` (E8.1, ruled 2026-10-19) | "Questions?" then a link "Contact us" (`aec-plan-contact-link`) | `/contact`, a plain `routerLink` with no topic and no form. Not on the hero. Not tracked. A Managed company (§5) does not see the panel's copy. |
| ~~Find your product, a chosen result (`search_result`)~~ | ~~"Claim this listing"~~ | Removed 2026-10-12 with the section (§6). The dialog no longer opens at step 2. |
| ~~Find your product, "Ask us to add it"~~ | | Removed 2026-10-12 with the section. `/contact?topic=add-product` keeps working for links from outside the app. |
| `/vendor-program/list-your-product` (`list_page`, AECI-1474) | The page itself | The flow inline, not a dialog, on the typed-in You step (§2.5). |

"Talk to us about Managed" no longer appears on either page, as a button or a link. "Claim your listing free" is retired. Never "Get Managed", "Buy" or "Start now".

The same labels apply on `/docs/vendors/plans` through the shared `shared/plan-cta/` components. The docs Free card's "Claim your listing" now opens the dialog too.

**As built, AECI-1365 (2026-10-15).** Nothing is preselected any more: the plan step is gone (§15.2). "Start with Managed" and the Free card open the same dialog with no seed. The `aecClaimDialogPlan` input and `ClaimDialogOpening.plan` are removed. E8 retires the "Start with Managed" label: **done 2026-10-19 (E8.2, AECI-1399).** Every control reads "Claim your listing". Claim is the one action.

**Signed-in vendor (§5).** A vendor seat sees "Go to your portal" (`/vendor`) wherever a control would open the dialog, the Managed card, rail and phone bar included. The contact link stays (E8.1, 2026-10-19, replacing the pricing link). A Managed company keeps §5's rule: no phone bar, no Managed button and no contact link in the panel. The FAQ's contact link shows for everyone.

**No-JS fallback.** Every dialog trigger is an `<a href="/search">` (`CLAIM_DIALOG_FALLBACK_HREF`). Without JS, before hydration, with no host on the page, or on a modified click, the link is followed. Changed 2026-10-12 from `/vendor-program#find-your-product` when that section was removed. `/search` is where the header search box falls back too, and it is the page equivalent of the dialog's Find it step: a visitor searches, opens the listing, and uses its own claim form. A new-tab click has JS, so search works there in full. Without JS the page renders its box and no results, the same as the header path.

### 15.2 The steps

One BrnDialog: `BrnDialogContent` with a `BrnDialogTitle` and a `BrnDialogDescription`, over the CDK overlay, on `--surface-base` with no shadow (`shared/claim-dialog/claim-dialog.ts`). It was built on the plan inquiry dialog's shell, which E8.1 removed on 2026-10-19. The title is "Claim your company" on the Find step and on the typed-in path, and "Claim <Company>" once a found listing names the company (AECI-1364, below). A visible step indicator reads "Step N of 4" and names the step. A Back button sits on every step after the first one the visitor saw, and never on the receipt.

1. **Find it.** `aec-search-autocomplete` with its own `inputId`, the visible label "Your product or company" and the placeholder "Search for your product or company". Choosing a product or vendor suggestion selects that listing and moves to step 2. Under the box: "Not listed? Type it in", a button that moves to the typed-in variant of step 2. Enter with no suggestion chosen does nothing in the dialog: it never navigates away from an open form.
2. **You.** A found listing shows a summary line, with "Change" back to step 1. A company hit reads "Claiming <Company>". A product hit reads "Claiming <Company> from the <Product> page", or "Claiming <Product>" when the search record has no vendor name. A typed-in listing first asks "Product or company name" (1 to 200 characters) and "Website" (an `https://` URL, `HttpsUrlSchema`). Then the claim form's identity fields, unchanged: "Your name", "Your role at the company", "LinkedIn profile (optional)" with the AECI-847 host allowlist, and "Your work email". A well-formed address at a free mailbox domain (`FREE_EMAIL_DOMAINS` in `packages/shared/src/free-email-domains.ts`: Gmail, Yahoo, AOL, Outlook.com/Hotmail, iCloud and similar) shows an advisory notice under the field: "This looks like a personal email address. Please use your work email if you have one. We can still accept this address, but confirming your claim may take longer." It never blocks the claim. It shows as soon as the address qualifies, so a signed-in visitor's prefilled personal address gets it too, and the field's `aria-describedby` names it. The notice lives in the shared `ClaimantFields`, so the per-listing claim page and drawer (§15.6) show it as well. "Continue" validates this step's fields only.
3. **Plan.** "Which plan are you interested in?" Three native radios: Free, Managed, Not sure yet. A one-line hint: "You can change your mind. We confirm the plan with you before anything is billed." Nothing is preselected unless the dialog was opened from a Managed control (Managed) or the Free card (Free). The answer is optional. "Continue" with no choice sends no plan answer.
4. **Additional comments.** An optional textarea, "Additional comments", up to 2,000 characters, then the submit button, "Send claim" (found) or "Send request" (typed-in).
5. **Done.** One receipt, focused on open. Found: "Claim sent", "We'll email {address} with our decision", and the three "What happens next" lines the claim form already shows. Typed-in: "Request sent", then "We'll add {name} to the directory, then email {address} so you can finish your claim." A "Done" button closes the dialog.

**Behaviour.**

- One host per page (`aec-claim-dialog-host`), `@defer`-loaded on the first open, so nothing reaches the cached SSR HTML.
- Below `sm` the panel is a full-screen sheet (`100dvh`, no radius). From `sm` it is a centred panel, `min(92vw, 36rem)` wide, scrolling inside at `85vh`.
- Focus moves into the dialog on open, to the step heading on every step change, and back to the trigger on close (BrnDialog / CDK). Escape and the close button close it at any step. Closing discards the form. Each open starts fresh.
- Never opened from an `effect()` (NG0602): the root `ClaimDialogService` holds an opener callback, which the dialog registers and the click handler calls.
- A submit failure keeps the visitor on step 4 with "Something went wrong. Please try again." A `404` on a found listing (the listing was unpublished since the search) says the listing is no longer available and offers "Type it in instead".

**A seeded open (2026-10-24, §2.4).** When the page seeded a company from `?vendor=`, the dialog opens on You with that company found, reports `claim_dialog_step` `you` with `path: 'found'`, and moves focus to the You heading. "Back" and "Change" both go to Find it, so a visitor who meant another company can still search.

**As built, AECI-1365 (2026-10-15): no plan step** (`docs/VENDOR_SIGNUP_PROCESS.md` decision 2). The dialog has three steps: Find it, You, Comments. The indicator reads "Step N of 3". Step 3 above is gone, and "Continue" on You goes to Additional comments. A submit failure keeps the visitor on the Comments step. `PlanInterestField` is deleted.

**As built, AECI-1364 (2026-10-15): a claim is on the company** (`docs/VENDOR_SIGNUP_PROCESS.md` decision 1). Choosing a product suggestion pre-fills the company from the search record's `vendor_name`. The record carries no vendor slug, so the dialog shows the name only and posts the product slug as before. The server resolves the company (§15.3). `ClaimDialogService.company` holds the name for the title. The flow sets it on every step change and clears it on the Find step. A product with no vendor row answers `404`, so the visitor gets the "Type it in instead" path above.

**As built, AECI-1474 (2026-10-24): the flow can start on typed-in You and render embedded** (§2.5). `ClaimDialogOpening.start: 'typed'` opens on the typed-in You step and focuses its first field. One `claim_dialog_step` fires (`you`, `typed`), and no `find`. The `embedded` input drops the dialog's inner scroll and the receipt's "Done". Back from there goes to Find, a ruled exception to "after the first one the visitor saw". Numbering (ruling 2026-10-24): with `start: 'typed'` the indicator counts two steps, You "Step 1 of 2" and Comments "Step 2 of 2", and the bar fills to match. Find after Back is a detour and shows no indicator. Choosing a found listing there keeps the two-step count. The count derives from `opening().start`, not from `embedded`. The dialog with no `start` is unchanged: three steps, Find is step 1.

**As built, AECI-1435 (2026-10-21): the receipt says "Check your inbox" when the claim waits on its link** (ADR 0043). When the API answers `confirmation_required: true`, the Done step reads "Check your inbox", then "We've sent a link to {address}. Your claim is not sent until you click it." (typed-in: "Your request is not sent until you click it."), then "The link works for 7 days. If it does not arrive, check your spam folder, or start again with the same email." An envelope icon replaces the tick, and there is no "What happens next" list. Focus moves to the heading as on every step. A signed-in visitor whose verified email is the typed address gets the "Claim sent" receipt above, unchanged.

### 15.3 A found listing: `POST /api/requests/claim`

**As built, AECI-1435 (2026-10-21): the typed address confirms first** (ADR 0043, `API_CONTRACTS.md` §6.7). Unless the visitor is signed in with the typed address, the submit only parks the claim in `request_confirmations` and emails `claim-confirm` to the typed address: "Confirm your claim for <Company>", what was claimed, one button to `/claims/confirm?token=…`, "This link works for 7 days." and "If you did not send this, ignore this email. Nothing happens unless you click." The link is single-use, never blind-copied to the operator list, and bounded to 3 mails per address per UTC day.

- **The confirm page.** `/claims/confirm` renders "Confirm your claim" and one button, "Confirm and send". Only the click POSTs, because mail scanners prefetch links. The route is noindex and absent from `ROUTE_CACHE_PATTERNS`, so it is `private, no-store`. The token leaves the address bar after the first render and is stripped from analytics URLs. The results are: "Claim sent" with the receipt's "What happens next" (routed variant included), "Request sent" for a typed-in listing, "Already confirmed", "This link has expired", "This link is not valid", and "That listing is no longer available". Each failure offers "Start again" to `/vendor-program`. A claim the AECI-1420 account check refuses at confirm shows "We could not accept this claim" (ruled 2026-10-21). For a seat on another company it says "This address already manages <Vendor> on AEC Integrations. Each address can manage one company. Send the claim again from a different work address." For a staff account it says "This address belongs to an AEC Integrations staff account. Send the claim again from a different work address." Both add "We've emailed you the same details." and "Start again". The click proved the mailbox, so naming the company is safe. The signed-in receipt stays generic.
- **What moves to confirm.** Everything below in this section: the acceptance row (with the submit's version, IP and user agent, and the confirm time), the AECI-1420 account check, owner routing, the Linear issue, `claim-submitted-alert`, `claim-received` and `claim-owner-review`. The claim takes the pending row's id.
- **The receipt email still says the same.** `claim-received` now goes after the click, so the visitor gets two mails for one claim: the link, then the receipt.

**As built, AECI-1364 (2026-10-15).** The endpoint still accepts `target_type: 'product'`, and its response is unchanged. It stores every claim on the company: `target_type = 'vendor'`, the product's primary vendor (else any `product_vendors` row), and the product in the new nullable `vendor_requests.context_product_id`. Migration 0076 is one `ALTER TABLE ... ADD COLUMN`, with no CHECK and no FK. A product with no vendor row returns the existing `404`. The audit row, the genesis transition, the Linear issue, `claim-submitted-alert` and `AdminClaim.context_product` ("Came from: <Product>" on `/admin/claims` and the claim detail) all carry the product. The duplicate probe keys on the company, so product-page and company-page claims on one company dedupe together. Contract: `API_CONTRACTS.md` §6.7.

**As built, AECI-1365 (2026-10-15): the plan field is removed.** `ClaimFormSchema` no longer has `plan_interest`, and `PlanInterestSchema` is deleted. Zod strips unknown keys, so a body that still sends the key validates and returns `201`, and the key is dropped. The API writes nothing to `vendor_requests.plan_interest`. The audit metadata, the genesis transition, the Linear line and the "Plan interest" row of `claim-submitted-alert` are gone, including on the §6.7 sweep's rebuilt issue and recovery alert. The column stays in `schema.ts`, marked deprecated, and E10 drops it. No migration. The text below is the AECI-1293 history.

**As built, AECI-1366 (2026-10-15): the vendor terms box, the acceptance and the receipt** (`docs/VENDOR_SIGNUP_PROCESS.md` §3 step 1, §4, decision 3).

- **The box.** A required checkbox, "I represent this company and accept the vendor terms", links the current terms page (`/legal/vendor-terms`, new tab). It sits on the dialog's You step on both paths, on both routed claim pages and in the drawer. `ClaimFormSchema` (and so `ListingRequestFormSchema`) gains `accepted_terms: z.literal(true)`. Missing or anything but `true` is `400 VALIDATION_FAILED` with `field: 'accepted_terms'`, and nothing is written. The form cannot submit unchecked. Its error is tied to the checkbox by `aria-describedby`. A `400` that names `accepted_terms` (a bundle loaded before the box shipped) shows the box's error, not "Something went wrong".
- **The acceptance.** The server stamps the current `vendor_terms` version (`LEGAL_AGREEMENT_CURRENT_VERSIONS`), `CF-Connecting-IP` and the user agent. `agreementAcceptanceStatements` writes one `agreement_acceptances` row (`source = 'claim'`, `email` = the typed address, `vendor_request_id` = the new claim) and its `agreement.accepted` audit row. Both ride the claim's own `db.batch`, after the claim insert, so a failed batch writes neither. Profile, vendor and billing account stay null until the approval links them (AECI-1367).
- **The seat disclosure.** When `GET /api/requests/claim-target/:type/:slug` says `has_seats`, the form shows Chris's ruled copy: "<Company> already maintains this listing. Send your request and their team will confirm you. We step in if they do not answer within 7 days." The dialog asks once a listing is chosen. The routed pages and the drawer ask in the browser after first render, never in SSR. A failed lookup shows nothing and never blocks the submit.
- **The receipt.** The on-screen receipt now reads "We've emailed a receipt to <email>. We'll write to you there with our decision." When the claim was routed, the owners decide, so the subtitle stops after "We've emailed a receipt to <email>." and "What happens next" reads "The team at <Company> has been asked to confirm you.", "If they accept, you get an invitation email to join." and "If nobody answers within 7 days, we review your claim and write to you." The dialog, both routed claim pages and the drawer carry it. Copy never puts a possessive on a company name ("Technologies's"); it says "the team at <Company>".
- **The email, `claim-received`.** This **reverses "no email to the visitor"**. After commit, in the same `waitUntil` chain as `claim-submitted-alert` and after it, the submitter gets a receipt: the company, the product page it came from, what happens next, and links to the vendor terms and the help page. It carries **no link that grants anything**: no sign-in, no portal, no token. The routed variant carries the same three sentences as the on-screen routed receipt. The address is typed, not verified, so the send is bounded: key `claim-received:{sha256(lower(email))}:{UTC day}`, at most one receipt per address per day across claims and listing requests. A request has one address and sends once, so the key is also the per-request bound. It says what to do if they did not send the claim. Not pausable: it is the claimant's record of accepting the terms. `production-external`.
- **The alert.** `claim-submitted-alert` gains "Sent to the owners at <Company>; AECi steps in on <date>." when the claim was routed (AECI-1368). The §6.7 sweep's recovery alert carries it too.

The existing endpoint and `ClaimRequestSchema`. ~~Plus one field, `plan_interest` (`PlanInterestSchema`: `free`, `managed`, `not_sure`, or `''` for not answered, stored as `NULL`).~~ Removed by AECI-1365: see the as-built note above.

**Comments are the claim's `body`.** Step 4's "Additional comments" is the claim form's existing optional `body` ("Anything we should know?", 0 to 2,000 characters). The dialog moves that field to the end and relabels it. It does not add a second free-text column: two notes from one claimant, under two labels, would split one answer across two places in the review. `vendor_requests.body` is `NOT NULL`, so an empty comment is stored as `''`, as today.

**Storage.** ~~One nullable column, `vendor_requests.plan_interest`, added by `ALTER TABLE ... ADD COLUMN`.~~ The column is unread and unwritten since AECI-1365 (as-built note above), and E10 drops it. **No CHECK constraint**, on purpose: a CHECK added in Drizzle is a table-level constraint, and any CHECK change makes drizzle-kit recreate the table (`docs/migrations.md` §0). `vendor_requests` has FK children (`vendor_entitlements.source_request_id`, and its own `duplicate_of_request_id`), so a recreate is the cascade hazard. ~~The vocabulary is enforced by `PlanInterestSchema` at the API.~~

~~The audit row (`vendor_request.created`) and the genesis workflow transition carry `plan_interest` in their metadata. The claim alert email (`claim-submitted-alert`) gains a "Plan interest" row. The Linear issue description gains the same line.~~ Removed by AECI-1365 (as-built note above).

### 15.4 A typed-in listing: `POST /api/requests/listing`

A new request kind, `listing_request`, in its **own table**, `listing_requests`.

**Since AECI-1474 (2026-10-24)** the same form also sits inline on `/vendor-program/list-your-product` (§2.5). It is the same call, the same row and the same receipt. Only `page` and `entry` on the events differ (§15.7).

**Why not a row in `vendor_requests`.** A typed-in listing has no target. `vendor_requests` has `target_type` and `target_id` `NOT NULL`, and CHECKs on `kind` (`claim`, `correction`) and `target_type` (`product`, `vendor`). Admitting the new kind means changing two CHECKs and a `NOT NULL`. On D1 each of those is a drizzle-kit table recreate, and `vendor_requests` has FK children, so the recreate's `DROP` fires the cascade path `docs/migrations.md` §0 forbids without its controls. The workflow side is the same: `workflow_instances.workflow_type` has a CHECK, and `workflow_transitions` is its FK child. A separate table is a plain `CREATE TABLE`, with nothing to cascade.

**The wire.** `ListingRequestSchema` in `packages/shared/src/api/requests.ts`:

```typescript
export const ListingRequestFormSchema = ClaimFormSchema.extend({
  listing_name: z.string().trim().min(1).max(200),
  website: HttpsUrlSchema.max(500),
});
export const ListingRequestSchema = ListingRequestFormSchema; // no target
```

It returns `RequestSubmitResponse` with `201` and the message "Your request has been received. We will add the listing and email you to finish your claim." Errors: `VALIDATION_FAILED` (400), `MALFORMED_REQUEST` (400).

**The table.** `listing_requests`: `id` (uuid), `listing_name`, `website`, `submitter_email`, `submitter_name` (nullable), `submitter_role` (nullable), `submitter_linkedin_url` (nullable), `plan_interest` (nullable; unwritten since AECI-1365, as-built note below), `body` (`NOT NULL`, default `''`), `status` (`open`, `resolved`, `rejected`; default `open`), `created_at`, `resolved_at`, `resolved_by`. **No FK and no CHECK**, the `field_overrides` precedent (`apps/api/src/db/schema.ts`): no FK to `profiles`, so erasure has nothing new to null, and an admin's id stays on the record the way it does in audit metadata. The vocabularies are enforced by Zod. One index, `(status, created_at)`, for the admin list.

**The write.** One `db.batch`: the insert and its `audit_log` row (`listing_request.created`, entity type `listing_request`, metadata ~~`plan_interest` and~~ `has_linkedin` (AECI-1365 dropped `plan_interest`, as-built note below), never the typed name, email or website). It is domain state (requests), so the row is required (ADR 0022). No `workflow_instances` row: the workflow vocabulary is CHECK-constrained (above), and the audit rows are the history. The §26.5 forward runs post-commit.

**As built, AECI-1365 (2026-10-15).** `ListingRequestFormSchema` lost `plan_interest` with the claim schema, and a body that still sends it returns `201`. The route writes nothing to `listing_requests.plan_interest`. The audit metadata is `{ source, has_linkedin }`, and the alert has no "Plan interest" row. The column stays, deprecated, until E10.

**Rate limit.** The path sits under `/api/requests/*`, so zone Rule A already caps it at the claim route's rate (5 per minute per IP, with a one-hour block). Like the claim route, it carries no in-Worker bucket (`docs/waf-rate-limits.md` §6.2: "Rule A already covers them"). The only key the Worker holds is a typed email, which rotates for free.

**As built, AECI-1366 (2026-10-15): the vendor terms box and the receipt.** The typed-in path carries the same required box (§15.3). Migration 0078 adds the nullable `agreement_acceptances.listing_request_id` (FK to `listing_requests`, `ON DELETE SET NULL`, one `ALTER TABLE ... ADD`). The route writes the acceptance with `listing_request_id` set and `vendor_request_id` null into its own batch, which is now four statements: the insert, its audit row, the acceptance and its `agreement.accepted` row. The visitor now gets `claim-received` after the alert, in the same `waitUntil`, under the same per-address, per-day key as a claim. It echoes the typed name as plain text in the body, never in the subject. The "No email to the visitor" below is superseded. The on-screen receipt reads "We've emailed a receipt to <email>. We'll add <name> to the directory, then write to you there so you can finish your claim."

**As built, AECI-1435 (2026-10-21): it waits on the emailed link too.** An anonymous typed-in listing is parked exactly as a claim is (§15.3), and the email reads "Confirm your listing request". The write above, the alert and the receipt run at confirm, and the row takes the pending id. The `201` message is "Check your email. Your request is not sent until you click the link we emailed you." A signed-in visitor whose verified email is the typed address skips the link.

**Notification.** A new operator alert, `listing-request-alert`, to `SUPPORT_EMAIL`, fire-and-forget in `ctx.waitUntil` after commit. Reply-to is the submitter, so a reply answers them. The table carries the name, website (plain text, never linked), submitter fields, ~~plan interest,~~ comments and the row id (AECI-1365 dropped the plan interest row, as-built note above), with a CTA to `/admin/requests`. Key `listing-request-alert:{id}`. Pausable: the request waits in `/admin/requests` either way. **No email to the visitor**, as with a claim: the address is typed, not verified, and the on-screen receipt is the receipt. No Linear issue: the alert and the admin queue are the record.

### 15.5 Admin

- **Claims.** ~~`AdminVendorRequest` gains `plan_interest` (`'free' | 'managed' | 'not_sure' | null`). The `/admin/claims` queue row and the claim detail show "Plan interest" with the answer, or "Not answered". In the queue's approve form the answer sits beside the plan radios as "They asked about: Managed", shown only when the claimant answered.~~ Removed by AECI-1365 (as-built note below). **The radios stay unselected** whatever the claimant said (`STAGE_2_PAID_TIERS_SPEC.md` §13.6, "nothing preselected"). The claimant's comments are the body the queue and the detail already show, now under the label "Comments".
- **Listing requests.** `/admin/requests` gains a second section, "Listing requests", under the corrections. Each row shows the name, website (plain text, with a copy-safe link that opens in a new tab), submitter name, role, email and LinkedIn, ~~plan interest,~~ comments and age (AECI-1365 dropped plan interest, as-built note below), with Resolve and Reject. It reads `GET /api/admin/listing-requests` (`status` and page params, like `GET /api/admin/requests`) and moderates through `PATCH /api/admin/listing-requests/:id` (`ModerateRequestSchema`). Each moderation is one `db.batch`: the guarded update and its `listing_request.resolved` or `listing_request.rejected` audit row. Both are behind `requireAdmin()`.
- **As built, AECI-1365 (2026-10-15).** `AdminVendorRequest`, `AdminClaim` and `AdminListingRequest` no longer carry `plan_interest`. The claim queue row, the claim detail and the listing request queue drop the "Plan interest" row. The approve form drops "They asked about". `plan-interest-label.ts` is deleted.
- **The badge.** `pending_requests` becomes open corrections plus open listing requests, so the Requests count matches the screen. Claims stay out of it (`admin-queue-counts.ts`). Since AECI-1377 it also counts open product requests, a vendor asking us to add the other product of an integration, which `/admin/requests` lists too (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.6).
- Resolving a listing request does not create the listing. The operator adds it upstream (the review app, then promote) and emails the submitter to claim it. That is the "we add it, then email you" in the receipt.

### 15.6 Per-listing claim pages

`/products/:slug/claim`, `/vendors/:slug/claim` and the in-place claim drawer keep working. They are step 2 onward on one form: the identity fields, then the plan question, then "Anything we should know?" relabelled "Additional comments". The plan question and the comments are both optional. They submit to `POST /api/requests/claim` as before, with `plan_interest`.

**As built, AECI-1365 (2026-10-15).** The plan question is gone from all three, so the form is the identity fields, then "Additional comments". The "Claim this listing" button on product and vendor detail pages now reads "Claim <Company>" (`docs/VENDOR_SIGNUP_PROCESS.md` §3 step 1). A product page uses its vendor's name, and "Claim your company" when the product has no vendor. The detail pages are cached on staging, so the deploy purges `route:detail`, which covers every `product:<slug>` and `vendor:<slug>` page (`apps/web/src/server/cache-tags.ts`).

**As built, AECI-1364 (2026-10-15).** All three are titled "Claim <Company>", and "Claim your company" when the company is unknown. The page `<title>` follows. The routed pages read the company from the existing reads: `GET /api/products/:slug` (its `vendor`) and `GET /api/vendors/:slug` (`claim-target.resolver.ts`, no page view, no `Cache-Tag`). A product page adds "From the <Product> page". The drawer takes the names from the detail page that opened it. The eyebrow reads "Vendor claim". The subtitle and the comments hint say "company", not "listing". The routed claim pages stay `private, no-store` with no `Cache-Tag`, so the copy change needs no purge. A slug that resolves to nothing now answers `404` with the form still rendered, as `/products/:slug/review` does. Any other failed read (a 5xx, a timeout) renders the form as "Claim your company" with no `404`, because the name is decoration and the form needed no read before.

### 15.7 Analytics

| Event | Properties | When |
|---|---|---|
| `claim_dialog_step` (new) | `step` (`find`, `you`, `plan`, `comments`, `done`), `page` (`vendor_program`, `docs_plans`), `entry` (the `PlanCtaPlacement` that opened it; `ask_to_add` removed 2026-10-12, before it shipped), `path` (`found`, `typed`; absent on `find`) | Once each time a step is shown, including the first. |
| `claim_requested` | ~~adds `plan_interest` (`free`, `managed`, `not_sure`, `none`)~~ unchanged since AECI-1365 (as-built note below) | A found-listing claim the API accepted, from the dialog, a claim page or the drawer. |
| `listing_requested` (new) | ~~`plan_interest`,~~ `page` (AECI-1365, as-built note below) | A typed-in request the API accepted. |
| `plan_cta_clicked` | unchanged shape. `plan: 'free'` now means a "Claim your listing" click and `plan: 'managed'` a "Start with Managed" click. Both open the claim dialog, so it counts opens. Since E8.2 (2026-10-19) both read "Claim your listing". `managed` marks the Managed card, rail and phone bar. | Every plan call to action. |
| ~~`plan_inquiry_submitted`~~ | ~~unchanged. It now counts inquiries from the "Questions about Managed or pricing? Talk to us" link and `/contact`.~~ **Removed 2026-10-19 (E8.1, AECI-1398):** the event no longer fires. | |

**As built, AECI-1365 (2026-10-15).** `claim_dialog_step.step` is `find`, `you`, `comments` or `done`, never `plan`. `claim_requested` and `listing_requested` no longer carry `plan_interest`. `listing_requested` carries `page` only. `docs/ANALYTICS.md` §4 is the event truth.

**As built, AECI-1474 (2026-10-24).** `claim_dialog_step.page` and `listing_requested.page` gain `list_your_product`, and `claim_dialog_step.entry` gains `list_page`, both from the listing request page (§2.5). On that page the first event is `step: you`, `path: typed`, with no `find` before it. They are new `ClaimDialogPage` and `ClaimDialogEntry` types. `PlanCtaPage` and `plan_cta_clicked` are unchanged.

**As built, 2026-10-24 (§2.4).** A dialog opened on `/vendor-program?vendor=` with a seeded company shows `you` first, with `path: 'found'`, and fires no `find`. Count dialog opens with `plan_cta_clicked`, not with `find`.

**As built, AECI-1435 (2026-10-21).** `claim_requested` and `listing_requested` gain `confirmation_required` (boolean). They still fire on the `201`, so on the confirm path they count submits, not sent claims. A new `claim_confirmed` fires from the `/claims/confirm` button with `kind` (`claim`, `listing`, or null when the link resolved to nothing) and `outcome` (`confirmed`, `already_confirmed`, `rejected`, `expired`, `not_found`, `gone`, `error`). `rejected` (2026-10-21) is a claim the account check refused at confirm. Never the token, the email, or the other company's name.

Never the search text, a typed name, a website or an email. The dialog's Find step does not fire `vendor_product_search`. That event was the inline section's count, and it is retired with the section (§9, 2026-10-12).

### 15.8 Migration

One drizzle-kit migration, additive only. The generated SQL must be exactly `CREATE TABLE listing_requests`, its index, and `ALTER TABLE vendor_requests ADD COLUMN plan_interest text` (shipped as written; AECI-1365 later stopped reading and writing the column, §15.3 as-built note). A `__new_` table, a `DROP TABLE` or an `INSERT INTO ... SELECT` in it means drizzle-kit chose a recreate, and the migration must not ship (`docs/migrations.md` §0).

### 15.9 Tests

- Shared: ~~`plan_interest` accepts the three values and `''`, rejects others, defaults when the key is absent.~~ (Removed by AECI-1365, §15.3 as-built note.) `ListingRequestSchema` requires the name and an `https://` website, and keeps the LinkedIn allowlist.
- API: ~~a claim with `plan_interest` and comments stores both. A body without the key still validates.~~ (AECI-1365: a body that still sends `plan_interest` returns `201` and the key is dropped, §15.3 as-built note.) A listing request writes the row and its audit row in one batch, sends the alert after commit, and rejects a bad website and a non-LinkedIn profile. The admin list and moderation for listing requests, including the `422` on a terminal row. The badge count.
- Web: the dialog's steps, Back, ~~the Managed and Free preselect,~~ the typed-in path, the signed-in swap to "Go to your portal", the analytics payloads (no typed text). The admin claim plan answer beside unselected radios. The listing request section.
- e2e: `apps/web/e2e/vendor-program-claim-dialog.spec.ts`, both paths with the search index and the two POST endpoints mocked.

### 15.10 Docs updated in the same change

`API_CONTRACTS.md` §6.7 (the `plan_interest` field, the new endpoint) and §6.10 (the listing request admin endpoints, the `pending_requests` predicate); `DATABASE_SCHEMA.md` (the column, the table, the ledger row); `ADMIN_PANEL_SPEC.md` (the Requests screen's second section and its badge); `STAGE_2_VENDOR_PORTAL_SPEC.md` §5 (the plan answer beside the radios); `ANALYTICS.md` §4; `NOTIFICATIONS.md` (generated by `pnpm docs:notifications`) and `docs/email.md` (the new alert); `OBSERVABILITY.md` (the `aeci.email.send` template list); `waf-rate-limits.md` §6.2 (the new path under Rule A); `STAGE_2_PRODUCT_DOCS_SPEC.md` §5 (the Plans page labels); `DESIGN.md` (the CTA wording); `POST_LAUNCH_MONITORING.md` where it reads `pending_requests`; the vendor docs pages `claiming-your-listing.md` and `plans.md`.

### 15.11 Not changed

- The "What Managed adds" list and the FAQ copy (other rulings pending). On 2026-10-12 the list's structure changed (§3, Free and Managed one pattern). Its wording did not. Later 2026-10-12 rulings removed its connector integrations line and reworded the integration detail body (§3 item 4). On 2026-10-13 the same line came off the help center's Plans page, its comparison table and the vendor-guide overview (`STAGE_2_PRODUCT_DOCS_SPEC.md`). The API gate it described is still in place. AECI-1323 decides it. One more reworded the several-products FAQ answer (§13 row 6).
- ~~`POST /api/plan-inquiries` and the inquiry dialog (§7).~~ **Removed 2026-10-19 (E8.1, AECI-1398):** both are gone (§7).
- The claim approval flow, the plan radios' rule and the grant emails.
- The full-width layout rule (§3, §11).

# AEC Integrations — Vendor Program Page Specification

**Version:** 0.4, build contract (2026-10-12 rulings: own benefit copy, the claim panel, new-tab doc links; §15 the claim dialog; Find your product removed and Free and Managed made one pattern; hero and claim copy, connector integrations out of the Managed pitch)
**Date:** 2026-10-12
**Status:** Build contract. Admitted into **Stage 2.5** by operator decision on 2026-10-12, as the sixth named exception to its "no new surface area" rule (`STAGE_2_5_SPEC.md` §14). It turns the marketing review's requirements draft ("For vendors" marketing page, 2026-10-12) into a contract checked against the code. Where the draft and the code disagreed, §1.2 records the ruling.
**Supersedes:** nothing. The draft stays a marketing-side input; this doc is the build truth.
**Inherits from:** Stage 1 / 1.5 / 2. Every constraint carries. The one most at risk here is the no-pay-for-placement firewall (`STAGE_2_PAID_TIERS_SPEC.md` §3.2): this page sells a plan, and nothing on it may suggest the plan buys position (§8).
**Companion docs:** `STAGE_2_PRODUCT_DOCS_SPEC.md` §5 (the `/docs/vendors/plans` page this page sits beside), `ANALYTICS.md` §4 (the `plan_*` events, §9 here), `CACHE_STRATEGY.md` (route tag, §2), `API_CONTRACTS.md` (`GET /api/vendor/me`, §5), `DESIGN.md` (navigation rule, §2.4).

> **Data-layer note.** §1 to §14 add no write and no table. Their one new read is an existing endpoint (`GET /api/vendor/me`), called from the browser only. **§15 (the claim dialog, AECI-1293) does add data:** a `listing_requests` table, `POST /api/requests/listing` and its audit row, and the two admin endpoints for it. §15.3 to §15.5 and §15.8 own them.

---

## 1. Purpose

A public landing page for AEC software vendors at **`/vendor-program`**.

- **Primary goal:** a vendor visit ends in a claim request for a listing. Claims are free.
- **Claim is the only plan action.** There is no Managed inquiry. A plain "Questions? Contact us" link to `/contact` handles questions.
- **Audience:** product marketing, partnerships or integrations leads, and founders at AEC software vendors. Many arrive from their own product's listing, a LinkedIn post, or outreach, often on a phone.
- **Relationship to the docs:** `/docs/vendors/plans` stays the detailed reference. The two pages link to each other.

### 1.1 Decisions settled 2026-10-12

| #   | Decision                   | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Launch timing              | **Public now.** Indexable, in the sitemap, linked from the footer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | Founding pilot on the page | **No.** The pilot stays in private outreach.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3   | Annual price               | **Show it.** The terms line reads "$25 USD a month or $250 USD a year per product." USD stays on each amount, because vendors outside the US read the page. The line names no payment method. The rail, phone bar and Managed card read "$25 USD a month per product". The comparison row reads "$25 USD a month or $250 USD a year per product", and its billing row "By card, monthly or yearly". The FAQ cost answer ends "You pay by card through Stripe, from the Billing tab." Ruled to ship while production checkout is still off (AECI-1396, `VENDOR_SIGNUP_PROCESS.md` §2 R2). The portal's plan panel reads "Managed is $25 a month or $250 a year per product." (AECI-1357). |
| 4   | Reply-time promise         | **None.** No page states a claim decision time or a reply time. The contact page keeps its own line (AECI-1398, AECI-1399).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5   | Inquiry routing            | **None.** There is no inquiry to route. Questions go to `/contact` (AECI-1398).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 6   | URL                        | **`/vendor-program`.** `/vendors` stays a 301 to `/products` (AECI-165).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### 1.2 Where the draft and the code disagreed

| Draft                                                                                                                  | Code                                                                                                                                                               | Ruling                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| URL `/vendors`                                                                                                         | A permanent redirect to `/products` (`removedIndexRedirect`, `apps/web/src/server-runtime.ts`). The index was removed on purpose.                                  | `/vendor-program`.                                                                                                |
| Claim is "sign-in, then the claim flow"                                                                                | A claim needs no account.                                                                                                                                          | Every claim control opens the claim dialog, which starts with Find it (§15).                                      |
| "Submit your product" on a miss                                                                                        | No submission flow existed.                                                                                                                                        | The claim dialog's typed-in step sends a `listing_request` (`POST /api/requests/listing`, §15.4).                 |
| Form: name, work email, company, products, message                                                                     | The plan inquiry form was retired (AECI-1398).                                                                                                                     | No form. Questions go to `/contact` (§15.1).                                                                      |
| Nav link "For vendors" in the site nav                                                                                 | `DESIGN.md` Navigation: the header row is public-directory-only, and any new item needs a re-measure (AECI-669).                                                   | Footer only (§2.4). The header link is an open decision (§13).                                                    |
| New events `vendor_cta_clicked`, `managed_inquiry_submitted`, `claim_started`, `claim_completed`, `vendor_page_viewed` | `plan_cta_clicked` and `claim_requested` already ship.                                                                                                             | Extend the existing events (§9). One new event, `claim_dialog_step`.                                              |
| Signed-in variants                                                                                                     | No app-wide plan signal. Plan data lives in `VendorPortalStore`, which is not root-provided.                                                                       | A root-level probe, browser-only (§5).                                                                            |
| "Verify trades, audiences and phases drive browse pages"                                                               | They do: `/trades`, `/audiences`, `/phases` and their `:slug` pages, and the `/search` facets.                                                                     | Copy may say buyers find products on those pages and filters. It may not say Managed ranks a product higher (§8). |
| Draft §9, fixes to `/docs/vendors/plans`                                                                               | Most shipped on 2026-10-12: the top button row, the full-width Managed card button, the closing panel, the rail card and the phone bar (`docs/docs-plans-cta.ts`). | §10 lists only what is left.                                                                                      |

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
- **Pricing structured data: the Managed plan's list price** (AECI-1431, 2026-10-29). Chris ruled it on once the price was final (`docs/PRICING_RULES.md` §2). The page emits one `schema.org/Service` block, `data-aeci-jsonld="plan"`, from `buildManagedPlanJsonLd` in `vendor-program/managed-plan-json-ld.ts` (the page's lazy chunk, to keep it out of the initial bundle). It carries two `Offer`s, monthly and yearly, each priced per product through a `UnitPriceSpecification` with a `billingDuration`. The prices read the same `MANAGED_LIST_PRICE_CENTS` and `MANAGED_ANNUAL_PRICE_CENTS` constants as the plan cards, so the published price and the visible one cannot differ. It is a `Service`, not a `Product`, because Google's product rich results expect a merchant listing. The founding discount and the pilot are private and never appear in it. The block is the same for every visitor, so the cached HTML stays visitor-neutral. _(Until 2026-10-29 the page emitted no `Offer`, because the price was then agreed per company.)_
- **Target searches**, for the title and description only: "list my software", "AEC software directory listing", "construction software integrations directory". Do not stuff them into the body.
- The page links into `/docs/vendors/*`, which is indexable and in the sitemap since AECI-1253 (2026-10-12).

### 2.4 Inbound links

| From                                                                             | Link                                                                               | Note                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Footer, Company column (`layout/site-footer.ts`)                                 | "For vendors"                                                                      | After Methodology.                                                                                                                                                                                                                                                                                                                        |
| Product detail page, beside the claim button ("Claim <Company>" since AECI-1365) | "Learn more about claiming" → `/vendor-program?vendor=<vendor slug>`, in a new tab | Visitor-neutral, so it stays in the cached HTML. Renamed 2026-10-24 from "Is this your product?", which read like a second claim button. It opens a new tab (`target="_blank"`, `aec-new-tab-icon`) so the visitor can return to the product page and claim there. A product with no vendor links to `/vendor-program` with no parameter. |
| `/docs/vendors/plans`                                                            | A line in the intro                                                                | §10.                                                                                                                                                                                                                                                                                                                                      |
| The `claim-approved` email                                                       | One line with the link                                                             | An approved claimant is on a plan and can act on it. `claim-rejected` gets no link, and `claim-submitted-alert` goes to support. Edit the template, then run `pnpm docs:notifications` (`apps/api/src/lib/notifications/registry.ts`).                                                                                                    |

The header row gets no link (§1.2).

**`?vendor=<slug>` (2026-10-24).** When the page loads with a `vendor` parameter, it reads `GET /api/vendors/:slug` in the browser after hydration and seeds the claim dialog with that company (`ClaimDialogService.setSeed`). Every "Claim your listing" then opens the dialog on the You step with "Claiming <Company>" and the "Claim <Company>" title (§15.2). "Change" still goes back to Find it. An unknown slug or a failed read seeds nothing, so the dialog starts on Find it as before. The cache key drops the query string (§2.2), so the SSR HTML is the same with or without the parameter. The seed clears when the page is left.

**Links to the listing request page (AECI-1474, §2.5).**

| From                                                                                       | Link                                                 | Note                                                                                |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `/vendor-program`, under the FAQ, beside "Questions? Contact us"                           | "Not listed yet?" then "Ask us to list your product" | A plain `routerLink`, same tab. Not tracked, like the contact link.                 |
| `/contact?topic=add-product`, the "Ask us to add your product" panel                       | "Request a listing", the primary button              | The support `mailto:` becomes the second, bordered button. The topic keeps working. |
| The help pages `/docs/trust/listing-submissions` and `/docs/vendors/claiming-your-listing` | "listing request form"                               | They named only the dialog's "Not listed? Type it in" before.                       |

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
4. **What Managed adds.** The section lede: "Managed is for products that need more than a corrected listing: your own account of what the product does on a project, who it is for, and how its integrations move data." Then the price and terms in small text, all from the shared constants in `shared/plan-cta/plan-cta.ts`:
   - The price line (`managedTermsLine`): "$25 USD a month or $250 USD a year per product." It names no payment method.
   - The term (`managedTermLine`): "Monthly has no commitment: cancel any time. We refund in full if you ask within 14 days of the first charge."
   - The renewal line (`managedRenewalLine`): "An annual license renews each year unless you opt out before the renewal date. Thirty days before that date, we email every seat and your billing email the date, the price, the license count and any change to the terms. A new price never applies mid-term."

   Then four lines, each with a plain title, a body and a "Learn more" link where a docs page exists:
   - **How teams use it.** "Describe, in your own words, the work your product does on a real project. Buyers judge fit by the work a product does, not by a feature list. Show them the job, and they can picture it on their own project."
   - **Trades, audiences and phases.** The vendor sets them "rather than leaving it to our reading of public sources". Buyers browsing or filtering by a trade find the products tagged with it.
   - **Integration detail buyers can check.** "Link evaluators to your integrations page and API docs. Confirm which data each integration moves, and your answer counts the same as your partner's. Buyers can check what an integration syncs before they rely on it for a project." Its one link is "Learn more". The plan cards merge the integration lines into one: "Integration detail: extra links and the data each integration moves."
   - **Review replies.**

   The plan cards share these lines, and the search engine line on them reads "Search engines notified when you update a page". It stays on the plan cards and the docs page, not in this list. The Free card's price line reads "Available for all products", with no "$0" figure. **Connector integrations are out of the Managed pitch** (ruled 2026-10-12). The line is gone from this list and from the shared plan cards, so `/docs/vendors/plans` loses that card line too. It remains a Managed capability (`STAGE_2_SPEC.md` §8.10, AECI-1040). The Markdown "What Managed adds" list on `/docs/vendors/plans` and the comparison table keep it as the feature reference.

5. **Plan cards.** Free and Managed side by side (§4, placement `card`). Reuse `DocsPlansComparisonComponent`'s cards. Do not copy them.
6. **How listings are sorted.** "Every listing is sorted by the same published rules. Your plan is not part of that." Link to `/docs/trust/how-ranking-works`. Write it as the reason buyers trust the directory, not as a disclaimer. Copy pass 2026-10-12 (Chris): the trust paragraph reads "That is why buyers trust what they find here, and why a claimed, complete listing is worth more than a paid one that is not. Paying changes what you can say. It never changes where you appear, whether a review is published, or how an agreement label is worked out."
7. **FAQ.** A native `<details>` list, in this order. No claim timing and no payment method appears except where noted.
   1. "Who can claim a listing?" Anyone who works at the company that makes the product. A claim on a product is a claim on the company, and the seat covers the whole company account.
   2. "What happens after I send a claim?" "A person reviews every claim and emails you the result."
   3. "We make several products. Do we claim each one?" "No. One claim gives you a seat on your company's account, and it covers every product your company makes. Managed is licensed per product. An owner buys licenses on the Billing tab and assigns one to each product you want on Managed."
   4. "What does Managed cost?" `managedCostAnswer`, from the two price constants: monthly has no commitment, an annual license renews unless the vendor opts out, a full refund within 14 days of the first charge, and "You pay by card through Stripe, from the Billing tab." (AECI-1396, shipped while production checkout is off, `VENDOR_SIGNUP_PROCESS.md` §2 R2).
   5. "Can we cancel a Managed plan early?" "Yes, on the monthly plan. Monthly has no commitment: cancel any time, and your licenses run to the end of the month you paid for. An annual license runs to its renewal date. If you opt out of renewal, it ends on that date." `/docs/vendors/plans` says the same, pinned by `vendor-program-copy.component.spec.ts`.
   6. "What happens when a Managed plan ends?" "Each product whose license ends moves to Free." Seats, sign-in and portal stay, nothing entered is removed, and the listings stay published. "The Managed fields stay just as you left them."
   7. "Does paying affect our reviews or where we rank?" No (§8).
8. **Closing panel.** §4, placement `bottom`.

**Removed 2026-10-13 (Chris): Coming soon** (`id="vp-coming-soon"`, formerly the seventh section). It promised performance reporting "to Managed". That named a tier before the tier was ruled (`VENDOR_PERFORMANCE_SPEC.md`), so it was a promise the first invoice could break. The page now describes only what ships, with no exception. Do not add a teaser back until the reporting has shipped on a ruled plan.

**Removed 2026-10-12 (Chris): Find your product** (`id="find-your-product"`, formerly the third section, §6). The claim dialog starts with Find it (§15.2 step 1), so the section repeated it. The hero's "How claiming works" step 1 now reads "Start your claim, then search for your product or your company." **Copy pass 2026-10-24 (Chris):** it reads "Start your claim here, or press Claim on any of your product pages, then search for your product or your company."

**Free and Managed are one pattern (settled 2026-10-12, Chris).** Both sections use the same layout and the same item, `li[aec-vendor-program-benefit]` (`vendor-program/vendor-program-benefit.ts`), so they cannot drift. An item is a plain semibold title (never a link), then the body, then, when the line has a docs page, a trailing "Learn more" link in a new tab with the new-tab cue. Its accessible name carries the title ("Learn more: How teams use it"). Neither section has subgroup headings. The only in-body link is the checklists link in Free. No Free line has a docs page of its own, so none ends in "Learn more".

One `h1`, then `h2` per section, in this order. The only `h3`s are the plan cards' own.

**This page carries its own benefit copy (settled 2026-10-12).** `/docs/vendors/plans` stays the feature reference. This page is the pitch. Every Free and Managed line says three things, in order: what the vendor can do, what the vendor gains, and what the buyer or the end user gains. The end user is the person who uses the integration on a project. The facts stay aligned with the docs page. The sentences do not have to match, and no test makes them. Three things stay shared: the plan cards (item 5, one component), the sort rule (item 6, one i18n id, `@@app.docs.plans.sortRule`, which reads the same as the Plans page), and the Managed terms (item 4 and item 7). The price and the monthly term come from the shared closing panel on both pages. Renewal and the early-cancel answer read the same as the Plans page's "Getting Managed". `vendor-program/vendor-program-copy.component.spec.ts` pins the sort rule, renewal, the early-cancel answer and the Plans page fragments this page links to.

**Doc links open in a new tab (settled 2026-10-12).** Every link on this page to `/docs/*` opens in a new tab: the section links, each "Learn more", the FAQ answers, "How ranking works" and "Compare every feature side by side". Each carries `target="_blank" rel="noopener"` and `aec-new-tab-icon`, the drawn icon plus the visually hidden "(opens in a new tab)". The reason is that a vendor reading the pitch keeps the claim one tab away. Conversion links stay in the tab: every claim link, "Questions? Contact us" and "Go to your portal". This is a page-scoped exception to `DESIGN.md`'s new-tab rule. `/docs/vendors/plans` keeps its links in the tab.

**Full width at desktop (settled 2026-10-12).** No narrow column with a blank right half: fill desktop width by layout. From `lg`, every section uses the whole `max-w-7xl` container, at 1024, 1280 and 1440px alike. Prose keeps a readable measure inside its column. The layout per section:

| Section                                       | From `lg`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hero                                          | The copy and the claim button in the left seven of twelve columns. "How claiming works" in the right five: three numbered steps (find, claim, we review it), facts the FAQ already states. Step 2 reads "Claiming is free. We set up your account when we approve your claim." Step 3 reads "A person reviews every claim and emails you the result." No claim timing. The claim dialog's subtitle uses the step 2 wording. "Needs no account" is retired everywhere, because it read as if no account is needed to manage a listing. Not a heading. Hidden below `lg`. |
| What changes when you claim, FAQ              | A split: the heading (and lede) in the left five columns, the content in the right seven. What changes when you claim puts the two labels side by side on the right (stacked below `sm`).                                                                                                                                                                                                                                                                                                                                                                               |
| What a free claim gets you, What Managed adds | The same split for both (2026-10-12): the heading and lede (Free's seat line; Managed's lede, then its terms line in small text, copy pass 2026-10-12) in the left four columns, the lines in the right eight as a two-column grid from `md`. One column at 375.                                                                                                                                                                                                                                                                                                        |
| Plan cards                                    | The shared cards side by side across the full width.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| How listings are sorted                       | The Bone panel, split: heading and sort rule left, the trust line and link right.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Closing panel                                 | The Forest panel, split: heading and terms left, the buttons and next steps right (`PlanCtaPanelComponent`'s `split` input).                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Phones stay one column.

---

## 4. Calls to action

Every claim control opens the claim dialog (§15.1). Claim is the only plan action, and questions go to a plain contact link.

| Action    | Text                    | Goes to                                                         |
| --------- | ----------------------- | --------------------------------------------------------------- |
| Claim     | "Claim your listing"    | The claim dialog. Without JS it is a link to `/search` (§15.1). |
| Questions | "Questions? Contact us" | `/contact`, a plain link with no form (§15.1).                  |

Never "Get Managed", "Start now" or "Buy". Public pages lead with the claim. Paying appears only on the portal's Billing tab, as "Pay by card" (AECI-1396).

### 4.1 Placements

| Placement         | `placement` value | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hero              | `top`             | The claim button, filled, on the first screen on desktop and phone. No contact link sits on the hero.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Plan cards        | `card`            | "Claim your listing" on both cards. Free's is the secondary style. Managed's is filled, at full card width.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Find your product | `search_result`   | Not used. The section was removed before it shipped (§6), and no production rows carry the value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Rail              | `rail`            | **Not on this page** (2026-10-12): it reserved an empty column beside every section (§3). The rail card stays on `/docs/vendors/plans`, so the `rail` placement value stays in analytics for that page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Phone bar         | `mobile_bar`      | Below `lg`: a slim bar fixed to the bottom. It hides while any full CTA is on screen, and it never covers the closing panel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Closing panel     | `bottom`          | A full-width band before the footer, with the headline "Tell the full story of your product" and the line "$25 USD a month or $250 USD a year per product. Monthly, cancel any time. Full refund within 14 days. If a plan ends, nothing you entered is removed." The price comes from `managedTermsLine`. The short term sentence is the panel's own string, so `managedTermLine` stays only beside the price in What Managed adds. A large "Claim your listing" button, with "Questions? Contact us", a plain link to `/contact`, beside it. Under the button, two numbered steps that describe the dialog the button opens, on both pages: "Find your listing and send your claim." and "We review it and email you the result." The steps show only while the button opens the dialog, so a vendor seat (§5) sees neither. |

**Reuse, don't fork.** The rail, the phone bar and the closing panel live in `apps/web/src/app/shared/plan-cta/` with a `page` input (§9). Both pages mount the phone bar and the closing panel. Only the docs page mounts the rail. The phone bar's `IntersectionObserver` logic and its `data-plans-cta` contract are unchanged.

**Annual price.** Add `MANAGED_ANNUAL_PRICE_CENTS = 25000` beside `MANAGED_LIST_PRICE_CENTS` in `packages/shared/src/entitlements.ts`. Format it with `formatPlanPrice`. Never hard-code "$250" in a template.

---

## 5. Signed-in vendor

The SSR HTML is always the signed-out page. After hydration:

| Visitor                                        | Change                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Signed out, or signed in without a vendor seat | None.                                                                                                             |
| Vendor seat, Free company                      | "Claim your listing" becomes "Go to your portal" (`/vendor`). The closing panel drops its two claim steps (§4.1). |
| Vendor seat, Managed company                   | As Free, plus the phone bar, the closing panel's contact link and its two steps are hidden.                       |

**The probe.** Add a root-provided `VendorPlanStatus` in `apps/web/src/app/vendor/`, on the `RoleStatus` pattern (`auth/role-status.ts`):

- It calls `GET /api/vendor/me` once, only when `VendorStatus.isVendor()` is true, only in the browser.
- It exposes `vendorSlug` and `managed` signals, both `null` until resolved. `managed` uses `isManaged` from `vendor/vendor-plan.ts`.
- It does not reuse or provide `VendorPortalStore`. That store is portal-scoped on purpose.
- A failed call leaves the page signed-out. It never shows an error.

---

## 6. Find your product

Retired 2026-10-12 (AECI-1293). The claim dialog's Find it step replaced this section (§15.2). The `/contact?topic=add-product` panel stays for links from outside the app.

---

## 7. Managed inquiry

Retired 2026-10-19 (AECI-1398). Claim is the only Managed action, and questions go through "Questions? Contact us", a plain link to `/contact` with no form (§15.1). Migration `0091` dropped `plan_inquiries`.

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

| Event               | Shape                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan_cta_clicked`  | `page` is `docs_plans` or `vendor_program`. `plan: 'free'` is a click on a Free-side control (hero, Free card, closing panel). `managed` is a click on a Managed-side control (Managed card, rail, phone bar). Every control reads "Claim your listing" and opens the claim dialog, so the event counts opens (§15.7). `placement` values are in §4.1. |
| `claim_dialog_step` | Covers the find funnel: step `find` shown, then step `you` with `path` `found` (a listing chosen) or `typed` (not listed) (§15.7). The dialog never sends the search text.                                                                                                                                                                             |
| `claim_requested`   | Fires when a claim form is sent, from any entry point (§15.7).                                                                                                                                                                                                                                                                                         |

There is no inline product search on this page, so no `vendor_product_search` event. The "Ask us to add it" link on `/contact` is not a plan call to action. A `$pageview` on `/contact` whose `$current_url` carries `topic=add-product` counts the arrivals.

Not added, and why:

- `vendor_page_viewed`: `$pageview` with `pathname = /vendor-program` already counts it.
- `claim_completed`: approval is an admin action, not a page event. It lives in `audit_log` and the admin claim queue.

**UTM.** LinkedIn and outreach links carry `utm_source`, `utm_medium` and `utm_campaign`. PostHog records them on `$pageview` without code. The marketing repo owns the link convention.

---

## 10. `/docs/vendors/plans` deltas

What `/docs/vendors/plans` takes from this page:

1. Pass `page: 'docs_plans'` on every CTA event (§9).
2. Mount the shared CTA components from `shared/plan-cta/` (§4.1). No visual change.
3. One intro line links to `/vendor-program`.
4. The closing panel shows the price from the two price constants (§4.1).
5. `STAGE_2_PRODUCT_DOCS_SPEC.md` §5's Plans entry matches.
6. The closing panel carries the price line and the monthly term with the 14-day refund. The Markdown repeats neither. "Getting Managed" opens with the per-product license and the hand-back rule, then the claim paragraph, then the renewal line word for word. The "Can we cancel a Managed plan early?" subsection sits under "Getting Managed" with the FAQ answer from §3 item 7. "The Billing tab" holds only tab mechanics. "When a Managed plan ends" speaks per product.

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

| Fact                                                                                                                                                                                                                                                  | Where to check                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| $25 a month per product is the public list price                                                                                                                                                                                                      | `MANAGED_LIST_PRICE_CENTS`                                                                                                                                                                                                                |
| $250 a year per product is the public annual price                                                                                                                                                                                                    | Chris, then `MANAGED_ANNUAL_PRICE_CENTS`                                                                                                                                                                                                  |
| Managed is licensed per product. Monthly has no commitment. An annual license renews unless the vendor opts out, with written notice at least 30 days ahead, and a new price never applies mid-term. A full refund within 14 days of the first charge | `docs/VENDOR_SIGNUP_PROCESS.md` §1 and §2, and the Managed plan agreement (E8.2, 2026-10-19)                                                                                                                                              |
| A claim approval time                                                                                                                                                                                                                                 | None is stated. Both pages say "A person reviews every claim and emails you the result." The closing panel step on both pages says "We review it and email you the result." The `/vendor-program` hero step and FAQ keep the longer line. |
| What a confirmed data flow shows publicly                                                                                                                                                                                                             | A pair page with a vendor attestation                                                                                                                                                                                                     |
| Any catalog count                                                                                                                                                                                                                                     | The API, on the day                                                                                                                                                                                                                       |

---

## 13. Open decisions

| #   | Question                                                                       | Default until decided                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What proof may appear: checked catalog counts, or quotes used with permission? | None.                                                                                                                                                                                                                                                             |
| 2   | A claim approval time in the FAQ?                                              | **No claim timing.** The FAQ asks "What happens after I send a claim?" and answers "A person reviews every claim and emails you the result." (AECI-1399).                                                                                                         |
| 3   | A "For vendors" link in the header row?                                        | Footer only. A header link needs a `DESIGN.md` change and the AECI-669 re-measure.                                                                                                                                                                                |
| 4   | A `name` field on plan inquiries?                                              | **Moot.** The plan inquiry form is gone (AECI-1398).                                                                                                                                                                                                              |
| 5   | A "Submit your product" flow for a product not in the catalog?                 | **Settled:** the claim dialog's typed-in step, a `listing_request` (§15.4). The contact topic `/contact?topic=add-product` stays for other entry points.                                                                                                          |
| 6   | Can one company's products sit on different plans?                             | **Yes** (AECI-1399). Managed is licensed per product. The several-products FAQ answer ends "Managed is licensed per product. An owner buys licenses on the Billing tab and assigns one to each product you want on Managed." `/docs/vendors/plans` says the same. |

---

## 14. Issue map

The epic and its children live in the Linear project **Stage 2.5 Hardening**. AECI-1290 runs last. Each issue's `**Spec section:**` line names this doc and one section.

| Issue                                                                     | Section     |
| ------------------------------------------------------------------------- | ----------- |
| **AECI-1281** Epic: vendor program page                                   | §1          |
| **AECI-1283** Route, caching, SEO, OG image, sitemap, inbound links       | §2          |
| **AECI-1284** Page sections and copy                                      | §3, §8      |
| **AECI-1285** Shared CTA components, placements, annual price             | §4          |
| **AECI-1286** `VendorPlanStatus` probe and signed-in variants             | §5          |
| **AECI-1287** Find your product (removed 2026-10-12, §6)                  | §6          |
| **AECI-1288** Analytics: `page`, `search_result`, `vendor_product_search` | §9          |
| **AECI-1289** `/docs/vendors/plans` deltas                                | §10         |
| **AECI-1290** Publication-day fact check                                  | §12         |
| **AECI-1293** Single claim dialog: find or type in, plan, comments        | §15         |
| **AECI-1474** Listing request page, the form inline                       | §2.5, §15.4 |

---

## 15. Claim dialog

**Ruling 2026-10-12 (Chris), AECI-1293.** One claim workflow, one dialog. A claim is on the company and asks no plan question. Every approval lands on Free, and Managed comes from a license the owner buys or AECi grants (`docs/VENDOR_SIGNUP_PROCESS.md` decisions 1, 2 and 5). Paying happens only on the portal Billing tab. Every main call to action opens this dialog. This section governs the claim rows of §4 and §4.1 and the `plan_cta_clicked` wording of §9.

### 15.1 Labels and entry points

| Where                                                                                        | Text                                                            | Opens                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hero (`top`), closing panel (`bottom`), Free plan card (`card`)                              | "Claim your listing"                                            | The dialog at step 1.                                                                                                                                                              |
| Managed plan card (`card`)                                                                   | "Claim your listing"                                            | The same dialog as every other control.                                                                                                                                            |
| Phone bar (`mobile_bar`), docs rail (`rail`)                                                 | "Claim your listing"                                            | The same dialog. Both sit on Managed-labelled surfaces: the bar's region is "Managed plan" and it hides for a Managed company (§5).                                                |
| Beside the closing panel's claim button (both pages), and under the FAQ on `/vendor-program` | "Questions?" then a link "Contact us" (`aec-plan-contact-link`) | `/contact`, a plain `routerLink` with no topic and no form. Not on the hero. Not tracked. A Managed company (§5) does not see the panel's copy. The FAQ's link shows for everyone. |
| `/vendor-program/list-your-product` (`list_page`, AECI-1474)                                 | The page itself                                                 | The flow inline, not a dialog, on the typed-in You step (§2.5).                                                                                                                    |

Every control opens the same dialog with nothing preselected. Claim is the one plan action. Never "Get Managed", "Buy", "Start now", "Start with Managed", "Talk to us about Managed" or "Claim your listing free". Public pages lead with the claim. Paying appears only on the portal's Billing tab (AECI-1396).

The same labels apply on `/docs/vendors/plans` through the shared `shared/plan-cta/` components, and the docs Free card's "Claim your listing" opens the dialog too.

**Signed-in vendor (§5).** A vendor seat sees "Go to your portal" (`/vendor`) wherever a control would open the dialog, the Managed card, rail and phone bar included. The contact link stays. A Managed company keeps §5's rule: no phone bar, and no contact link or steps in the panel.

**No-JS fallback.** Every dialog trigger is an `<a href="/search">` (`CLAIM_DIALOG_FALLBACK_HREF`). Without JS, before hydration, with no host on the page, or on a modified click, the link is followed. `/search` is where the header search box falls back too, and it is the page equivalent of the dialog's Find it step: a visitor searches, opens the listing, and uses its own claim form. A new-tab click has JS, so search works there in full. Without JS the page renders its box and no results, the same as the header path.

### 15.2 The steps

One BrnDialog: `BrnDialogContent` with a `BrnDialogTitle` and a `BrnDialogDescription`, over the CDK overlay, on `--surface-base` with no shadow (`shared/claim-dialog/claim-dialog.ts`). The title is "Claim <Company>" once a found listing names the company. It is "Claim your company" on the Find step and on the typed-in path, where no company is known yet. The description reads "Claiming is free. We set up your account when we approve your claim." There is no plan question (`docs/VENDOR_SIGNUP_PROCESS.md` decision 2).

The dialog has three steps and then a receipt. A visible indicator reads "Step N of 3" and names the step: Find it, You, Comments. A Back button sits on every step after the first one the visitor saw, and never on the receipt.

1. **Find it.** The step heading is "Find your listing". `aec-search-autocomplete` has its own `inputId`, the visible label "Your product or company" and the placeholder "Search for your product or company". Choosing a product or vendor suggestion selects that listing and moves to step 2. Choosing a product pre-fills the company from the search record's `vendor_name`. The record carries no vendor slug, so the dialog shows the name only and posts the product slug. The server resolves the company (§15.3), and a product with no vendor row answers `404`. Under the box: "Not listed? Type it in", a button that moves to the typed-in variant of step 2. Enter with no suggestion chosen does nothing in the dialog, so it never navigates away from an open form.
2. **You.** The step heading is "About you". A found listing shows a summary line, with "Change" back to step 1. A company hit reads "Claiming <Company>". A product hit reads "Claiming <Company> from the <Product> page", or "Claiming <Product>" when the search record has no vendor name. A typed-in listing first asks "Product or company name" (1 to 200 characters) and "Website" (an `https://` URL, `HttpsUrlSchema`). Then the identity fields: "Your name", "Your role at the company", "LinkedIn profile (optional)" with the AECI-847 host allowlist, and "Your work email". A well-formed address at a free mailbox domain (`FREE_EMAIL_DOMAINS` in `packages/shared/src/free-email-domains.ts`: Gmail, Yahoo, AOL, Outlook.com/Hotmail, iCloud and similar) shows an advisory notice under the field: "This looks like a personal email address. Please use your work email if you have one. We can still accept this address, but confirming your claim may take longer." It never blocks the claim. It shows as soon as the address qualifies, so a signed-in visitor's prefilled personal address gets it too, and the field's `aria-describedby` names it. The notice lives in the shared `ClaimantFields`, so the per-listing claim page and drawer (§15.6) show it as well. The required vendor terms box sits last on this step (§15.3). When the company already has seats, the seat disclosure shows too. "Continue" validates this step's fields only.
3. **Comments.** The step heading is "Anything to add?". An optional textarea, "Additional comments", up to 2,000 characters, then the submit button, "Send claim" (found) or "Send request" (typed-in).
4. **Receipt.** One receipt, focused on open. An anonymous visitor, or one signed in with another address, sees "Check your inbox" (ADR 0043): "We've sent a link to {address}. Your claim is not sent until you click it." (typed-in: "Your request is not sent until you click it."), then "The link works for 7 days. If it does not arrive, check your spam folder, or start again with the same email." An envelope icon replaces the tick, and there is no "What happens next" list. A signed-in visitor whose verified email is the typed address sends the claim at once and sees "Claim sent" with the receipt text of §15.3 and its three "What happens next" lines. Typed-in: "Request sent", then "We'll add {name} to the directory, then email {address} so you can finish your claim." A "Done" button closes the dialog.

**Behaviour.**

- One host per page (`aec-claim-dialog-host`), `@defer`-loaded on the first open, so nothing reaches the cached SSR HTML.
- Below `sm` the panel is a full-screen sheet (`100dvh`, no radius). From `sm` it is a centred panel, `min(92vw, 36rem)` wide, scrolling inside at `85vh`.
- Focus moves into the dialog on open, to the step heading on every step change, and back to the trigger on close (BrnDialog / CDK). Escape and the close button close it at any step. Closing discards the form. Each open starts fresh.
- Never opened from an `effect()` (NG0602): the root `ClaimDialogService` holds an opener callback, which the dialog registers and the click handler calls. The service holds the company name for the title. The flow sets it on every step change and clears it on the Find step.
- A submit failure keeps the visitor on the Comments step with "Something went wrong. Please try again." A `404` on a found listing (the listing was unpublished since the search) says the listing is no longer available and offers "Type it in instead".

**A seeded open (§2.4).** When the page seeded a company from `?vendor=`, the dialog opens on You with that company found, reports `claim_dialog_step` `you` with `path: 'found'`, and moves focus to the You heading. "Back" and "Change" both go to Find it, so a visitor who meant another company can still search.

**Starting on the typed-in step, and embedded** (§2.5). `ClaimDialogOpening.start: 'typed'` opens on the typed-in You step and focuses its first field. One `claim_dialog_step` fires (`you`, `typed`), and no `find`. The `embedded` input drops the dialog's inner scroll and the receipt's "Done". With `start: 'typed'` the indicator counts two steps, You "Step 1 of 2" and Comments "Step 2 of 2", and the bar fills to match. Back from You goes to Find, a ruled exception to "after the first one the visitor saw". Find after Back is a detour and shows no indicator. Choosing a found listing there keeps the two-step count. The count derives from `opening().start`, not from `embedded`. The dialog with no `start` has three steps and Find is step 1.

### 15.3 A found listing: `POST /api/requests/claim`

A claim is on the **company** (`docs/VENDOR_SIGNUP_PROCESS.md` decision 1). The endpoint accepts `target_type: 'product'` or `'vendor'`. A product claim is stored with `target_type = 'vendor'`, the product's primary vendor (else any `product_vendors` row), and the product in the nullable `vendor_requests.context_product_id` (`0076`, no CHECK and no FK). A product with no vendor row returns `404`. The audit row, the genesis transition, the Linear issue, `claim-submitted-alert` and `AdminClaim.context_product` ("Came from: <Product>") all carry the product. The duplicate probe keys on the company, so product-page and company-page claims on one company dedupe together. Contract: `API_CONTRACTS.md` §6.7.

The claim form has no plan field (decision 2). `ClaimFormSchema` has no `plan_interest`. Zod strips unknown keys, so a body that still sends it returns `201` and the key is dropped. The columns are gone (`0093`, `0094`).

**The typed address confirms first** (ADR 0043, `API_CONTRACTS.md` §6.7). Unless the visitor is signed in with a verified email equal to the typed address, the submit only parks the claim in `request_confirmations` and emails `claim-confirm` to the typed address: "Confirm your claim for <Company>", what was claimed, one button to `/claims/confirm?token=…`, "This link works for 7 days." and "If you did not send this, ignore this email. Nothing happens unless you click." The link is single-use, never blind-copied to the operator list, and bounded to 3 mails per address per UTC day.

- **The confirm page.** `/claims/confirm` renders "Confirm your claim" and one button, "Confirm and send". Only the click POSTs, because mail scanners prefetch links. The route is noindex and absent from `ROUTE_CACHE_PATTERNS`, so it is `private, no-store`. The token leaves the address bar after the first render and is stripped from analytics URLs. The results are: "Claim sent" with the receipt's "What happens next" (routed variant included), "Request sent" for a typed-in listing, "Already confirmed", "This link has expired", "This link is not valid", and "That listing is no longer available". Each failure offers "Start again" to `/vendor-program`.
- **A refused claim.** The account check (AECI-1420, `VENDOR_SIGNUP_PROCESS.md` §2) runs at confirm and shows "We could not accept this claim". For a seat on another company it says "This address already manages <Vendor> on AEC Integrations. Each address can manage one company. Send the claim again from a different work address." For a staff account it says "This address belongs to an AEC Integrations staff account. Send the claim again from a different work address." Both add "We've emailed you the same details." and "Start again". The click proved the mailbox, so naming the company is safe. The signed-in receipt stays generic.
- **What runs at confirm.** The acceptance row, the account check, owner routing, the Linear issue, `claim-submitted-alert`, `claim-received` and `claim-owner-review`. The claim takes the pending row's id. The visitor gets two mails for one claim: the link, then the receipt.

**The vendor terms box** (`docs/VENDOR_SIGNUP_PROCESS.md` §3 step 1, §4, decision 3).

- **The box.** A required checkbox, "I represent this company and accept the vendor terms", links the current terms page (`/legal/vendor-terms`, new tab). It sits on the dialog's You step on both paths, on both routed claim pages and in the drawer. `ClaimFormSchema` (and so `ListingRequestFormSchema`) has `accepted_terms: z.literal(true)`. Missing or anything but `true` is `400 VALIDATION_FAILED` with `field: 'accepted_terms'`, and nothing is written. The form cannot submit unchecked. Its error is tied to the checkbox by `aria-describedby`. A `400` that names `accepted_terms` (a bundle loaded before the box shipped) shows the box's error, not "Something went wrong".
- **The acceptance.** The server stamps the current `vendor_terms` version (`LEGAL_AGREEMENT_CURRENT_VERSIONS`), `CF-Connecting-IP` and the user agent. `agreementAcceptanceStatements` writes one `agreement_acceptances` row (`source = 'claim'`, `email` = the typed address, `vendor_request_id` = the new claim) and its `agreement.accepted` audit row, in the claim's own `db.batch`, after the claim insert. A failed batch writes neither. An anonymous claim writes them at confirm, with the submit's version, IP and user agent and the confirm time. Profile, vendor and billing account stay null until the approval links them.
- **The seat disclosure.** When `GET /api/requests/claim-target/:type/:slug` says `has_seats`, the form shows: "<Company> already maintains this listing. Send your request and their team will confirm you. We step in if they do not answer within 7 days." The dialog asks once a listing is chosen. The routed pages and the drawer ask in the browser after first render, never in SSR. A failed lookup shows nothing and never blocks the submit.
- **The receipt.** "We've emailed a receipt to <email>. We'll write to you there with our decision." When the claim was routed, the owners decide, so the subtitle stops after "We've emailed a receipt to <email>." and "What happens next" reads "The team at <Company> has been asked to confirm you.", "If they accept, you get an invitation email to join." and "If nobody answers within 7 days, we review your claim and write to you." The dialog, both routed claim pages and the drawer carry it. Copy never puts a possessive on a company name ("Technologies's"). It says "the team at <Company>".
- **The email, `claim-received`.** After commit, in the same `waitUntil` chain as `claim-submitted-alert` and after it, the submitter gets a receipt: the company, the product page it came from, what happens next, and links to the vendor terms and the help page. It carries **no link that grants anything**: no sign-in, no portal, no token. The routed variant carries the same three sentences as the on-screen routed receipt. The address is typed, not verified, so the send is bounded: key `claim-received:{sha256(lower(email))}:{UTC day}`, at most one receipt per address per day across claims and listing requests. It says what to do if they did not send the claim. Not pausable, because it is the claimant's record of accepting the terms. `production-external`.
- **The alert.** `claim-submitted-alert` says "Sent to the owners at <Company>; AECi steps in on <date>." when the claim was routed. The §6.7 sweep's recovery alert carries it too.

**Comments are the claim's `body`.** The dialog's "Additional comments" is the claim form's optional `body` (0 to 2,000 characters), moved to the end. It is not a second free-text column, because two notes from one claimant under two labels would split one answer across two places in the review. `vendor_requests.body` is `NOT NULL`, so an empty comment is stored as `''`.

### 15.4 A typed-in listing: `POST /api/requests/listing`

A request kind, `listing_request`, in its **own table**, `listing_requests`. The same form also sits inline on `/vendor-program/list-your-product` (§2.5). It is the same call, the same row and the same receipt. Only `page` and `entry` on the events differ (§15.7).

**Why not a row in `vendor_requests`.** A typed-in listing has no target. `vendor_requests` has `target_type` and `target_id` `NOT NULL`, and CHECKs on `kind` (`claim`, `correction`) and `target_type` (`product`, `vendor`). Admitting the new kind means changing two CHECKs and a `NOT NULL`. On D1 each of those is a drizzle-kit table recreate, and `vendor_requests` has FK children, so the recreate's `DROP` fires the cascade path `docs/migrations.md` §0 forbids without its controls. The workflow side is the same: `workflow_instances.workflow_type` has a CHECK, and `workflow_transitions` is its FK child. A separate table is a plain `CREATE TABLE`, with nothing to cascade.

**The wire.** `ListingRequestSchema` in `packages/shared/src/api/requests.ts`:

```typescript
export const ListingRequestFormSchema = ClaimFormSchema.extend({
  listing_name: z.string().trim().min(1).max(200),
  website: HttpsUrlSchema.max(500),
});
export const ListingRequestSchema = ListingRequestFormSchema; // no target
```

`ClaimFormSchema` carries the required `accepted_terms: z.literal(true)` (§15.3), so the typed-in form carries the vendor terms box too. The route returns `RequestSubmitResponse` with `201`. Errors: `VALIDATION_FAILED` (400), `MALFORMED_REQUEST` (400).

**The confirm link.** An anonymous typed-in listing is parked in `request_confirmations` exactly as a claim is (§15.3, ADR 0043), and the email reads "Confirm your listing request". The `201` message is "Check your email. Your request is not sent until you click the link we emailed you." The write, the alert and the receipt below run at confirm, and the row takes the pending id. A signed-in visitor whose verified email is the typed address skips the link, and the `201` message is "Your request has been received. We will add the listing and email you to finish your claim." (`LISTING_REQUEST_RECEIVED`).

**The table.** `listing_requests`: `id` (uuid), `listing_name`, `website`, `submitter_email`, `submitter_name` (nullable), `submitter_role` (nullable), `submitter_linkedin_url` (nullable), `body` (`NOT NULL`, default `''`), `status` (`open`, `resolved`, `rejected`, default `open`), `created_at`, `resolved_at`, `resolved_by`. **No FK and no CHECK**, the `field_overrides` precedent (`apps/api/src/db/schema.ts`): no FK to `profiles`, so erasure has nothing new to null, and an admin's id stays on the record the way it does in audit metadata. The vocabularies are enforced by Zod. One index, `(status, created_at)`, for the admin list.

**The write.** One `db.batch` of four statements: the insert, its `audit_log` row (`listing_request.created`, entity type `listing_request`, metadata `{ source, has_linkedin }`, never the typed name, email or website), the `agreement_acceptances` row with `listing_request_id` set and `vendor_request_id` null (`0078`), and its `agreement.accepted` row. It is domain state (requests), so the audit row is required (ADR 0022). No `workflow_instances` row: the workflow vocabulary is CHECK-constrained (above), and the audit rows are the history. The §26.5 forward runs post-commit.

**Rate limit.** The path sits under `/api/requests/*`, so zone Rule A already caps it at the claim route's rate (5 per minute per IP, with a one-hour block). Like the claim route, it carries no in-Worker bucket (`docs/waf-rate-limits.md` §6.2: "Rule A already covers them"). The only key the Worker holds is a typed email, which rotates for free.

**Notifications.** Two emails go out after commit, in one `ctx.waitUntil` chain. `listing-request-alert` goes to `SUPPORT_EMAIL` with reply-to set to the submitter. Its table carries the name, website (plain text, never linked), submitter fields, comments and the row id, with a CTA to `/admin/requests`. Key `listing-request-alert:{id}`. Pausable, because the request waits in `/admin/requests` either way. `claim-received` goes to the submitter, under the same per-address, per-day key as a claim (§15.3). It echoes the typed name as plain text in the body, never in the subject. No Linear issue: the alert and the admin queue are the record.

**The receipt.** "We've emailed a receipt to <email>. We'll add <name> to the directory, then write to you there so you can finish your claim." An anonymous visitor sees the "Check your inbox" receipt first (§15.2).

### 15.5 Admin

- **Claims.** The `/admin/claims` queue row and the claim detail show the claimant's comments under the label "Comments", and "Came from: <Product>" when the claim began on a product page. There is no plan answer and no plan radios, because every approval lands on Free (`docs/VENDOR_SIGNUP_PROCESS.md` §3 step 2).
- **Listing requests.** `/admin/requests` has a second section, "Listing requests", under the corrections. Each row shows the name, website (plain text, with a copy-safe link that opens in a new tab), submitter name, role, email and LinkedIn, comments and age, with Resolve and Reject. It reads `GET /api/admin/listing-requests` (`status` and page params, like `GET /api/admin/requests`) and moderates through `PATCH /api/admin/listing-requests/:id` (`ModerateRequestSchema`). Each moderation is one `db.batch`: the guarded update and its `listing_request.resolved` or `listing_request.rejected` audit row. Both are behind `requireAdmin()`.
- **The badge.** `pending_requests` is open corrections plus open listing requests, so the Requests count matches the screen. Claims stay out of it (`admin-queue-counts.ts`). It also counts open product requests, a vendor asking us to add the other product of an integration, which `/admin/requests` lists too (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.6, AECI-1377).
- Resolving a listing request does not create the listing. The operator adds it upstream (the review app, then promote) and emails the submitter to claim it. That is the "we add it, then email you" in the receipt.

### 15.6 Per-listing claim pages

`/products/:slug/claim`, `/vendors/:slug/claim` and the in-place claim drawer are the dialog's You and Comments steps on one form: the identity fields, the vendor terms box, then "Additional comments". They submit to `POST /api/requests/claim`. There is no plan question.

All three are titled "Claim <Company>", and "Claim your company" when the company is unknown. The page `<title>` follows. The "Claim <Company>" button on product and vendor detail pages uses the vendor's name, and "Claim your company" when the product has no vendor (`docs/VENDOR_SIGNUP_PROCESS.md` §3 step 1, AECI-1364, AECI-1365). A product page adds "From the <Product> page". The eyebrow reads "Vendor claim". The subtitle and the comments hint say "company", not "listing".

The routed pages read the company from `GET /api/products/:slug` (its `vendor`) and `GET /api/vendors/:slug` (`claim-target.resolver.ts`, no page view, no `Cache-Tag`). The drawer takes the names from the detail page that opened it. The routed claim pages stay `private, no-store` with no `Cache-Tag`. A slug that resolves to nothing answers `404` with the form still rendered, as `/products/:slug/review` does. Any other failed read (a 5xx, a timeout) renders the form as "Claim your company" with no `404`, because the name is decoration. The detail pages are cached, so a change to the button copy purges `route:detail` (`apps/web/src/server/cache-tags.ts`).

### 15.7 Analytics

| Event               | Properties                                                                                                                                                                                                             | When                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `claim_dialog_step` | `step` (`find`, `you`, `comments`, `done`), `page` (`vendor_program`, `docs_plans`, `list_your_product`), `entry` (the `PlanCtaPlacement` that opened it, or `list_page`), `path` (`found`, `typed`, absent on `find`) | Once each time a step is shown, including the first.                                 |
| `claim_requested`   | `target_type`, `slug`, `request_id`, `confirmation_required`                                                                                                                                                           | A found-listing claim the API accepted, from the dialog, a claim page or the drawer. |
| `listing_requested` | `page`, `confirmation_required`                                                                                                                                                                                        | A typed-in request the API accepted.                                                 |
| `claim_confirmed`   | `kind` (`claim`, `listing`, or null when the link resolved to nothing), `outcome` (`confirmed`, `already_confirmed`, `rejected`, `expired`, `not_found`, `gone`, `error`)                                              | The "Confirm and send" button on `/claims/confirm` got an answer.                    |
| `plan_cta_clicked`  | `plan`, `placement`, `page` (§9)                                                                                                                                                                                       | Every plan call to action. It counts dialog opens, not claims.                       |

`claim_requested` and `listing_requested` fire on the `201`. With `confirmation_required: true` they count submits, not sent claims, and `claim_confirmed` counts the clicks (ADR 0043). `rejected` is a claim the account check refused at confirm. The event carries no token, no email and no other company's name.

The first event on the listing request page (§2.5) is `step: you`, `path: typed`, with no `find` before it. A dialog opened on `/vendor-program?vendor=` with a seeded company (§2.4) shows `you` first, with `path: 'found'`, and fires no `find`. Count dialog opens with `plan_cta_clicked`, not with `find`.

Never the search text, a typed name, a website or an email. The Find step does not fire `vendor_product_search`. `docs/ANALYTICS.md` §4 is the event truth.

### 15.8 Migration

The claim dialog added one table, `listing_requests`, and its index, as a plain `CREATE TABLE` (`0070`). `0076` added `vendor_requests.context_product_id` and `0078` added `agreement_acceptances.listing_request_id`, each one `ALTER TABLE ... ADD COLUMN`. The `plan_interest` columns on `vendor_requests` and `listing_requests` are gone (`0093` and `0094`, `docs/migrations.md` §3.2). A migration that holds a `__new_` table, a `DROP TABLE` or an `INSERT INTO ... SELECT` means drizzle-kit chose a recreate and must not ship (`docs/migrations.md` §0).

### 15.9 Tests

- Shared: `ListingRequestSchema` requires the name and an `https://` website, keeps the LinkedIn allowlist, and requires `accepted_terms: true`. A claim body that still sends `plan_interest` validates and the key is dropped.
- API: a listing request writes the row, its audit row, the acceptance and its audit row in one batch, sends the alert after commit, and rejects a bad website and a non-LinkedIn profile. An anonymous submit parks in `request_confirmations` and writes nothing else. The admin list and moderation for listing requests, including the `422` on a terminal row. The badge count.
- Web: the dialog's steps, Back, the typed-in path, the "Check your inbox" receipt, the signed-in swap to "Go to your portal", the analytics payloads (no typed text), and the listing request section of the admin queue.
- e2e: `apps/web/e2e/vendor-program-claim-dialog.spec.ts`, both paths with the search index and the two POST endpoints mocked.

### 15.10 Docs updated in the same change

The companion docs that carry the claim dialog's contracts: `API_CONTRACTS.md` §6.7 (the claim and listing request endpoints) and §6.10 (the listing request admin endpoints, the `pending_requests` predicate), `DATABASE_SCHEMA.md` (`listing_requests`, `request_confirmations`, `agreement_acceptances`), `ADMIN_PANEL_SPEC.md` (the Requests screen's second section and its badge), `STAGE_2_VENDOR_PORTAL_SPEC.md` §5, `ANALYTICS.md` §4, `NOTIFICATIONS.md` (generated by `pnpm docs:notifications`) and `docs/email.md`, `OBSERVABILITY.md` (the `aeci.email.send` template list), `waf-rate-limits.md` §6.2 (the new path under Rule A), `STAGE_2_PRODUCT_DOCS_SPEC.md` §5, `DESIGN.md` (the CTA wording), `POST_LAUNCH_MONITORING.md` where it reads `pending_requests`, and the vendor docs pages `claiming-your-listing.md` and `plans.md`.

### 15.11 Not changed

- The "What Managed adds" list: its structure is in §3 (Free and Managed are one pattern), and its wording is in §3 item 4. Connector integrations stay out of the pitch. They remain a Managed capability (`STAGE_2_SPEC.md` §8.10).
- The claim approval flow and the grant emails (`docs/VENDOR_SIGNUP_PROCESS.md` §3, `STAGE_2_VENDOR_PORTAL_SPEC.md`).
- The full-width layout rule (§3, §11).

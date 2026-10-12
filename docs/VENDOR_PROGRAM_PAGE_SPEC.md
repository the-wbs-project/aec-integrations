# AEC Integrations — Vendor Program Page Specification

**Version:** 0.4, build contract (2026-10-12 rulings: own benefit copy, the claim panel, new-tab doc links; §15 the claim dialog; Find your product removed and Free and Managed made one pattern; hero and claim copy, connector integrations out of the Managed pitch)
**Date:** 2026-10-12
**Status:** Build contract. Admitted into **Stage 2.5** by operator decision on 2026-10-12, as the sixth named exception to its "no new surface area" rule (`STAGE_2_5_SPEC.md` §14). It turns the marketing review's requirements draft ("For vendors" marketing page, 2026-10-12) into a contract checked against the code. Where the draft and the code disagreed, §1.2 records the ruling.
**Supersedes:** nothing. The draft stays a marketing-side input; this doc is the build truth.
**Inherits from:** Stage 1 / 1.5 / 2. Every constraint carries. The one most at risk here is the no-pay-for-placement firewall (`STAGE_2_PAID_TIERS_SPEC.md` §3.2): this page sells a plan, and nothing on it may suggest the plan buys position (§8).
**Companion docs:** `STAGE_2_PRODUCT_DOCS_SPEC.md` §5 (the `/docs/vendors/plans` page this page sits beside), `ANALYTICS.md` §4 (the `plan_*` events, §9 here), `CACHE_STRATEGY.md` (route tag, §2), `API_CONTRACTS.md` (`POST /api/plan-inquiries`, `GET /api/vendor/me`, §5 and §7), `DESIGN.md` (navigation rule, §2.4), `docs/email.md` (the inquiry receipt and alert, §7).

> **Data-layer note.** §1 to §14 add no write and no table. Their one new read is an existing endpoint (`GET /api/vendor/me`), called from the browser only. **§15 (the claim dialog, AECI-1293) does add data:** a nullable `vendor_requests.plan_interest` column, a `listing_requests` table, `POST /api/requests/listing` and its audit row, and the two admin endpoints for it. §15.3 to §15.5 and §15.8 own them.

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
| Claim is "sign-in, then the claim flow" | A claim needs no account. It is per listing: `/products/:slug/claim` and `/vendors/:slug/claim`, both `RequestForm` with `kind: 'claim'`. | "Claim your listing free" scrolls to Find your product (§6). A result leads to that listing's claim form. **Superseded 2026-10-12 by §15:** every claim control opens the claim dialog, which starts with Find it. The Find your product section is removed. |
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
- The page links into `/docs/vendors/*`, which is indexable and in the sitemap since AECI-1253 (2026-10-12).

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

1. **Hero.** The headline (settled 2026-10-12): "Your products may already be listed here. Make sure buyers read your version." The subhead (settled 2026-10-12, Chris): "AEC Integrations lists AEC software and its integrations from public sources. Claim your listing for free to correct it, keep it current, and show buyers your team maintains it." Both calls to action (§4). No statistics.
2. **What changes when you claim** (settled 2026-10-12, replaces "The problem"). One or two sentences of the problem, then a before and after panel with the two real maintenance labels: "AEC Integrations maintained" before, "Vendor maintained · Updated" and a date once the vendor saves a change or confirms a page is right (`STAGE_2_ATTESTATIONS_SPEC.md` §13.9, `STAGE_2_PAID_TIERS_SPEC.md` §13.8). Both labels are drawn by the listing's own `shared/maintenance-marker` component, never retyped, so the page cannot show wording a listing does not. The example date is today, in UTC. A claim alone does not change the label, so the copy never says it does.
3. **What a free claim gets you.** Three outcomes: your listing in your words, your integrations owned by you, a complete listing at no cost. The seat link stays in the lede, and the checklist link in the first item's body.
4. **What Managed adds.** The price and terms line first, from the shared constants. Then four lines: how teams use it; trades, audiences and phases; more detailed information about integrations; review replies. Ruled 2026-10-12: the integrations page and API docs links line and the confirmed data flows line are one entry, "More detailed information about integrations (additional URLs, data flow, etc.)", which keeps both docs links. The plan cards merge the same two items into the same line. "Search engine notice" stays on the plan cards and the docs page, not in this list. **Removed from the Managed pitch 2026-10-12 (Chris): connector integrations.** The "Connector integrations" line is gone from this list, and "The integrations you deliver through a connector" is gone from the shared plan cards, so `/docs/vendors/plans` loses that card line too. It remains a Managed capability (`STAGE_2_SPEC.md` §8.10, AECI-1040). The Markdown "What Managed adds" list on `/docs/vendors/plans` and the comparison table keep it as the feature reference.
5. **Plan cards.** Free and Managed side by side (§4, placement `card`). Reuse `DocsPlansComparisonComponent`'s cards. Do not copy them.
6. **How listings are sorted.** "Every listing is sorted the same way: how well it matches the search, then how complete it is. Your plan is not part of that." Link to `/docs/trust/how-ranking-works`. Write it as the reason buyers trust the directory, not as a disclaimer.
7. **Coming soon.** Performance reporting for Managed, labelled as not available yet, framed as what it will let the vendor see. It keeps the sentence that it never changes where a listing ranks or appears.
8. **FAQ.** Who can claim; how long approval takes (generally within 48 hours, §12); several products; invoice or purchase order; what happens when a plan ends; whether paying affects reviews or ranking. Use a native `<details>` list.
9. **Closing panel.** §4, placement `bottom`.

**Removed 2026-10-12 (Chris): Find your product** (`id="find-your-product"`, formerly the third section, §6). The claim dialog starts with Find it (§15.2 step 1), so the section repeated it. The hero's "How claiming works" step 1 now reads "Start your claim, then search for your product or your company."

**Free and Managed are one pattern (settled 2026-10-12, Chris).** Both sections use the same layout and the same item, `li[aec-vendor-program-benefit]` (`vendor-program/vendor-program-benefit.ts`), so they cannot drift. An item is a plain semibold title (never a link), then the body, then, when the line has a docs page, a trailing "Learn more" link in a new tab with the new-tab cue. Its accessible name carries the title ("Learn more: How teams use it"). Neither section has subgroup headings: the three Managed `h3`s ("Explain what your product does on a project", "Back up your integrations", "Answer buyers in public") are gone. The wording of every line and every link target stayed. Only the old bold link lead-in became the plain title plus "Learn more", and the title dropped its trailing period. In-body links stay in the body: the checklists link in Free and "Attesting an integration" in Managed. No Free line has a docs page of its own, so none ends in "Learn more".

One `h1`, then `h2` per section, in this order. The only `h3`s are the plan cards' own.

**This page carries its own benefit copy (settled 2026-10-12).** `/docs/vendors/plans` stays the feature reference. This page is the pitch. Every Free and Managed line says three things, in order: what the vendor can do, what the vendor gains, and what the buyer or the end user gains. The end user is the person who uses the integration on a project. The facts stay aligned with the docs page. The sentences do not have to match, and no test makes them. Two things stay shared: the plan cards (item 6, one component) and the sort rule (item 7, one i18n id, `@@app.docs.plans.sortRule`, which reads the same as the Plans page). `vendor-program/vendor-program-copy.component.spec.ts` pins only the sort rule and the Plans page fragments this page links to.

**Doc links open in a new tab (settled 2026-10-12).** Every link on this page to `/docs/*` opens in a new tab: the section links, each "Learn more", the FAQ answers, "How ranking works" and "Compare every feature side by side". Each carries `target="_blank" rel="noopener"` and `aec-new-tab-icon`, the drawn icon plus the visually hidden "(opens in a new tab)". The reason is that a vendor reading the pitch keeps the claim one tab away. Conversion links stay in the tab: every claim link, the Managed inquiry and "Go to your portal". This is a page-scoped exception to `DESIGN.md`'s new-tab rule. `/docs/vendors/plans` keeps its links in the tab.

**Full width at desktop (settled 2026-10-12).** No narrow column with a blank right half: fill desktop width by layout. From `lg`, every section uses the whole `max-w-7xl` container, at 1024, 1280 and 1440px alike. Prose keeps a readable measure inside its column. The layout per section:

| Section | From `lg` |
|---|---|
| Hero | The copy and both buttons in the left seven of twelve columns. "How claiming works" in the right five: three numbered steps (find, claim, we review it), facts the FAQ already states. Copy settled 2026-10-12 (Chris): step 2 reads "Claiming is free. We set up your account when we approve your claim." Step 3 reads "A person at AEC Integrations reads and processes every claim." The claim dialog's subtitle uses the step 2 wording. "Needs no account" is retired everywhere: it read as if no account is needed to manage a listing. Not a heading. Hidden below `lg`. |
| What changes when you claim, Coming soon, FAQ | A split: the heading (and lede) in the left five columns, the content in the right seven. What changes when you claim puts the two labels side by side on the right (stacked below `sm`). |
| What a free claim gets you, What Managed adds | The same split for both (2026-10-12): the heading and lede (Free's seat line, Managed's terms line) in the left four columns, the lines in the right eight as a two-column grid from `md`. One column at 375. |
| Plan cards | The shared cards side by side across the full width. |
| How listings are sorted | The Bone panel, split: heading and sort rule left, the trust line and link right. |
| Closing panel | The Forest panel, split: heading and terms left, the buttons and next steps right (`PlanCtaPanelComponent`'s `split` input). |

Phones stay one column.

---

## 4. Calls to action

> **Superseded in part by §15 (2026-10-12, AECI-1293).** Every claim control and every Managed button now opens the claim dialog, labelled "Claim your listing" or "Start with Managed". "Talk to us about Managed" is now the text link "Questions about pricing? Talk to us". §15.1 is the current table. The placements below still name where each control sits.

Two actions, with the same wording everywhere.

| Action | Text | Goes to |
|---|---|---|
| Claim | "Claim your listing free" | `#find-your-product` on this page. On `/docs/vendors/plans` it stays `CLAIM_PATH`. (Superseded by §15.1: the claim dialog, with `/search` as the no-JS target since 2026-10-12.) |
| Managed | "Talk to us about Managed" | The plan inquiry dialog in place. The `href` stays `/contact?topic=managed` (`MANAGED_CONTACT_HREF`) for no-JS and new-tab clicks. |

Never "Get Managed", "Start now" or "Buy". There is no checkout.

### 4.1 Placements

| Placement | `placement` value | What |
|---|---|---|
| Hero | `top` | Both buttons side by side, on the first screen on desktop and phone. Managed is filled. Claim is outlined. |
| Plan cards | `card` | "Claim your listing free" on Free, secondary style. "Talk to us about Managed" on Managed, full card width, filled. The existing reply line sits under it. |
| Find your product | `search_result` | **Removed 2026-10-12** with the section (§6). The value is retired. |
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
| `plan_cta_clicked` | Add `page`: `docs_plans` or `vendor_program`. Add placement `search_result` (**retired 2026-10-12** with Find your product). Existing values keep their meaning. `plan: 'free'` now covers "Claim your listing free" and "Claim this listing" on this page. **Since §15:** `free` is a "Claim your listing" click and `managed` a "Start with Managed" click, and both open the claim dialog. |
| `plan_inquiry_submitted` | Add `page`, with the same values. `contact` stays a placement for the `/contact` form, with `page` absent. |
| `vendor_product_search` | **Retired 2026-10-12** with Find your product (§6). It was fired once per settled non-empty query, with `results_count` only. Nothing fires it now. The claim dialog's `claim_dialog_step` covers the find funnel: step `find` shown, then step `you` with `path` `found` (a listing chosen) or `typed` (not listed) (§15.7). The dialog never sent the search text and still does not. |
| `claim_requested` | No change here. §15.7 adds `plan_interest`. It fires when a claim form is sent, from any entry point. |

"Ask us to add it" (§6, removed 2026-10-12) fired nothing. It is not a plan call to action, so `plan_cta_clicked` would be wrong. A `$pageview` on `/contact` whose `$current_url` carries `topic=add-product` already counts the arrivals.

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
- One heading order. Visible focus on every link and button. Button contrast meets WCAG AA. The phone bar reserves its height and never traps focus (WCAG 2.2, 2.4.11), as the docs bar already does.

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
| 5 | A "Submit your product" flow for a product not in the catalog? | **Settled 2026-10-12:** the contact path with a topic, `/contact?topic=add-product` (§6). **Superseded the same day by §15:** the claim dialog's typed-in step, a `listing_request`. The contact topic stays for other entry points. |

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

---

## 15. Claim dialog

**Ruling 2026-10-12 (Chris), AECI-1293.** One claim workflow replaces the two parallel asks. Managed is granted at claim approval (the `/admin/claims` plan radios, `STAGE_2_PAID_TIERS_SPEC.md` §13.6), so a separate Managed form was a second form with a hidden dependency on the first. Every main call to action now opens one dialog. This section supersedes the claim rows of §4 and §4.1, the result link and "Ask us to add it" target of §6, and the `plan_cta_clicked` wording of §9. §7 still governs the inquiry dialog, which stays as the pricing question's path.

### 15.1 Labels and entry points

| Where | Text | Opens |
|---|---|---|
| Hero (`top`), closing panel (`bottom`), Free plan card (`card`) | "Claim your listing" | The dialog at step 1. The Free card preselects Free. |
| Managed plan card (`card`) | "Start with Managed" | The dialog at step 1, Managed preselected. |
| Phone bar (`mobile_bar`), docs rail (`rail`) | "Start with Managed" | The same as the Managed card. Both are Managed-labelled surfaces: the bar's region is "Managed plan" and it already hides for a Managed company (§5). |
| Beside the hero's "Claim your listing", under the Managed card's button, beside the closing panel's button | "Questions about pricing? Talk to us" (text link) | The plan inquiry dialog (§7), unchanged. Its `href` stays `MANAGED_CONTACT_HREF`. |
| ~~Find your product, a chosen result (`search_result`)~~ | ~~"Claim this listing"~~ | Removed 2026-10-12 with the section (§6). The dialog no longer opens at step 2. |
| ~~Find your product, "Ask us to add it"~~ | | Removed 2026-10-12 with the section. `/contact?topic=add-product` keeps working for links from outside the app. |

"Talk to us about Managed" no longer appears as a button on either page. "Claim your listing free" is retired. Never "Get Managed", "Buy" or "Start now".

The same labels apply on `/docs/vendors/plans` through the shared `shared/plan-cta/` components. The docs Free card's "Claim your listing" now opens the dialog too.

**Signed-in vendor (§5).** A vendor seat sees "Go to your portal" (`/vendor`) wherever a control would open the dialog. That includes "Start with Managed". The pricing link stays, because a Free company asking about Managed is the inquiry form's job. A Managed company keeps §5's rule: no phone bar, no Managed button in the panel.

**No-JS fallback.** Every dialog trigger is an `<a href="/search">` (`CLAIM_DIALOG_FALLBACK_HREF`). Without JS, before hydration, with no host on the page, or on a modified click, the link is followed. Changed 2026-10-12 from `/vendor-program#find-your-product` when that section was removed. `/search` is where the header search box falls back too, and it is the page equivalent of the dialog's Find it step: a visitor searches, opens the listing, and uses its own claim form. A new-tab click has JS, so search works there in full. Without JS the page renders its box and no results, the same as the header path.

### 15.2 The steps

One BrnDialog, the plan inquiry dialog's shell (`shared/plan-inquiry/plan-inquiry-dialog.ts`). The title is "Claim your listing". A visible step indicator reads "Step N of 4" and names the step. A Back button sits on every step after the first one the visitor saw, and never on the receipt.

1. **Find it.** `aec-search-autocomplete` with its own `inputId`, the visible label "Your product or company" and the placeholder "Search for your product or company". Choosing a product or vendor suggestion selects that listing and moves to step 2. Under the box: "Not listed? Type it in", a button that moves to the typed-in variant of step 2. Enter with no suggestion chosen does nothing in the dialog: it never navigates away from an open form.
2. **You.** A found listing shows a summary line ("Claiming" and the listing name, with "Change" back to step 1). A typed-in listing first asks "Product or company name" (1 to 200 characters) and "Website" (an `https://` URL, `HttpsUrlSchema`). Then the claim form's identity fields, unchanged: "Your name", "Your role at the company", "LinkedIn profile (optional)" with the AECI-847 host allowlist, and "Your work email". "Continue" validates this step's fields only.
3. **Plan.** "Which plan are you interested in?" Three native radios: Free, Managed, Not sure yet. A one-line hint: "You can change your mind. We confirm the plan with you before anything is billed." Nothing is preselected unless the dialog was opened from a Managed control (Managed) or the Free card (Free). The answer is optional. "Continue" with no choice sends no plan answer.
4. **Additional comments.** An optional textarea, "Additional comments", up to 2,000 characters, then the submit button, "Send claim" (found) or "Send request" (typed-in).
5. **Done.** One receipt, focused on open. Found: "Claim sent", "We'll email {address} with our decision", and the three "What happens next" lines the claim form already shows. Typed-in: "Request sent", then "We'll add {name} to the directory, then email {address} so you can finish your claim." A "Done" button closes the dialog.

**Behaviour.**

- One host per page (`aec-claim-dialog-host`), `@defer`-loaded on the first open, so nothing reaches the cached SSR HTML.
- Below `sm` the panel is a full-screen sheet (`100dvh`, no radius). From `sm` it is a centred panel, `min(92vw, 36rem)` wide, scrolling inside at `85vh`.
- Focus moves into the dialog on open, to the step heading on every step change, and back to the trigger on close (BrnDialog / CDK). Escape and the close button close it at any step. Closing discards the form. Each open starts fresh.
- Never opened from an `effect()` (NG0602): the service holds an opener callback, as `PlanInquiryService` does.
- A submit failure keeps the visitor on step 4 with "Something went wrong. Please try again." A `404` on a found listing (the listing was unpublished since the search) says the listing is no longer available and offers "Type it in instead".

### 15.3 A found listing: `POST /api/requests/claim`

The existing endpoint and `ClaimRequestSchema`, plus one field:

```typescript
export const PlanInterestSchema = z.enum(['free', 'managed', 'not_sure']);
// ClaimFormSchema gains
plan_interest: z.union([z.literal(''), PlanInterestSchema]).default(''),
```

`''` means not answered and is stored as `NULL`. The key is omittable, like `submitter_linkedin_url`, because the endpoint already serves production traffic.

**Comments are the claim's `body`.** Step 4's "Additional comments" is the claim form's existing optional `body` ("Anything we should know?", 0 to 2,000 characters). The dialog moves that field to the end and relabels it. It does not add a second free-text column: two notes from one claimant, under two labels, would split one answer across two places in the review. `vendor_requests.body` is `NOT NULL`, so an empty comment is stored as `''`, as today.

**Storage.** One nullable column, `vendor_requests.plan_interest`, added by `ALTER TABLE ... ADD COLUMN`. **No CHECK constraint**, on purpose: a CHECK added in Drizzle is a table-level constraint, and any CHECK change makes drizzle-kit recreate the table (`docs/migrations.md` §0). `vendor_requests` has FK children (`vendor_entitlements.source_request_id`, and its own `duplicate_of_request_id`), so a recreate is the cascade hazard. The vocabulary is enforced by `PlanInterestSchema` at the API.

The audit row (`vendor_request.created`) and the genesis workflow transition carry `plan_interest` in their metadata. The claim alert email (`claim-submitted-alert`) gains a "Plan interest" row. The Linear issue description gains the same line.

### 15.4 A typed-in listing: `POST /api/requests/listing`

A new request kind, `listing_request`, in its **own table**, `listing_requests`.

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

**The table.** `listing_requests`: `id` (uuid), `listing_name`, `website`, `submitter_name`, `submitter_email`, `submitter_role`, `submitter_linkedin_url` (nullable), `plan_interest` (nullable), `body` (`NOT NULL`, default `''`), `status` (`open`, `resolved`, `rejected`; default `open`), `created_at`, `resolved_at`, `resolved_by`. **No FK and no CHECK**, the `field_overrides` precedent (`apps/api/src/db/schema.ts`): no FK to `profiles`, so erasure has nothing new to null, and an admin's id stays on the record the way it does in audit metadata. The vocabularies are enforced by Zod. One index, `(status, created_at)`, for the admin list.

**The write.** One `db.batch`: the insert and its `audit_log` row (`listing_request.created`, entity type `listing_request`, metadata `plan_interest` and `has_linkedin`, never the typed name, email or website). It is domain state (requests), so the row is required (ADR 0022). No `workflow_instances` row: the workflow vocabulary is CHECK-constrained (above), and the audit rows are the history. The §26.5 forward runs post-commit.

**Rate limit.** The path sits under `/api/requests/*`, so zone Rule A already caps it at the claim route's rate (5 per minute per IP, with a one-hour block). Like the claim route, it carries no in-Worker bucket (`docs/waf-rate-limits.md` §6.2: "Rule A already covers them"). The only key the Worker holds is a typed email, which rotates for free.

**Notification.** A new operator alert, `listing-request-alert`, to `SUPPORT_EMAIL`, fire-and-forget in `ctx.waitUntil` after commit. Reply-to is the submitter, so a reply answers them. The table carries the name, website (plain text, never linked), submitter fields, plan interest, comments and the row id, with a CTA to `/admin/requests`. Key `listing-request-alert:{id}`. Pausable: the request waits in `/admin/requests` either way. **No email to the visitor**, as with a claim: the address is typed, not verified, and the on-screen receipt is the receipt. No Linear issue: the alert and the admin queue are the record.

### 15.5 Admin

- **Claims.** `AdminVendorRequest` gains `plan_interest` (`'free' | 'managed' | 'not_sure' | null`). The `/admin/claims` queue row and the claim detail show "Plan interest" with the answer, or "Not answered". In the queue's approve form the answer sits beside the plan radios as "They asked about: Managed". **The radios stay unselected** whatever the claimant said (`STAGE_2_PAID_TIERS_SPEC.md` §13.6, "nothing preselected"). The claimant's comments are the body the queue and the detail already show, now under the label "Comments".
- **Listing requests.** `/admin/requests` gains a second section, "Listing requests", under the corrections. Each row shows the name, website (plain text, with a copy-safe link that opens in a new tab), submitter name, role, email and LinkedIn, plan interest, comments and age, with Resolve and Reject. It reads `GET /api/admin/listing-requests` (`status` and page params, like `GET /api/admin/requests`) and moderates through `PATCH /api/admin/listing-requests/:id` (`ModerateRequestSchema`). Each moderation is one `db.batch`: the guarded update and its `listing_request.resolved` or `listing_request.rejected` audit row. Both are behind `requireAdmin()`.
- **The badge.** `pending_requests` becomes open corrections plus open listing requests, so the Requests count matches the screen. Claims stay out of it (`admin-queue-counts.ts`).
- Resolving a listing request does not create the listing. The operator adds it upstream (the review app, then promote) and emails the submitter to claim it. That is the "we add it, then email you" in the receipt.

### 15.6 Per-listing claim pages

`/products/:slug/claim`, `/vendors/:slug/claim` and the in-place claim drawer keep working. They are step 2 onward on one form: the identity fields, then the plan question, then "Anything we should know?" relabelled "Additional comments". The plan question and the comments are both optional. They submit to `POST /api/requests/claim` as before, with `plan_interest`.

### 15.7 Analytics

| Event | Properties | When |
|---|---|---|
| `claim_dialog_step` (new) | `step` (`find`, `you`, `plan`, `comments`, `done`), `page` (`vendor_program`, `docs_plans`), `entry` (the `PlanCtaPlacement` that opened it; `ask_to_add` retired 2026-10-12), `path` (`found`, `typed`; absent on `find`) | Once each time a step is shown, including the first. |
| `claim_requested` | adds `plan_interest` (`free`, `managed`, `not_sure`, `none`) | A found-listing claim the API accepted, from the dialog, a claim page or the drawer. |
| `listing_requested` (new) | `plan_interest`, `page` | A typed-in request the API accepted. |
| `plan_cta_clicked` | unchanged shape. `plan: 'free'` now means a "Claim your listing" click and `plan: 'managed'` a "Start with Managed" click. Both open the claim dialog, so it counts opens. | Every plan call to action. |
| `plan_inquiry_submitted` | unchanged. It now counts inquiries from the "Questions about pricing? Talk to us" link and `/contact`. | |

Never the search text, a typed name, a website or an email. The dialog's Find step does not fire `vendor_product_search`. That event was the inline section's count, and it is retired with the section (§9, 2026-10-12).

### 15.8 Migration

One drizzle-kit migration, additive only. The generated SQL must be exactly `CREATE TABLE listing_requests`, its index, and `ALTER TABLE vendor_requests ADD COLUMN plan_interest text`. A `__new_` table, a `DROP TABLE` or an `INSERT INTO ... SELECT` in it means drizzle-kit chose a recreate, and the migration must not ship (`docs/migrations.md` §0).

### 15.9 Tests

- Shared: `plan_interest` accepts the three values and `''`, rejects others, defaults when the key is absent. `ListingRequestSchema` requires the name and an `https://` website, and keeps the LinkedIn allowlist.
- API: a claim with `plan_interest` and comments stores both. A body without the key still validates. A listing request writes the row and its audit row in one batch, sends the alert after commit, and rejects a bad website and a non-LinkedIn profile. The admin list and moderation for listing requests, including the `422` on a terminal row. The badge count.
- Web: the dialog's steps, Back, the Managed and Free preselect, the typed-in path, the signed-in swap to "Go to your portal", the analytics payloads (no typed text). The admin claim plan answer beside unselected radios. The listing request section.
- e2e: `apps/web/e2e/vendor-program-claim-dialog.spec.ts`, both paths with the search index and the two POST endpoints mocked.

### 15.10 Docs updated in the same change

`API_CONTRACTS.md` §6.7 (the `plan_interest` field, the new endpoint) and §6.10 (the listing request admin endpoints, the `pending_requests` predicate); `DATABASE_SCHEMA.md` (the column, the table, the ledger row); `ADMIN_PANEL_SPEC.md` (the Requests screen's second section and its badge); `STAGE_2_VENDOR_PORTAL_SPEC.md` §5 (the plan answer beside the radios); `ANALYTICS.md` §4; `NOTIFICATIONS.md` (generated by `pnpm docs:notifications`) and `docs/email.md` (the new alert); `OBSERVABILITY.md` (the `aeci.email.send` template list); `waf-rate-limits.md` §6.2 (the new path under Rule A); `STAGE_2_PRODUCT_DOCS_SPEC.md` §5 (the Plans page labels); `DESIGN.md` (the CTA wording); `POST_LAUNCH_MONITORING.md` where it reads `pending_requests`; the vendor docs pages `claiming-your-listing.md` and `plans.md`.

### 15.11 Not changed

- The "What Managed adds" list and the FAQ copy (other rulings pending). On 2026-10-12 the list's structure changed (§3, Free and Managed one pattern). Its wording did not. A later 2026-10-12 ruling removed its connector integrations line (§3 item 4).
- `POST /api/plan-inquiries` and the inquiry dialog (§7).
- The claim approval flow, the plan radios' rule and the grant emails.
- The full-width layout rule (§3, §11).

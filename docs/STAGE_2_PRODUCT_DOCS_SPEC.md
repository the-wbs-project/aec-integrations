# AEC Integrations — Stage 2 Product Docs / Help Center

**Version:** 1.0 — **build contract**
**Date:** August 2026 (v0.1 scope outline); firmed into a build contract 2026-10-08 (AECI-1247)
**Status:** Decomposed. The AECI-634 epic has eight sub-issues, AECI-1247 to AECI-1254 (§8). The vendor guide is built and noindex (AECI-1104). The shell is built (AECI-1248): the `/docs` home, section indexes, prev/next, linked breadcrumbs, noindex by path and the sitemap entries, with `requests-and-corrections` imported. The getting-started and trust pages are built and indexable (AECI-1249). The reviewer and account pages are built and indexable (AECI-1250). The footer Help column and the `/methodology` links down into `/docs/trust/*` and `/docs/getting-started/taxonomy` are built (AECI-1252). The help center was restyled after Devin's DeepWiki (AECI-1259). The 2026-10-09 marketing-review rulings are applied (AECI-1261, AECI-1264, AECI-1265): the vendor guide is its own docs, out of the help center's sidebar and home. The remaining pages of the site map are unbuilt.
**Companion to:** `docs/STAGE_2_SPEC.md` §2.6 (the pillar stub). The architecture decision is ADR 0040.

> **2026-10-09, the vendor guide split out and the help center tightened (AECI-1265, marketing
> review B2 to B7, B9, B10).** Chris's rulings, applied in one pass.
> - **Two guides from one manifest.** Every section now belongs to a guide. The **help center**
>   (`/docs`, its home and its sidebar) holds Getting started, Trust and ranking, Reviewer guide,
>   Your account and a new **For vendors** section of exactly two pages: a short overview at
>   `/docs/vendors/overview` and `claiming-your-listing`. The **vendor guide** is the `vendors`
>   section: every other `/docs/vendors/*` page, at its old URL, with `/docs/vendors` as its landing
>   page. On its pages the shell shows the vendor guide's own tree and a "Back to the help center"
>   link. The home and the help-center sidebar never list it. Which tree renders follows from the
>   URL alone, so cached pages stay visitor-neutral. Indexing is unchanged: everything under
>   `/docs/vendors`, the For vendors pages included, stays noindex until AECI-1253.
> - **Vendor material left the buyer pages** for the vendor guide: "If you are the vendor" on
>   `agreement-states`, the vendor change-request section of `requests-and-corrections` (one
>   sentence now links to `contests-and-protests`), the seat-address rule on `signing-in`, and the
>   seat notes on `your-data` (now on `your-seat`, with one sentence left before deletion). The
>   connector sections of `owning-an-integration` and `claiming-your-listing` moved to a new
>   `vendors/connector-vendors` page, "For connector vendors".
> - **New buyer page** `getting-started/checking-before-you-buy` (B4). `claiming-your-listing` opens
>   with what buyers see when a vendor claims (B5).
> - **The plan panel line** is "No plan changes where you rank or appear, or whether a review is
>   published." (B2). The Plans list drops "what we verify" and ends on how an agreement label is
>   worked out.
> - **"Cannot be bought" is stated in full once**, on `how-ranking-works` (B6). Elsewhere a page
>   says how the order or label is worked out and links there. "Not bought" on `agreement-states`
>   is now "Not set by a plan".
> - **"Data flow" and "type of data" are linked once** where both appear (B7). The connector
>   contest field list uses the labels the form shows.
> - **There is no reviews@ mailbox** (B9). Review reports go to `support@aecintegrations.com`.
> - **One "Current limits" note** on the vendor guide's landing collects the not-yet notes (B10).

> **2026-10-09, the account label removed (AECI-1264, marketing review B1).** The public
> "Active on AEC Integrations" badge is gone, and no page says a plan turns a public label on or
> off. `trust/the-account-label` never shipped, so it was deleted with no redirect, and the trust
> section is two pages. `vendors/plans-and-the-account-label` is now `vendors/plans`, titled
> "Plans". Its old URL was live in production, so the SSR Worker answers it with a 301 to the new
> one (`server-runtime.ts`, beside the AECI-926 category redirect). `/methodology` lost its label
> bullet, and its list of what Managed affects is four items.

> **2026-10-09, marketing review rulings (AECI-1261).** Two rules now bind every page.
> **"AECi" is internal shorthand.** Public text says "AEC Integrations", or "we" and "us" in body
> copy. The first getting-started page is now `getting-started/about-aec-integrations`, titled
> "About AEC Integrations". Its first slug never left this branch, so it has no redirect.
> The public label now reads "Active on AEC Integrations". Four Changes-page labels were renamed
> in the product and the docs follow them: "AEC Integrations" under By, "Changes by AEC
> Integrations", "Our reason" and "Queued for a Google re-crawl request". Other portal and public
> strings that say "AECi" are inventoried for a follow-up, not changed.
> **No page describes version comparison or version stamps** until the product can create them.
> The pair-page comparison is built (AECI-303, AECI-304) but dormant: no portal screen creates a
> release or stamps an answer, and promote does not carry versions. So the Versions sections of
> `reading-an-integration-page` and `attesting-an-integration` are gone, and so is the Managed
> paragraph about it on `plans-and-the-account-label`. The 12-month re-confirmation line now says
> what `detectStaleVersion` does: any Yes older than 12 months gets a re-confirm ask, and it does
> not expire.

> **2026-10-09 — the DeepWiki shell (AECI-1259).** Chris rejected the Zendesk look. `/docs` is now a
> layout route: `DocsShellComponent` (`docs-shell.ts`) renders a full-height sidebar tree, a slim
> top bar with a slash breadcrumb and "Last updated", and a `<router-outlet>` for the home, the
> section indexes and the articles. Anchor site **Devin (DeepWiki)**, Mobbin screen c3936cdb,
> replacing Zendesk. The sidebar lists exactly the manifest's visible sections and pages. Below `lg`
> it is a panel behind a "Docs menu" button. Articles gain an "On this page" rail from `xl`, drawn as
> dashes, which lists the page's `h2`s minus "Related". Every body `h2` and `h3` now has a stable
> slug id, built at manifest time by `docs-markdown.ts`. The template renders those headings itself,
> because Angular's `[innerHTML]` sanitizer strips `id` and the repo never bypasses it. The home and
> the section indexes drop their cards for divided lists, and the pager drops its cards for text
> links. Content, routes, URLs, indexing, caching and the sitemap are unchanged. There is still no
> docs search and no "Ask" box (§3). The layout contract is `DESIGN.md` "Product docs".

> **2026-10-08 — reviewer and account pages shipped (AECI-1250).** Three pages, indexable and in
> `sitemap.xml`: `reviewers/writing-a-review` (order 1, ahead of `requests-and-corrections`), and
> `account/signing-in` and `account/your-data`, which make `account` a visible section. Every
> sentence was checked against the review form, `POST /api/reviews`, the moderation route, the
> account page, `DELETE /api/account`, the login page and the account menu. Where the shipped copy
> says something the code does not do, the pages follow the code and the copy is filed: the
> display-name help, the rate-limit and body-length messages (AECI-1256), the rejection email's
> "submit an updated review" (AECI-1257) and the unset "Verified reviewer" label (AECI-1258).

> **2026-10-08 — getting-started and trust shipped (AECI-1249).** Six reader pages, indexable and in
> `sitemap.xml`: `getting-started/about-aec-integrations` (renamed by AECI-1261), `reading-an-integration-page`, `taxonomy`, and
> `trust/how-ranking-works`, `the-account-label` _(never reached production; deleted by AECI-1264, see above)_, `agreement-states`. `how-ranking-works` is the
> `STAGE_2_5_SPEC.md` §2 step 3 ranking-method page; Chris signs its wording off before AECI-1249
> merges. The "Active on AEC Integrations" label's "What this means" link now opens the reader page
> `/docs/trust/the-account-label` instead of the noindex vendor guide, so the vendor guide's one
> remaining inbound link is the claim confirmation. Every label these pages quote was checked
> against the shipped components on the day.

> **2026-10-08 — the shell shipped (AECI-1248).** `/docs` (home, with the audience split),
> `/docs/<section>` (section index) and the previous / next pager are built, all generated from the
> manifest. A declared section with no pages has no home card, no route and no sitemap entry, so
> on that day only `vendors` and `reviewers` showed (AECI-1249 added `getting-started` and `trust`). The breadcrumb's "Docs" and section crumbs are links.
> Noindex is driven by path: `NOINDEX_PATH_PREFIXES` moved to `apps/web/src/app/docs/docs-indexing.ts`
> (re-exported by `server/robots-policy.ts`) and now covers `/docs/vendors` itself as well as
> everything below it. The cache matchers cover bare `/docs`. `sitemap.xml` lists `/docs`,
> `/docs/reviewers` and `/docs/reviewers/requests-and-corrections`, through a lazy `import()` of the
> manifest. `requests-and-corrections` is imported and was re-checked against the shipped request
> form and the vendor change-request flow. The v0 note below is kept as history.

> **2026-09-23 — v0 vendor tranche shipped (AECI-1104).** The vendor guide was built ahead of the
> rest of the epic, because publishing it is a `STAGE_2_1_SPEC.md` §5 exit gate (§3.5 there). It
> brought the minimum shell with it: a docs manifest (`apps/web/src/app/docs/docs-content.ts`), one
> article component (`docs-page.ts`, then anchored on **Zendesk**'s help-center article page:
> breadcrumb, a section rail, the article; AECI-1259 replaced that anchor with DeepWiki), and one
> route pattern, `/docs/<section>/<slug>`, as
> explicit lazy children generated from the manifest (`docs.routes.ts`). It had **no `/docs` home
> page and no section index**, and the breadcrumb's "Docs" and section crumbs were plain text.
> AECI-1248 built both. The vendor pages are **noindex in every env and absent from
> `sitemap.xml`** until the portal opens, by path (`pathForcesNoindex`, see the AECI-1248 note).
> AECI-1253 lifts it, in the same sitting as AECI-1105. Since AECI-1265 the claim confirmation opens the help center's `claiming-your-listing`, and the vendor guide's inbound links are help-center cross-links. (The
> "Active on AEC Integrations" label and its "What this means" link were removed in AECI-1264.) The footer Help column (AECI-1252) links into `/docs` but
> not into the vendor guide. The portal "Learn more" links (AECI-1253) are not built. The same-PR sync rule (§4) is in
> `docs/CODE_REVIEW_CHECKLIST.md` §Spec alignment.

---

## 1. What this is

A **reader-facing product documentation surface** ("the docs") supporting the product as it stands at the end of Stage 2. It is not repo documentation (that's `docs/`), not marketing content, and not the in-portal microcopy. It is the public reference a person is sent to when a one-line tooltip isn't enough.

Three audiences, in priority order:

1. **Vendors**: the Stage 2 addition and the reason this exists now. Claiming a profile, the dashboard, attesting to integrations, product versions, plans and entitlements, notifications.
2. **Readers** (AEC firms evaluating integrations): how the directory works. Taxonomy, agreement states, what ranking does and does not reward.
3. **Reviewers**: dual reviews, requesting integrations and corrections.

Trust content is first-class, not an afterthought: "how ranking works and what paid does **not** buy" (§8.1(4) of `STAGE_2_SPEC.md`) gets its own pages. Documentation is part of the trust surface.

## 2. The decision: not a separate site

**Docs ship inside `apps/web` as a lazy `/docs` route area, not a separate app, not a second framework, not a subdomain.** Recorded as **ADR 0040** (2026-10-08), which carries the rationale and the re-open trigger.

| Option | Verdict |
|---|---|
| Lazy `/docs` route area in `apps/web` (this doc) | **Chosen** |
| Separate static-site app (`apps/docs`, Astro/Starlight or similar) on `docs.aecintegrations.com` | Declined, see re-open trigger |
| Separate Worker on a `www.…/docs/*` route | Declined. The route split buys nothing the lazy route area doesn't, and costs a second deploy pipeline |

Why in-SPA wins here:

1. **The pattern already exists and is proven.** The legal pages (AECI-237) and `/methodology` (AECI-804) are exactly this: Markdown and frontmatter in `apps/web/src/content/`, inlined at build time by the esbuild `text` loader, parsed by a content registry (`marked`, GFM), SSR-rendered, edge-cached.
2. **One design system.** `DESIGN.md` and the anchor-site rule exist so AECi reads as one publication. A second framework means a second token sync that will drift.
3. **The platform work is already paid for.** SSR, the native Workers Cache (keyed on URL and Worker version, so build-inlined content is **fresh on every deploy with zero purge wiring**), i18n, a11y discipline, the sitemap, four-tier environments and Access.
4. **Doc staleness is the failure mode that matters most here.** In-repo docs let the PR that changes a surface update that surface's docs **in the same diff**.
5. **SEO.** `/docs` on `www` consolidates domain authority. A subdomain splits it.

Costs accepted: docs edits ride app deploys; bundle growth, confined to the lazy `/docs` chunk.

**Re-open trigger:** revisit a dedicated docs generator when **any** of these holds. The corpus passes about 75 pages. Versioned docs become a requirement. A public or partner API reference ships (out of Stage 2 scope per `STAGE_2_SPEC.md` §9) and brings OpenAPI-style tooling with its own needs.

## 3. Tech stack

No new Worker, no new schema, no new bindings, no migration.

| Layer | Choice |
|---|---|
| Framework | Angular, same app. Lazy route area under `/docs` (`apps/web/src/app/docs/`) |
| Content | Markdown and YAML frontmatter: `apps/web/src/content/docs/<section>/<slug>.md` |
| Build | The existing esbuild `text` loader (`apps/web/angular.json`). Inlined at build time, no runtime fetch |
| Rendering | `marked` (GFM), the same pipeline as `legal-content.ts`. The **docs manifest** (`docs-content.ts`) is the single source for routes, navigation, prev/next and sitemap entries |
| Sections | `getting-started`, `trust`, `reviewers`, `account`, `for-vendors`, `vendors`, `faq`. Each has a `$localize`-wrapped label and summary in the manifest, an order and a **guide**: `help` (the help center) or `vendor` (the vendor guide, `vendors` only). `faq` is a one-page section at `/docs/faq`. Since AECI-1265 a section's URL segment can differ from its id: `for-vendors` serves `/docs/vendors/*` beside the vendor guide. A section with a `home` page (`for-vendors`, home `overview`) has no index of its own. A section may carry an intro, rendered on its index (the vendor guide's landing) |
| Routes | `/docs` (home), `/docs/<segment>` (section index), `/docs/<segment>/<slug>` (article). All explicit and generated from the manifest, so an unknown `/docs/*` path falls through to the `**` 404. The manifest throws if two sections would own one index path or two pages one path |
| Navigation | Two sidebar trees, picked from the URL (AECI-1265). The help center's lists its sections; the vendor guide's lists the vendor guide with a link back. The `/docs` home lists help-center sections only |
| Frontmatter | Scalar keys only (`parseFrontmatter`): `title`, `description`, `section`, `order`, `last_updated` (a pre-formatted display string, the legal rule). The manifest throws at module init when `section` does not match the folder, when two pages in a section share an `order`, or when a page does not end in a `## Related` list |
| Prev/next | Within one section, in `order`. Never across sections |
| Styling | Tailwind v4 and the semantic tokens. Typography per `DESIGN.md`, body in `.aec-prose`. Light only |
| Caching | Native Workers Cache on the static-page TTL (24h edge / 1h browser), on both `/docs` and `/docs/*`. Freshness on deploy is automatic (§2.3). **`Cache-Tag: route:index`**, not the `docs docs:{slug}` first sketched here (AECI-1104): the content changes only on deploy, which already rotates the cache key, so a per-page purge handle would have no producer. `cache-tags.ts` also forbids ad-hoc tag namespaces. Add a `docs` entity only if a runtime purge of docs ever becomes real |
| Indexing | Driven by path. `NOINDEX_PATH_PREFIXES` (`apps/web/src/app/docs/docs-indexing.ts`, re-exported by `apps/web/src/server/robots-policy.ts`) is the one list. A prefix covers the path itself and everything below it, so `/docs/vendors` covers the section index too. The page's `robots` meta and the SSR egress `X-Robots-Tag` both read it, and the sitemap leaves out any path it covers. Opening a section to search engines is a one-line change |
| Sitemap | `/docs`, every indexable section index and every indexable page, built from the manifest. **No `<lastmod>`**, the same as `/legal/*`: `last_updated` is a display string, and parsing it would add a second date format |
| Re-crawl pings | **None.** IndexNow is not part of docs publishing (Chris, 2026-10-08). Its producers are catalog promotes and vendor portal writes. Nothing submits a build-inlined static page, and `/methodology` and `/legal/*` rely on the sitemap too |
| Search | **None at v0.** Navigation and browser find. The deferred path is an Algolia `docs_{env}` index on the existing app, not a new search system |
| i18n | The body is content, not UI strings (the legal rule, not extracted to `messages.xlf`). Page chrome is `i18n` / `$localize`-wrapped. Per-locale `.md` files are the later mechanism |
| Analytics | PostHog page events, standard. No new instrumentation concept |

## 4. Technique (the authoring model)

- **Docs-as-code.** Same repo, same branch model, same PR review. Git history is the version log (the `STAGE_1_SPEC.md` §27.3 rule the legal pages already follow). No CMS, no database-backed content.
- **The sync rule.** A PR that changes a documented surface updates that surface's doc page in the same PR. It is in `docs/CODE_REVIEW_CHECKLIST.md` §Spec alignment, and it is the main defense against the staleness that motivates the in-SPA choice. AECI-1254 adds a build-time link check as the second defense.
- **Voice.** Per `PRODUCT.md`: plain, trust-first, no marketing gloss in reference content. Docs state what paid does *not* buy as plainly as what it does.
- **Say what the reader can do, not how the plumbing works.** Help pages never describe reindexing, IndexNow, crawler pings, cache purges or other site-operations mechanics (Chris, 2026-10-08). If a reader needs to know when a change appears, say what they will see, not why.
- **Assemble, never invent.** Every sentence must be true of the shipped site on the day it merges. The six do-not-say items in `STAGE_2_5_SPEC.md` §7.1 apply to every page.
- **No screenshots at v0.** They rot faster than any prose and double the maintenance of every UI change. Prefer prose and links into the live surface. Revisit once the portal UI stabilizes.
- **Contextual entry, one direction.** Portal surfaces link **into** docs pages ("Learn more" links, §7). Docs pages never embed portal state: `/docs` is public and edge-cached, `/api/vendor/*` is `private, no-store`, and that boundary stays clean.
- **Legal pages are cross-referenced, never duplicated.** `/legal/*` keeps its own registry, lifecycle (§27), and counsel workflow. Docs link to it.
- **Every page ends with `## Related`**, linking its neighbours. The manifest enforces it.

## 5. Site map

URL scheme: `/docs/<segment>/<slug>`, kebab-case. About 25 pages at v1. Since AECI-1265 the site
map has two guides.

**The help center** (`/docs`, its home and its sidebar):

```
/docs                                — Help center home: audience split (reader / reviewer), then every help-center section   AECI-1248, AECI-1265
├─ getting-started/                  — SHIPPED (AECI-1249), indexable
│  ├─ about-aec-integrations         — the directory, dual-vendor verification, who curates
│  ├─ reading-an-integration-page    — the product-PAIR page: claims, attestations, agreement states
│  ├─ checking-before-you-buy        — reading the labels for a buying decision, what to ask each vendor (AECI-1265)
│  └─ taxonomy                       — mechanisms, data objects, trades (the four facets)
├─ trust/                            — SHIPPED (AECI-1249), indexable
│  ├─ how-ranking-works              — purely algorithmic; what paid does NOT buy, stated in full here only. Is the STAGE_2_5_SPEC §2 step 3 ranking-method page
│  └─ agreement-states               — unverified / single-source / confirmed / conflict, plainly
├─ reviewers/                        — SHIPPED (AECI-1250; requests-and-corrections by AECI-1248), indexable
│  ├─ writing-a-review               — dual reviews: product quality vs onboarding experience
│  └─ requests-and-corrections       — requesting an integration, correcting a listing
├─ account/                          — SHIPPED (AECI-1250), indexable
│  ├─ signing-in                     — magic link + Google, common failure modes, an expired session
│  └─ your-data                      — links /legal/privacy; deletion/erasure path
├─ For vendors (section `for-vendors`, URLs under /docs/vendors/, no index page) — AECI-1265, noindex until AECI-1253
│  ├─ overview                       — "For vendors": what claiming is, Free and Managed at a glance, what no plan changes, the vendor guide
│  └─ claiming-your-listing          — what buyers see, the claim form, what we check, outcomes
└─ faq                               — AECI-1254: seeded from real pilot-vendor questions, not invented
```

**The vendor guide** (section `vendors`, its own landing page and sidebar tree, listed on neither the
help-center home nor its sidebar):

```
/docs/vendors                        — Vendor guide landing: intro, the page list, one "Current limits" note   AECI-1265
├─ your-seat                         — sign-in, portal tabs, owners vs members, invites, removal, your account and your seat
├─ attesting-an-integration          — Affirm/Deny/Clear, add a data flow, agreement states, what happens next
├─ owning-an-integration             — claim, edit, per-side links, retire/restore, create (AECI-1023, ADR 0035)
├─ contests-and-protests             — sending and receiving contests and change requests, the protest to AECi (§11b)
├─ replying-to-reviews               — who replies, moderation, the public label, edit/withdraw/resubmit (§11c, AECI-1181)
├─ plans                             — Free vs Managed, checklists, "Looks right", what no plan changes, billing, plan end (AECI-1219; slug renamed by AECI-1264, old URL 301s)
├─ change-history                    — the Changes page: every change, who made it, AECi's reasons (AECI-1160)
├─ connector-vendors                 — "For connector vendors": the catalogue seat, the Catalogue tab, integrations delivered through a connector (§8.9/§8.10; AECI-1265)
└─ (AECI-1251, after the AECI-1103 rehearsal) your-dashboard, editing-profile-and-products, product-versions,
   notifications-and-messages; performance only if analytics.view has shipped
```

Everything under `/docs/vendors`, both guides' pages there included, is noindex until AECI-1253.

> **Boundary with `/methodology` (AECI-804, shipped).** The two `trust/` pages above cover the same
> ground as the editorial methodology page. They do not duplicate it and they must not replace it.
> `/methodology` is the **single-page, citable editorial statement**: one read, indexable, in the
> sitemap, the canonical short answer to "how does this directory work". `/docs/trust/*` is the
> **task-level depth** underneath it, and links up rather than absorbing. The rule of thumb:
> `/methodology` is what we assert, `/docs/trust/*` is how to act on it. Same split for
> `getting-started/about-aec-integrations`. See `STAGE_2_5_SPEC.md` §7.2, which owns this boundary.
>
> Reader pages that overlap a vendor page (`agreement-states` with `attesting-an-integration`)
> explain what a reader sees and link across for what a vendor does. No paragraph appears in both.

> **`requests-and-corrections` was drafted ahead of the epic (AECI-1023, 2026-09-22)** and imported
> by AECI-1248, which re-verified it against the shipped request form and the vendor portal. Three
> sentences were wrong and were fixed. A public correction is not forwarded to an integration's owner
> by any code, so the page now says we ask the owner. The vendor route on an integration's own page is
> **Request a change** or **Request a correction**; **Contest a field** is the connector lane only.
> A contest can move to AEC Integrations after it is sent, and the owner of a connector-delivered
> integration decides only on Managed. *(AECI-1265: the vendor change-request section left this
> page for `contests-and-protests`, which already covered all of it. One sentence links there.)*

## 6. Deliberately deferred (not in this epic)

- Docs search (Algolia `docs_{env}` is the path when wanted)
- A changelog / what's-new page
- Per-locale content files
- Any versioned-docs mechanism
- Screenshots / recorded walkthroughs
- An embedded support widget (the feedback endpoint and mailing-list band already exist)
- Re-crawl pings on publish (§3, "Re-crawl pings")

## 7. Open questions, answered

1. **Which portal moments get a "Learn more" link?** **Answered 2026-10-08 (AECI-1247).** One link per moment, added by AECI-1253 when the vendor guide is published:

   | Portal moment | Component | Page |
   |---|---|---|
   | Claim outcome | `vendor/components/vendor-claim-outcome.ts` | `claiming-your-listing` (in the help center's For vendors section since AECI-1265; URL unchanged) |
   | Seats page | `vendor/sections/vendor-seats-page.ts` | `your-seat` |
   | Attestation lane | `vendor/integration-detail/` | `attesting-an-integration` |
   | Integration edit, create, retire | `vendor-integration-edit-form.ts`, `vendor-integration-create.ts` | `owning-an-integration` |
   | Contest form and protest | `vendor-contest-form.ts`, `vendor-contest-protest.ts` | `contests-and-protests` |
   | Review reply | `vendor/sections/vendor-product-reviews-page.ts` | `replying-to-reviews` |
   | Plan panel and free-plan checklist | `vendor/vendor-plan.ts`, the free-plan checklist | `plans` |
   | Changes page | `vendor/history/` | `change-history` |

2. ~~Does the vendor guide organize by task or by tier?~~ **Answered: by task** (AECI-1104). Seat-only and plan-gated actions are marked on each task page rather than split into tiers.
3. ~~Header nav entry or footer-only at launch?~~ **Answered: footer-only, as a Help column** (2026-10-08). The header's primary row is public-directory-only, width-budgeted and closed, so a new secondary destination goes to the footer (`DESIGN.md` §Navigation, The Overflow Rule). The Help column holds "Help center" (`/docs`), "Getting started" and "How ranking works" from AECI-1252, and "For vendors" from AECI-1253. Since AECI-1265 that link has a page to land on: `/docs/vendors/overview`. Chris: easy to readjust. Promoting `/docs` into the header row later is a deliberate re-measure at 1024px, not a default.
4. **What does the FAQ actually need?** Collect the real questions from the first pilot cohort (AECI-1105) rather than inventing them. AECI-1254 writes it after that.

## 8. Epic decomposition (2026-10-08)

One PR per sub-issue, each into `main`. All sit in the "Stage 2.1 — Vendor Activation" project (Chris, 2026-10-08). Only AECI-1251 and AECI-1253 gate `STAGE_2_1_SPEC.md` §5. The rest is reader content riding in the same window.

| # | Issue | Scope | Gated on |
|---|---|---|---|
| T0 | AECI-1247 | This build contract, ADR 0040, stale page counts | — |
| T1 | AECI-1248 | `/docs` home, section index pages, prev/next, linked breadcrumbs, noindex by path, `/docs` cache matchers, sitemap entries, import `requests-and-corrections` | T0 |
| T2 | AECI-1249 | Getting-started and trust pages; `how-ranking-works` discharges `STAGE_2_5_SPEC.md` §2 step 3 | T1 |
| T3 | AECI-1250 | Reviewer and account pages | T1 |
| T4 | AECI-1251 | The rest of the vendor guide | T1, the AECI-1103 rehearsal |
| T5a | AECI-1252 | Footer Help column; `/methodology` links down into `/docs/trust/*` | T2 |
| T5b | AECI-1253 | Publish the vendor guide (drop the noindex prefix), "For vendors" in the footer, the §7 portal links | T1; run in the same sitting as AECI-1105 |
| T6 | AECI-1254 | FAQ, build-time internal link check, epic close-out | T5b, AECI-1105 |

The epic closes when every sub-issue is closed (`docs/linear-issue-conventions.md` §6).

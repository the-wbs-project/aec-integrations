# AEC Integrations — Stage 2 Product Docs / Help Center

**Version:** 1.0 — **build contract**
**Date:** August 2026 (v0.1 scope outline); firmed into a build contract 2026-10-08 (AECI-1247)
**Status:** Decomposed. The AECI-634 epic has eight sub-issues, AECI-1247 to AECI-1254 (§8). The vendor guide is built (AECI-1104) and, since AECI-1253, indexable, in the sitemap, in the footer Help column and linked from the vendor portal (§7 question 1). The shell is built (AECI-1248): the `/docs` home, section indexes, prev/next, linked breadcrumbs, noindex by path and the sitemap entries, with `requests-and-corrections` imported. The getting-started and trust pages are built and indexable (AECI-1249). The reviewer and account pages are built and indexable (AECI-1250). The footer Help column and the `/methodology` links down into `/docs/trust/*` and `/docs/getting-started/taxonomy` are built (AECI-1252). The help center was restyled after Devin's DeepWiki (AECI-1259). The 2026-10-09 marketing-review rulings are applied (AECI-1261, AECI-1264, AECI-1265): the vendor guide is its own docs, out of the help center's sidebar and home. The internal link check is built (AECI-1254, part 2). The rest of the vendor guide is built (AECI-1251): `your-dashboard`, `editing-profile-and-products` and `notifications-and-messages`. The FAQ waits for the AECI-1105 pilot questions. A performance page waits for `analytics.view`, and `product-versions` waits for AECI-1263.
**Companion to:** `docs/STAGE_2_SPEC.md` §2.6 (the pillar stub). The architecture decision is ADR 0040.

> **2026-10-13, the rest of the vendor guide (AECI-1251, T4).** Three pages, indexable and in
> `sitemap.xml` like the rest of the guide: `your-dashboard` (order 4), `editing-profile-and-products`
> (5) and `notifications-and-messages` (6). The eight pages after `your-seat` moved down three places
> in `order`, so the guide reads sign in, dashboard, editing, messages, then the integration work.
> Every sentence was checked against the portal components and `docs/NOTIFICATIONS.md` on the day.
> Copy no seat can reach is left out ("Editing is paused.", the read-only form notices). The editing
> page says which saved company fields no public page shows: contact email and phone are for us to
> reach the vendor, and parent company and ownership are on record only (Chris, 2026-10-13). The two
> product doc URLs now render under "Resources" on the product page (AECI-1309), on every plan. The portal gained four "Learn more" links to the
> new pages (§7 question 1). Two pages the issue named are **not** written. Performance waits for
> `analytics.view`, which has no consumer: the overview's Views tile reads "Coming soon".
> `product-versions` waits for AECI-1263 (§6). The issue's "noindex until T5b" was overtaken by
> AECI-1253.

> **2026-10-12, the vendor guide is published (AECI-1253, items 1, 2 and 4).** Chris ruled that no
> help page or landing page is noindex. `NOINDEX_PATH_PREFIXES` is now empty, so `/docs/vendors` and
> every page under it renders no robots meta, gets no path-forced `X-Robots-Tag`, and is listed in
> `sitemap.xml`. The list and its three readers stay, so holding a path out again is a one-line
> change. The footer Help column gained "Vendor guide" (`/docs/vendors/overview`). This was
> decoupled from AECI-1105: `/vendor-program` is public and indexable and links into the guide. The
> portal "Learn more" links (§7 question 1) and the `STAGE_2_1_SPEC.md` §5 tick were held for AECI-1105.
> Every "noindex until AECI-1253" statement in the notes below is history.
>
> **Same day, the portal links shipped too (AECI-1253 item 3).** Chris ruled "we are going live
> today", so item 3 was built rather than held for AECI-1105. §7 question 1 lists every link.

> **2026-10-12, two guides behind a toggle (AECI-1271).** The help center's For vendors section
> is gone. Its two pages, `overview` and `claiming-your-listing`, moved into the vendor guide at
> unchanged URLs, as its first two pages. The guides are now **General** (`help`) and
> **For vendors** (`vendor`), with disjoint URL spaces: `/docs/vendors` and everything under it is
> the vendor guide, and nothing else is. A "General / For vendors" toggle tops the sidebar on every
> docs page and replaced the "Back to the help center" link. No General page links into the vendor
> guide. The manifest throws on a new one unless it is on `GENERAL_TO_VENDOR_LINK_ALLOWLIST`, which
> ships empty. The `urlSegment` and `home` section features went with For vendors, their only user.
> The note below is the history this one supersedes in part.
>
> **Same day, docs search (AECI-1270).** Each guide now has a search box under the toggle, on one
> Algolia index per tier (`staging_docs`, `production_docs`; demo reads production). §3 "Search" is
> the contract. It left §6.

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
>   `/docs/vendors`, the For vendors pages included, stays noindex until AECI-1253. *(AECI-1253
>   lifted it on 2026-10-12.)*
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
> links. Content, routes, URLs, indexing, caching and the sitemap are unchanged. There was still no
> docs search and no "Ask" box. *(AECI-1270 added docs search, §3 "Search". There is still no "Ask"
> box.)* The layout contract is `DESIGN.md` "Product docs".

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
> AECI-1253 lifts it, in the same sitting as AECI-1105. *(It lifted it on 2026-10-12, ahead of AECI-1105, by Chris's ruling. The footer Help column now links the guide too.)* Since AECI-1265 the claim confirmation opens the help center's `claiming-your-listing`, and the vendor guide's inbound links are help-center cross-links. (The
> "Active on AEC Integrations" label and its "What this means" link were removed in AECI-1264.) The footer Help column (AECI-1252) links into `/docs`, and
> since AECI-1253 into the vendor guide ("Vendor guide"). The portal "Learn more" links shipped 2026-10-12 (AECI-1253 item 3, §7 question 1). The same-PR sync rule (§4) is in
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
| Sections | `getting-started`, `trust`, `reviewers`, `account`, `vendors`, `faq`. Each has a `$localize`-wrapped label and summary in the manifest, an order and a **guide**: `help` (the General guide) or `vendor` (the For vendors guide, `vendors` only). A section's URL segment is its id. `faq` is a one-page section at `/docs/faq`. A section may carry an intro, rendered on its index (the vendor guide's landing) |
| Routes | `/docs` (home), `/docs/<section>` (section index), `/docs/<section>/<slug>` (article). All explicit and generated from the manifest, so an unknown `/docs/*` path falls through to the `**` 404. The manifest throws if two pages share one path |
| Navigation | A "General / For vendors" guide toggle tops the sidebar on every docs page (AECI-1271): two links, the current guide marked `aria-current="true"` from the URL alone. Under it, one of two sidebar trees, picked from the URL (AECI-1265): General lists its sections, For vendors lists the vendor guide. The `/docs` home lists General sections only |
| Cross-guide links | No General page or intro links into the vendor guide (AECI-1271). The manifest collects every href from the `marked` tokens and throws at module init, naming the file, when a General href's path is or sits under a vendor-guide path. `GENERAL_TO_VENDOR_LINK_ALLOWLIST` in `docs-content.ts` ships empty. Vendor → General links are allowed |
| Frontmatter | Scalar keys only (`parseFrontmatter`): `title`, `description`, `section`, `order`, `last_updated` (a pre-formatted display string in US format, "Month D, YYYY": the legal rule. AECI-1262 set the format. Help-center pages still carry "D Month YYYY" until AECI-1267). The manifest throws at module init when `section` does not match the folder, when two pages in a section share an `order`, or when a page does not end in a `## Related` list |
| Prev/next | Within one section, in `order`. Never across sections |
| Styling | Tailwind v4 and the semantic tokens. Typography per `DESIGN.md`, body in `.aec-prose`. Light only |
| Caching | Native Workers Cache on the static-page TTL (24h edge / 1h browser), on both `/docs` and `/docs/*`. Freshness on deploy is automatic (§2.3). **`Cache-Tag: route:index`**, not the `docs docs:{slug}` first sketched here (AECI-1104): the content changes only on deploy, which already rotates the cache key, so a per-page purge handle would have no producer. `cache-tags.ts` also forbids ad-hoc tag namespaces. Add a `docs` entity only if a runtime purge of docs ever becomes real |
| Indexing | Every docs page is indexable since AECI-1253. Driven by path: `NOINDEX_PATH_PREFIXES` (`apps/web/src/app/docs/docs-indexing.ts`, re-exported by `apps/web/src/server/robots-policy.ts`) is the one list, and it is empty. A prefix covers the path itself and everything below it, so a `/docs/x` entry would cover the section index too. The page's `robots` meta and the SSR egress `X-Robots-Tag` both read it, and the sitemap leaves out any path it covers. Holding a section out is a one-line change |
| Sitemap | `/docs`, every indexable section index and every indexable page, built from the manifest. **No `<lastmod>`**, the same as `/legal/*`: `last_updated` is a display string, and parsing it would add a second date format |
| Re-crawl pings | **None.** IndexNow is not part of docs publishing (Chris, 2026-10-08). Its producers are catalog promotes and vendor portal writes. Nothing submits a build-inlined static page, and `/methodology` and `/legal/*` rely on the sitemap too |
| Search | **One search box per guide (AECI-1270).** It sits under the guide toggle and searches only the current guide. Records live in one Algolia index per tier on the existing app: `staging_docs` and `production_docs`, named `<prefix>_docs` like the entity indexes (this replaced the `docs_{env}` sketch). Demo reads `production_docs` and never writes it. Records are built from the manifest by `buildDocsSearchRecords` (`docs-search-records.ts`): one per page lede, one per `h2` with its `h3`s folded in, `## Related` skipped, the vendor guide's landing intro included. Each carries `guide` (`help` or `vendor`), and the box filters on it. Anchors are the ids `renderDocsBody` renders. `scripts/algolia/push-docs.mjs` pushes them on every staging deploy and production promote, after the settings step: save every record, then delete ids no longer built, never a full replace. The box renders in the browser only, after hydration, and is absent when the inline config carries no `docsIndex`. It is an Angular Aria combobox on the lite client, loaded only in the lazy `/docs` chunk. Settings: `SEARCH_RANKING.md` §3.5. Keys and CI: `CICD_PLAN.md` §7.5 |
| i18n | The body is content, not UI strings (the legal rule, not extracted to `messages.xlf`). Page chrome is `i18n` / `$localize`-wrapped. Per-locale `.md` files are the later mechanism |
| Analytics | PostHog page events, standard. No new instrumentation concept |

## 4. Technique (the authoring model)

- **Docs-as-code.** Same repo, same branch model, same PR review. Git history is the version log (the `STAGE_1_SPEC.md` §27.3 rule the legal pages already follow). No CMS, no database-backed content.
- **The sync rule.** A PR that changes a documented surface updates that surface's doc page in the same PR. It is in `docs/CODE_REVIEW_CHECKLIST.md` §Spec alignment, and it is the main defense against the staleness that motivates the in-SPA choice. The internal link check is the second defense (AECI-1254). It runs in the `ng test` component specs, which a PR into `main` must pass, as the `only links to docs pages and app routes that exist` case in `docs-content.component.spec.ts`. Every `/docs` href in the Markdown must be a page, section index or the docs home the manifest serves, and a `#fragment` must be a heading id on that page. Every other href starting with `/` must match a route in `app.routes.ts`, lazy children included, with `:param` segments matching any one segment. A path only the SSR Worker answers, such as a 301, fails: link the canonical URL. `http(s)` and `mailto:` links are not checked. A relative or bare `#fragment` link fails. A failure names the `.md` file, the href and the reason. The helpers are in `docs-link-check.harness.ts`.
- **Voice.** Per `PRODUCT.md`: plain, trust-first, no marketing gloss in reference content. Docs state what paid does *not* buy as plainly as what it does.
- **Say what the reader can do, not how the plumbing works.** Help pages never describe reindexing, IndexNow, crawler pings, cache purges or other site-operations mechanics (Chris, 2026-10-08). If a reader needs to know when a change appears, say what they will see, not why.
- **Assemble, never invent.** Every sentence must be true of the shipped site on the day it merges. The six do-not-say items in `STAGE_2_5_SPEC.md` §7.1 apply to every page.
- **No screenshots at v0.** They rot faster than any prose and double the maintenance of every UI change. Prefer prose and links into the live surface. Revisit once the portal UI stabilizes.
- **Contextual entry, one direction.** Portal surfaces link **into** docs pages ("Learn more" links, §7). Docs pages never embed portal state: `/docs` is public and edge-cached, `/api/vendor/*` is `private, no-store`, and that boundary stays clean.
- **Legal pages are cross-referenced, never duplicated.** `/legal/*` keeps its own registry, lifecycle (§27), and counsel workflow. Docs link to it.
- **Every page ends with `## Related`**, linking its neighbours. The manifest enforces it.

## 5. Site map

URL scheme: `/docs/<section>/<slug>`, kebab-case. About 25 pages at v1. Since AECI-1265 the site
map has two guides. Since AECI-1271 they are **General** and **For vendors**, switched by the
sidebar toggle, with disjoint URL spaces.

**General** (`/docs`, its home and its sidebar):

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
└─ faq                               — AECI-1254: seeded from real pilot-vendor questions, not invented
```

**For vendors**, the vendor guide (section `vendors`, its own landing page and sidebar tree, listed
on neither the General home nor its sidebar):

```
/docs/vendors                        — Vendor guide landing: intro, the page list, one "Current limits" note   AECI-1265
├─ overview                          — "For vendors": what claiming is, Free and Managed at a glance, what no plan changes, where to go next (moved from the help center, AECI-1271)
├─ claiming-your-listing             — what buyers see, the claim form, what we check, outcomes (moved from the help center, AECI-1271)
├─ your-seat                         — sign-in, portal tabs, owners vs members, invites, removal, your account and your seat
├─ your-dashboard                    — the company and product tabs, the Vendor Overview (glance band, Getting started, What needs you), a product's overview, the plan-ended banner, live updates (AECI-1251)
├─ editing-profile-and-products      — company profile fields, logos, product Profile tab by plan, the four facet tabs, "How teams use it", when an edit shows, the company fields no public page shows, AECi locks (AECI-1251)
├─ notifications-and-messages        — the Messages tab's four parts, every email a seat can get, the daily reminder switch (AECI-1251)
├─ attesting-an-integration          — Affirm/Deny/Clear, add a data flow, agreement states, what happens next
├─ owning-an-integration             — claim, edit, per-side links, retire/restore, create (AECI-1023, ADR 0035)
├─ contests-and-protests             — sending and receiving contests and change requests, the protest to AECi (§11b)
├─ replying-to-reviews               — who replies, moderation, the public label, edit/withdraw/resubmit (§11c, AECI-1181)
├─ plans                             — Free vs Managed, benefit-first (marketing review 2026-10-12): pricing cards (`shared/plan-cta/plan-cards.ts`) + comparison table (`docs-plans-comparison.ts`), an intro line linking to the public `/vendor-program` page, what every plan includes, what Managed adds, why buyers trust the order, a "Coming soon" teaser (the one ruled exception to "describe only what ships"), plan end, then "Getting Managed" last so the page closes on its call-to-action panel. Since AECI-1293 (`VENDOR_PROGRAM_PAGE_SPEC.md` §15) every call to action opens the one claim dialog: "Claim your listing" under the intro, on the Free card and in the closing panel, and "Start with Managed" (Managed preselected) on the Managed card, in the rail from 90rem and in the phone bar. "Questions about Managed or pricing? Talk to us" sits under the intro, on the Managed card and in the panel, and opens the plan inquiry dialog. The page mounts one `aec-claim-dialog-host` and one `aec-plan-inquiry-host`. Since AECI-1285 these components live in `shared/plan-cta/` and are shared with `/vendor-program`. Each takes `page: 'docs_plans'` here, which `plan_cta_clicked` and `plan_inquiry_submitted` carry (`ANALYTICS.md` §4, AECI-1288). The closing panel's terms line shows the monthly and the annual price, both from `@aeci/shared/entitlements` (`MANAGED_LIST_PRICE_CENTS`, `MANAGED_ANNUAL_PRICE_CENTS`, AECI-1289). Since 2026-10-13 it reads "$25 USD a month or $250 USD a year per product, billed by invoice or purchase order.", followed by the one-year term, and "Getting Managed" states the price, the term, renewal and a "Can we cancel a Managed plan early?" answer in prose (`VENDOR_PROGRAM_PAGE_SPEC.md` §10 item 6). The pricing link opens the plan inquiry dialog in place, which saves the inquiry and emails the visitor and support (`POST /api/plan-inquiries`, AECI-1279); `/contact?topic=managed` carries the same form for no-JS clicks (AECI-1219; slug renamed by AECI-1264, old URL 301s). The public `/vendor-program` page shares these CTA components and links here, including to the `#what-managed-adds`, `#compare-plans` and `#when-a-managed-plan-ends` headings. Since the 2026-10-12 ruling that page carries its own benefit copy and this page stays the feature reference: an edit to a Free, Managed or "Coming soon" sentence here needs no matching edit there. Keep the facts aligned, so a feature that changes here is checked there too. Two things stay shared. The plan cards are one component. The sort rule is one i18n id (`@@app.docs.plans.sortRule`) in `docs-plans-comparison.ts` and on that page, and it must read the same as this page's "Why buyers trust the order". `vendor-program/vendor-program-copy.component.spec.ts` fails when the sort rule, or one of the three heading ids that page links to, changes on one side only. Its contract is `VENDOR_PROGRAM_PAGE_SPEC.md` §4, and the Plans-page deltas it made are §10
├─ checklists                        — the company and product checklists and "Looks right", moved off `plans` on 2026-10-12
├─ change-history                    — the Changes page: every change, who made it, AECi's reasons (AECI-1160)
├─ connector-vendors                 — "For connector vendors": the catalogue seat, the Catalogue tab, integrations delivered through a connector (§8.9/§8.10; AECI-1265)
└─ (deferred, §6) performance, until analytics.view has a consumer; product-versions, until a vendor can create a release (AECI-1263)
```

Everything under `/docs/vendors`, which since AECI-1271 is the vendor guide alone, is indexable and in the sitemap since AECI-1253, like the General guide.

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

- A changelog / what's-new page
- Per-locale content files
- Any versioned-docs mechanism
- A vendor performance page, until `analytics.view` has a consumer (`VENDOR_PERFORMANCE_SPEC.md`). The overview's Views tile reads "Coming soon", and `plans` carries the one "Coming soon" note (AECI-1251)
- A `product-versions` vendor page, until a vendor can create a release. The version comparison is not reachable today and the docs must not describe it (AECI-1263)
- Screenshots / recorded walkthroughs
- An embedded support widget (the feedback endpoint and mailing-list band already exist)
- Re-crawl pings on publish (§3, "Re-crawl pings")

## 7. Open questions, answered

1. **Which portal moments get a "Learn more" link?** **Answered 2026-10-08 (AECI-1247); built 2026-10-12 (AECI-1253 item 3).** One link per surface, under the surface's heading or intro. Every link is `aec-vendor-docs-link` (`vendor/components/vendor-docs-link.ts`): the visible text "Learn more", a visually hidden suffix naming the page, a new tab with `aec-new-tab-icon`, `rel="noopener"`. It keeps its own copy of each page title so the portal bundle does not carry the docs manifest. Its spec fails when a slug stops resolving or a title drifts from the page's frontmatter. The table names the component that renders each link:

   | Portal moment | Component | Page |
   |---|---|---|
   | Claim outcome: the "Claim & correction status" block on Messages | `vendor/sections/vendor-messages-page.ts` | `claiming-your-listing` (in the vendor guide since AECI-1271; URL unchanged). Until 2026-10-12 this row named `vendor-claim-outcome.ts`. That file is the attestation lane's "what happens next" line about a data-flow claim, not a listing claim, so the link went to where a listing claim's status shows |
   | Seats page | `vendor/sections/vendor-seats-page.ts` | `your-seat` |
   | Vendor Overview, under "What needs you" (the page has no heading of its own above the glance band) | `vendor/sections/vendor-overview-section.ts` | `your-dashboard` (AECI-1251) |
   | Company profile, under "Vendor profile"; a product's Profile tab, above the form | `vendor/sections/vendor-profile-section.ts`; `vendor/sections/vendor-product-profile-page.ts` | `editing-profile-and-products` (AECI-1251) |
   | Messages, under the page intro. The claim-status block keeps its own `claiming-your-listing` link and the change-requests block its own, one link per block | `vendor/sections/vendor-messages-page.ts` | `notifications-and-messages` (AECI-1251) |
   | Attestation lane: "Data that's shared" on the integration page | `vendor/integration-detail/integration-shared-data.ts` | `attesting-an-integration` |
   | Integration edit, create, retire | The integration page's Overview section (`vendor-integration-detail-page.ts`), "Add an integration" (`vendor-integration-create.ts`), "Integrations your company offers" (`vendor-owned-integrations.ts`, which holds the edit form and Retire) | `owning-an-integration` |
   | Contest form and protest | The open "Request a change" form (`vendor-contest-form.ts`), the Change requests block on Messages (`vendor-contests-list.ts`) and on the integration page (`integration-change-requests.ts`). The protest renders inside the last two | `contests-and-protests` |
   | Review reply | `vendor/components/vendor-reviews-list.ts` | `replying-to-reviews` |
   | Plan panel and checklist | `vendor/components/vendor-plan-panel.ts`; `vendor/components/vendor-checklist.ts`, so the company and the product checklist both carry it | `plans`, `checklists`. The issue named `plans-and-the-account-label`, which AECI-1264 renamed to `plans`; the checklist text moved to `checklists` on 2026-10-12 |
   | Capability registry and plan price | `@aeci/shared/entitlements` (`TIER_CAPABILITIES`, `MANAGED_LIST_PRICE_CENTS`, `MANAGED_ANNUAL_PRICE_CENTS`) | `plans`. The comparison table's capability rows, the list price and the closing panel's annual price read the registry, so they follow it. Its other rows (seat rights, search-engine notice, connector integrations) are literals in `docs/docs-plans-comparison.ts` and must be edited by hand |
   | Changes page | `vendor/history/vendor-history-page.ts` | `change-history` |

2. ~~Does the vendor guide organize by task or by tier?~~ **Answered: by task** (AECI-1104). Seat-only and plan-gated actions are marked on each task page rather than split into tiers.
3. ~~Header nav entry or footer-only at launch?~~ **Answered: footer-only, as a Help column** (2026-10-08). The header's primary row is public-directory-only, width-budgeted and closed, so a new secondary destination goes to the footer (`DESIGN.md` §Navigation, The Overflow Rule). The Help column holds "Help center" (`/docs`), "Getting started" and "How ranking works" from AECI-1252, and "Vendor guide" (`/docs/vendors/overview`), shipped by AECI-1253 on 2026-10-12. It is not called "For vendors": that label is the Company column's link to `/vendor-program` (AECI-1283). Since AECI-1265 that link has a page to land on: `/docs/vendors/overview`, the vendor guide's first page since AECI-1271. Chris: easy to readjust. Promoting `/docs` into the header row later is a deliberate re-measure at 1024px, not a default.
4. **What does the FAQ actually need?** Collect the real questions from the first pilot cohort (AECI-1105) rather than inventing them. AECI-1254 writes it after that.

## 8. Epic decomposition (2026-10-08)

One PR per sub-issue, each into `main`. All sit in the "Stage 2.1 — Vendor Activation" project (Chris, 2026-10-08). Only AECI-1251 and AECI-1253 gate `STAGE_2_1_SPEC.md` §5. The rest is reader content riding in the same window.

| # | Issue | Scope | Gated on |
|---|---|---|---|
| T0 | AECI-1247 | This build contract, ADR 0040, stale page counts | — |
| T1 | AECI-1248 | `/docs` home, section index pages, prev/next, linked breadcrumbs, noindex by path, `/docs` cache matchers, sitemap entries, import `requests-and-corrections` | T0 |
| T2 | AECI-1249 | Getting-started and trust pages; `how-ranking-works` discharges `STAGE_2_5_SPEC.md` §2 step 3 | T1 |
| T3 | AECI-1250 | Reviewer and account pages | T1 |
| T4 | AECI-1251 | The rest of the vendor guide. **Shipped 2026-10-13:** `your-dashboard`, `editing-profile-and-products`, `notifications-and-messages` and their portal links. Performance and `product-versions` stay deferred (§6) | T1, the AECI-1103 rehearsal |
| T5a | AECI-1252 | Footer Help column; `/methodology` links down into `/docs/trust/*` | T2 |
| T5b | AECI-1253 | Publish the vendor guide (drop the noindex prefix), "Vendor guide" in the footer Help column, the §7 portal links. **All three shipped 2026-10-12** by Chris's rulings, ahead of AECI-1105: the first two, then the portal links ("we are going live today") | T1 |
| T6 | AECI-1254 | FAQ, internal link check (an `ng test` case, §4), epic close-out | T5b, AECI-1105 |

The epic closes when every sub-issue is closed (`docs/linear-issue-conventions.md` §6).

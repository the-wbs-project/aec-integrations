# AEC Integrations — Stage 2 Product Docs / Help Center (Scope Outline)

**Version:** 0.1 — **scope outline, not a build contract**
**Date:** August 2026
**Status:** Kickoff draft (the AECI-634 epic). Deliberately light: the vendor-guide half documents portal surfaces that are about to be tested hands-on, so the site map in §5 is a v0 expected to move. Firm this doc up (as the other Stage 2 pillars did) **before** decomposing the epic into sub-issues, and not before portal testing settles.
**Companion to:** `docs/STAGE_2_SPEC.md` §2.6 (the pillar stub) — this doc is the fuller outline.

> **2026-09-23 — v0 vendor tranche shipped (AECI-1104).** The vendor guide is built ahead of the
> rest of the epic, because publishing it is a `STAGE_2_1_SPEC.md` §5 exit gate (§3.5 there). It
> brought the minimum shell with it: a docs manifest (`apps/web/src/app/docs/docs-content.ts`), one
> article component (`docs-page.ts`, anchor site **Zendesk**'s help-center article page:
> breadcrumb, a section rail, the article), and one route pattern, `/docs/<section>/<slug>`, as
> explicit lazy children generated from the manifest (`docs.routes.ts`). There is **no `/docs` home
> page and no section index yet**; the breadcrumb's "Docs" and section crumbs are plain text. Six
> pages, organised by task (open question 2, answered: task). They are **noindex in every env and
> absent from `sitemap.xml`** until the portal opens: the page sets `robots: noindex` and the SSR
> egress stamps `X-Robots-Tag` on `/docs/vendors/*` (`pathForcesNoindex`). AECI-1105 lifts both.
> Nothing links into `/docs` yet: the footer entry (open question 3) and the portal "Learn more"
> links (open question 1) wait for the same trigger. The §5 site map below is updated to what
> shipped. The same-PR sync rule (§4) is now in `docs/CODE_REVIEW_CHECKLIST.md` §Spec alignment.

---

## 1. What this is

A **reader-facing product documentation surface** ("the docs") supporting the product as it stands at the end of Stage 2. It is not repo documentation (that's `docs/`), not marketing content, and not the in-portal microcopy — it is the public reference a person is sent to when a one-line tooltip isn't enough.

Three audiences, in priority order:

1. **Vendors** — the Stage 2 addition and the reason this exists now: claiming a profile, the dashboard, attesting to integrations, product versions, plans & entitlements, notifications.
2. **Readers** (AEC firms evaluating integrations) — how the directory works: taxonomy, agreement states, the vendor account-status label, what ranking does and does not reward.
3. **Reviewers** — dual reviews, requesting integrations/corrections.

Trust content is first-class, not an afterthought: "how ranking works and what paid does **not** buy" (§8.1(4) of `STAGE_2_SPEC.md`) gets its own pages. Documentation is part of the trust surface.

## 2. The decision: not a separate site

**Docs ship inside `apps/web` as a lazy `/docs` route area — not a separate app, not a second framework, not a subdomain.**

| Option | Verdict |
|---|---|
| Lazy `/docs` route area in `apps/web` (this doc) | **Chosen** |
| Separate static-site app (`apps/docs`, Astro/Starlight or similar) on `docs.aecintegrations.com` | Declined — see re-open trigger |
| Separate Worker on a `www.…/docs/*` route | Declined — the route split buys nothing the lazy route area doesn't, and costs a second deploy pipeline |

Why in-SPA wins here:

1. **The pattern already exists and is proven.** The legal pages (AECI-237) are exactly this: markdown + frontmatter in `apps/web/src/content/legal/`, inlined at build time by the esbuild `text` loader, parsed by a content registry (`legal-content.ts` → `marked`, GFM), SSR-rendered, edge-cached. The docs generalize that pattern; they don't invent one.
2. **One design system.** `DESIGN.md` + the anchor-site rule exist so AECi reads as one publication. A second framework means a second token sync that will drift.
3. **The platform work is already paid for.** SSR, native Workers Cache (keyed on URL + Worker version — build-inlined content is therefore **automatically fresh on every deploy, with zero purge wiring**), i18n architecture, a11y discipline, sitemap/IndexNow, four-tier environments + Access. A separate site re-buys all of it.
4. **Doc staleness is the failure mode that matters most here.** In-repo, in-SPA docs let the PR that changes a surface update that surface's docs **in the same diff** — the same discipline this repo already enforces for its own `docs/`.
5. **SEO.** `/docs` on `www` consolidates domain authority; a subdomain splits it. Help content is a discovery funnel for a directory product.

Costs accepted: docs edits ride app deploys (fine — deploys are cheap, gated, and the content is versioned by git); bundle growth (mitigated — the docs area is a lazy route chunk; content strings load only on `/docs` routes).

**Re-open trigger** (dated-decision house style, ADR 0023 precedent): revisit a dedicated docs generator when **any** of — the corpus passes ~75 pages; versioned docs become a requirement; a public/partner API reference ships (out of Stage 2 scope per `STAGE_2_SPEC.md` §9) and brings OpenAPI-style tooling with its own needs. Promote this section to an ADR when the epic is decomposed.

## 3. Tech stack

No new Worker, no new schema, no new bindings, no migration.

| Layer | Choice |
|---|---|
| Framework | Angular, same app — lazy route area under `/docs` (`apps/web/src/app/docs/`) |
| Content | Markdown + YAML frontmatter: `apps/web/src/content/docs/<section>/<slug>.md` |
| Build | Existing esbuild `text` loader (`apps/web/angular.json`) — inlined at build time, no runtime fetch |
| Rendering | `marked` (GFM), same pipeline as `legal-content.ts`; the registry generalizes into a **docs manifest** that also carries the nav tree (section order, page order, prev/next) from frontmatter |
| Frontmatter | Scalar keys only (reuse/generalize `parseFrontmatter`): `title`, `description`, `section`, `order`, `last_updated` (pre-formatted display string — the legal rule), optional `related` |
| Styling | Tailwind v4 + the semantic tokens; typography per `DESIGN.md`. Light-only until §2.5 dark reintroduction, after which docs inherit dark for free |
| Caching | Native Workers Cache on the static-page TTL (24h edge / 1h browser); freshness on deploy is automatic (see §2.3). **Shipped as `Cache-Tag: route:index`, not the `docs docs:{slug}` first sketched here** (AECI-1104): the build-inlined content changes only on deploy, which already rotates the cache key, so a per-page purge handle would have no producer. `cache-tags.ts` also forbids ad-hoc tag namespaces. Add a `docs` entity only if a runtime purge of docs ever becomes real |
| Search | **None at v0.** Nav + browser find. The deferred path is an Algolia `docs_{env}` index (Algolia is already wired) — not a new search system |
| i18n | Body is content, not UI strings (the legal rule — not extracted to `messages.xlf`); page chrome is `$localize`-wrapped; per-locale `.md` files are the later mechanism |
| Analytics | PostHog page events, standard — no new instrumentation concept |

## 4. Technique (the authoring model)

- **Docs-as-code.** Same repo, same branch model, same PR review. Git history is the version log (the `STAGE_1_SPEC.md` §27.3 rule the legal pages already follow); no CMS, no database-backed content.
- **The sync rule.** A PR that changes a documented surface updates that surface's doc page in the same PR. Add this to `docs/CODE_REVIEW_CHECKLIST.md` when the epic builds — it is the entire defense against the staleness that motivates the in-SPA choice.
- **Voice.** Per `PRODUCT.md` — plain, trust-first, no marketing gloss in reference content. Docs state what paid does *not* buy as plainly as what it does.
- **No screenshots at v0.** They rot faster than any prose and double the maintenance of every UI change. Prefer prose + links into the live surface. Revisit once the portal UI stabilizes.
- **Contextual entry, one direction.** Portal surfaces link **into** docs anchors ("Learn more" affordances); docs pages never embed portal state — `/docs` is public and edge-cached, `/api/vendor/*` is `private, no-store`, and that boundary stays clean.
- **Legal pages are cross-referenced, never duplicated.** `/legal/*` keeps its own registry, lifecycle (§27), and counsel workflow; docs link to it.

## 5. Site map — v0 (expected to move during portal testing)

URL scheme: `/docs/<section>/<slug>`, kebab-case. Roughly 18 pages.

```
/docs                                — Docs home: audience split (reader / vendor / reviewer)
├─ getting-started/
│  ├─ what-aeci-is                   — the directory, dual-vendor verification, who curates
│  ├─ reading-an-integration-page    — the product-PAIR page: claims, attestations, agreement states
│  └─ taxonomy                       — mechanisms, data objects, trades (the four facets)
├─ trust/
│  ├─ how-ranking-works              — purely algorithmic; what paid does NOT buy
│  ├─ the-account-label              — what "Active on AECi" means (AECI-965 retired "Verified badge"; AECI-1131 relabeled it from "Vendor account active"/"Account active"), that it is the plan
│  └─ agreement-states               — unverified / single-source / confirmed / conflict, plainly
├─ vendors/                          — SHIPPED v0 2026-09-23 (AECI-1104), noindex until AECI-1105
│  ├─ claiming-your-listing          — the claim form, what we check, outcomes, connector-vendor seats (§8.9/§8.10)
│  ├─ your-seat                      — sign-in, portal tabs, owners vs members, invites, removal, seat vs plan
│  ├─ attesting-an-integration       — Affirm/Deny/Clear, add a data flow, agreement states, what happens next
│  ├─ owning-an-integration          — claim, edit, per-side links, retire/restore, create (AECI-1023, ADR 0035)
│  ├─ contests-and-protests          — sending and receiving contests, the protest to AECi (§11b)
│  └─ plans-and-the-account-label    — the four things a plan changes, what it never changes, billing, expiry
│     (not yet written: your-dashboard, editing-profile-and-products, product-versions)
├─ reviewers/
│  ├─ writing-a-review               — dual reviews: product quality vs onboarding experience
│  └─ requests-and-corrections       — requesting an integration, correcting a listing, contesting a detail (AECI-1023)
├─ account/
│  ├─ signing-in                     — magic link + Google, common failure modes
│  └─ your-data                      — links /legal/privacy; deletion/erasure path
└─ faq                               — seeded from real concierge-onboarding questions, not invented
```

> **Boundary with `/methodology` (AECI-804, shipped).** The three `trust/` pages above cover the same
> ground as the editorial methodology page, which now exists at a top-level URL. They do not duplicate
> it and they must not replace it. `/methodology` is the **single-page, citable editorial statement**:
> one read, indexable, in the sitemap, the canonical short answer to "how does this directory work".
> `/docs/trust/*` is the **task-level depth** underneath it, and links up rather than absorbing. The
> rule of thumb: `/methodology` is what we assert, `/docs/trust/*` is how to act on it. Same split for
> `getting-started/what-aeci-is`. See `STAGE_2_5_SPEC.md` §7.2, which owns this boundary.
>
> Two things `/docs` inherits from that page when it lands: the `.aec-prose` class (renamed from
> `.legal-prose` by AECI-804 precisely because it now styles more than the legal set), and the
> "assemble, never invent" rule with its six do-not-say items in `STAGE_2_5_SPEC.md` §7.1.

> **Two pages were drafted ahead of the epic (AECI-1023, 2026-09-22).** *Update 2026-09-23:
> `owning-an-integration` is now the fourth entry of the manifest and renders. `requests-and-corrections`
> is still unimported, pending the reviewer tranche.* The vendor-owned
> integrations epic (AECI-1003, ADR 0035) changed what a vendor can do to an integration, and the
> docs were the fourth public surface that needed the new rule. This epic had not started, so there
> is no `/docs` route and no registry. The two pages were written as Markdown at the paths §3
> defines, with the frontmatter §3 lists, and **nothing imports them**: they are not in the bundle
> and not reachable on the site. When the shell is built they are the first two entries of the
> manifest. Until then they are held to the same-PR sync rule (§4) by hand: a change to claim, edit,
> links, retire, create or contests updates them in the same change.
>
> - `apps/web/src/content/docs/vendors/owning-an-integration.md`
> - `apps/web/src/content/docs/reviewers/requests-and-corrections.md`
>
> This runs ahead of the "vendor guide goes last" sequencing on purpose, and only for these two.
> The contract they document is settled (ADR 0035), so the reason for waiting does not apply to
> them.

## 6. Deliberately deferred (not in the v0 epic)

- Docs search (Algolia `docs_{env}` is the path when wanted)
- A changelog / what's-new page
- Per-locale content files
- Any versioned-docs mechanism
- Screenshots / recorded walkthroughs
- An embedded support widget (the feedback endpoint + mailing-list band already exist)

## 7. Open questions (answer during portal testing, before decomposition)

1. Which portal moments get a "Learn more" link — claim form, attestation lanes, plan panel, notification list?
2. ~~Does the vendor guide organize by task (leaning yes) or by tier?~~ **Answered: by task** (AECI-1104). Seat-only and plan-gated actions are marked on each task page rather than split into tiers.
3. ~~Header nav entry or footer-only at launch?~~ **Answered: footer-only.** The header's primary row is public-directory-only, width-budgeted and closed, and its `More▾` overflow menu was retired — a new *secondary* destination now goes to the footer by rule, not by preference (`DESIGN.md` §Navigation → The Overflow Rule). `/docs` is exactly such a destination. Promoting it into the row later is possible but is a deliberate re-measure at 1024px, not a default.
4. What does the FAQ actually need? Collect the real questions from the first concierge cohort rather than inventing them.

## 8. Epic decomposition sketch — **not final, do not build from this**

1. Content collection + registry + `/docs` shell (nav, index, article page, caching, sitemap)
2. Getting-started + trust content set
3. Reviewer + account + FAQ content set
4. Vendor guide content set (**last** — after portal testing)
5. Cross-links from portal surfaces + SEO wiring + checklist rule

---

*This is a living kickoff outline (the same posture `STAGE_2_SPEC.md` started in). Grow it into a build contract before decomposing AECI-634.*

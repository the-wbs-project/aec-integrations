# AEC Integrations — Stage 2.5 Specification (Hardening Interlude)

**Version:** 0.1 — **proposal, not yet seeded into Linear**
**Date:** August 2026
**Status:** Kickoff draft from the 2026-08-24 Stage 3 planning session. Stage 2.5 is a deliberately small, **finishable** interlude between **Stage 2.1** (vendor activation — `docs/STAGE_2_1_SPEC.md`, inserted 2026-08-31) and Stage 3 (growth & trust — `docs/STAGE_3_SPEC.md`). Nothing here is a new feature.
**Precondition:** Stage 2.5 opens when the Stage 2.1 exit criteria (`STAGE_2_1_SPEC.md` §5 — vendors live) are green. The ordering is a deliberate discipline firewall: vendor-management polish finishes before this stage's work may compete for attention. The pull runs one way — a 2.5 item may move *forward* into 2.1 only when it demonstrably blocks seat-granting (recorded in both docs); nothing moves the other way.
**Inherits from:** Stage 1 / 1.5 / 2 — every constraint carries; this doc adds none.

## 1. Purpose and admission test

Stage 2 built the vendor portal, attestations, paid tiers, and real-time surface, but the backlog accumulated a stratum of issues that belong to **no** stage: live production defects, decided-but-unbuilt product changes, integrity debt, and doc drift. Stage 3 would inherit all of it silently. Stage 2.5 exists to clear that stratum first.

An issue is admitted to Stage 2.5 only if it passes one of four tests — otherwise it is Stage 3 (or stays where it is):

1. **Live defect or broken operational surface** on a deployed tier.
2. **Decided and sequenced product change whose delay blocks other work** — today that is exactly one thing: the search-ranking overhaul, which gates all trust/ranking copy and the marketing push.
3. **Integrity debt that compounds** once Stage 3 builds on top of it (audit invariants, catalog correctness).
4. **Overdue quality gate** (the manual screen-reader passes; the docs de-stale sweep).

**Exit criteria** are listed in §8. When they are green, Stage 3 opens.

---

## 2. The anchor: search-ranking overhaul (AECI-636)

**The decision is made** (2026-08-23, recorded on AECI-636 — the implementation spec lives in the issue's comment of that date and is self-contained; the research brief is in the marketing repo at `docs/strategy/search-ranking-decision-brief.md`). The shape: **evidence-gated, depth-weighted, surface-scoped.** `integration_count` is retired as an ordering signal everywhere; products/vendors tie-break on a content-keyed `listing_tier`; the integrations index (and later pairs) orders on `desc(evidence_tier), desc(mechanism_rank)`; unscored is a labeled state that sorts last by attribute omission; no numeric score is rendered anywhere; money never touches the evidence pipeline; corrections are free for anyone, forever.

Build sequence (from the issue, unchanged):

1. **Product change 1** — `products` + `vendors` `customRanking` → `desc(listing_tier)`; compute `listing_tier` in `apps/api/src/lib/algolia-transforms.ts`; retire the two "Most integrations" replicas. Co-edit `packages/shared/src/algolia.ts`, `algolia.spec.ts`, and `docs/SEARCH_RANKING.md` §3.1/§3.2/§5/§5a in the same PR (the repo's lockstep rule). *Side benefit: retiring two replicas per env relieves the exhausted Algolia index quota (24 used / 20 cap).*
2. **Product change 2** — the one schema addition: `limits` (three-state: documented / attested-none-known / absent) on integrations; add the `file-transfer` mechanism kind at rank 1; compute `evidence_tier`; `integrations` index → `desc(evidence_tier), desc(mechanism_rank)`; fold the same shape into the §3.4 pairs plan.
3. **Publish the ranking-method page** — the plain-language twin of `SEARCH_RANKING.md` (parameters and relative importance, no algorithm, no numbers). Publishing before 1–2 would publish count, the thing being retired. Its natural home is the trust section of the AECI-634 `/docs` area ("how ranking works" is a named first-class page in `STAGE_2_PRODUCT_DOCS_SPEC.md`) — AECI-634 is Stage 2 work running in the same window (see §9); if the docs shell has landed by this step, publish there, otherwise ship standalone and fold in when it does.
4. **Release the blocked copy** — the two in-repo lines (`home-differentiation.ts:104`, `home-trust-pillars.ts:95` — "vendors who want to maintain their own listing, never from changing what you see"), the `/about` negation-stack rewrite, plus the marketing-repo vendor-facing explanation (contingent until 1–3 ship).

**Do-not-do traps carry verbatim** from the issue: no plan-status-keyed tiers, no freshness in ranking until updates are free, no engagement in ordering, no precise published numbers, no paid fast lane, no gate creep.

**Fold-ins:**

- **AECI-283** (Phase 8.5 "search ranking post-launch tuning loop") is re-scoped by this change — the loop in `SEARCH_RANKING.md` §7 tunes signals that are being retired. Rewrite §7 and re-baseline the loop around `listing_tier` / `evidence_tier` as the close-out step of this track, then AECI-283 is Done.
- **AECI-534** (remove `has_api_docs` from search facet / API / Algolia / D1) rides with product change 1 — it edits the same four lockstep files.

---

## 3. Live defects and broken operations

| Issue | What is broken | Priority |
|---|---|---|
| **AECI-618** | Listing pages (`/products`, category/audience/phase/trade browse) SSR an error string and **zero product links** on both public tiers — the `httpResource()` relative-path fetch fails at the edge while the resolver/service-binding path works. Hydration hides it from browsers; crawlers and LCP pay for it. Fix direction 1 (server-side service-binding path for the listing controller) is the consistent one. | High |
| **AECI-589** | Cache-purge secrets were never provisioned — `POST /admin/purge` 401s on **every** tier, plus false "not set" warnings on `DD_*`. The manual/incident purge surface is dead. | Medium |
| **AECI-531** | GDPR erasure: the `auth.users` delete is **silently skipped in production** with zero telemetry — the erasure flow reports success while leaving the auth record. | High |
| **AECI-591** | §26.1 violation: the `*/15` reconcile sweep mutates `vendor_requests` + `workflow_instances` with **no audit row** — the one standing exception to "failure to log is a transactional failure". | Medium |

## 4. Catalog integrity

| Issue | What it fixes | Priority |
|---|---|---|
| **AECI-559** | The category vocabulary has no Procurement / Materials Management entry — 40+ products have no correct home. A vocabulary addition with browse/SEO surface impact; do it before pSEO (Stage 3) multiplies the pages built on the taxonomy. | Medium |
| **AECI-595** | Promote has no retract semantics — deleting an Airtable record always strands the live D1 row (today's workaround is the manual `ops:retract-product` script). **Sized by AECI-767 on 2026-09-07**: the whole production tail was **0 stranded products, 1 vendor, 6 integration edges** (7 claims + 7 attestations in cascade), all seven publicly reachable and in search. A cleanup, not a trust problem — and five of the seven were **already-filed items that were never executed**, so the binding constraint was the retraction backlog, not the missing feature. **That backlog is now fully drained: re-measured 2026-09-08 the tail is ZERO** — every bucket empty, 0 publicly reachable rows, and the sweep exits 0 for the first time (AECI-593, AECI-794 and AECI-795 all executed, the Bluebeam lane closed). **AECI-595 itself is now Done** — it closed 2026-09-07 on the *upstream* side shipping (review-repo PR #93). **AECI-795 is the row that argues hardest for the consumer**: it is the one of the seven whose deletion was recorded *nowhere* — not upstream, not here — so it was retracted on an operator ruling taken after escalating, rather than on a note. The review app now exposes `list_retractions` (the feed: `supabaseId`, curator `reason`, `carrierProductIds`, `since` cursor) and `confirm_retractions` (the ack). **The AECi consumer was never built and nothing here references either tool**, so the gap is still open from this end; the feed is also empty, because it journals deletions going forward only. That remainder is tracked as **AECI-811**, and it is a consumer to build rather than a protocol to design. Evidence: `scripts/ops/2026-09-stranded-row-audit/README.md`, `scripts/ops/2026-09-procore-followup-retraction/README.md`, `scripts/ops/2026-09-dynamics-monday-retraction/README.md`, `docs/REVIEW_APP_PROMOTE_API.md` §5.1. | Medium |
| **AECI-592** | Data-quality check #2 (`ready_products_unpromoted`) is unreachable; replace with a promotion-status invariant guard that can actually fire. | Medium |

## 5. Stage 2 close-out debt

Two items moved forward to Stage 2.1 on 2026-08-31 (both are vendor-portal polish and gate seat-granting): **AECI-623** (capability convergence) and **AECI-633** (the vendor-portal screen-reader pass) — see `STAGE_2_1_SPEC.md` §3.3. What remains here:

| Issue | What it closes | Priority |
|---|---|---|
| **AECI-244** | The outstanding **manual screen-reader pass** over the public site (the Stage-1 Phase 7.10 pass that never ran), per `docs/a11y-manual-testing-checklist.md` and logged. May be run in the same sitting as AECI-633 (Stage 2.1) if calendars align — the former pairing was a scheduling convenience, not a dependency. **Partly discharged 2026-09-09** by a tool-assisted public-site pass against production `44aba9cf` → `docs/ACCESSIBILITY_AUDIT.md`: the keyboard layer is clean, and it found **three serious WCAG 4.1.3 (AA) status-message failures** plus seven lesser items, now filed. **What remains here** is the part a browser cannot do: the VoiceOver and NVDA speech layer (scripted in checklist §6/§7), dialog focus management, and the review-form `Tab` walk — the last two need a **local seeded** run, because production's moderation queue is empty and its destructive dialogs must not be opened. | Medium |

## 6. Docs & process de-stale sweep

Per the standing review finding — most code-review noise is stale docs. One focused sweep: **AECI-598** (de-stale `STAGE_1_SPEC.md` — §26 audit, the RLS self-contradiction, the §1a companion index; High), **AECI-599** (purge the remaining `appendAuditLog()` references), **AECI-600** (duplicate ADR number 0010 + CICD_PLAN's dark-theme a11y claim), **AECI-601** (Spec-section line missing on 40% of recent issues; `ADMIN_PANEL_SPEC.md` invisible from `stage-2`). *Optional rider:* AECI-620 (slim root `CLAUDE.md`, nested per-app files) — admit only if the sweep has room; otherwise Stage 3.

## 7. Public trust and answer-surface artifacts

The surfaces that describe AECi to a careful reader, a search quality rater, or an answer engine. Tracked under the **AECI-788** epic (SEO and AI-answer-surface visibility), whose own "Doc debt" note asks for exactly this section: *"add a section covering the head/structured-data contract and the AI-surface routes to `docs/STAGE_2_5_SPEC.md`"*. That debt was recorded on the issue, never in this file, until AECI-804 closed.

**This is the one admitted exception to §9's "no new surface area".** It is admitted under §1 test 4 (overdue quality gate), not test 2: nothing is blocked on it, but the process it documents is the product's strongest differentiator and shipping a directory that never states its own editorial standard is a gap, not a feature request. The exception is **one page**. Any further public surface is Stage 3 or AECI-634, not this section.

| Issue | What it adds | Priority |
|---|---|---|
| **AECI-804** | `/methodology` — the editorial methodology page. **Shipped.** See the contract below. | Medium |
| **AECI-784** | The site-wide `@id`-linked JSON-LD entity graph. Owns every structured-data decision; `/methodology` deliberately emits none. Blocked by **AECI-805** (social profiles), or `sameAs` ships empty. | High |
| **AECI-785 / AECI-787** | `llms.txt` and an RSS/Atom feed. Both new SSR routes, both needing a cache-tag decision. 785 is downgraded to Low on the epic (no provider commits to reading it); ship a static route or decline it, but do not build a generator. | Low |
| **AECI-802** | Entity titles and meta descriptions carrying search intent. Blocked by **AECI-799** (Search Console baseline) under the epic's measurement-before-change rule. | High |
| **AECI-803** | Paginated listings self-canonicalise instead of every page claiming to be page 1. Five routes, `page` the only allowlisted canonical param. Contract: `STAGE_1_PHASE_2_SPEC.md` §9.1a. Not blocked by AECI-799 — it fixes a documented anti-pattern rather than tuning copy, so the measurement-before-change rule does not bite. | Low |

### 7.1 `/methodology` — the build contract (AECI-804, shipped)

One page at `/methodology`, linked from the footer's Company column and from `/about`. Static, indexable, cacheable on the `/about` static-page TTL (24 hr edge / 1 hr browser, `Cache-Tag: route:index`, no resilience pair, no `cacheKeyParams`), and **in `sitemap.xml`** — the first non-legal static page listed there, deliberately, because being found and cited is the page's whole purpose.

Built as **build-time-inlined Markdown**, generalizing the AECI-237 legal pattern rather than an inline template: `apps/web/src/content/methodology.md` → `methodology/methodology-content.ts` → `MethodologyPage`. The body is content and is not extracted into `messages.xlf`; the page chrome is `$localize`-wrapped as usual. The shared prose class was renamed `.legal-prose` → **`.aec-prose`** in the same change, since it now styles two page families and AECI-634 will make it three.

**The governing rule is that the page assembles, never invents.** Every assertion maps to shipped behaviour. Six things it must therefore not say, each of which was true of an earlier draft of one surface or another:

1. No accuracy or completeness warranty. `/legal/listing-accuracy` disclaims it and the two must not diverge.
2. No correction response SLA. None is promised anywhere and none is measured.
3. Not "researched and written by hand". The AECI-299 seeding pass wrote machine-generated annotations into `attestations.note`; they reached production and are now suppressed at read (AECI-779). "Compiled from public sources and curated by AEC Integrations" is what the code supports.
4. **No ranking signals.** The rule (position is never for sale, and what a paid plan does affect) belongs here; the signals belong to §2 step 3's ranking-method page. Naming them before AECI-636 lands would publish `integration_count`, the signal that overhaul retires. `methodology.component.spec.ts` asserts the four current signal names are absent from the rendered page.
5. Not that a vendor plan affects only editing. It affects **four** things and the page lists all four: what a vendor may edit, whether it may confirm or dispute integration details (gated by `assertVerifiedVendor` on the `vendors.verified` mirror, which mirrors an active paid entitlement), whether the Verified badge shows, and **how far back version history goes on the public pair page**. That last one is `integration.version_diff`, and it is the only capability an anonymous reader can feel, so the page discloses it *and* its limits: the current state and the agreement or conflict state are always free and full-fidelity, only the historical comparison is gated, and it opens when **either** endpoint vendor holds a plan. Understating this would be the same failure as overstating verification. `methodology.component.spec.ts` pins both halves. Conversely the page must not claim `analytics.view` or `profile.rich_fields` do anything: those are declared with no consumer.
6. Not that the agreement ladder is an observed state. `single_source` / `confirmed` / `conflict` are shipped and unit-tested but unreachable until a vendor holds a verified account, and none does. The page states that plainly, and a spec assertion pins the qualifier so it cannot be silently dropped.

**The legal-page mismatch is disclosed, not papered over.** `/methodology` links to `/legal/listing-accuracy` and `/legal/review-guidelines` as the fuller statements, and both still open with "Draft, pending legal review. This document is not yet in force" (AECI-308 is the counsel gate; AECI-306 owns the outstanding entity and jurisdiction placeholders). A page whose first paragraph promises to describe how the site works today cannot hand the reader a policy that says it is not in force without saying so. The page therefore names the draft status in the same sentence as the links. **When counsel signs off and the banners come down, that sentence must come down with them** — it is a second owed edit alongside the one below.

**The edit that is owed when the vendor portal opens.** Point 6's "not yet open" paragraph, and the matching sentence about the verified-vendor badge, become false the day the first seat is granted. Stage 2.1's exit (`STAGE_2_1_SPEC.md` §5, vendors live) is the trigger; nothing in CI will catch it, which is why it is written down here.

### 7.2 Boundary with the other two surfaces that claim this content

Three planned surfaces overlap, and without a rule they duplicate:

- **`/methodology` is the single-page, citable editorial statement.** Top-level URL, indexable, in the sitemap. It answers "how does this directory work and why should I trust it" in one read. It is the canonical short answer.
- **The ranking-method page (§2 step 3)** carries the plain-language ranking parameters and their relative importance. `/methodology` states only the rule and links here once it exists.
- **AECI-634's `/docs/trust/*`** (`STAGE_2_PRODUCT_DOCS_SPEC.md` §5: `how-ranking-works`, `verification-and-the-badge`, `agreement-states`) carries task-level depth for vendors and readers. It links up to `/methodology` and does not absorb it. Rule of thumb: `/methodology` is what we assert, `/docs/trust/*` is how to act on it.

## 8. Exit criteria

- [ ] Ranking changes 1 + 2 live; replicas retired; `SEARCH_RANKING.md` §3/§5/§5a/§7 match deployed settings; ranking-method page published; blocked copy released.
- [ ] `curl` of `/products` + one page per taxonomy type on production returns product links and no error string (AECI-618 AC), locked by an e2e assertion.
- [ ] `POST /admin/purge` succeeds on every tier; GDPR erasure deletes or loudly fails; the reconcile sweep writes audit rows.
- [ ] Procurement category live; retract semantics shipped; the invariant guard can fire.
- [ ] The public-site screen-reader pass (AECI-244) logged; the four-doc de-stale sweep merged.
- [ ] `/methodology` live, indexable and in the sitemap, with every assertion on it traceable to shipped behaviour (§7.1).

## 9. Out of scope

Everything in `docs/STAGE_3_SPEC.md` — trust-ladder rungs 2/3, pSEO, stack-aware discovery, DX tail. Stage 2.5 admits **no new surface area**, with exactly one named exception: the `/methodology` page in §7, admitted under §1 test 4 and scoped to one page.

**Not out of scope, but not *in* Stage 2.5 either:** the Product Docs / Help Center (**AECI-634**) is **Stage 2 work** (`STAGE_2_SPEC.md` §2.6) that runs in the same calendar window — it was always sequenced after vendor-portal testing settles, and it must ship **before vendors are asked to do the work and pay**, because that ask has to come with support. Stage 2.5 neither blocks it nor absorbs it; the one touchpoint is §2 step 3 (the ranking-method page prefers the `/docs` trust section as its home).

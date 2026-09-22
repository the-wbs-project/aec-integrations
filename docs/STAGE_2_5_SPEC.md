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

1. **Product change 1** — `products` + `vendors` `customRanking` → `desc(listing_tier)`; compute `listing_tier` in `apps/api/src/lib/algolia-transforms.ts`; retire the two "Most integrations" replicas. Co-edit `packages/shared/src/algolia.ts`, `algolia.spec.ts`, and `docs/SEARCH_RANKING.md` §3.1/§3.2/§5/§5a in the same PR (the repo's lockstep rule). *Side benefit: retiring two replicas per env can relieve the exhausted Algolia index quota (24 used / 20 cap), but only after an operator deletes the detached indexes (see below).* **Built in two parts (plan on AECI-636, 2026-09-21).** Part A puts `listing_tier` on the records, with no ranking change. Each environment is then backfilled. Part B flips `customRanking`, retires the replicas and the D1 "Most integrations" list sort. Removing a replica in code only detaches it, so the quota relief needs an operator to delete the detached indexes, and it reaches 20 of 20, not below the cap.

   **✅ Built, both parts (AECI-636, 2026-09-22).** Part A shipped `listing_tier` on the records, and every environment was backfilled to full coverage on 2026-09-21 and 2026-09-22. Part B flipped `customRanking` and retired both replicas and the D1 list sort in code. One departure is ruled, not accidental. `products` keeps `desc(review_count)` as its second signal, by Chris's ruling of 2026-09-22 on AECI-636. That departs from the 2026-08-23 decision that reviews rank on a shrunk average and never on a raw count. It is inert today. `vendors` ranks on `desc(listing_tier)` alone. Nothing is on the quota yet. Six detached indexes still need deleting by hand, and preview's apply then lands the app at 20 of 20 (`SEARCH_RANKING.md` §5a). The rollout per environment is Chris's. The home-page "Most integrated product" and "Most active category" cards (D2) are deferred and unchanged. They must be decided before step 3 publishes.
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
| ~~**AECI-618**~~ | ~~Listing pages SSR an error string and zero product links on both public tiers.~~ **Closed 2026-09-11 as a duplicate of AECI-746, which shipped the fix.** Fix direction 1 is what landed: `apps/web/src/app/app.routes.ts` prefetches page 1 through the service binding during resolution. Locked by `apps/web/e2e/ssr-listing-crawlability.spec.ts` and by the deployed-tier probe `scripts/check-ssr-listings.sh`. **No longer Stage 2.5 work.** | — |
| **AECI-589** | Cache-purge secrets were never provisioned — `POST /admin/purge` 401s on **every** tier, plus false "not set" warnings on `DD_*`. The manual/incident purge surface is dead. | Medium |
| **AECI-531** | GDPR erasure: the `auth.users` delete is **silently skipped in production** with zero telemetry — the erasure flow reports success while leaving the auth record. | High |
| **AECI-591** | §26.1 violation: the `*/15` reconcile sweep mutates `vendor_requests` + `workflow_instances` with **no audit row** — the one standing exception to "failure to log is a transactional failure". | Medium |

## 4. Catalog integrity

| Issue | What it fixes | Priority |
|---|---|---|
| **AECI-559** | The category vocabulary has no Procurement / Materials Management entry — 40+ products have no correct home. A vocabulary addition with browse/SEO surface impact; do it before pSEO (Stage 3) multiplies the pages built on the taxonomy. | Medium |
| **AECI-595** | Promote has no retract semantics — deleting an upstream record always strands the live D1 row (the workaround was the manual `ops:retract-product` script; superseded — see below). **Sized by AECI-767 on 2026-09-07**: the whole production tail was **0 stranded products, 1 vendor, 6 integration edges** (7 claims + 7 attestations in cascade), all seven publicly reachable and in search. A cleanup, not a trust problem — and five of the seven were **already-filed items that were never executed**, so the binding constraint was the retraction backlog, not the missing feature. **That backlog is now fully drained: re-measured 2026-09-08 the tail is ZERO** — every bucket empty, 0 publicly reachable rows, and the sweep exits 0 for the first time (AECI-593, AECI-794 and AECI-795 all executed, the Bluebeam lane closed). **AECI-595 itself is now Done** — it closed 2026-09-07 on the *upstream* side shipping (review-repo PR #93). **AECI-795 is the row that argues hardest for the consumer**: it is the one of the seven whose deletion was recorded *nowhere* — not upstream, not here — so it was retracted on an operator ruling taken after escalating, rather than on a note. The review app now exposes `list_retractions` (the feed: `supabaseId`, curator `reason`, `carrierProductIds`, `since` cursor) and `confirm_retractions` (the ack). **The consumer shipped 2026-09-13 as AECI-882** (`scripts/ops/2026-09-retraction-consumer/`), and the sentence this row used to carry — that the feed was empty because it journals forward only — was overtaken within two days of being written. Between 09-10 and 09-12 the journal filled with **216 pending entries**, and **215 of them resolved to `connector_evidenced_pairs`, not `integrations`** — the table the daily sweep excludes by design, so the sweep read green on all 215 while they were live on the public site. The consumer deleted and confirmed **214** on 2026-09-13 and held **2** Agave pairs carrying 21 claims for **AECI-891** — **ruled 2026-09-13**: a claim may anchor to a *reached* pair and AECi carries it, rather than translating it onto the delivered tier (`DATABASE_SCHEMA.md` §5a.1, `REVIEW_APP_PROMOTE_API.md` §3a). **Both holds were released 2026-09-14 (AECI-909)** once AECI-891 was live in production and AECI-910 had re-anchored all 21 claims onto the reach tier, so all 216 entries are now executed and confirmed and the feed is empty. The daily job gained a `pendingRetractions` bucket so this class is never again invisible to it. Two lessons outlived the run: a single-table consumer would have *confirmed* the 215 it could not see, which is the one unrecoverable direction; and `ops:retract-product` is no longer the workaround for an integration, because it cannot touch the pairs table at all. Evidence: `scripts/ops/2026-09-stranded-row-audit/README.md`, `scripts/ops/2026-09-procore-followup-retraction/README.md`, `scripts/ops/2026-09-dynamics-monday-retraction/README.md`, `docs/REVIEW_APP_PROMOTE_API.md` §5.1. | Medium |
| **AECI-592** | ~~Data-quality check #2 (`ready_products_unpromoted`) is unreachable; replace with a promotion-status invariant guard that can actually fire.~~ **Done 2026-09-13.** Shipped as `promotion_status_invariant` (severity `error`, both `products` and `vendors`). It also retired a second dead check the issue had not spotted — `broken_integration_refs` filtered for `retracted`/`rejected` endpoints, which nothing writes either — so the suite went from twelve checks to eleven. | Medium |

## 5. Stage 2 close-out debt

Two items moved forward to Stage 2.1 on 2026-08-31 (both are vendor-portal polish and gate seat-granting): **AECI-623** (capability convergence) and **AECI-633** (the vendor-portal screen-reader pass) — see `STAGE_2_1_SPEC.md` §3.3. What remains here:

| Issue | What it closes | Priority |
|---|---|---|
| **AECI-244** | The outstanding **manual screen-reader pass** over the public site (the Stage-1 Phase 7.10 pass that never ran), per `docs/a11y-manual-testing-checklist.md` and logged. May be run in the same sitting as AECI-633 (Stage 2.1) if calendars align — the former pairing was a scheduling convenience, not a dependency. **Partly discharged 2026-09-09** by a tool-assisted public-site pass against production `44aba9cf` → `docs/ACCESSIBILITY_AUDIT.md`: the keyboard layer is clean, and it found **three serious WCAG 4.1.3 (AA) status-message failures** plus seven lesser items, now filed. **What remains here** is only the part a browser cannot do: the **VoiceOver and NVDA speech layer**, scripted in checklist §6/§7 — about ten minutes per screen reader, then a dated §4 run-log entry. **Everything else moved to Stage 3 on 2026-09-09 by operator decision** (AECI-829 the 4.1.3 class, AECI-830 links/landmarks, AECI-831 the minor set, AECI-832 the local-seeded run that covers dialog focus management, the review-form `Tab` walk and the mobile viewport). Those four are defect and coverage work, not this interlude's punch list. | Medium |

## 6. Docs & process de-stale sweep

Per the standing review finding — most code-review noise is stale docs. One focused sweep: **AECI-598** (de-stale `STAGE_1_SPEC.md` — §26 audit, the RLS self-contradiction, the §1a companion index; High), **AECI-599** (purge the remaining `appendAuditLog()` references), **AECI-600** (duplicate ADR number 0010 + CICD_PLAN's dark-theme a11y claim), **AECI-601** (Spec-section line missing on 40% of recent issues; `ADMIN_PANEL_SPEC.md` invisible from `stage-2`). *Optional rider:* AECI-620 (slim root `CLAUDE.md`, nested per-app files) — admit only if the sweep has room; otherwise Stage 3.

## 7. Public trust and answer-surface artifacts

The surfaces that describe AECi to a careful reader, a search quality rater, or an answer engine. Tracked under the **AECI-788** epic (SEO and AI-answer-surface visibility), whose own "Doc debt" note asks for exactly this section: *"add a section covering the head/structured-data contract and the AI-surface routes to `docs/STAGE_2_5_SPEC.md`"*. That debt was recorded on the issue, never in this file, until AECI-804 closed.

**This is the first of §9's two admitted exceptions to "no new surface area"** (the second is the vendor Performance page, §10). It is admitted under §1 test 4 (overdue quality gate), not test 2: nothing is blocked on it, but the process it documents is the product's strongest differentiator and shipping a directory that never states its own editorial standard is a gap, not a feature request. The exception is **one page**. Any further public surface is Stage 3 or AECI-634, not this section.

| Issue | What it adds | Priority |
|---|---|---|
| **AECI-804** | `/methodology` — the editorial methodology page. **Shipped.** See the contract below. | Medium |
| **AECI-784** | The site-wide `@id`-linked JSON-LD entity graph. Owns every structured-data decision; `/methodology` deliberately emits none. Blocked by **AECI-805** (social profiles), or `sameAs` ships empty. | High |
| **AECI-785 / AECI-787** | `llms.txt` and an RSS/Atom feed. Both new SSR routes, both needing a cache-tag decision. 785 is downgraded to Low on the epic (no provider commits to reading it); ship a static route or decline it, but do not build a generator. | Low |
| **AECI-802** | Entity titles and meta descriptions carrying search intent. **Shipped 2026-09-09**, after AECI-799 landed the dated Search Console baseline the epic's measurement-before-change rule required. Contract: `STAGE_1_PHASE_2_SPEC.md` §9.1 (title templates + the four-rung description ladder). Its trust line is constrained by §7.1 below: the snippet must not claim verification while no vendor holds a seat, and it becomes revisable on the day the first one does. | High |
| **AECI-803** | Paginated listings self-canonicalise instead of every page claiming to be page 1. Five routes, `page` the only allowlisted canonical param. Contract: `STAGE_1_PHASE_2_SPEC.md` §9.1a. Not blocked by AECI-799 — it fixes a documented anti-pattern rather than tuning copy, so the measurement-before-change rule does not bite. | Low |

### 7.1 `/methodology` — the build contract (AECI-804, shipped)

One page at `/methodology`, linked from the footer's Company column and from `/about`. Static, indexable, cacheable on the `/about` static-page TTL (24 hr edge / 1 hr browser, `Cache-Tag: route:index`, no resilience pair, no `cacheKeyParams`), and **in `sitemap.xml`** — the first non-legal static page listed there, deliberately, because being found and cited is the page's whole purpose.

Built as **build-time-inlined Markdown**, generalizing the AECI-237 legal pattern rather than an inline template: `apps/web/src/content/methodology.md` → `methodology/methodology-content.ts` → `MethodologyPage`. The body is content and is not extracted into `messages.xlf`; the page chrome is `$localize`-wrapped as usual. The shared prose class was renamed `.legal-prose` → **`.aec-prose`** in the same change, since it now styles two page families and AECI-634 will make it three.

**The governing rule is that the page assembles, never invents.** Every assertion maps to shipped behaviour. Six things it must therefore not say, each of which was true of an earlier draft of one surface or another:

1. No accuracy or completeness warranty. `/legal/listing-accuracy` disclaims it and the two must not diverge.
2. No correction response SLA. None is promised anywhere and none is measured.
3. Not "researched and written by hand". The AECI-299 seeding pass wrote machine-generated annotations into `attestations.note`; they reached production and are now suppressed at read (AECI-779). "Compiled from public sources and curated by AEC Integrations" is what the code supports.
4. **No ranking signals.** The rule (position is never for sale, and what a paid plan does affect) belongs here; the signals belong to §2 step 3's ranking-method page. Naming them before AECI-636 lands would publish `integration_count`, the signal that overhaul retires. `methodology.component.spec.ts` asserts the four current signal names are absent from the rendered page.
5. Not that a vendor plan affects only editing. It affects **four** things and the page lists all four: what a vendor may edit, whether it may confirm or dispute integration details (gated by `assertVerifiedVendor` on the legacy `vendors.verified` mirror, which mirrors an active paid entitlement), whether the public account label shows, and **how far back version history goes on the public pair page**. That last one is `integration.version_diff`, and it is the only capability an anonymous reader can feel, so the page discloses it *and* its limits: the current state and the agreement or conflict state are always free and full-fidelity, only the historical comparison is gated, and it opens when **either** endpoint vendor holds a plan. Understating this would misstate the plan. `methodology.component.spec.ts` pins both halves. Conversely the page must not claim `analytics.view` or `profile.rich_fields` do anything: those are declared with no consumer.
6. Not that the agreement ladder is an observed state. `single_source` / `confirmed` / `conflict` are shipped and unit-tested but unreachable until a vendor has active account access, and none does. The page states that plainly, and a spec assertion pins the qualifier so it cannot be silently dropped.

**The legal-page mismatch is disclosed, not papered over.** `/methodology` links to `/legal/listing-accuracy` and `/legal/review-guidelines` as the fuller statements, and both still open with "Draft, pending legal review. This document is not yet in force" (AECI-308 is the counsel gate; AECI-306 owns the outstanding entity and jurisdiction placeholders). A page whose first paragraph promises to describe how the site works today cannot hand the reader a policy that says it is not in force without saying so. The page therefore names the draft status in the same sentence as the links. **When counsel signs off and the banners come down, that sentence must come down with them** — it is a second owed edit alongside the one below.

**The edit that is owed when the vendor portal opens.** Point 6's "not yet open" paragraph, and the matching sentence about the verified-vendor badge, become false the day the first seat is granted. Stage 2.1's exit (`STAGE_2_1_SPEC.md` §5, vendors live) is the trigger; nothing in CI will catch it, which is why it is written down here. **A third edit joined the list with AECI-802 (2026-09-09)** and it is not on this page: `@@meta.trustLine` in `apps/web/src/app/core/meta-copy.ts` reads "Independent data, compiled and curated by AEC Integrations." on every product and vendor page precisely because point 6 is true today. It is deliberately understated, so it does not become *wrong* when a seat is granted — but it does become worth revisiting, and a resolver spec asserts the string carries no "verified" claim, so a future change has to be made on purpose.

**A fourth owed edit joined the list with AECI-1005 (2026-09-21): integrations are vendor-owned now (ADR 0035).** Three sentences of `methodology.md` describe a catalogue AECi authors end to end, and they become partial the day an owner claims its first integration. "Catalogue data is compiled from publicly available sources … We curate that material" stays true of AECi's seed and stops being true of a claimed row, which promote no longer writes and whose owner edits it from AECI-1006 on. "Vendor-maintained means the company itself edited that record" reads slightly wrong for a row that was claimed but not yet edited, because a claim sets `maintained_by = 'vendor'` and stamps the date (§13.9 of `STAGE_2_ATTESTATIONS_SPEC.md`) without changing any words on the page. And the list of what a paid plan affects is unchanged, deliberately: claiming, owner edits and contests are seat-gated, not plan-gated (AECI-1003 decision 15), so they must NOT be added to it. The copy belongs to **AECI-1023**, which ships the reader- and vendor-facing wording from 1005 onward. The trigger is the first claim in production, and nothing in CI will catch it. **Discharged by AECI-1023 (2026-09-22):** the page gained a "Who owns an integration" section (owner = the "Offered by" vendor, claim with no approval, AECi's updates stop at the claim, contest routing with the `owner` field always to AECi, an open contest is invisible to readers, retire is not delete, vendor-created rows, connector-delivered rows closed to every vendor write), the "Vendor-maintained" bullet now says what the marker means on an integration and that it is not ownership, "Nothing reaches the public catalogue on its own" became "Nothing we research …", and point 6's paragraph now reads "Vendor accounts opened in September 2026, so most claims and integrations are still recorded by AEC Integrations". That last wording is the one that must be revisited when seats are granted at scale. The reader-correction sentence now says we share a correction with the owner, who decides whether to change it. `methodology.component.spec.ts` pins each sentence, and the plan list is still exactly four items.

### 7.2 Boundary with the other two surfaces that claim this content

Three planned surfaces overlap, and without a rule they duplicate:

- **`/methodology` is the single-page, citable editorial statement.** Top-level URL, indexable, in the sitemap. It answers "how does this directory work and why should I trust it" in one read. It is the canonical short answer.
- **The ranking-method page (§2 step 3)** carries the plain-language ranking parameters and their relative importance. `/methodology` states only the rule and links here once it exists.
- **AECI-634's `/docs/trust/*`** (`STAGE_2_PRODUCT_DOCS_SPEC.md` §5: `how-ranking-works`, `verification-and-the-badge`, `agreement-states`) carries task-level depth for vendors and readers. It links up to `/methodology` and does not absorb it. Rule of thumb: `/methodology` is what we assert, `/docs/trust/*` is how to act on it.

## 8. Exit criteria

- [ ] Ranking changes 1 + 2 live; replicas retired; `SEARCH_RANKING.md` §3/§5/§5a/§7 match deployed settings; ranking-method page published; blocked copy released.
- [x] `curl` of `/products` + one page per taxonomy type on production returns product links and no error string, locked by an e2e assertion. **Met by AECI-746** (`apps/web/e2e/ssr-listing-crawlability.spec.ts` + `scripts/check-ssr-listings.sh`); AECI-618 closed as its duplicate 2026-09-11.
- [ ] `POST /admin/purge` succeeds on every tier; GDPR erasure deletes or loudly fails; the reconcile sweep writes audit rows.
- [ ] Procurement category live (AECI-559). ~~Retract semantics shipped~~ **done** — the upstream half closed as AECI-595 and the AECi consumer shipped as AECI-882. All 216 pending retractions are executed and confirmed — 214 on 2026-09-13, and the 2 held for AECI-891 on 2026-09-14 (AECI-909), once the 21 claims they carried had been re-anchored to the reach tier. ~~The invariant guard can fire~~ **done** (AECI-592).
- [ ] The public-site screen-reader pass (AECI-244) logged — **the machine half is done** (`docs/ACCESSIBILITY_AUDIT.md`, 2026-09-09); what gates this box is the VoiceOver/NVDA run and its §4 run-log entry. The defects it found are **Stage 3** (AECI-829…832), so they do not gate 2.5. The four-doc de-stale sweep merged.
- [ ] `/methodology` live, indexable and in the sitemap, with every assertion on it traceable to shipped behaviour (§7.1).
- [ ] The vendor Performance page live for vendors with active analytics access, its measurement foundation (AECI-930) and search-console channel (AECI-931) shipped, and the privacy-policy sentence published in the same release as the page (§10, `VENDOR_PERFORMANCE_SPEC.md`).

## 9. Out of scope

Everything in `docs/STAGE_3_SPEC.md` — trust-ladder rungs 2/3, pSEO, stack-aware discovery, DX tail. Stage 2.5 admits **no new surface area**, with exactly three named exceptions: the `/methodology` page in §7, admitted under §1 test 4 and scoped to one page; and the vendor Performance page in §10, admitted 2026-09-14 by operator decision and scoped to one portal section plus its measurement foundation; and the logo controls in §11, admitted 2026-09-15 under AECI-955.

**Not out of scope, but not *in* Stage 2.5 either:** the Product Docs / Help Center (**AECI-634**) is **Stage 2 work** (`STAGE_2_SPEC.md` §2.6) that runs in the same calendar window — it was always sequenced after vendor-portal testing settles, and it must ship **before vendors are asked to do the work and pay**, because that ask has to come with support. Stage 2.5 neither blocks it nor absorbs it; the one touchpoint is §2 step 3 (the ranking-method page prefers the `/docs` trust section as its home).

---

## 10. Vendor performance reporting (admitted 2026-09-14)

**This is the second admitted exception to §9's "no new surface area".** It is admitted by operator decision rather than under one of the four §1 tests, and the reasoning is recorded so the firewall stays legible: `STAGE_2_SPEC.md` §8.1(3) lists vendor analytics as a Verified benefit, the `analytics.view` capability has been declared with no consumer since AECI-610, and the paid pitch to the first vendors needs the benefit to exist. The exception is **one portal section** (`/vendor/:vendorSlug/performance`) plus the measurement changes it depends on, which are operator-facing and would pass §1 test 3 on their own. Anything comparative (share of catalogue, category percentile), any emailed report, and any enquiry or outcome layer stays out — `STAGE_3_SPEC.md` §4 records the first two.

The build contract is **`docs/VENDOR_PERFORMANCE_SPEC.md`**; its §1.1 records the nine decisions settled on 2026-09-14 and its §1.2 maps the three epics. The rationale and the 2026-09-14 repository verification that shaped the contract are in `docs/design/vendor-performance-direction.md`, which stays a discovery record.

| Epic | Scope | Gate |
|---|---|---|
| A — Measurement foundation (**AECI-930**) | Pair-page attribution on `page_views` (AECI-929, High), outbound-click ownership, vendor self-visit exclusion, the consented pair-page view event | Blocks C. |
| B — Search-console channel (**AECI-931**) | Per-URL Google Search Console and Bing Webmaster data for every catalogue page, own storage, host-filtered | Independent of C; the page renders "not connected" without it. |
| C — The page (**AECI-932**) | Wireframes via Mobbin first, then the read endpoint with its caveat envelope and CSV export, then the page, then the privacy-policy sentence and the `/methodology` update in the same release | Blocked by A. |

Two rules carried from the contract, restated here because they are the ones a later editor is most likely to bend: the page reads the **same population definition** as the digest and `/admin/overview` (the AECI-872 classification record once agreed; the shared predicates until then) and adds no predicate of its own; and it is a **read**, outside the AECI-516 freshness cursor, with no audit row and no rate limit.

The admitted metric has a **second placement**: the Views tile on the vendor overview (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.10). It shipped in Stage 2.1 with AECI-983 as a placeholder with no figure and no server read, and AECI-941 wires it under the same gate (`VENDOR_PERFORMANCE_SPEC.md` §5.6). It is not a third surface exception.

## 11. Vendor and product logos (AECI-955)

The third admitted surface exception (the fourth is §12) adds logo editing to the vendor portal and the admin vendor detail and product roster. It permits only logo content writes in the admin panel. ADR 0032 records the validation decision.

### 11.1 Upload and serving contract

- `POST /api/vendor/logo` requires a vendor seat and `profile.edit` or `product.edit`. `POST /api/admin/logo` requires an admin. Both use the authenticated write limiter and a **new** same-origin check (`requireLogoOrigin`, `apps/api/src/routes/logos.ts`). It is new because the rest of the API leans on its JSON content type for CSRF: a cross-origin `<form>` can post `multipart/form-data` with no preflight, but it cannot post `application/json`. A request with no `Origin` header must carry a `Bearer` token instead.
- Accept exactly one multipart field named `file`. Cap the complete request at 2 MiB + 16 KiB before multipart parsing, even without Content-Length. Cap the file at 2 MiB and each dimension at 2048 pixels. PNG, JPEG and static WebP only. Reject SVG, animated images, malformed structures, truncated files and trailing bytes. Determine format from bytes, never MIME or filename. Validation checks container structure, not full pixel decoding.
- Store original bytes under their lowercase SHA-256 key using `UPLOADS`. Return `{logo_url: "/api/logos/<64 hex characters>"}`. Neither upload endpoint writes D1. An upload is not a catalog edit until a parent form saves.
- `GET /api/logos/:key` is public and not rate-limited. Strictly validate the key. Derive a fixed image Content-Type from validated bytes, never object metadata. Return `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and `Cache-Control: public, max-age=31536000, immutable`. Missing/invalid objects are non-cacheable errors. The SSR API proxy must preserve these headers.
- URLs accept HTTPS addresses or exact `/api/logos/<hash>` paths, plus null for removal. The server never fetches external URLs. Existing stored URLs remain readable. Local paths must identify an existing validated object before being saved. As built, the admin logo handler and both vendor profile/product PATCH handlers call the shared `assertStoredLogo` guard before constructing the write batch; a missing, oversized or invalid object returns `400 VALIDATION_FAILED` and no catalog or audit row is written.
- `GET /api/logos/:key` re-reads R2 and re-validates on every request, because the served `Content-Type` comes from the bytes and never from object metadata. Cloudflare does not edge-cache extensionless paths by default, so `immutable` buys browser caching only until a Cache Rule is added. `CACHE_STRATEGY.md` "Logo assets" holds that operator item.
- Bind one private bucket per environment, `aeci-uploads-{preview,staging,demo,production}`, in all five Wrangler blocks. Root uses preview. Public access is through the API Worker only. No automatic expiry: a content-addressed object may be shared by many records. Unreferenced uploads may remain and require a future reference-aware cleanup job.

### 11.2 Catalog writes and promote coexistence

Both `vendors` and `products` gain nullable `logo_source`: null means promote-owned, `vendor` or `admin` means locally managed. Existing rows start null. A logo field explicitly supplied through a vendor save sets source vendor, including clearing to null. Omission leaves both columns unchanged. Admin `PATCH /api/admin/vendors/:id/logo` and `PATCH /api/admin/products/:id/logo` accept exactly `{logo_url}` and set source admin. These are logo-only exceptions to ADMIN_PANEL_SPEC §2 and the paid-tier catalog lockout.

The logo, provenance and updated_at write share one Drizzle batch with the ordinary vendor.updated/product.updated audit row, carrying before/after state and actor. Post-commit cache purges cover vendor:{slug}, or product:{slug} and index:products. Vendor ownership and capability checks remain unchanged. Product timestamps feed the existing nightly Algolia sync. Logo edits do not request search-engine recrawls.

Promote tests logo_source inside the SQL UPDATE so a local edit between planning and committing is preserved. It never writes logo_source. Clearing a logo stays protected. No reset-to-promote control is introduced.

### 11.3 Shared control and validation

`aec-logo-input` combines URL entry, file selection and drag/drop, preview, remove, pending feedback and localized errors. Its editable presentation has two modes: HTTPS values use the URL field and upload picker, while an uploaded `/api/logos/<hash>` draft shows the preview, a localized "Uploaded image" label and the Remove action without rendering the opaque path in an editable field. Removal returns the control to URL/upload mode. Keyboard users use the native file picker. Read-only users can read/copy the value; an uploaded path is labeled as an uploaded-image reference and stays `readonly`. Upload completion changes only the draft. Parent Save is unavailable while upload is pending; switching value or destroying the control cancels stale completion. Failed uploads keep the previous value. Form saves remain pessimistic.

Validation includes adversarial format/size/dimension/trailing-data tests, multipart cardinality and bounded-body tests, authenticated upload and object-serving tests, ownership and promote fencing tests, and component interaction tests. Typecheck, lint and Angular build must pass before handoff.

## 12. Vendors author "How teams use it" (AECI-963)

The fourth admitted surface exception, and the one that needs its admission stated out loud rather than assumed.

**This is a new feature, and §1's admission test does not cover it.** It is not a live defect, not the sequenced ranking change, not integrity debt, and not an overdue quality gate. The status line at the top of this document says "Nothing here is a new feature". It enters the same way §7, §10 and §11 entered: as a named exception, decided by the operator on 2026-09-16 rather than inferred. If a later reader is looking for the rule that admitted it, this paragraph is the rule.

The prompt was an operator request on 2026-09-15 for a way to manage "How Teams Use It" copy. `products.usefulness` renders as its own section on every product detail page and is write-only through promote, so nobody could change a word of it without a re-promote from the review app.

### 12.1 What the vendor gets

A "How teams use it" pair of cards on the vendor product form, one per facet (by audience, by phase), each reading what is published and opening a modal to write it. **Since AECI-994 the cards and the modal are gone:** the points are written directly under each ticked term on the vendor portal's Audiences and Phases tabs, as a bullet list with add, remove and reorder (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.12). A group ties one taxonomy term to one to eight short bullets. Saving publishes to the live product page immediately.

Three decisions taken deliberately, all of which a later reader may want to revisit and none of which are accidents:

- **No moderation.** A vendor edit publishes on save. The alternative — a draft state and an admin queue — was priced and declined for now. The honesty cost is real and is paid in copy: the editor says the text publishes immediately with no review, because there is no queue and no "vendor supplied" label on the public page to carry that fact instead.
- **No "vendor supplied" label on the product page.** Considered and not taken. Revisit it if the section starts reading as marketing rather than description; that is the trigger, not a schedule.
- **No admin editor.** The operator's own route in is the vendor portal, which is dark until seats are granted. This ships inert and goes live when pilot vendors are seated. Adding an admin editor later needs no migration: `usefulness_source` already accepts `'admin'`.

### 12.2 Ownership, and the fence

`products` gains nullable `usefulness_source` (`vendor` | `admin`; migration `0042_wide_the_hunter.sql`, one bare `ALTER TABLE … ADD COLUMN`). Null means promote-owned. This is §11.2's `logo_source` mechanism applied to narrative copy, and it behaves identically: promote tests the column **inside** the SQL UPDATE rather than from a planning read, so a vendor save landing between the plan and the commit is still preserved; promote never writes the provenance column; and an explicit clear claims ownership too, because a clear that did not would be undone by the next promote.

One thing differs from §11, deliberately. **Promote reports the refusal** as a `preserved[]` entry (`kind: 'usefulness'`, `ref` = the product's). The logo fence is silent, which is tolerable for a URL and is not tolerable here: without a receipt an upstream curator keeps writing narrative copy that no longer ships and is never told. The entry is advisory and one-sided — it can be missing for a value that was in fact preserved, and can never be present for one that was not, because nothing clears `usefulness_source`. `REVIEW_APP_PROMOTE_API.md` §4 states that asymmetry for the review app.

The receipt is also **rarer than it looks**. A vendor can only author the block while it holds a portal seat, and AECI-520's claimed-vendor block already skips that vendor's products wholesale — so during normal operation promote never reaches the usefulness fence and the review app sees `skipped[] { kind: 'product' }` instead. The fence and its receipt are what cover the window after a seat is banned or revoked, when the product becomes promote-writable again but the vendor's copy is still published.

The transition is **one-way by design**, matching §11's "no reset-to-promote control". Once a vendor writes the block, the review app's copy is dead for that product.

This reverses a shipped ownership decision recorded in two places, both corrected in the same change: `packages/shared/src/api/vendor.ts`'s allow-list doc, and `API_CONTRACTS.md` §6.14's list of AECi-owned columns. ADR 0033 records why the ownership moved.

### 12.3 Contract and validation

`PATCH /api/vendor/products/:id` accepts `usefulness` as a full replacement, `null` to clear, absent to leave alone. It is gated on a new **`product.usefulness.edit`** capability — the first `PRODUCT_COLUMN_MAP` entry whose capability is not `product.edit`, which is what makes the entitlement axis separately observable at all. Inert at launch under the binary ladder.

The wire shape carries `slug` and `points` and **no `name`**. The stored shape has one, and the public page interpolates it verbatim, so a vendor-supplied name would be free text in a slot readers parse as an AECi taxonomy label. The server resolves it from the taxonomy row on every write.

Resolution is find-only, and an unknown slug is a **400**, not promote's silent drop. The reason the two differ: promote is a bulk machine push that must not fail whole over one stale term and has a `skipped[]` receipt a human reads, while a vendor picked the term from a list this API rendered and has no receipt channel — and the form re-seeds its baseline from the PATCH echo, so a dropped group would settle the form clean on content that never reached the database. Two groups resolving to the same term merge, matching promote, so both writers agree on the stored shape. `{ audiences: [], phases: [] }` normalises to `null`, so "cleared" has one encoding.

Caps: ten groups per facet (matching the taxonomy facets' own cap), eight points per group (matching the review app's), two hundred characters per point. They bound the audit row, which carries the block in both before and after state.

Two rules the editor keeps because the caps are newer than the data. Promote enforces none of them, so an already-promoted block can exceed any of the three: the editor therefore validates only a value it is actually **sending**, never the untouched server copy, or one over-long promoted point would lock the Save button with nothing to fix. And the editor lists the vocabulary **plus any stored term the vocabulary does not know**, labelled with its slug, because `/api/taxonomy` is a cached snapshot while promote can mint a term and write a group for it in the same window — a vocabulary-only list would delete that group on save with nothing shown. (Since AECI-994 the editor is `vendor-product-facet-editor.ts` on the Audiences and Phases tabs.)

The editor stages into a dirty-diff rather than persisting on close, because a staged edit is protected by `VendorPortalStore.markDirty` and the "changed somewhere else" banner. Since AECI-994 the tags and the points for a facet share that one draft and one Save, and the same PATCH carries both (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.12).

`MATERIAL_PRODUCT_FIELDS` gains `usefulness`, so an edit files as `product.updated` and not `product.minor` in the ADR 0031 Google re-crawl worklist. Cache purging is unchanged (`product:{slug}` already covers the detail page) and Algolia needs nothing, since `usefulness` is not an indexed attribute.

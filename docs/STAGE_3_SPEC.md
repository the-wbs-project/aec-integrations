# AEC Integrations — Stage 3 Specification (Scope Outline)

**Version:** 0.1 — **scope outline, not a build contract**
**Date:** August 2026
**Status:** Kickoff draft (2026-08-24 planning session). This is the Stage 3 equivalent of `STAGE_2_SPEC.md` at its v0.1 — the pillars, the backlog triage, and the open decisions. It is **not** decomposed into buildable issues; each pillar grows its own companion spec before build (as every Stage 2 pillar did).
**Inherits from:** Stage 1 (`STAGE_1_SPEC.md`), Stage 1.5 (`STAGE_1_5_SPEC.md`), Stage 2 (`STAGE_2_SPEC.md` + its five build/scope companion docs), Stage 2.1 (`docs/STAGE_2_1_SPEC.md`), and Stage 2.5 (`docs/STAGE_2_5_SPEC.md`).
**Supersedes:** the scattered "Stage 3" forward references — `STAGE_2_SPEC.md` §9's "trust scoring beyond basic anti-abuse (Stage 3)" and `STAGE_1_SPEC.md`'s review-translation note (§ Phase 5, "Stage 3+").

> **Preconditions.** Stage 3 opens when (a) `stage-2 → main` has merged and deployed (the Stage 2 ship gate — a **dark launch**: vendor surfaces live but no seats granted; **the merge landed 2026-09-03; "and deployed" still means a prod promote**) — **including the Product Docs / Help Center (AECI-634)**, which is Stage 2 work sequenced last (after portal testing settles) precisely because vendors being asked to do the work and pay must be supportable through it — (b) the Stage 2.1 exit criteria (`STAGE_2_1_SPEC.md` §5, added 2026-08-31) are green — vendors actually seated and live — and (c) the Stage 2.5 exit criteria (`STAGE_2_5_SPEC.md` §8) are green — in particular the search-ranking overhaul, because two Stage 3 pillars (trust ladder, pSEO) build directly on `evidence_tier` and the published ranking mechanism.

---

## 1. Overview

Stage 1: the public reads. Stage 1.5: the integration spine. Stage 2: **the vendors log in** (claim → verify → attest → pay). Stage 3 is where **the platform earns trust at scale and gets found**: the roadmap's long-named "trust scoring beyond basic anti-abuse" becomes the verification ladder, and the search-intent growth play (pSEO) makes AECi the answer to "does X integrate with Y".

The through-line is the AECI-636 ranking decision: Stage 2.5 ships the *mechanism* (gate + depth + scoping); Stage 3 ships the *ladder above it* — the evidence rungs that only human verification and dual-vendor attestation can grant — and then multiplies the surfaces (pair-page orientations, "meaningful no" pages) that the mechanism makes safe to publish.

**Trust invariants carry unchanged and non-negotiable:** no pay-for-placement; money never touches eligibility, completeness, accuracy, or queue order; one-sided states are visibly labeled; no numeric trust score is rendered anywhere; corrections free for anyone, forever.

## 2. Scope pillars

### 2.1 Trust & Verification Ladder — *the anchor*

The Stage 3 realization of "trust scoring beyond basic anti-abuse." Not a score — a **ladder of labeled evidence states**, extending the Stage 2.5 `evidence_tier`:

- **Rung 2 — AECi-verified.** Formalize today's `source='aeci'` attestations into a verification workflow: an entry checked against public docs gets `evidence_tier: 2`, a visible "Verified by AECi against public documentation" state, and a `last_reviewed_at` stamp (the AECI-616 plumbing already exists).
- **Rung 3 — dual-vendor attested.** The original product thesis. Both vendors' live attestations agree (`computeAgreement` → `confirmed`, which since AECI-605 requires two **distinct** vendor identities) → `evidence_tier: 3`. Dormant until vendor adoption produces second attesters; the rung ships with a "0 today" expectation and lights up organically.
- **Demand-ordered verification queue.** Engagement data (most-searched pairs first) orders **the queue only** — its one permitted use under AECI-636. "No known limits" attestations jump to verification priority.
- **Review trust, when volume arrives.** The AECI-636 rule pre-decided: 5+ reviews (the API's existing threshold) ranking on an average shrunk toward the catalog mean, never count. Plus **AECI-281** — refine the review-moderation workflow after the first real reviews.
- **Anti-gaming instrumentation.** Detection for gate-stuffing (five trivial-but-true entries), attestation churn, and correction abuse — the private anti-abuse layer the published mechanism explicitly reserves.

### 2.2 Search-Intent Growth (pSEO)

Adopt the existing **"Pair-Page Search Intent (pSEO)" Linear project wholesale** as this pillar — its spec is already written (`STAGE_1_5_SPEC.md` §11, Addendum A) and its five issues are already phased:

- **AECI-340** dual-orientation indexable pair pages (per-orientation canonical + direction-framed content)
- **AECI-341** context-specific suggestions module (taxonomy-driven, algorithmic)
- **AECI-342** "meaningful no" pages — scoring, template, tiered indexing
- **AECI-343** per-pair "report a missing integration" CTA → requests pipeline
- **AECI-344** GSC measurement loop (dual-orientation gate + quarterly tier review)

Sequenced **after** the ranking-method page is live (2.5 §2 step 3) so the published mechanism matches what pair pages exhibit, and after AECI-618 (2.5 §3) so the pages being multiplied actually server-render their content. **AECI-560** (sitemap index / sub-sitemap split) attaches here as the gated companion — dual-orientation + meaningful-no indexing is precisely what could push URL counts toward its 50k trigger.

### 2.3 Stack-aware discovery — *candidate, decision required*

The AECI-636 long-term direction: "tools that connect to what I already run" beats any global score and is unfarmable. Requires a signed-in reader's **stack profile** (a new surface for an audience that today only writes reviews) and a ranking/suggestion path scoped to it. **Not committed** — see §5(3). If deferred, it becomes the Stage 4 anchor candidate.

> **Product Docs / Help Center is *not* a Stage 3 pillar.** AECI-634 stays Stage 2 work (`STAGE_2_SPEC.md` §2.6): its sequencing rule defers it until vendor-portal testing settles, but it ships **within Stage 2** — vendors being told "do this work, pay this fee" must be supportable through the process from day one. Stage 3 inherits the `/docs` surface as an existing home for new trust content, not as work to do.

### 2.4 Platform & DX tail

The non-feature backlog that fits Stage 3's operating posture, batched loosely: **AECI-533** (drop the 19 review-app-only D1 columns), **AECI-590** (reverse-proxy PostHog through our own domain), **AECI-597** (hardcoded-color-literal lint rule), **AECI-602** (plan check → CI sticky comment, once the FP rate is known), **AECI-555** (re-evaluate Cloudflare CI on Workflows at Artifacts GA — spike, trigger-gated), **AECI-620** (slim CLAUDE.md; if not taken as the 2.5 rider), **AECI-621** (spec-grill skill — *useful for authoring the Stage 3 companion specs themselves; consider building it first*). The **AECI-637 temp-env decision** that used to sit on this list is **resolved and off it**: `stage-2` merged into `main` on 2026-09-03, so the `stage2` mirror lost the branch it mirrored, and it was torn down under **AECI-808** rather than being carried through Stage 2.1 and 2.5.

### 2.5 Accessibility remediation (added 2026-09-09)

**Not in the original outline** — added when the AECI-244 public-site pass finally ran and produced
findings that needed a home. Operator decision routed them here rather than to Stage 2.5 §5, where the
triage table in §3 below had scoped the AECI-244 close-out. That divergence is recorded in both documents
and in each issue, so it does not later read as a filing error.

Evidence for all four: **`docs/ACCESSIBILITY_AUDIT.md`** (production `44aba9cf`, 2026-09-09).

| Issue | What | Severity |
|---|---|---|
| **AECI-829** | `/auth/login`, `/products/:slug/review` and `/account` replace the view on a state change with no live region and no focus move. **WCAG 2.1 4.1.3 Status Messages, Level AA**, on the two primary conversion paths. | Serious |
| **AECI-830** | Three links with the identical accessible name "Source" pointing to three different destinations; two `role="search"` landmarks, neither named. | Serious |
| **AECI-831** | Minor set of five: `disabled` rather than `aria-disabled` submit buttons, unnamed integration tables, no `aria-current` on the section nav, no new-tab warning on "Visit website", duplicated `aria-current` in the admin nav. | Minor |
| **AECI-832** | The coverage the production run could not reach: dialog focus management on all four dialogs, the review-form `Tab` walk, and the mobile viewport. Needs a **local seeded** run. | Coverage |

**The point worth carrying forward.** None of these is catchable by the automated gates, and AECI-829's
class is structurally invisible to axe: the defect exists only *after* a form submission, and axe never
submits. When these are fixed, the regression assertion belongs in the e2e spec — submit, then assert
focus or the announcement — not in a new axe rule. Each issue names the assertion and the spec file.

**Still owned by AECI-244, not by this stage:** the VoiceOver and NVDA speech layer, which is a human
run against the scripted walkthroughs in `docs/a11y-manual-testing-checklist.md` §6/§7.

### 2.6 Rebrand & name-change handling — *design INCOMPLETE, do not decompose*

**Not in the original outline** — added 2026-09-11 after Trimble consolidated a range of products
under a "Trimble Unity" umbrella and raised the general question: *when a product or vendor is renamed,
how does a reader researching the previous name still find it?* Today the answer is "they don't."

> **This section is a bookmark, not a contract.** The option space below is surveyed and the
> ground truth is verified, but **the mechanism is not chosen**. §5(6) holds the decisions that must
> close before this pillar can be decomposed into issues. Do not treat the working recommendation as
> settled. Tracked as **AECI-863**.

**What already works, and why that was a surprise.** Promote's update branch writes the new `name` and
**reuses the existing `slug`** (`apps/api/src/routes/promote.ts:1892`), so a straight rename never
breaks a URL and never 404s. That is not incidental — it is `STAGE_1_PHASE_2_SPEC.md` §6.2 ("slugs are
immutable by default") working as designed.

**What does not work.** Four verified gaps:

| # | Gap | Evidence |
|---|---|---|
| 1 | **Search recall is zero for the old name.** The product index's `searchableAttributes` carry no former-name attribute, so the pre-rename string matches nothing unless it happens to survive in `description`. | `packages/shared/src/algolia.ts:379` |
| 2 | **Old names are unrecoverable after the fact.** The `product.updated` audit row promote writes carries no `beforeState`/`afterState`, so name history cannot be mined from `audit_log`. Whatever we build must capture the old name **at rename time**. | `apps/api/src/routes/promote.ts:1915` |
| 3 | **The §6.2 escape hatch was never built.** That section promised an admin "rename slug" action creating a 301, and deferred it to Phase 6. Phase 6 shipped without it. The stand-in is the single hardcoded `/vendors/bluebeam` → `/vendors/nemetschek-group` 301, whose own comment instructs the next person to build the general map rather than add a third entry. | `docs/STAGE_1_PHASE_2_SPEC.md:207`, `apps/web/src/server-runtime.ts:1380` |
| 4 | **A vendor cannot tell us they rebranded.** `name` is absent from `PRODUCT_COLUMN_MAP`, so the portal has no path for it, and `products.name` is writable only by promote. Every rename therefore originates upstream in **`aec-integrations-review`**, which makes any wire-carried solution a two-repo change. | `apps/api/src/routes/vendor.ts:775` |

**A rebrand is four different problems, and only one of them is a rename.** This is the distinction the
design has to respect — Trimble Unity is row 2, not row 1:

| Case | Example | URL | Search | Page |
|---|---|---|---|---|
| 1:1 rename | Construction United → Construction Together | already fine | broken (gap 1) | already fine |
| **N:1 consolidation** | five products → Trimble Unity | 4 of 5 URLs go stale | broken | **wrong — the page must move** |
| Vendor rebrand | `vendors.company_name` changes | already fine | broken (the `vendor_name` facet) | already fine |
| 1:N split | one product becomes two | ambiguous | broken | needs a chooser |

**The options surveyed (2026-09-11), none chosen:**

- **A — `former_names` on `products` + `vendors`.** A JSON column carried on the promote wire, flattened
  into the Algolia record as a **searchable-only, non-faceted** attribute ranked last, plus one line of
  on-page copy ("Formerly Construction United"). This is a direct clone of the shipped `trade_aliases`
  pattern (`SEARCH_RANKING.md` §3.1), so it reuses the transform, the settings lockstep, and the
  existing decision against synonyms. The on-page line is **not decoration**: a reader who Googles the
  old name never reaches our search box, so the string has to be in indexable body copy. Cost: one
  migration, one optional promote field, one Algolia attribute, a **full reindex per environment**, and
  the review-app half. Solves gaps 1 and 2. Does **not** solve consolidation.
- **B — the general slug→slug redirect map.** The unbuilt §6.2 promise: a small `slug_redirects` table
  consulted **only on the not-found branch** (never the hot path), emitting 301, plus the admin action.
  Unlike every other redirect in `server-runtime.ts` this map is **mutable**, so it needs its own
  `Cache-Tag` handle. It is the only mechanism that handles N:1 consolidation, and it retires the
  Bluebeam hardcode. Solves gap 3. Does **not** solve search recall — a 301 helps a stale URL, not a
  typed query.
- **C — Algolia one-way synonyms (old → new).** Rejected on the existing precedent:
  `docs/SEARCH_RANKING.md:113` already declined synonyms for the alias job because they are index-level
  configuration outside code lockstep. Adopting them now would split alias handling across two
  mechanisms for no gain, and would put nothing on the page.
- **D — model the rebrand as a dated evidence event.** `old_name` / `new_name` / `effective_at` /
  source URL, surfaced on the product page and the pair-page version-diff timeline. This is the
  Stage-3-native framing: dual-verified rename provenance is editorial nobody else has, and it answers
  "what happened to X" queries, which is exactly the §2.2 search-intent play. Highest cost — new table,
  new UI, ongoing curation — and it still needs A underneath it to make the old name findable.
- **E — let vendors report it.** A vendor-portal notice that routes to a curator, not a self-serve
  rename (gap 4). Cheapest of the five and the weakest on its own; noted so the gap is recorded rather
  than to sequence it first.

**Working recommendation, explicitly not a decision:** A as the core, B when the second per-entity
redirect lands (the first real consolidation will force it), D as the Stage 3 content play, skip C,
E opportunistically.

**Why this landed in Stage 3 rather than Stage 2.5.** Option D is a trust/evidence surface and option A
feeds §2.2's search-intent play, so the pillar's centre of gravity is here. Two riders, both recorded
so they do not later read as filing errors: (a) if a live rebrand starts actively breaking a page before
Stage 3 opens, the **B** half is the prod-fix-class carve-out and moves forward on its own; (b) the
required full reindex should ride the one **AECI-825** already owes every environment rather than
buying a second.

## 3. Backlog triage (2026-08-24)

Every open, stage-less or misplaced issue, with its proposed destination. Marketing project excluded per the planning instruction; Legal project stays its own track (AECI-309…312 are deliberate deferred decisions, not build work); AECI-596 stays with the admin-panel track (AECI-572).

| Issue | Today | → Destination |
|---|---|---|
| AECI-636 ranking overhaul | Stage 1.5 project (misplaced) | **Stage 2.5 §2** (anchor) |
| AECI-283 ranking tuning loop | Stage 2 Build | **Stage 2.5 §2** (fold-in: §7 rewrite + re-baseline) |
| AECI-534 remove `has_api_docs` | Stage 2 Build | **Stage 2.5 §2** (rides change 1) |
| AECI-618 listing SSR error | no project | **Stage 2.5 §3** |
| AECI-589 purge secrets | no project | **Stage 2.5 §3** |
| AECI-531 GDPR erasure skip | no project | **Stage 2.5 §3** |
| AECI-591 sweep audit gap | no project | **Stage 2.5 §3** |
| AECI-559 Procurement category | no project | **Stage 2.5 §4** |
| AECI-595 promote retract | no project | **Stage 2.5 §4** |
| AECI-592 unreachable DQ check | no project | **Stage 2.5 §4** |
| AECI-623 capability convergence | Stage 2 Build | **Stage 2.1 §3.3** (moved forward from 2.5 §5 on 2026-08-31 — gates seat-granting) |
| AECI-633 vendor-portal SR pass | Stage 2 Build | **Stage 2.1 §3.3** (moved forward from 2.5 §5 on 2026-08-31 — gates seat-granting) |
| AECI-244 public-site SR pass | Stage 1 Build | **Stage 2.5 §5** — but only the VoiceOver/NVDA run itself. The machine layer was discharged 2026-09-09 → `docs/ACCESSIBILITY_AUDIT.md`, and **the four defect/coverage issues it produced were routed to Stage 3** (see §2.5 above) |
| AECI-598 / 599 / 600 / 601 docs | no project | **Stage 2.5 §6** |
| AECI-281 moderation refinement | Stage 2 Build | **Stage 3 §2.1** |
| AECI-340 / 341 / 342 / 343 / 344 | pSEO project | **Stage 3 §2.2** (project adopted as the pillar) |
| AECI-560 sitemap split | Stage-1 deferrals epic | **Stage 3 §2.2** (gated companion) |
| AECI-634 docs epic | Stage 2 Build | **stays in Stage 2 Build** — ships within Stage 2, after portal testing settles; vendor support must exist before vendors are asked to work and pay (§2.3 note) |
| AECI-533 / 590 / 597 / 602 / 555 / 620 / 621 | Stage 2 Build / no project | **Stage 3 §2.4** |
| AECI-635 RTL follow-through | Stage-1 deferrals epic | **stays gated** (trigger: a second locale; not a Stage 3 commitment) |

## 4. Explicitly still later (Stage 4+)

- **Rich media profiles** (Stage 4 — the long-standing marker).
- **Automated billing / self-serve card payment** (deferred by `STAGE_2_SPEC.md` §8.1(5); revisit when the offline PO/invoice flow strains).
- **Review translation** (`STAGE_1_SPEC.md` "Stage 3+" note) — stays out of Stage 3 unless a non-EN locale ships; its trigger is the same as AECI-635's.
- **Public/partner write API** (boundary unchanged).
- **Stack-aware discovery**, if §5(3) resolves to defer.

## 5. Open decisions (settle before decomposition)

1. **Pillar sequencing.** Recommended: 2.1 rung 2 + the queue first (it feeds pair-page content quality), 2.2 immediately after the preconditions clear, 2.4 continuous; 2.3 waits on decision (3). Confirm or reorder.
2. **Rung-2 operating cost.** AECi-verified is human work; decide the weekly verification budget and whether the queue surfaces in the admin panel (relates to the admin-panel track, AECI-572).
3. **Stack-aware discovery: Stage 3 stretch or Stage 4 anchor?** It is the largest net-new surface on the list and the only one needing a reader-side account model beyond reviews.
4. **Linear mechanics.** Proposed: a **"Stage 2.1 Vendor Activation"** project (`STAGE_2_1_SPEC.md`), a **"Stage 2.5 Hardening"** project (the §3 moves) and a **"Stage 3"** project seeded with epic parents per pillar; the pSEO project either folds in or gains a Stage 3 label and stays standalone. Epic branches per the Stage 2 convention only where a pillar carries a companion spec.
6. **Rebrand handling: which mechanism, and does consolidation count as in-scope?** §2.6 is a
   **bookmarked survey, not a design.** Four things must close before it can be decomposed
   (**AECI-863**): (a) pick the mechanism set — A alone, A+B, or A+B+D; (b) decide whether N:1
   consolidation is Stage 3 scope at all, or whether we keep handling it by hand until a second case
   appears; (c) settle who authors a former name — the review app on the promote wire, or an AECi-side
   admin action, noting that `products.name` is promote-only today; (d) confirm the `former_names`
   shape (flat string list vs. dated entries), because D needs dates and A does not, and choosing the
   flat list first makes D a migration. Until (a)–(d) are answered, **do not seed sub-issues.**

5. **Branch model.** Does Stage 3 reuse the long-lived `stage-2`-style integration branch (ADR 0019 pattern → a `stage-3` branch after the Stage 2 merge), or move to trunk-ish now that prod promotes by SHA? Default: repeat ADR 0019 with `stage-3`.

---

*This is a living kickoff outline. As each pillar approaches build, promote it into a companion build spec (as Stage 2's pillars did), decompose into 3–10 focused issues per `STAGE_1_SPEC.md` §24.4, and record decisions here.*

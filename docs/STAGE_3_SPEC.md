# AEC Integrations — Stage 3 Specification (Scope Outline)

**Version:** 0.1 — **scope outline, not a build contract**
**Date:** August 2026
**Status:** Kickoff draft (2026-08-24 planning session). This is the Stage 3 equivalent of `STAGE_2_SPEC.md` at its v0.1 — the pillars, the backlog triage, and the open decisions. It is **not** decomposed into buildable issues; each pillar grows its own companion spec before build (as every Stage 2 pillar did).
**Inherits from:** Stage 1 (`STAGE_1_SPEC.md`), Stage 1.5 (`STAGE_1_5_SPEC.md`), Stage 2 (`STAGE_2_SPEC.md` + its five build/scope companion docs), Stage 2.1 (`docs/STAGE_2_1_SPEC.md`), and Stage 2.5 (`docs/STAGE_2_5_SPEC.md`).
**Supersedes:** the scattered "Stage 3" forward references — `STAGE_2_SPEC.md` §9's "trust scoring beyond basic anti-abuse (Stage 3)" and `STAGE_1_SPEC.md`'s review-translation note (§ Phase 5, "Stage 3+").

> **Preconditions.** Stage 3 opens when (a) `stage-2 → main` has merged and deployed (the Stage 2 ship gate — a **dark launch**: vendor surfaces live but no seats granted; **the merge landed 2026-09-03; "and deployed" still means a prod promote**) — **including the Product Docs / Help Center (AECI-634)**, which is Stage 2 work sequenced last (after portal testing settles) precisely because vendors being asked to do the work and pay must be supportable through it — (b) the Stage 2.1 exit criteria (`STAGE_2_1_SPEC.md` §5, added 2026-08-31) are green — vendors actually seated and live — and (c) the Stage 2.5 exit criteria (`STAGE_2_5_SPEC.md` §7) are green — in particular the search-ranking overhaul, because two Stage 3 pillars (trust ladder, pSEO) build directly on `evidence_tier` and the published ranking mechanism.

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

The non-feature backlog that fits Stage 3's operating posture, batched loosely: **AECI-533** (drop the 19 review-app-only D1 columns), **AECI-590** (reverse-proxy PostHog through our own domain), **AECI-597** (hardcoded-color-literal lint rule), **AECI-602** (plan check → CI sticky comment, once the FP rate is known), **AECI-555** (re-evaluate Cloudflare CI on Workflows at Artifacts GA — spike, trigger-gated), **AECI-620** (slim CLAUDE.md; if not taken as the 2.5 rider), **AECI-621** (spec-grill skill — *useful for authoring the Stage 3 companion specs themselves; consider building it first*). Plus the **AECI-637 temp-env decision** (tear down or promote the `stage2` mirror) — **its trigger has fired**: `stage-2` merged into `main` and was retired on 2026-09-03, so the mirror tier no longer has a branch to mirror. Decide it early rather than carrying an idle tier through Stage 2.1 and 2.5.

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
| AECI-244 public-site SR pass | Stage 1 Build | **Stage 2.5 §5** (may share a sitting with AECI-633) |
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
5. **Branch model.** Does Stage 3 reuse the long-lived `stage-2`-style integration branch (ADR 0019 pattern → a `stage-3` branch after the Stage 2 merge), or move to trunk-ish now that prod promotes by SHA? Default: repeat ADR 0019 with `stage-3`.

---

*This is a living kickoff outline. As each pillar approaches build, promote it into a companion build spec (as Stage 2's pillars did), decompose into 3–10 focused issues per `STAGE_1_SPEC.md` §24.4, and record decisions here.*

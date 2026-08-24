# AEC Integrations — Stage 2.5 Specification (Hardening Interlude)

**Version:** 0.1 — **proposal, not yet seeded into Linear**
**Date:** August 2026
**Status:** Kickoff draft from the 2026-08-24 Stage 3 planning session. Stage 2.5 is a deliberately small, **finishable** interlude between Stage 2 (all six epics Done on `stage-2`) and Stage 3 (growth & trust — `docs/STAGE_3_SPEC.md`). Nothing here is a new feature.
**Inherits from:** Stage 1 / 1.5 / 2 — every constraint carries; this doc adds none.

## 1. Purpose and admission test

Stage 2 built the vendor portal, attestations, paid tiers, and real-time surface, but the backlog accumulated a stratum of issues that belong to **no** stage: live production defects, decided-but-unbuilt product changes, integrity debt, and doc drift. Stage 3 would inherit all of it silently. Stage 2.5 exists to clear that stratum first.

An issue is admitted to Stage 2.5 only if it passes one of four tests — otherwise it is Stage 3 (or stays where it is):

1. **Live defect or broken operational surface** on a deployed tier.
2. **Decided and sequenced product change whose delay blocks other work** — today that is exactly one thing: the search-ranking overhaul, which gates all trust/ranking copy and the marketing push.
3. **Integrity debt that compounds** once Stage 3 builds on top of it (audit invariants, catalog correctness).
4. **Overdue quality gate** (the manual screen-reader passes; the docs de-stale sweep).

**Exit criteria** are listed in §7. When they are green, Stage 3 opens.

---

## 2. The anchor: search-ranking overhaul (AECI-636)

**The decision is made** (2026-08-23, recorded on AECI-636 — the implementation spec lives in the issue's comment of that date and is self-contained; the research brief is in the marketing repo at `docs/strategy/search-ranking-decision-brief.md`). The shape: **evidence-gated, depth-weighted, surface-scoped.** `integration_count` is retired as an ordering signal everywhere; products/vendors tie-break on a content-keyed `listing_tier`; the integrations index (and later pairs) orders on `desc(evidence_tier), desc(mechanism_rank)`; unscored is a labeled state that sorts last by attribute omission; no numeric score is rendered anywhere; money never touches the evidence pipeline; corrections are free for anyone, forever.

Build sequence (from the issue, unchanged):

1. **Product change 1** — `products` + `vendors` `customRanking` → `desc(listing_tier)`; compute `listing_tier` in `apps/api/src/lib/algolia-transforms.ts`; retire the two "Most integrations" replicas. Co-edit `packages/shared/src/algolia.ts`, `algolia.spec.ts`, and `docs/SEARCH_RANKING.md` §3.1/§3.2/§5/§5a in the same PR (the repo's lockstep rule). *Side benefit: retiring two replicas per env relieves the exhausted Algolia index quota (24 used / 20 cap).*
2. **Product change 2** — the one schema addition: `limits` (three-state: documented / attested-none-known / absent) on integrations; add the `file-transfer` mechanism kind at rank 1; compute `evidence_tier`; `integrations` index → `desc(evidence_tier), desc(mechanism_rank)`; fold the same shape into the §3.4 pairs plan.
3. **Publish the ranking-method page** — the plain-language twin of `SEARCH_RANKING.md` (parameters and relative importance, no algorithm, no numbers). Publishing before 1–2 would publish count, the thing being retired. Its natural home is the trust section of the AECI-634 `/docs` area ("how ranking works" is a named first-class page in `STAGE_2_PRODUCT_DOCS_SPEC.md`) — AECI-634 is Stage 2 work running in the same window (see §8); if the docs shell has landed by this step, publish there, otherwise ship standalone and fold in when it does.
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
| **AECI-595** | Promote has no retract semantics — deleting an Airtable record always strands the live D1 row (today's workaround is the manual `ops:retract-product` script). | Medium |
| **AECI-592** | Data-quality check #2 (`ready_products_unpromoted`) is unreachable; replace with a promotion-status invariant guard that can actually fire. | Medium |

## 5. Stage 2 close-out debt

| Issue | What it closes | Priority |
|---|---|---|
| **AECI-623** | Converge `assertVerifiedVendor` onto `requireCapability('attestation.author')` — the one seam the Paid Tiers epic left duplicated. | Medium |
| **AECI-633** + **AECI-244** | The two outstanding **manual screen-reader passes** (vendor portal live-updating surface; the Stage-1 Phase 7.10 public-site pass that never ran), executed together per `docs/a11y-manual-testing-checklist.md` and logged. | Medium |

## 6. Docs & process de-stale sweep

Per the standing review finding — most code-review noise is stale docs. One focused sweep: **AECI-598** (de-stale `STAGE_1_SPEC.md` — §26 audit, the RLS self-contradiction, the §1a companion index; High), **AECI-599** (purge the remaining `appendAuditLog()` references), **AECI-600** (duplicate ADR number 0010 + CICD_PLAN's dark-theme a11y claim), **AECI-601** (Spec-section line missing on 40% of recent issues; `ADMIN_PANEL_SPEC.md` invisible from `stage-2`). *Optional rider:* AECI-620 (slim root `CLAUDE.md`, nested per-app files) — admit only if the sweep has room; otherwise Stage 3.

## 7. Exit criteria

- [ ] Ranking changes 1 + 2 live; replicas retired; `SEARCH_RANKING.md` §3/§5/§5a/§7 match deployed settings; ranking-method page published; blocked copy released.
- [ ] `curl` of `/products` + one page per taxonomy type on production returns product links and no error string (AECI-618 AC), locked by an e2e assertion.
- [ ] `POST /admin/purge` succeeds on every tier; GDPR erasure deletes or loudly fails; the reconcile sweep writes audit rows.
- [ ] Procurement category live; retract semantics shipped; the invariant guard can fire.
- [ ] Both screen-reader passes logged; the four-doc de-stale sweep merged.

## 8. Out of scope

Everything in `docs/STAGE_3_SPEC.md` — trust-ladder rungs 2/3, pSEO, stack-aware discovery, DX tail. Stage 2.5 admits **no new surface area**.

**Not out of scope, but not *in* Stage 2.5 either:** the Product Docs / Help Center (**AECI-634**) is **Stage 2 work** (`STAGE_2_SPEC.md` §2.6) that runs in the same calendar window — it was always sequenced after vendor-portal testing settles, and it must ship **before vendors are asked to do the work and pay**, because that ask has to come with support. Stage 2.5 neither blocks it nor absorbs it; the one touchpoint is §2 step 3 (the ranking-method page prefers the `/docs` trust section as its home).

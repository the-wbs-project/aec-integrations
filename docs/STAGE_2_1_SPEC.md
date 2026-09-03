# AEC Integrations — Stage 2.1 Specification (Vendor Activation Interlude)

**Version:** 0.1 — **proposal, not yet seeded into Linear**
**Date:** August 2026
**Status:** Kickoff draft from the 2026-08-31 go-live planning session. Stage 2.1 is a deliberately narrow interlude between the **Stage 2 dark launch** (`stage-2 → main` merged and deployed with zero vendor seats granted) and **Stage 2.5** (`docs/STAGE_2_5_SPEC.md`). It exists as a **discipline firewall**: the already-built vendor-management surface gets tested, refined, and switched on *before* any new-feature work (the 2.5 ranking overhaul included) is allowed to compete for attention.
**Inherits from:** Stage 1 / 1.5 / 2 — every constraint carries; this doc adds none.
**Sequence:** Stage 2 ship (dark) → **Stage 2.1** (this doc) → Stage 2.5 → Stage 3. Stage 2.5 opens when §5 here is green.

## 1. Purpose and admission test

Stage 2's vendor-management functionality (claiming, seat grants, dashboard, attestations, entitlements, live revalidation) ships to production **dark**: the code is live, but no claims are approved and no entitlements are set, so the portal is inert behind its three locks (session → admin-approved seat grant → admin-set entitlements). The public-facing Stage 2 content — the connector/iPaaS lane above all — goes live immediately; the vendor experience does not.

Stage 2.1 is the window between those two go-lives. Its only product is confidence: the vendor surface exercised end-to-end, its rough edges filed off, and the first real vendors seated.

An issue is admitted to Stage 2.1 only if it **refines, hardens, or verifies already-built Stage 2 vendor-management functionality**, or **directly gates granting real vendor seats**. No new features. No non-vendor work — that is Stage 2.5 (or Stage 3). When tempted, re-read the Status line.

**Pull-forward rule.** A Stage 2.5 item may move into Stage 2.1 only when it demonstrably blocks seat-granting; the move is recorded in both docs. The reverse move (2.1 scope drifting into "while we're here" feature work) is not permitted.

---

## 2. Entry preconditions — the Stage 2 ship gate

These are Stage 2 close-out work, not Stage 2.1 scope — recorded here because Stage 2.1 is their consumer and no other doc yet holds the merged list (from the 2026-08-31 merge-readiness analysis).

> **Status 2026-09-03 — the gate is discharged and `stage-2` merged into `main`.** Disposition of
> each item below, so nothing is re-derived as a blocker:
>
> | # | Disposition |
> |---|---|
> | 1 Reverse reconcile | ✅ AECI-750 (#609) then AECI-774 (#620). Verified at merge time by tree diff: the only files `main` had that `stage-2` lacked were the **61 intentional deletions** (Datadog transports + `observability/datadog/*`, `nav-more-*`, `admin/reviewers/*`, `check-logical-properties.mjs`, `cache-purge.spec.ts`, the superseded card/layout files). No accidental reverts. |
> | 2 Migration renumbering | ✅ `main`'s `0000`–`0020` are **byte-identical** on both branches; `stage-2` adds `0021`–`0028` only. Note this is a bigger set than the five this spec predicted, and **`0027_powerful_killraven` is a destructive recreate**, not additive — it is safe only because it carries `claims` + `attestations` through `__carry_*` tables (`src/test/migration-0027.spec.ts` is the guard). §2(2)'s "no destructive recreates — low-risk" line was written before AECI-721 PR-B existed and is superseded. |
> | 3 Observability decision | ✅ Resolved to **PostHog-only** — the operator knowingly waived both the `stage-2 → main` precondition and the 2–4 week prod soak (see `POSTHOG_MIGRATION_SPEC.md`). The merge flips **staging**; prod's plane flips at the next `promote-to-prod`, not at the merge. |
> | 4 WAF before the claim endpoint | ✅ AECI-659 (#619), applied to the production host set 2026-09-03. |
> | 5 Entitlement backfill | ✅ **No-op** — production and demo have **zero** `verified = 1` vendors (`STAGE_2_DEMO_TEST_PLAN.md` §8). Re-check before granting the first seat, not before the merge. |
> | 6 Claim-CTA posture | ✅ Default taken: leave `/vendors/:slug/claim` open and let claims **park** in the admin queue. |
>
> The merge landed as a **true merge commit** carrying `stage-2`'s tree byte-for-byte, which
> required temporarily clearing `required_linear_history` on `main` (restored immediately after).
> `stage-2` is retired — see `docs/CICD_PLAN.md` §10.


1. **Reverse reconcile first.** `main → stage-2` before `stage-2 → main`: ~44 main commits are true content drift (the August traffic/analytics work — AECI-658/660/661/683/686/668/706 — is absent from `stage-2`, verified by tree diff). The prior reconcile (AECI-619) surfaced six defects a clean merge hid; budget accordingly.
2. **Migration renumbering.** `main` and `stage-2` each minted their own `0016–0019`; production D1 has main's set applied. Stage-2's five migrations (claims/attestation columns, `product_versions`, `last_reviewed_at`/`maintained_by`, `vendor_entitlements`, `vendor_seat_invites`) renumber to `0020–0024` with regenerated snapshots + journal on the merged tree. All five are additive — no destructive recreates — so prod application is low-risk once renumbered.
3. **Observability decision.** AECI-651 removed Datadog on `stage-2` only; prod is Datadog-only and `main` has since *added* monitors the `stage-2` tree deletes. Either verify PostHog alerting parity (including the post-split monitors) before the merge, or carry the Datadog removal back out during the reconcile and decommission it as its own soaked step. The launch must not silently flip prod observability.
4. **WAF before the claim endpoint.** Production has no WAF rules (AECI-659); the public claim POST must not go live unprotected.
5. **Entitlement backfill.** Any `verified = 1` production vendors need `vendor_entitlements` rows at cutover, or the `entitlement_mirror_drift` check fires from day one (`vendors.verified` is a mirror under the Paid Tiers model).
6. **Claim-CTA posture decided.** `/vendors/:slug/claim` is publicly reachable at the dark launch. Default: **leave it open and let claims park** in the admin queue (a live demand signal for this stage); the alternative (hide the CTA) is a deliberate reversal, not a drift.

## 3. Scope

### 3.1 The dress rehearsal

The full vendor lifecycle exercised as a real vendor would hit it — on staging first, then against dark production:

claim submission → claimant identity resolution → admin claim review → approve → seat grant → first sign-in → vendor dashboard → attestation authoring (including the `single_source` / conflict states) → entitlement set / renew / clear → verified badge appearing on trust **and** search surfaces → claim-decision + seat emails delivered → live revalidation cadence observed (20 s focused / 60 s unfocused / paused hidden).

Tools that exist for this: `/preview/vendor-dashboard` (persona/entitlement presets, no session needed) for surface passes; a staged claim with a test vendor identity for the real pipeline. The rehearsal is complete only when a full pass requires **zero manual DB intervention**.

### 3.2 The refinement backlog

Seeded empty **by design** — it is filled by rehearsal findings, parked-claim observations, and dark-window telemetry. This is the stage's actual work; the admission test in §1 governs what lands here.

### 3.3 Moved-in close-out items (from Stage 2.5 §5)

| Issue | What it closes | Why it moved |
|---|---|---|
| **AECI-623** | Converge `assertVerifiedVendor` onto `requireCapability('attestation.author')` — the one seam the Paid Tiers epic left duplicated. | Pure vendor-portal authz polish; exactly this stage's admission test. |
| **AECI-633** | The manual screen-reader pass over the vendor portal's live-updating surface (per `docs/a11y-manual-testing-checklist.md`). | Gates asking vendors in; a11y of the surface vendors are invited to is a seat-granting blocker. May still be run in the same sitting as AECI-244 (which stays in 2.5 §5) if calendars align — the pairing was a scheduling convenience, not a dependency. |

### 3.4 Dark-window operations

- Monitor the parked claim queue; decide and (if needed) implement the acknowledgement posture for parked claimants ("received, under review" — nothing that promises a timeline).
- Watch the vendor-surface metrics through whichever observability stack §2(3) resolved to.
- Process accumulated parked claims as part of §5's controlled activation — none are approved before the exit gate opens.
- **Connector-vendor claims stay parked per the §8.8/§8.9 commercial model** (parked, never granted or rejected) — Stage 2.1's activation does not override that carve-out.

### 3.5 Vendor-guide docs dependency (AECI-634 — stays Stage 2 work)

The Product Docs / Help Center epic remains Stage 2 scope (`STAGE_2_SPEC.md` §2.6, `STAGE_2_PRODUCT_DOCS_SPEC.md`), but its deferred **vendor-guide tranche** was always triggered by "vendor-portal testing settles" — which is this stage. Publication of the vendor guides is a §5 exit gate: vendors are not asked to do the work (and later pay) without support content in place.

## 4. Out of scope

Everything in `docs/STAGE_2_5_SPEC.md` (the AECI-636 ranking overhaul above all — it is the named temptation this stage firewalls against) and `docs/STAGE_3_SPEC.md`. No new vendor features: no billing automation, no portal surface additions, no attestation-model extensions. If the rehearsal reveals a *missing capability* rather than a defect in a built one, it is written up for 2.5/3 triage, not built here.

## 5. Exit criteria — the vendor go-live gate

- [ ] Dress rehearsal (§3.1) passes end-to-end on staging **and** dark production with zero manual DB intervention.
- [ ] AECI-623 merged; AECI-633 logged green.
- [ ] Vendor guides (§3.5) published.
- [ ] Refinement backlog (§3.2) empty, or each remainder explicitly deferred with a recorded reason.
- [ ] First pilot vendor(s) invited, claimed, granted, and attesting successfully — then the parked queue is processed and claim approval becomes routine operation.

When these are green, vendors are live — and Stage 2.5 opens.

---

*This is a living kickoff outline. When seeded into Linear it becomes a "Stage 2.1 Vendor Activation" project; §3.3's two issues move projects; §3.2 issues are created as found.*

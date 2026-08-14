# Phase 6 Completion Report

**Issue:** [AECI-220](https://linear.app/aec-integrations/issue/AECI-220) — Phase 6.13, Phase 6 completion checkpoint
**Spec anchor:** `docs/STAGE_1_PHASE_6_SPEC.md` (all) + `docs/STAGE_1_SPEC.md` §16 Phase 6 (build-order bullets, lines 1132–1143). Phase 6 = Requests & moderation. Companion contracts: `API_CONTRACTS.md` §6.10–6.11 (admin requests/reviewers + Linear webhook), `DATABASE_SCHEMA.md` §8 (`vendor_requests`, `workflow_instances`, `workflow_transitions`), `OBSERVABILITY.md` §"AECi Phase 6 — Requests / Moderation".
**Mirrors:** [AECI-67](https://linear.app/aec-integrations/issue/AECI-67) (Phase 2 gate), [AECI-146](https://linear.app/aec-integrations/issue/AECI-146) (Phase 3 gate), [AECI-187](https://linear.app/aec-integrations/issue/AECI-187) (Phase 4 gate), [AECI-207](https://linear.app/aec-integrations/issue/AECI-207) (Phase 5 gate).
**Evaluated against:** the working tree on `chris/aeci-220-…`, branched from `main` @ `3e2a25a`. · **Date:** 2026-06-26 (UTC)

This is the "Phase 6 is Done" gate. Like the Phase 2/3/4/5 gates it **surfaces** open items rather than silently closing them: every AECI-220 acceptance line and every §16 Phase 6 build-order bullet is mapped to ✅ Done / ⚠️ Partial / ❌ Outstanding with concrete file:line evidence, and each non-green item carries either a follow-up or an explicit written punt.

**Prerequisites met:** the Phase 2/3/4/5 gates are closed; Phase 6 inherits their lint/axe/Lighthouse CI wiring (AECI-65), the console-health harness (AECI-162), and the Phase 5 review-moderation + authz layers it extends. The data layer (`vendor_requests`, `workflow_instances`, `workflow_transitions`, audit log) pre-existed (§16 note) — Phase 6 was app code, **zero migrations**.

---

## 1. Verdict

**Phase 6 is functionally complete and shippable.** All twelve Phase 6 build issues (6.1–6.12 = AECI-208…AECI-219) are merged to `main` (verified `Done` in Linear). The requests/moderation pipeline is live end-to-end in code: a claim/correction submit inserts a `vendor_requests` row + a `workflow_instance` + a genesis `workflow_transition` (AECI-209), then `ctx.waitUntil` creates a Linear issue idempotently in the "Vendor Requests" project with domain-match + duplicate-flag signals (AECI-211/215); `POST /api/webhooks/linear` HMAC-verifies and syncs Linear → site status with a `workflow_transition` (AECI-212); an admin resolves/rejects in `/admin/requests` (AECI-216/217), which now pushes **site → Linear** (status + comment + transition) — see §4.1; a 15-min reconciliation sweep retries stuck (`linear_issue_id IS NULL`) rows and fires an admin email on persistent failure (AECI-214); reviewer ban management ships the `/admin/reviewers` list + unban + the moderation-queue repeat-offender → ban dialog (AECI-218); and observability adds the `aeci.linear.*` / `aeci.request.moderation.action` / `aeci.moderation.ban` metrics + the "Requests/Moderation" dashboard and monitors (AECI-219). `workflow_transitions` are recorded for all three required workflow types plus the bonus `reviewer_ban` type (§2a AC4). All admin surfaces are token-only, i18n-wrapped, and light-only (AECI-226).

**The one gap this checkpoint found and closed:** the **site → Linear sync (Phase 6.6 / AECI-213)** was implemented + unit-tested in `lib/linear.ts` but **never wired** — `index.ts` mounted `createModerateRequestHandler()` with no args, so production used the `noopSyncToLinear` default. An admin resolve/reject updated the app DB but never touched the Linear issue, and `aeci.linear.sync` never fired in prod. This checkpoint wired the real `pushRequestResolutionToLinear` into the seam (§4.1) — per Chris's call to fix it here rather than defer it.

**Repo-checkable gates run for this report — all green:**

| Gate | Result |
|------|--------|
| `pnpm typecheck` (shared, api, datatool — web excluded by design, no web code changed) | ✅ exit 0 |
| `pnpm lint` (ESLint ×5 packages + `check-logical-properties` + Prettier) | ✅ exit 0 · "All matched files use Prettier code style!" · no physical-direction utilities |
| `pnpm test` (unit + integration) | ✅ **api 573** (60 files) · **shared 272** (21 files) · **web 576** (86 files) · web integration: no files |
| `ng extract-i18n` (verification only — **not** committed) | ✅ exit 0 · **770 messages → 724 trans-units** · committed `src/locale/messages.xlf` untouched · ⚠️ 4 pre-existing duplicate-id warnings (see §F3) |
| `grep -rin "slack\|n8n"` over `apps/ packages/ .github/` | ✅ no live wiring — only historical "dropped" comments (one stale `n8n` comment fixed, §4.2) |

The only items **not** green are **deployed-environment confirmations** — the live staging claim→Linear→webhook→resolve→sync flow, the Linear-down→sweep→admin-email failure path, and axe/Lighthouse/console on the auth-gated admin pages — bundled into **§F1** (Chris is providing staging access/secrets to run them live; the Phase 6 analogue of AECI-222/AECI-233). None is a Phase 6 *build* defect.

---

## 2. Acceptance checklist

### 2a. AECI-220 acceptance criteria

| AC | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| 1 | Every §16 Phase 6 item + Phase-6-spec acceptance verified → produce `docs/PHASE_6_COMPLETION.md` | ✅ | This document. Per-bullet mapping in §2b; all 12 build issues (AECI-208…219) `Done` in Linear. |
| 2 | **E2E on staging**: submit claim → Linear issue created → inbound webhook syncs status → admin resolves in `/admin/requests` → site→Linear sync; domain-match + duplicate flags shown | ⚠️ | **Code wired ✅ (incl. the §4.1 sync fix), live run ⚠️.** submit `apps/api/src/routes/requests.ts:295`; issue create `apps/api/src/lib/linear.ts:343` (`createLinearIssueForRequest`); webhook `apps/api/src/routes/webhooks.ts:133`; admin resolve `apps/api/src/routes/admin-requests.ts:274`; **site→Linear sync now wired** `apps/api/src/index.ts` → `pushRequestResolutionToLinear` (`lib/linear.ts:468`); flags rendered `apps/web/src/app/admin/requests/request-queue.html`. **Live run on staging → §F1.** |
| 3 | **Failure path**: simulate Linear down → row stuck → reconciliation sweep retries → admin email fires | ⚠️ | **Code shipped ✅, live run ⚠️.** On Linear failure the row stays `open`/`linear_issue_id=null` (`lib/linear.ts`, never throws); sweep `apps/api/src/lib/reconciliation-sweep.ts` (`runReconciliationSweep`, every 15 min, `scheduled.ts`) retries idempotently + emits `aeci.linear.reconcile.*`; persistent failure → `sendAdminAlert` (`lib/admin-alert.ts` → Resend `lib/email.ts`). Unit-covered (`reconciliation-sweep.spec.ts`, `linear.spec.ts`). **Live run needs staging + `LINEAR_API_KEY`/`RESEND_API_KEY` → §F1.** |
| 4 | `workflow_transitions` recorded for all three workflow types (`vendor_claim`, `correction_request`, `review_moderation`) | ✅ | `vendor_claim`/`correction_request`: genesis `requests.ts:277`, admin action `admin-requests.ts:382`, webhook `webhooks.ts:253`, site→Linear sync `linear.ts:540`. `review_moderation`: submit `reviews.ts:218`, admin moderation `admin-reviews.ts:296`. Bonus reversible `reviewer_ban`: `admin-reviewers.ts:261`. All via `workflowTransitionInsert` in a `db.batch`. |
| 5 | **No Slack anywhere; no n8n wiring** (greps clean) | ✅ | `grep -rin "slack\|n8n"` over `apps/ packages/ .github/` → only historical "dropped" comments (`meta.helpers.ts:24` OG-render note; `promote-to-prod.yml:738` "Slack intentionally dropped"; an `index.ts:144` n8n comment **fixed** in §4.2). No live integration, channel, or workflow. |
| 6 | Monorepo lint clean; axe + Lighthouse on the admin UIs; no console errors; `ng extract-i18n` verification (no committed `messages.xlf`) | ⚠️ | **lint + i18n ✅; live admin axe/LH/console ⚠️.** `pnpm lint` exit 0; `ng extract-i18n` exit 0, committed xlf untouched (§1 table). Admin a11y is covered by the **component specs** (`request-queue.component.spec.ts`, `reviewer-bans.component.spec.ts`, passed) — the admin pages can't be reached in CI e2e (the `requireAdmin()` service-binding call can't be `page.route`-stubbed; the documented AECI-205 precedent, `e2e/admin-reviews.spec.ts:11-16`), so the live axe/Lighthouse/console pass rides a **real admin session → §F1**. Plus 4 pre-existing duplicate-id warnings → §F3. |
| 7 | `DESIGN.md` updated with the new admin-requests components | ✅ | New **"Requests & Moderation (Phase 6)"** subsection (`DESIGN.md`, after the Phase 5 admin block) documenting `<aec-request-queue>`, `<aec-reviewer-bans>`, and the repeat-offender prompt + ban dialog in `<aec-review-queue>` — token-only, i18n, light-only. See §4.3. |
| 8 | Outstanding items get a follow-up Phase 6.x issue or an explicit punt | ✅ | Three punts written in §3 (F1 operational verification, F2 double-transition observation, F3 i18n duplicate-ids). Per Chris's instruction, they're **documented as punts here for Chris to file** — this checkpoint creates no Linear issues. |

### 2b. §16 Phase 6 build-order bullets

| §16 bullet | Issue(s) | Status | Evidence |
|-----------|----------|--------|----------|
| Lean workflow tracking (`workflow_instances` + `workflow_transitions` audit; §26.2) | AECI-209 | ✅ | `apps/api/src/lib/audit.ts:59` (`workflowTransitionInsert`); `db/schema.ts` (`workflowInstances`/`workflowTransitions`, incl. all four `workflow_type`s); recorded-not-enforced per the §26.3 lean relaxation. Genesis instance + transition on submit `requests.ts:271,277`. |
| Linear issue creation on request submit (CF Worker, idempotent, `waitUntil`) + failure handling | AECI-211 | ✅ | `apps/api/src/lib/linear.ts:343` (`createLinearIssueForRequest` — "Vendor Requests" project, template, `Source URL` attachment, labels incl. `domain-check-pending`, idempotency guard `linear_issue_id IS NULL`, never throws); wired `requests.ts:295` via `ctx.waitUntil`. Metrics `aeci.linear.issue[.duration_ms]`. |
| `POST /api/webhooks/linear` (HMAC → transitions) + site→Linear sync on admin action | AECI-212 / AECI-213 | ✅ | Webhook `routes/webhooks.ts:133` (HMAC verify → `aeci.webhooks.linear.hmac_failure`/`receipt`, status map + transition in a `db.batch`). Site→Linear sync `lib/linear.ts:468` (`pushRequestResolutionToLinear`) — **wired into the resolve/reject seam at `index.ts` in this checkpoint (§4.1)**; metric `aeci.linear.sync[.duration_ms]`. |
| Reconciliation sweep (cron) for stuck requests + admin-email backstop | AECI-214 | ✅ | `apps/api/src/lib/reconciliation-sweep.ts` (`runReconciliationSweep`, 15-min cron in `scheduled.ts`; retries `open`/unlinked rows older than the stuck threshold, alerts past the persistent threshold); `lib/admin-alert.ts` → Resend (`lib/email.ts`, `stuck-request-alert`). Metrics `aeci.linear.reconcile.*`. |
| domain-match + duplicate flags on submit (informational; no auto-approval) | AECI-215 | ✅ | `routes/requests.ts` (`computeDomainMatch` → `vendor_requests.domain_match`; `detectDuplicate` → `duplicate_of_request_id`); `is_duplicate` computed at read time in `admin-requests.ts` (two indexed `groupBy`s, no N+1). Both informational — never auto-decide. Rendered `request-queue.html`. |
| `GET /api/admin/requests` + resolve/reject actions + `/admin/requests` UI | AECI-216 / AECI-217 | ✅ | API `routes/admin-requests.ts` (`requireAdmin`; list with kind/status filters + pagination + duplicate compute; `PATCH` resolve/reject — preload gate, guarded atomic `db.batch` = status + audit + transition + instance, then post-commit site→Linear sync). UI `apps/web/src/app/admin/requests/request-queue.ts` (`<aec-request-queue>`). |
| Reviewer ban management (admin sets `banned_at`; enforcement-on-submit is Phase 5) | AECI-218 | ✅ | API `routes/admin-reviewers.ts` (`GET` banned list; `PATCH` ban/unban — self/admin guards, toggle guard, atomic batch + audit + reversible `reviewer_ban` transition; metric `aeci.moderation.ban`). UI `admin/reviewers/reviewer-bans.ts` (`<aec-reviewer-bans>`, unban) + the repeat-offender prompt → `BrnDialog` ban dialog in `admin/reviews/review-queue.ts`. |
| Phase 6 observability + completion checkpoint | AECI-219 / AECI-220 | ✅ | `observability/datadog/dashboard-requests-moderation.json` + `monitor-linear-pipeline-failure.json` / `monitor-linear-reconcile-stuck.json` / `monitor-linear-reconcile-no-data.json` / `monitor-moderation-queue-age.json`; `OBSERVABILITY.md` §"AECi Phase 6 — Requests / Moderation". Checkpoint = this doc. **Live Datadog apply → §F1.** |

**Score: AC — 5 ✅ / 3 ⚠️ · §16 bullets — 8 ✅ / 0 ⚠️ / 0 ❌.** Every ⚠️ is a deployed-env confirmation (§F1) or a documented punt (§F3) — not a Phase 6 build defect.

---

## 3. Outstanding items — follow-ups & punts

> Per Chris's instruction for this checkpoint, outstanding items are **documented here as punts for Chris to file**; this checkpoint creates no Linear issues.

### F1 — Phase 6 operational verification (deployed staging + secrets)

Everything in AECI-220's "E2E on staging" / "failure path" / "axe + Lighthouse on the admin UIs" that needs a **deployed environment + real admin auth + secrets** (the Phase 6 analogue of AECI-222 / AECI-233). The code + config is merged and green; what remains is live confirmation, to be run with the staging access/secrets Chris is providing:

- **Happy path:** submit a claim on staging → a Linear issue appears in the "Vendor Requests" project with the `Source URL` attachment + domain/duplicate signals → flip the issue state in Linear → the inbound webhook syncs `vendor_requests.status` → resolve it in `/admin/requests` → confirm the **site → Linear** push (issue transitions to Done/Canceled, comment posted, the `site-linear-sync` `workflow_transition` written) and that the domain-match + duplicate flags render.
- **Failure path:** make `LINEAR_API_KEY` invalid → submit → confirm the row stays `open`/`linear_issue_id=null` → the 15-min sweep retries and, past the persistent threshold, `sendAdminAlert` fires (`stuck-request-alert` via Resend) and `aeci.linear.reconcile.persistent_failure` is emitted.
- **Admin UIs:** axe AA + Lighthouse + console-cleanliness on `/admin/requests` and `/admin/reviewers` against a deployed origin **with a real admin session** (component specs cover structure; the live pass needs the session — AECI-205 precedent).
- **Datadog:** apply `observability/datadog/dashboard-requests-moderation.json` + the four monitors to the live org; confirm the Phase 6 metrics report.

Required secrets for the live run (per memory, several are unset pre-launch): `LINEAR_API_KEY`, the Linear webhook signing secret, `RESEND_API_KEY` + `ADMIN_ALERT_EMAIL`, and a Linear webhook registered at `POST /api/webhooks/linear`.

### F2 — Double `workflow_transition` on resolve/reject (design observation)

Now that the site→Linear sync is wired (§4.1), an admin resolve/reject writes **two** transitions for the same `from→to`: the in-transaction `source:'admin-moderation'` row (`admin-requests.ts`, the authoritative local state change) and the post-commit `source:'site-linear-sync'` row (`lib/linear.ts`, capturing the Linear push outcome + `linear_state_*` metadata). This is **by design** per AECI-213 AC2 (a site-originated sync transition) composed with AECI-216 (the moderation transition), and the two are distinguishable by `metadata.source` — but it's a slightly redundant pair worth a deliberate decision (keep both for the Linear-push audit trail, or collapse to one). Not a defect; flagged for Chris to file if a cleanup is wanted.

### F3 — i18n duplicate-id warnings (4, mostly pre-existing)

`ng extract-i18n` reports 4 duplicate-message warnings where the same `@@id` is reused across templates with **whitespace-different** source text (the extractor dedupes to the first source): `admin.shell.eyebrow` and `admin.shell.nav.reviewers` (admin-shell vs. nav-menu/user-menu — Phase 6 admin nav), `listing.filters.title` (facet-sidebar, Phase 3), and `app.header.account` (nav-menu vs. user-menu, Phase 5). These are benign **intentional label reuse** (same translation, incidental template padding), not new Phase 6 build defects, and extraction still exits 0. The Phase 5 gate fixed analogous warnings by giving distinct contexts distinct ids (`PHASE_5_COMPLETION.md` §4.2); the same treatment (or an explicit "reuse is intentional" decision) would clear these. Punt for Chris to file — touching `nav-menu.ts`/`user-menu.ts`/`admin-shell.ts`/`facet-sidebar.ts` templates is its own UI change with its own design/axe pass.

> **Update — header "More" menu restructure.** Two of the four are now resolved as a side effect: `admin.shell.eyebrow` and `admin.shell.nav.reviewers` no longer collide, because the admin link set moved into one shared `$localize` array (`admin/admin-nav.ts`) that both the shell and the header's "More" menu render. The same change reused the `@@app.footer.*` ids for the More menu's Legal/Company links and pre-empted seven new collisions by applying the documented tight `<ng-container i18n>` wrap in `site-footer.ts`. **Two warnings remain**: `listing.filters.title` (facet-sidebar) and `app.header.account` (nav-menu vs. user-menu). Extraction still exits 0.

### Not a defect — deferred items are spec'd, not missed

Per `STAGE_1_PHASE_6_SPEC.md` §14, the Resend transactional email *home* (the §6.2 failure alert) landed in Phase 7.5 (AECI-240); WAF rate limits on the public request endpoints and the daily data-quality job are Phase 7. The guarded workflow FSM is intentionally deferred (Stage-1 lean relaxation of §26.3) — transitions are recorded, not enforced.

---

## 4. Work done in this issue

### 4.1 Wired the site → Linear sync (the one real Phase 6 gap)

`index.ts` mounted `createModerateRequestHandler()` with no arguments, so the `SyncRequestToLinear` seam fell back to its `noopSyncToLinear` default — the real `pushRequestResolutionToLinear` (`lib/linear.ts:468`, fully implemented + unit-tested by AECI-213) was never injected. In production an admin resolve/reject updated the app DB but never transitioned/commented the Linear issue, and `aeci.linear.sync` never fired.

Fixed by wiring the real sync at the composition root and matching the seam shape to it:

- **`apps/api/src/index.ts`** — `createModerateRequestHandler(getDb, pushRequestResolutionToLinear)` (added the `getDb` + `pushRequestResolutionToLinear` imports). `pushRequestResolutionToLinear` is a silent no-op without `LINEAR_API_KEY`, so the standalone/test posture is preserved.
- **`apps/api/src/routes/admin-requests.ts`** — the `SyncRequestToLinear` seam now passes the full `LinearResolutionInput` (it previously carried only `{requestId, status, reason, linearIssueId}`, missing `workflowId`/`kind`/`fromStatus`/`actorId` the sync needs for its transition + comment). The call site builds the full input from values already in scope; the `noopSyncToLinear` default stays for standalone/test use.
- **`apps/api/src/routes/admin-requests.spec.ts`** — updated the two sync-seam assertions to the expanded `LinearResolutionInput` shape.
- **`apps/api/src/lib/linear.ts`** — corrected the stale "AECI-217, not yet built" doc comment on `pushRequestResolutionToLinear` (it's now wired).

Verified: `pnpm --filter @aeci/api typecheck` clean; `admin-requests.spec.ts` (25) + `linear.spec.ts` (29) green; full suite green (§1).

### 4.2 Fixed a stale `n8n` comment in `index.ts`

The vendor-requests mount comment described the Phase 6 pipeline as "n8n/Linear/admin … out of scope" (written at AECI-128 / Phase 2). Rewrote it to drop n8n (dropped per `STAGE_1_PHASE_6_SPEC.md` §4) and reflect that the pipeline is now built. This was the only `n8n` hit in `apps/`/`packages/`/`.github/` source.

### 4.3 DESIGN.md: added the "Requests & Moderation (Phase 6)" component subsection

DESIGN.md §5 ended at "Auth & Reviews (Phase 5)" with no Phase 6 admin coverage. Added a **"Requests & Moderation (Phase 6)"** subsection documenting `<aec-request-queue>` (`/admin/requests` — kind/status filters, domain-match + duplicate flags, resolve/reject, Linear link, live region), `<aec-reviewer-bans>` (`/admin/reviewers` — banned list + unban), and the repeat-offender prompt + imperative `BrnDialog` ban dialog in `<aec-review-queue>`. Token-only, full i18n, light-only.

### 4.4 Companion-doc staleness fixes (Chris's "keep docs current" preference)

- **`OBSERVABILITY.md`** — `aeci.moderation.ban` was documented as a **deferred/unbuilt** contract ("the ban write-path is unbuilt … not yet emitted"); AECI-218 shipped it. Corrected the table row + the prose note to the real source (`admin-reviewers.ts` `emitBanAction`) and tag set (`outcome:ok|invalid_state|forbidden`). Also **added** the missing `aeci.request.moderation.action` row (emitted by AECI-216, undocumented).
- **`STAGE_1_PHASE_6_SPEC.md` §6.5** — "keeps Linear and **Supabase** consistent" → the app DB (D1, ADR 0016); added a note that the sync is wired via `pushRequestResolutionToLinear` at the composition root.

_(No Phase 6 build behavior was changed beyond the §4.1 wiring fix — the features shipped in AECI-208…219. This gate added the wiring fix, the DESIGN.md subsection, the doc-staleness fixes above, and this report.)_

---

## 5. Notes & known debt

- **Note A — `aeci.linear.sync` was inert until §4.1.** Because the sync was never wired, the metric, the site-originated `workflow_transition`, and the Linear-side status/comment never occurred in prod on an admin resolve/reject (the webhook direction and issue-creation were unaffected). The §F1 staging run is the first live exercise of the outbound-resolution path.
- **Note B — deployed-env behavior is operational.** As with prior gates, "the staging flow works" / "monitors live" / "axe-LH on admin pages" describe the shipped *capability* and its tests; the live behavior is tracked in §F1. Edge/cron/webhook behavior is only fully observable against a deployed CF environment (Miniflare ≠ the edge; webhooks need a public origin + registered signing secret).
- **Note C — graceful/empty + fail-open states are first-class.** Linear issue-create, the site→Linear sync, the reconcile email, and the toxicity scorer all **never throw** and no-op silently without their secrets; `/admin/requests` and `/admin/reviewers` render empty/loading/error/capped states; a stuck row stays visible in `/admin/requests` as the guaranteed backstop. Pre-launch with unset secrets renders cleanly, not as errors.
- **Light-only (AECI-226).** The Phase 6 admin surfaces ship a single light theme; no `dark:` variants were added.
- **Build noise (non-blocking).** `ng extract-i18n` / vitest print "File not found in TypeScript compilation" notes for the `packages/shared/src/**` re-exports (bundled correctly, outside the web tsconfig program) — documented since AECI-67; build-config notes, not i18n/runtime issues.

---

## 6. Design sign-off (AECI-207 / AECI-187 / AECI-146 / AECI-67 convention)

- The Phase 6 admin surfaces were assembled from the established catalog token + type vocabulary and the existing `<aec-admin-shell>`, so the moderation experience reads as the **same publication** as the public directory (the Anchor-Site Rule). Like the Phase 5 admin tooling, they have **no dedicated design-direction doc / recorded Mobbin anchor** — they're admin tooling built from existing tokens + Spartan overlay primitives. If Chris wants a recorded anchor for the admin surfaces, that's a small follow-up, not an AECI-220 blocker.
- DESIGN.md now documents every shipped Phase 6 admin component (§4.3), token-only color, full i18n, light-only.
- a11y: the request queue uses `aria-pressed` filter toggles + a `role=status` live region; the ban dialog is a Spartan `BrnDialog` opened imperatively (not from an `effect()`); component specs for both new pages pass. Full axe AA + Lighthouse on the **authed** admin pages rides §F1 (needs a real admin session — AECI-205 precedent).
- The **formal `/impeccable` craft + polish history per component, or Chris's explicit sign-off, is a human gate** this report can't self-certify — flagged for Chris to confirm.

---

## 7. Hand-off

**Punts documented for Chris to file** (no issues created by this checkpoint, per instruction):

- **F1** — Phase 6 operational verification: deployed staging E2E (submit → Linear → webhook → resolve → site→Linear sync, flags shown), the Linear-down → sweep → admin-email failure path, authed admin-UI axe + Lighthouse + console, and the live Datadog apply. Chris is providing staging access/secrets; the live run + flipping the §2a AC2/AC3/AC6 ⚠️ rows to ✅ happens next.
- **F2** — decide whether the double `workflow_transition` on resolve/reject (admin-moderation in-tx + site-linear-sync post-commit) should stay or collapse to one.
- **F3** — i18n duplicate-id hygiene for the 4 reused `@@id`s (or an explicit "reuse is intentional" ruling).

**Already tracked:** [AECI-246](https://linear.app/aec-integrations/issue/AECI-246) — Phase 7.12, the Stage 1 launch-readiness gate, which the §F1 live confirmations naturally feed.

**Ready to mark Phase 6 Done** once Chris confirms:

1. The deployed-env operational items (§F1) are acceptable to verify post-merge / via the staging run, not as a build blocker (matches how Phase 2/4/5 deferred their live apply).
2. The two observations (§F2 double-transition, §F3 i18n duplicate-ids) are acceptable as documented punts to file rather than in-checkpoint work.
3. The design sign-off in §6 (per-component craft/polish history or explicit sign-off; optionally a recorded anchor for the admin surfaces).

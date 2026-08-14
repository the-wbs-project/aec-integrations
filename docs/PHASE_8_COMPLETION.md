# Phase 8 Completion Report (living checkpoint)

**Issue:** [AECI-279](https://linear.app/aec-integrations/issue/AECI-279) — Phase 8.1, Post-launch monitoring & stabilization
**Spec anchor:** `docs/STAGE_1_SPEC.md` §16 Phase 8 (build-order bullets, lines 1184–1188) + §14 (observability). CWV budgets referenced by the AC live in `docs/STAGE_1_PHASE_2_SPEC.md` §12 (not §12 of the Stage 1 spec — see the stale-cite note below). Companion records: `docs/OBSERVABILITY.md`, `docs/RUNBOOKS.md`, `docs/POST_LAUNCH_MONITORING.md`, `docs/POST_LAUNCH_HEALTH_REPORT.md`, `docs/ANALYTICS_BASELINE.md`, `docs/launch-cutover-runbook.md`.
**Mirrors:** [AECI-67](https://linear.app/aec-integrations/issue/AECI-67) (Phase 2), [AECI-146](https://linear.app/aec-integrations/issue/AECI-146) (Phase 3), [AECI-187](https://linear.app/aec-integrations/issue/AECI-187) (Phase 4), [AECI-207](https://linear.app/aec-integrations/issue/AECI-207) (Phase 5), [AECI-220](https://linear.app/aec-integrations/issue/AECI-220) (Phase 6), [AECI-246](https://linear.app/aec-integrations/issue/AECI-246) (Phase 7 / launch-readiness gate).
**Prerequisites met:** the DNS cutover shipped (AECI-247/277, #438) — **production is live** (`www.aecintegrations.com`, prod SHA `8348297…`, deployed `2026-07-05T18:10Z`; `/api/version` = `/_version`, no stale SSR). Phase 7's launch punts (F1–F4) are the ops backdrop this pass operates against.
**Evaluated against:** the working tree on `chris/aeci-279-…`, at `main` @ `a0dfe6b`. · **Date:** 2026-07-11 (UTC)

**This is a _living_ checkpoint, not a one-shot "Done" gate.** Phases 2–7 each closed a build phase; Phase 8 is an *ongoing* post-launch operate-and-tune period (§16 "Week 11+"). AECI-279 is **Phase 8.1** — the first slice: it ships the durable monitoring scaffolding and the concrete, traffic-independent alert fixes, and honestly marks what is blocked or still ongoing. Like the prior gates it **surfaces** open items rather than silently closing them; unlike them, several §16 Phase 8 bullets legitimately stay open (they need weeks of real traffic and are later Phase-8 slices).

**The one criterion that cannot be met yet — real-user CWV — is blocked, not skipped by oversight.** Verified against live prod on 2026-07-11: `curl -s https://www.aecintegrations.com/ | grep -oE '__AECI_(POSTHOG|DD)__'` returns **nothing** — the HTML injects only `__AECI_ALGOLIA__` + `__AECI_SUPABASE__`. **PostHog and Datadog RUM are dark in production** (the `DD_APPLICATION_ID` / `DD_CLIENT_TOKEN` / `POSTHOG_KEY` secret *values* are unset; AECI-326 wired the CI push but not the values). So there is **zero field CWV data** to confirm against the §12 budgets. Per the scope decision on this issue, the CWV read is **deferred** (§F1), not attempted against absent data.

**Stale spec-cite raised (not silently worked around — CLAUDE.md rule):**

- The AECI-279 AC says "Phase 2 **§12** budgets." §12 of `docs/STAGE_1_SPEC.md` is "Issue Tracking — Linear via n8n." The actual performance budgets (LCP ≤ 2.5s, CLS ≤ 0.1, TTFB ≤ 100/600ms, LH ≥ 90, detail JS ≤ 200 KB) live in **`docs/STAGE_1_PHASE_2_SPEC.md` §12**. Read the AC's "§12" as the Phase 2 spec.
- The `docs/STAGE_1_SPEC.md` §16 line "7.13 DNS cutover … AECI-247" is still `[ ]` although the cutover **shipped** (prod is live @ `8348297`). Flagged for AECI-247's closure to check; not flipped here (out of scope for Phase 8.1).

**Repo-checkable gates run for this report:**

| Gate | Result |
|------|--------|
| `pnpm format:check` (Prettier; `*.md` is prettier-ignored, so JSON + code only) | ✅ exit 0 · "All matched files use Prettier code style!" |
| `pnpm lint` (ESLint ×N packages + `check-logical-properties` + Prettier) | ✅ exit 0 |
| `pnpm typecheck` (shared, api, datatool — web excluded by design) | ✅ exit 0 |
| `jq` parse of all 23 `observability/datadog/monitor-*.json` | ✅ 23 / 23 valid |
| `pnpm test` | **Not run** — this change is documentation (prettier-ignored `*.md`) + Datadog **monitor JSON** only; no application code, schema, or test surface changed. The DQ severity split and WAF-poll liveness are Datadog config (metric tags they query already exist), not code paths under test. Reflects `main` @ `a0dfe6b`. |

_This checkpoint changes **only docs + monitor JSON** — no application logic — so the gates reflect `main` @ `a0dfe6b`._

---

## 1. Verdict

**Phase 8.1 is functionally complete for the parts that don't require weeks of real traffic; the rest is honestly marked blocked or ongoing.** The operate-and-tune pass is inherently multi-week and cannot be "finished" in one change, so AECI-279 delivers what durably reduces future toil: a repeatable daily/weekly **monitoring runbook** (`POST_LAUNCH_MONITORING.md`); a dated **health-report log** with its first structural snapshot (`POST_LAUNCH_HEALTH_REPORT.md`); and two concrete, correct-regardless-of-volume **alert fixes** — the data-quality monitor **severity split** (warn checks no longer page like integrity errors) and the missing **WAF-poll liveness monitor** (a silently-dead hourly poll now pages). The dependent records (`OBSERVABILITY.md`, `RUNBOOKS.md`, `docs/README.md`, `CLAUDE.md`) were updated so nothing goes stale, and the OBSERVABILITY monitors table was completed to all **23** committed monitors (it had been missing the three pre-existing data-quality rows).

**What is _not_ green — and why none is a Phase 8.1 build defect:**

- **Real-user CWV (AC3)** — **blocked**: prod RUM is dark (secret values unset). No field data exists to confirm. Provisioning is an ops flip → **§F1**.
- **Alert tuning by observed noise (AC2)** — **partial**: the two structural fixes shipped, but retuning the launch-placeholder *thresholds* needs a real-traffic baseline that doesn't exist yet → **§F3**.
- **The broader §16 Phase 8 bullets** — iterate stats-card content, refine moderation on first reviews, start Stage 2 planning — are **later Phase-8 slices**, not part of the 8.1 monitoring pass → **§F4**.

---

## 2. Acceptance checklist

### 2a. AECI-279 acceptance criteria

| AC | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| 1 | Daily monitoring: errors/APM, RUM CWV, edge cache, Algolia latency/errors, scheduled-job health, request→Linear + moderation | ✅ | Repeatable procedure shipped: `docs/POST_LAUNCH_MONITORING.md` §1 (daily checklist, all named dashboards/metrics/monitors) + §1a (8 crons at the time of this pass; **10 since Phase 8.3** — §2c). RUM-CWV row is gated on §0 (analytics dark **at the time of this pass**; both globals are injected as of 2026-08-12 — §2c). Ongoing *execution* is operational, not a code artifact. |
| 2 | Triage + ticket regressions; tighten warn-level alerts that prove noisy or miss real issues | ⚠️ | **Two concrete fixes shipped.** "Noisy": data-quality **severity split** — `monitor-data-quality-check.json` scoped `severity:error` (pages) + new `monitor-data-quality-check-warn.json` (informational, non-paging) so 8 hygiene checks stop paging like integrity errors. "Miss real issues": new `monitor-waf-poll-no-data.json` (a silently-dead hourly WAF poll now pages). Triage→ticket loop documented (`POST_LAUNCH_MONITORING.md` §4). Threshold retuning is traffic-gated → **§F3**. |
| 3 | Confirm real-user CWV against the (Phase 2) §12 budgets; address the worst offenders | ❌ | **Blocked** — prod RUM dark (no `__AECI_DD__`); zero field CWV data. **Not read** (scope decision). Interim lab reference recorded in `POST_LAUNCH_HEALTH_REPORT.md` (2026-07-11 entry) + `PERFORMANCE_AUDIT.md`. Likely field offenders (CLS on detail/browse/taxonomy 0.145–0.326; detail JS ~227 KB) are **owned by AECI-221**. Provision + first read → **§F1**. |
| 4 | Capture a "first week / first month" health report | ✅ | `docs/POST_LAUNCH_HEALTH_REPORT.md` — a dated log modeled on `ANALYTICS_BASELINE.md`, with the observable-vs-blocked matrix, an entry template, and the first (2026-07-11, structural) snapshot. Weekly/first-month entries accrue operationally. |

### 2b. §16 Phase 8 build-order bullets (spec lines 1184–1188)

| §16 Phase 8 item | Status | Evidence / note |
|-----------|--------|----------|
| Monitor errors, performance, search quality | ⚠️ in-progress | AECI-279 ships the *procedure + tooling* (`POST_LAUNCH_MONITORING.md`, the alert fixes). Ongoing monitoring is operational; performance (CWV) is gated on §F1. |
| Iterate on stats card content based on real traffic | ⚠️ in-progress (Phase 8.2) | **AECI-280**: the 2026-07-12 prod traffic pull validated the trending 7d-window + top-5 (left unchanged) and added a `TRENDING_MIN_VIEWS = 3` honesty floor; window/top-N re-eval + PostHog-join weighting + card-resonance review deferred to a ~30d follow-up → **§F4**. |
| Refine moderation workflow based on first reviews | ❌ not started | Needs the first real user reviews. Later Phase-8 slice → **§F4**. |
| Start Stage 2 planning | ❌ not started | Separate track; the `stage-2` integration branch exists (ADR 0019). → **§F4**. |

**Score: AC — 2 ✅ / 1 ⚠️ / 1 ❌ (blocked) · §16 Phase 8 — 0 done / 2 ⚠️ in-progress / 2 not-started** (AECI-280 / Phase 8.2 moved "iterate stats-card content" to in-progress). Phase 8 is **ongoing** — 8.1 + 8.2 are slices, not the whole phase. Every non-green item is an ops flip (§F1), a traffic-gated retune (§F3), or a later Phase-8 slice (§F4) — not a build defect.

### 2c. Phase 8.3 — Admin panel / operator console (epic AECI-572)

> **Appended 2026-08-14 by AECI-587** (the §12 docs closeout), per Note D. The 8.1 verdict, AC table
> and score above are the AECI-279 record as written on 2026-07-11 and are **not restated or
> rescored here** — where 8.3 changed a fact one of them asserts, the change is recorded in this
> section and cross-referenced from there.

**Spec:** `docs/ADMIN_PANEL_SPEC.md` (v1.0 build contract, promoted 2026-08-12 by AECI-573).
**Scope:** a read-only operator console over data AECi already collects — the consent-independent
read surface for `page_views`, plus a screen for the two cron digests. §13 **D1** placed it in Phase
8.3 on the **`main` line** (not Stage 2 — no vendor auth), integrated on the **`admin-panel`** epic
branch as a second time-boxed exception under ADR 0019 (`CICD_PLAN.md` §10).

**Status at this checkpoint: all 15 units Done; the epic has not yet merged to `main`.** Prod is at
`c461a883` (2026-08-13T07:53Z), a `main` commit. Nothing below is deployed — staging auto-tracks
`main`, so per §13 D1 obligation (b) **per-PR preview Workers were the verification surface** for
the whole epic.

| §10 unit | Issue | Shipped |
|---|---|---|
| — | AECI-573 | Decision gate: §13 Q1–Q7 → D5–D11, timing + base branch (D1), spec promoted to contract |
| §9.6 | AECI-575 | `/admin/*` + `/account` excluded from `PageViewTracker` — write side **and** retroactive read filter (D12) |
| P1.1–P1.6 | AECI-574, 576, 577, 578, 579, 580 | The read API (8 `GET` endpoints) + the shell restructure, Overview, Activity, Traffic, Catalog and System screens; hand-rolled SVG chart primitives (D3, no new client dependency) |
| P2.1–P2.2 | AECI-581, 582 | `metrics_daily` + the 00:15 snapshot cron + historical backfill, `products.promoted_at` (D6); the production page-view bot backfill |
| P3.1–P3.2 | AECI-583, 584 | `job_runs` + all ten crons instrumented + DQ results persisted; the 03:00 retention prune (400d / 90d / indefinite, D5) |
| P4.1 | AECI-585 | Page-view ingest fixes; the three dead columns dropped (D7) — the repo's first table-recreate migration |
| P5.1 | AECI-586 | Audience section (mailing list, churn, UTM, geography) + the feedback inbox |
| §12 | AECI-587 | This docs closeout |

**What changed for post-launch operations** — the reason this belongs in *this* file:

1. **`page_views` has a read surface.** It was write-only-in-practice since launch; the daily digest
   was the only thing that read it. Eight admin endpoints now do, behind `requireAdmin()`.
2. **Cron liveness split in two.** Since AECI-583 the panel owns the **record** (last run, outcome,
   duration per job, from `job_runs`); **Datadog still owns absence** — a cron that never starts
   writes no row either, so only a no-data monitor catches it. §1 row 6 of the monitoring runbook
   states the split rather than replacing one with the other.
3. **The morning read needs no email.** The 04:00 data-quality digest is readable on demand at
   `/admin/system`, with the last stored run as the default view; D1 size and per-table row counts
   no longer need `wrangler d1 execute`. Per **D2 no cron was retired** — push and pull are
   complementary.
4. **Retention exists and is enforced.** Nothing is deleted yet: `job_runs` first bites ~2026-11-11,
   `page_views` ~2027-07.
5. **§F1's blocker cleared.** Both `__AECI_POSTHOG__` and `__AECI_DD__` are injected in prod HTML
   (verified 2026-08-14). AC3 above is no longer *blocked* — only *unread*. See §F1.

**Two audit-model decisions worth carrying forward** (they govern review, not just this epic):
**ADR 0022** scopes the §26.1 audit-in-batch invariant to **domain state** — derived and log-class
writes are exempt, recorded as the standing exemption EX-002; and **scheduled deletion is never
exempt**, so the retention prune writes exactly one `retention.pruned` summary row per run in the
same batch as its deletes. The test is *entity class, not actor class*.

**Consciously open, none blocking:** AECI-590 (reverse-proxy PostHog, D9, Low, outside the epic) ·
AECI-591 (the `*/15` reconcile sweep's genuine §26.1 violation — surfaced by ADR 0022, deliberately
not legitimized, Medium) · AECI-592 (data-quality check #2 is unreachable, Medium).

**New punts from this slice:** §F5 (no `metrics-snapshot` monitor) and §F6 (the at-merge
obligations).

---

## 3. Outstanding items — follow-ups & punts

> Per the checkpoint convention (Phases 2–7, per Chris's standing instruction), outstanding items are **documented here as punts for Chris to file**; this checkpoint creates no Linear issues.

### F1 — Provision the analytics secrets + first field CWV read (the AC3 blocker) — **half done**

Set the GitHub secret **values** so the CI-wired push lights up prod: `DD_APPLICATION_ID`, `DD_CLIENT_TOKEN` (Datadog RUM), and `POSTHOG_KEY`. Then verify `curl -s https://www.aecintegrations.com/ | grep -oE '__AECI_(POSTHOG|DD)__'` prints both, and ~1 week later do the first field CWV read (Datadog RUM → Optimize Vitals, `aeci` app, `env:production`, p75 LCP/CLS/INP vs `STAGE_1_PHASE_2_SPEC.md` §12) — recording it in `POST_LAUNCH_HEALTH_REPORT.md`. This closes AC3. Ops-only, no code.

> **Update (2026-08-14, AECI-587).** The provisioning half is **done** — both globals are injected in prod HTML (verified by the `curl` above on 2026-08-14; first confirmed 2026-08-12). **AC3 is no longer blocked, only unread**: field data has been accruing for ~2 days, so the first CWV read is now a task rather than an impossibility. That read is the remaining half of this punt. Note the RUM sample stays thin while the site is pre-marketing, and PostHog additionally under-counts by whatever share of visitors run a blocker (→ AECI-590).

### F2 — Apply the three AECI-279 monitors to Datadog

Monitors are committed JSON applied out-of-band (`OBSERVABILITY.md` → "Applying the dashboard + monitors"). Apply: `monitor-data-quality-check.json` (edited → `severity:error`), `monitor-data-quality-check-warn.json` (new), `monitor-waf-poll-no-data.json` (new). Substitute `@NOTIFICATION_CHANNEL_TBD` → `@chrisw@thewbsproject.com`; decide the warn monitor's `@NOTIFICATION_CHANNEL_LOW_TBD` routing (a low-urgency handle, or leave literal to keep it UI-only / non-paging).

### F3 — Threshold retuning once a real-traffic baseline exists (the AC2 tail)

The launch-placeholder thresholds (`POST_LAUNCH_MONITORING.md` §3: error-rate 1%, cache-hit 70%, page_views 10%, auth 30%, toxicity 50%, Linear 50%/3-per-hr, moderation 48h, WAF 500/15m) were set before traffic existed. Review weekly against real data and tighten/relax per monitor — enforcement level only, never relax a budget to pass.

### F4 — Later Phase-8 slices (8.2+)

The remaining §16 Phase 8 bullets are separate slices needing real traffic/reviews. **Iterate home stats-card content** is now under way as **Phase 8.2 / AECI-280** — the first pass (2026-07-12) tuned the trending card on real `page_views` (added the `TRENDING_MIN_VIEWS` floor; window/top-N validated and left unchanged) and documented the trending tunables (`POST_LAUNCH_MONITORING.md` §3). Its own **~30d follow-up** is still to be filed: window/top-N re-evaluation, PostHog-join weighting + recency decay, and the card-resonance/swap review once PostHog + RUM have volume. The other two — refine the moderation workflow after the first real reviews; start Stage 2 planning (`stage-2` branch) — remain to be filed as their own issues when the traffic/inputs exist.

> **Update (2026-08-14, AECI-587).** Two more slices have since happened, neither of them from the §16 bullet list. **Stage 2 planning has started** (AECI-282 → `docs/STAGE_2_SPEC.md` + six epics on the `stage-2` branch), so that bullet is no longer "not started". And **Phase 8.3 — the admin panel (epic AECI-572) — is code-complete** (§2c); it was not a §16 bullet at all, which is the point of Note D: Phase 8 is a period, and slices arrive that the original build order never named. Its own punts are §F5 and §F6. Moderation-workflow refinement remains genuinely not started — it still needs the first real user reviews, and `reviews` was **0 rows** at the 2026-08-12 census.

### F5 — Add a `metrics-snapshot` no-data monitor (Phase 8.3)

The 00:15 UTC `metrics_daily` snapshot is the **only cron with no dedicated Datadog monitor**, and it is the one where absence is permanently lossy: it is queue-less (a failed run is never retried) and a missed day's **stock** metrics cannot be reconstructed — only flows can. A gap also silently aborts the whole 03:00 retention prune (§7.4 forbids pruning an uncaptured day), so today a snapshot outage surfaces as a *retention* alert or not at all.

Build it on `aeci.metrics_snapshot.run{outcome:ok,trigger:cron,env:production}` with `notify_no_data` over ~30h, modeled on `monitor-algolia-sync-no-data.json`. A second, non-paging monitor on `aeci.metrics_snapshot.metric{outcome:failed}` would catch the `partial` case (one broken producer out of 19) that the run-level tag hides. Runbook already written: `RUNBOOKS.md` → "Metrics snapshot missing or incomplete".

### F6 — At-merge obligations for `admin-panel → main` (Phase 8.3)

Four things AECI-587 could not discharge, because the docs closeout lands *before* the squash merge. The canonical list is `ADMIN_PANEL_SPEC.md` **§12a**; it is also filed as **[AECI-596](https://linear.app/aec-integrations/issue/AECI-596)** so it survives outside the spec. In short: replace `ANALYTICS_BASELINE.md`'s placeholder "the AECI-585 production deploy" dates with the real date; retire §7.3's migration-not-yet-deployed note and confirm `main`'s `account.ts` no longer nulls `page_views.user_id`; apply migrations `0010`–`0014` per tier after reconciling the Drizzle journal (§13 D1 obligation (a)); retire the `admin-panel` branch (`CICD_PLAN.md` §10 — time-boxed, not a standing third line).

### Not a defect — flagged, not fixed here

- **CWV worst-offenders (CLS on detail/browse/taxonomy, detail-page JS ~227 KB)** are pre-identified in `PERFORMANCE_AUDIT.md` and **owned by AECI-221** (the warn→error Lighthouse re-flip); AECI-279 validates them against field data (§F1), it does not implement the perf fixes.
- **The `RUNBOOKS.md` banner** still promises a "severity matrix / comms / post-mortem template … land in Phase 6" that never landed — a pre-existing incident-process gap, surfaced for Chris; out of scope for this monitoring pass.

---

## 4. Work done in this issue

### 4.1 Alert fix A — data-quality monitor severity split
`observability/datadog/monitor-data-quality-check.json` re-scoped to `severity:error` (name + query + message); new `observability/datadog/monitor-data-quality-check-warn.json` for `severity:warn` (informational, non-paging, `@NOTIFICATION_CHANNEL_LOW_TBD`). The `aeci.data_quality.check` gauge already carries the `severity:` tag (`apps/api/src/scheduled.ts:641-642`), so this is monitor config, not app code.

### 4.2 Alert fix B — WAF-poll liveness monitor
New `observability/datadog/monitor-waf-poll-no-data.json` — `notify_no_data` on `aeci.waf.poll{outcome:ok,trigger:cron,env:production}` over a 3h window, modeled on `monitor-algolia-sync-no-data.json`. Fills the gap `OBSERVABILITY.md` itself flagged.

### 4.3 Monitoring runbook — `docs/POST_LAUNCH_MONITORING.md`
The daily/weekly operate-and-tune procedure: the §0 analytics-injection gate, the daily checklist (§1) + the cron table (§1a — 7 crons as shipped here, 10 since Phase 8.3), the weekly checklist (§2), the launch-tunable-threshold table (§3), the triage→ticket loop (§4), and the monitor-apply ops note (§5).

### 4.4 Health-report log — `docs/POST_LAUNCH_HEALTH_REPORT.md`
Dated log (template + first structural entry) modeled on `ANALYTICS_BASELINE.md`, with the observable-vs-blocked matrix; CWV marked blocked with the interim lab reference.

### 4.5 This report — `docs/PHASE_8_COMPLETION.md`
The living Phase 8 checkpoint: AC + §16-bullet mapping with evidence, the four punts, and the two stale-cite corrections.

### 4.6 Dependent-doc updates
`OBSERVABILITY.md` (monitors table completed to 23 incl. the DQ + WAF-poll rows; DQ-severity + WAF-poll-liveness prose; apply-note count/placeholder); `RUNBOOKS.md` (DQ + WAF alert lists reflect the split + new monitor); `docs/README.md` (index rows for the two new docs); `CLAUDE.md` (source-of-truth rows + `PHASE_{2..7}` → `{2..8}`).

### 4.7 Phase 8.3 — admin panel (epic AECI-572, appended 2026-08-14 by AECI-587)

Not work done *in AECI-279* — appended per Note D so this file keeps describing Phase 8 as a whole. The build is recorded in §2c; what the **closeout** (AECI-587) itself did: verified all 20 rows of the `ADMIN_PANEL_SPEC.md` §12 update contract against the files rather than trusting the owning sub-issues (17 were already satisfied); wrote the three that were not — a new dated `POST_LAUNCH_HEALTH_REPORT.md` entry, the missing `metrics-snapshot` runbook, and this section; closed the seven §14.3 known-stale claims; and reconciled the spec's own §10 against what shipped. Two accuracy fixes worth naming because they were wrong in a way review would not have caught: `CODE_REVIEW_EXEMPTIONS.md` EX-002's path scope did not list the three new bookkeeping writers, so the exemption would not have matched the writes it exists for; and `STAGE_1_SPEC.md` §26's DDL was still Postgres (`uuid` / `jsonb` / `timestamptz`) two migrations after the D1 move — AECI-573 had corrected the prose only.

---

## 5. Notes & known debt

- **Note A — "dark until secrets" is by design, but it blocks a real AC here.** Unlike prior gates where the no-op-without-secrets posture only deferred *observability*, in Phase 8.1 it blocks the CWV *acceptance criterion* itself — you cannot confirm field CWV with no field data. §F1 is the flip.
- **Note B — monitors apply out-of-band.** As with every prior phase's monitors, the committed JSON must be applied to Datadog manually (§F2). Nothing in this change is "live" until applied.
- **Note C — the OBSERVABILITY monitors table was stale before this pass** — it listed 18 of the 21 committed monitors (the 3 data-quality monitors from AECI-241 were never added). Completed to 23 here (18 + 3 DQ + 2 new).
- **Note D — Phase 8 is a period, not a milestone.** This checkpoint is intentionally re-openable; append to it (and the health-report log) as later slices land, rather than treating it as closed.

---

## 6. Design sign-off

**N/A — no rendered UI.** AECI-279 touches only docs + Datadog monitor JSON; no `apps/web` surface changed, so the UI-touching design checklist (CLAUDE.md) does not apply.

---

## 7. Hand-off

**Punts documented for Chris to file** (no issues created by this checkpoint, per convention):

- **F1** — provision `DD_APPLICATION_ID` / `DD_CLIENT_TOKEN` / `POSTHOG_KEY` values (un-dark RUM + PostHog), then the first field CWV read → closes AC3.
- **F2** — apply the three AECI-279 monitors to Datadog; decide the warn monitor's low-urgency routing.
- **F3** — retune the launch-placeholder thresholds once a real-traffic baseline exists.
- **F4** — the later Phase-8 slices (stats-card iteration, moderation-workflow refinement, Stage 2 planning).
- **F5** *(Phase 8.3)* — add a `metrics-snapshot` no-data monitor; it is the only cron without one, and the only one where a missed run is permanently lossy.
- **F6** *(Phase 8.3)* — the `admin-panel → main` at-merge obligations (`ADMIN_PANEL_SPEC.md` §12a), filed as **AECI-596**.

**Linear housekeeping:** AECI-279 moved to **In Progress** and assigned to Chris at start.

**This checkpoint stays open** (living) — Phase 8 is ongoing. Mark Phase 8 "done" only when Chris decides the post-launch period is complete (typically at the one-month health-report entry + Stage 2 hand-off), at which point the §16 Phase 8 bullets and the §F4 slices should be resolved or filed.

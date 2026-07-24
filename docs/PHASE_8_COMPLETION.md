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
| 1 | Daily monitoring: errors/APM, RUM CWV, edge cache, Algolia latency/errors, scheduled-job health, request→Linear + moderation | ✅ | Repeatable procedure shipped: `docs/POST_LAUNCH_MONITORING.md` §1 (daily checklist, all named dashboards/metrics/monitors) + §1a (8 crons). RUM-CWV row is gated on §0 (analytics dark); every server-side signal is live. Ongoing *execution* is operational, not a code artifact. |
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

---

## 3. Outstanding items — follow-ups & punts

> Per the checkpoint convention (Phases 2–7, per Chris's standing instruction), outstanding items are **documented here as punts for Chris to file**; this checkpoint creates no Linear issues.

### F1 — Provision the analytics secrets + first field CWV read (the AC3 blocker)

Set the GitHub secret **values** so the CI-wired push lights up prod: `DD_APPLICATION_ID`, `DD_CLIENT_TOKEN` (Datadog RUM), and `POSTHOG_KEY`. Then verify `curl -s https://www.aecintegrations.com/ | grep -oE '__AECI_(POSTHOG|DD)__'` prints both, and ~1 week later do the first field CWV read (Datadog RUM → Optimize Vitals, `aeci` app, `env:production`, p75 LCP/CLS/INP vs `STAGE_1_PHASE_2_SPEC.md` §12) — recording it in `POST_LAUNCH_HEALTH_REPORT.md`. This closes AC3. Ops-only, no code.

### F2 — Apply the three AECI-279 monitors to Datadog

Monitors are committed JSON applied out-of-band (`OBSERVABILITY.md` → "Applying the dashboard + monitors"). Apply: `monitor-data-quality-check.json` (edited → `severity:error`), `monitor-data-quality-check-warn.json` (new), `monitor-waf-poll-no-data.json` (new). Substitute `@NOTIFICATION_CHANNEL_TBD` → `@chrisw@thewbsproject.com`; decide the warn monitor's `@NOTIFICATION_CHANNEL_LOW_TBD` routing (a low-urgency handle, or leave literal to keep it UI-only / non-paging).

### F3 — Threshold retuning once a real-traffic baseline exists (the AC2 tail)

The launch-placeholder thresholds (`POST_LAUNCH_MONITORING.md` §3: error-rate 1%, cache-hit 70%, page_views 10%, auth 30%, toxicity 50%, Linear 50%/3-per-hr, moderation 48h, WAF 500/15m) were set before traffic existed. Review weekly against real data and tighten/relax per monitor — enforcement level only, never relax a budget to pass.

### F4 — Later Phase-8 slices (8.2+)

The remaining §16 Phase 8 bullets are separate slices needing real traffic/reviews. **Iterate home stats-card content** is now under way as **Phase 8.2 / AECI-280** — the first pass (2026-07-12) tuned the trending card on real `page_views` (added the `TRENDING_MIN_VIEWS` floor; window/top-N validated and left unchanged) and documented the trending tunables (`POST_LAUNCH_MONITORING.md` §3). Its own **~30d follow-up** is still to be filed: window/top-N re-evaluation, PostHog-join weighting + recency decay, and the card-resonance/swap review once PostHog + RUM have volume. The other two — refine the moderation workflow after the first real reviews; start Stage 2 planning (`stage-2` branch) — remain to be filed as their own issues when the traffic/inputs exist.

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
The daily/weekly operate-and-tune procedure: the §0 analytics-injection gate, the daily checklist (§1) + 7-cron table (§1a), the weekly checklist (§2), the launch-tunable-threshold table (§3), the triage→ticket loop (§4), and the monitor-apply ops note (§5).

### 4.4 Health-report log — `docs/POST_LAUNCH_HEALTH_REPORT.md`
Dated log (template + first structural entry) modeled on `ANALYTICS_BASELINE.md`, with the observable-vs-blocked matrix; CWV marked blocked with the interim lab reference.

### 4.5 This report — `docs/PHASE_8_COMPLETION.md`
The living Phase 8 checkpoint: AC + §16-bullet mapping with evidence, the four punts, and the two stale-cite corrections.

### 4.6 Dependent-doc updates
`OBSERVABILITY.md` (monitors table completed to 23 incl. the DQ + WAF-poll rows; DQ-severity + WAF-poll-liveness prose; apply-note count/placeholder); `RUNBOOKS.md` (DQ + WAF alert lists reflect the split + new monitor); `docs/README.md` (index rows for the two new docs); `CLAUDE.md` (source-of-truth rows + `PHASE_{2..7}` → `{2..8}`).

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

**Linear housekeeping:** AECI-279 moved to **In Progress** and assigned to Chris at start.

**This checkpoint stays open** (living) — Phase 8 is ongoing. Mark Phase 8 "done" only when Chris decides the post-launch period is complete (typically at the one-month health-report entry + Stage 2 hand-off), at which point the §16 Phase 8 bullets and the §F4 slices should be resolved or filed.

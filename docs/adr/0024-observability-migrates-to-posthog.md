# ADR 0024 — Observability migrates from Datadog to PostHog (dual-run)

**Status:** Accepted (2026-08-24; epic AECI-639, kickoff AECI-641) — **implemented; the
dual-run is over.** AECI-651 removed the Datadog leg on **2026-08-28**, so the decision below
describes a completed migration rather than an in-flight one. Two things the reader should
carry forward: the decommission ran on the **`stage-2` line only** (`main`, which deploys
production, still carries Datadog-only code until the branches merge), and it ran **without the
2–4 week prod soak this ADR made a precondition** — the operator waived that gate knowingly,
accepting that the histogram-p95 reconstruction (§AW6 manual step 2) was never validated against
the Datadog original. That validation is now a standing sanity check in
`POST_LAUNCH_MONITORING.md` §2.7 rather than a gate.
**Build contract:** [`docs/POSTHOG_MIGRATION_SPEC.md`](../POSTHOG_MIGRATION_SPEC.md)
**Builds on:** ADR 0016 (D1/Drizzle topology), ADR 0021 (promote Workflow — whose
observability contract must survive the swap), ADR 0022 (audit-invariant scope — its
"forward to Datadog" wording is updated under this ADR's authority)

## Context

AECi runs a live, operated Datadog installation: a ~50-metric custom catalog emitted by
both Workers over a shared transport (`packages/shared/src/datadog.ts`), 26 applied
monitors + 5 dashboards (`observability/datadog/`, applied to us5), browser RUM carrying
prod Core Web Vitals, the §26.5 audit-log forward, and two operating procedures on top
(`POST_LAUNCH_MONITORING.md`, `RUNBOOKS.md`). PostHog already runs beside it as the
consent-gated product-analytics layer (AECI-239), in one project shared by every tier.

The sibling repo `earned-value` migrated the same architecture off Datadog onto PostHog
end-to-end (EV-97), covering Worker logs/metrics over OTLP, error tracking with source
maps, web vitals, deploy markers, observability-as-code, and feature flags — with all
three intakes authenticated by the publishable project token. Running two observability
vendors across the portfolio, with four Datadog Worker secrets and a per-vendor mental
model, is the situation this ADR ends.

## Decision

Migrate AECi's observability onto PostHog, as a **dual-run**: the PostHog transport
ships beside Datadog (fan-out inside the per-Worker adapters), and Datadog is deleted
only after the spec's verification checklist is green on production plus a 2–4 week
prod soak (AECI-651). Datadog remains the operating safety net for the whole window.

The load-bearing choices, ratified with the operator on 2026-08-24:

1. **Two-mode browser init.** An anonymous operational slice — `capture_exceptions` +
   web vitals, memory persistence, no identifiers — runs for **all** visitors,
   including DNT/GPC browsers. This preserves the exact posture Datadog RUM has today
   (consent-independent, replay off) rather than silently narrowing error coverage to
   the consenting minority, which `ANALYTICS_BASELINE.md` shows is near-zero for
   single-page arrivals. The consent banner **and** DNT/GPC continue to hard-gate
   product analytics (pageviews, the event catalog, identify/groups), unchanged.
   Basis: DNT is a deprecated non-standard (W3C WG closed 2019; Safari removed it 2019,
   Firefox in v135, Feb 2025); GPC is legally binding in 12 US states but only as an
   opt-out of sale/sharing, which AECi does not do; operational telemetry is
   opt-out-exempt in normal industry practice. The privacy policy discloses the posture
   (CalOPPA requires disclosing the DNT response regardless).
2. **Alert model.** The org is on PostHog Pay-as-you-go, so the free tier's 5-alert cap
   does not apply — failure/threshold monitors port individually on merit. **Hourly
   alert cadence is accepted** (15-minute checks require the Boost add-on; revisit
   post-growth). Absence detection — the job Datadog's `notify_no_data` uniquely owned,
   with no PostHog equivalent at any tier — moves to one **external scheduled-CI
   liveness sweep** that queries per-cron heartbeats and fails red + emails; running
   outside the Worker is precisely what lets it detect a dead Worker. `job_runs` +
   `/admin/system` + the digest emails remain the in-product record.
3. **Two projects, not an `env` filter.** Prod = `aec-integrations` (354071),
   production only; non-prod = `aec-integrations-dev` (525793) for
   local/preview/staging/**demo**/stage2, separated by `$host`. Demo had been receiving
   the production key and polluting prod analytics; that ends (AECI-640).
4. **The SSR key injection stays — a deliberate reversal of EV's equivalent step.** EV
   committed per-tier tokens into its environment files; AECi promotes one build by SHA
   across staging → demo → prod, so the artifact cannot know its tier — only the Worker
   can. `window.__AECI_POSTHOG__` (deployment-env-only, cache-safe per §9.1a) remains
   the delivery mechanism. Relatedly, `POSTHOG_KEY` stops being a CI-pushed Worker
   secret and becomes a committed per-env wrangler var: the token is publishable and
   ships in the HTML anyway, and secret-keeping is what caused the weeks-dark prod
   analytics of AECI-326.
5. **The §26.5 audit forward re-targets** through its existing injected-forwarder seam
   to PostHog Logs. The §26.1 audit-row-in-the-same-batch invariant is untouched.
6. **Session replay stays off** — enabling it is a separate privacy review, not a
   migration side-effect.
7. **Branch: `stage-2`**, one PR per workstream, no epic branch — dual-emit keeps every
   workstream independently shippable. Production stays on Datadog until
   `stage-2 → main` merges; the dispatch-only promote workflows execute from `main`, so
   their edits ride the merge.

## Consequences

**Gained:** one vendor across the portfolio; Worker telemetry secrets 4 → 0 (the
publishable token is a var); error tracking with source maps and person/session links —
a capability Datadog RUM was never configured for here; deploy markers on every insight;
feature flags; the product-analytics and ops planes join (server events and browser
events share people/groups).

**Lost or changed (stated, not discovered):** hourly alert cadence replaces 5–15-minute
paging on four monitors; `notify_no_data` is replaced by the CI sweep, which depends on
GitHub Actions availability; **PostHog Metrics is alpha, and AECi leans far harder on
custom metrics than EV did** — the entire cron-health model rides them — mitigated by
the dual-run window and by `job_runs`/admin-panel being an independent record; the
1,000-series cardinality budget forces dropping the raw `status` metric tag and a
standing no-new-tag-without-arithmetic rule; browser search telemetry becomes
consent-scoped where the RUM action saw every search; server-side flag checks cost a
network round-trip (local evaluation needs a personal key, which must never become a
Worker secret).

**Re-open triggers:** a paging-grade incident where hourly detection demonstrably cost
real time → buy Boost or re-home that alert; PostHog Metrics leaving alpha with a
changed query shape → revisit the manual dashboard recipes; the CI sweep proving flaky
as a liveness backstop → reconsider a paid no-data mechanism or an external uptime
service; session replay wanted → its own privacy review, consent-gated + masked per the
EV policy.

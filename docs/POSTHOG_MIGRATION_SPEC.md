# PostHog Migration Spec — Datadog → PostHog (dual-run)

> **Status: complete (2026-08-28).** Every sub-issue including **AECI-651** has shipped, so this
> document is now a **build record**, not an in-flight contract. `docs/OBSERVABILITY.md` is
> canonical for the live plane, which is PostHog only.
>
> Two deviations from what this spec specified, both deliberate and both the operator's call:
> the decommission landed on the **`stage-2` line only** (`main` still runs Datadog-only code
> until the branches merge), and the **2–4 week prod soak in §AW-final was waived** — PostHog
> had never run as production's observability plane when Datadog was removed, so §AW6's
> histogram-p95 spot-check never happened against the original. It survives as a standing check
> in `POST_LAUNCH_MONITORING.md` §2.7.

**Status:** Build contract for epic **AECI-639** (sub-issues AECI-640…651). Committed by
AECI-641 (kickoff). Decisions ratified with Chris 2026-08-24; design rationale in
[ADR 0024](./adr/0024-observability-migrates-to-posthog.md).

**Provenance:** the sibling repo `earned-value` completed this migration end-to-end
(EV-97 / earned-value PR #217). Its migration prompt is the base contract; this document
carries everything AECi needs from it inline (§2) plus the AECi-specific overrides (§3),
so it is self-contained. Where this doc and a general PostHog instinct disagree, this doc
wins; where this doc is silent, the EV decisions in §2 apply.

**Reading guide:** sub-issues anchor to the `AW*` sections (§AW1–§AW9, §AW-final).
§1 is the inventory record, §2–§3 are the normative decisions, the rest are tables and
checklists the workstreams execute against.

**Read §8 before §2–§3.** §8 records what the build actually found — verified intake
behaviour, the cardinality arithmetic that changed the tag vocabulary, and the current
state of every operator prerequisite. Where §8 and an earlier section disagree, §8 wins;
the earlier text is left intact so the delta stays legible.

---

## Decisions record (ratified 2026-08-24)

| # | Decision | Outcome |
|---|---|---|
| D1 | Cutover shape | **Dual-run**: PostHog transport ships beside Datadog (adapter fan-out); Datadog deleted only after verification + prod soak (§AW-final). Datadog is live and operated — 26 monitors, 5 dashboards, runbooks — so no direct swap. |
| D2 | Browser consent posture | **Two-mode init**: an anonymous operational slice (errors + web vitals, memory persistence, no identifiers) runs for **all** visitors — **including DNT/GPC browsers**, matching today's consent-independent Datadog RUM; the consent banner **and** DNT/GPC keep hard-gating product analytics. Industry basis: DNT is deprecated (W3C WG closed 2019; Safari removed 2019, Firefox removed v135 Feb 2025); GPC binds in 12 US states but only for sale/share, which AECi doesn't do; ops telemetry is opt-out-exempt in normal practice. Disclosed in the privacy policy (§AW2). |
| D3 | Alerts | Org is **Pay-as-you-go → alert count unlimited** ("Free tier organizations can create up to 5 alerts total. Paid plans have no limit" — posthog.com/docs/alerts). Port failure/threshold monitors **individually on merit**. **Hourly cadence accepted** (15-min checks need the Boost add-on; revisit post-growth). Liveness/no-data → one **external CI sweep** (§AW6) — no PostHog tier has `notify_no_data`. |
| D4 | Project topology | Prod = `aec-integrations` (**354071**), production tier only. Non-prod = `aec-integrations-dev` (**525793**): local, preview, staging, **demo**, stage2 — separated by `$host`/`env`. (Demo previously received the production key and polluted prod data — fixed by AECI-640.) |
| D5 | Session replay | **OFF at v0** (as since AECI-31); enabling it is a separate privacy review, not part of this migration. |
| D6 | Branch | **`stage-2`**, one PR per workstream, no epic branch (dual-emit keeps each workstream independently shippable). Prod stays on Datadog until `stage-2 → main` merges. The dispatch-only `promote-to-*.yml` workflows execute from `main`; their edits ride the merge or land as small main PRs at cutover. |

---

## §1 Inventory (recorded 2026-08-24)

### Why AECi is the hard case

EV's Datadog was code-complete but never provisioned — a code-only migration. AECi's is
**live and operated**: 5 applied dashboards + 26 applied monitors on us5 (notifications
to the operator), a ~50-metric custom catalog (`docs/OBSERVABILITY.md`), browser RUM
capturing prod Core Web Vitals, and two operating procedures on top
(`docs/POST_LAUNCH_MONITORING.md`, `docs/RUNBOOKS.md`). Hence D1.

### Datadog touchpoints

| Touchpoint | Where |
|---|---|
| Shared Worker transport | `packages/shared/src/datadog.ts` (`createDatadogClient({service, worker, ddSource})`) + thin adapters `apps/api/src/datadog.ts`, `apps/web/src/server-datadog.ts`; ~47 non-spec files call `logToDatadog`/`submit*` |
| §26.5 audit forward | `packages/shared/src/audit-log.ts` (`forwardAuditLog`/`forwardWorkflowTransition`) — forwarder is injected, already transport-agnostic |
| API request metrics | `apps/api/src/metrics-middleware.ts` — `endpoint` (matched pattern) + raw `status` + `status_class` |
| Metric catalog | `docs/OBSERVABILITY.md` — ~50 `aeci.*` metrics; rigorous failure-vs-liveness split throughout |
| Dashboards + monitors as code | `observability/datadog/` — 5 dashboards, 26 monitors (applied live; JSON is for-record) |
| Browser RUM | `apps/web/src/app/datadog.provider.ts` (`@datadog/browser-rum`, consent-independent, replay off, CWV, `aeci.app_started`), `search-rum.ts` (`aeci.search.query` action), `__AECI_DD__` inject |
| Secrets/vars | `DD_API_KEY` (both Workers, all envs, manually provisioned), `DD_APPLICATION_ID`+`DD_CLIENT_TOKEN` (web, CI-pushed by 4 workflows), `DD_SITE` vars (~12 env blocks), `DD_APP_KEY` (operator), `.dev.vars.example` both apps, `RECOMMENDED_SECRETS` lists |
| CI | `deploy.yml`, `pr-preview.yml`, `promote-to-demo.yml`, `promote-to-prod.yml`, `refresh-staging.yml` + comments in others |
| WAF poll | `apps/api/src/lib/waf-metrics.ts` + `packages/shared/src/cloudflare-analytics.ts` (`CF_ZONE_ID`/`CF_ANALYTICS_API_TOKEN` stay — vendor-independent) |
| Docs naming Datadog | `OBSERVABILITY.md`, `RUNBOOKS.md`, `POST_LAUNCH_MONITORING.md`, `ANALYTICS_BASELINE.md`, `POST_LAUNCH_HEALTH_REPORT.md`, `environments.md`, `CICD_PLAN.md`, `email.md`, `local-tracing.md`, `CODE_REVIEW_CHECKLIST.md`, `ADMIN_PANEL_SPEC.md` §7.2, `STAGE_1_SPEC.md` §26.5/§14, ADR 0022, `CLAUDE.md`, phase-completion docs |
| Admin panel prose | `apps/web/src/app/admin/system/system-status.ts`, `admin-notes.ts` |

### Existing PostHog state

- **Browser product analytics** (AECI-239): consent-gated `posthog-js` in
  `apps/web/src/app/analytics/`; 8 custom events already `snake_case object_verb` with
  `snake_case` properties; auto pageviews `history_change`; `locale`+`theme` dimensions.
  Prod is provisioned (verified live 2026-08-24: served HTML injects `__AECI_POSTHOG__`
  and `__AECI_DD__` — the "prod is dark" state in `ANALYTICS_BASELINE.md` is stale).
- **Org** "The WBS Project": `aec-integrations` (354071, live data),
  `aec-integrations-dev` (525793, empty — ready-made non-prod), plus the two EV projects
  and `wbs-homepage`. 0 insight alerts existed org-wide at inventory time.
- **Operator-traffic caveat:** the operator's consented browser feeds prod product
  analytics while `page_views` excludes them via verified admin session — fixed by the
  internal-user exclusion in AECI-640/§AW8.

---

## §2 Decisions carried from the EV migration (normative)

### Transport architecture

`packages/shared/src/posthog.ts` exposes `createPosthogClient({ service, worker, source })`;
each Worker ships a thin adapter pinning identity (`aeci-api`/`aeci-api`/`worker`;
`aeci-web`/`aeci-web`/`worker-angular`). One shared factory, never two copies.
**Rename-only call-site surface:** `logToDatadog` → `logToPosthog`; `submitCount` /
`submitGauge` / `submitDistribution` / `hostnameFromRequest` keep signatures. New:
`captureEvent`, `captureException`, `isFeatureEnabled`, and — since AECI-666 —
`logBatchToPosthog` (§8.12).

**Three pipes, two mechanisms:** events + exceptions via `posthog-node`'s workerd export
(`posthog-node/edge`); logs + metrics via hand-rolled OTLP/HTTP JSON to `{host}/i/v1/logs`
and `{host}/i/v1/metrics` (the SDK's metrics client aggregates in-memory over 10 s — wrong
for short-lived isolates; emit per call). All three intakes authenticate with the
publishable `phc_` project token → **Worker telemetry secrets 4 → 0**;
`POSTHOG_PROJECT_KEY` + `POSTHOG_HOST` are plain per-env wrangler vars.

### Four invariants (unchanged from the Datadog transport)

1. Every dispatch via `ctx.waitUntil(...)` — never blocks the response.
2. A forwarding failure must not throw — `console.warn` and swallow.
3. No project key → total no-op (keyless local/preview is the design).
4. One tag vocabulary on all pipes: `env` · `app:aeci` · `service` · `worker` ·
   `version` · `locale` · `host`; emit `service.name` as an OTLP **resource** attribute
   (the Logs explorer's service filter reads only that). `version` = `COMMIT_SHA`
   (already injected, AECI-74); `host` from the request URL.

### workerd gotchas (encode in the transport, with comments)

- **Build the `posthog-node` client per request**; `flushAt: 1`, `flushInterval: 0`.
- **Flush via `ctx.waitUntil(client.flush())` — never `captureImmediate` /
  `captureExceptionImmediate`** (they resolve before the network send finishes; the
  isolate tears down mid-flight and the event vanishes — the single most expensive
  mistake available in the file).
- `fetchRetryCount: 0` — retry-with-backoff inside `waitUntil` is the wrong trade.
- `disableGeoip: true` — else every server event geo-resolves to the Worker egress
  datacentre.
- **Release the intake response body on every path** (`discardResponseBody`,
  `@aeci/shared/response-drain`) — including the `!res.ok` path, which only reads a
  snippet. An unread body holds an open connection, a Worker invocation may hold only
  ~6, and past that the runtime cancels the stalled responses into `fetch` promises
  that **never settle** — so the `res.ok` guard above and its `catch` both go unrun
  and the outage is completely silent. See §8.12 (AECI-666).

### OTLP payload details (copy verbatim)

- Severity: `debug:5/DEBUG`, `info:9/INFO`, `warn:13/WARN`, `error:17/ERROR`.
- Timestamps: ns as a **string** (`` `${Date.now()}000000` ``).
- `aggregationTemporality: 1` (DELTA); counts = `sum` with `isMonotonic: true`; gauges =
  `gauge`; durations = `histogram` with **explicit bounds**
  `[5,10,25,50,75,100,250,500,750,1000,1500,2500,5000,7500,10000]` ms (brackets the
  1.5 s p95 thresholds; `bucketCounts` has `bounds.length + 1` entries).
- `key:value` tag strings split on the **first** colon only (route patterns contain
  colons).
- Numbers → `doubleValue`, else `stringValue`; drop `undefined`/`null`.
- Point attributes carry only the caller's tags — the shared vocabulary rides as
  resource attributes; repeating it per point multiplies series count.

### pnpm trap

Declare `posthog-node` in **each consuming app's** `package.json`, not only the shared
package: the Angular production build resolves from the importing file (succeeds) while
the Vite dev server resolves the bare specifier from the app root (fails). **A green
`pnpm build` does not prove `pnpm dev` works — check both.** Record at the top of the
transport.

### Metric discipline

Tag by **matched route pattern**, never concrete path. Tag `status_class`, **not** raw
`status` (the code lives on the error log). **Never a user/person/session id on a
metric.** Failure and liveness stay separate signals: emit on every run with `outcome`;
never alert below-threshold on a failure slice (empty on healthy days → constant alert).
The gated render log (AECI-103 `shouldEmitRenderLog`) ports as-is.

### Host split gotcha

`us.posthog.com` is the **management** API; `us.i.posthog.com` is **ingest**. Easy to
swap; the failure is a confusing 404. CSP `connect-src` needs the ingest host + the
assets host (`us-assets.i.posthog.com`) — both already allowlisted.

---

## §3 AECi-specific overrides

### §3.1 Dual-run, then delete (O1)

Ship the PostHog transport **beside** Datadog: the per-Worker adapters expose the new
names and fan out to both vendors internally (each leg keeps its own
no-op-without-config behaviour). Call sites rename once; the Datadog leg dies inside the
adapters at §AW-final. Window: 2–4 weeks of verified operation. Cost: doubled telemetry
egress per request for the window — bounded, accepted.

### §3.2 The SSR bootstrap injection stays (O2 — reverses EV's WS2)

EV deleted browser env-injection because its token could be committed per tier in
`environments/*.ts`. AECi promotes **one build by SHA** across staging → demo → prod
(`docs/environments.md`), so the artifact carries no tier knowledge — only the Worker
does. `window.__AECI_POSTHOG__` (deployment-env-only, cache-safe per §9.1a) stays; only
`__AECI_DD__` is deleted at the end. Related: `POSTHOG_KEY` stops being a CI-pushed
secret and becomes the committed `POSTHOG_PROJECT_KEY` var (AECI-640) — the token is
publishable and ships in the HTML; keeping it a secret is what produced the weeks-dark
prod analytics of AECI-326.

### §3.3 Two-mode consent init (O3 / D2)

- **Tier 1 — server-side (never gated):** Worker logs (incl. §26.5 audit forwards), all
  metrics, cron heartbeats, promote-job events, deploy markers. Consent does not apply.
- **Tier 2 — browser operational (runs for all visitors, DNT/GPC included):**
  `persistence: 'memory'`, `autocapture: false`, no pageviews/pageleave, no session
  recording, `capture_exceptions: true`, `capture_performance: { web_vitals: true }`,
  plus `PosthogErrorHandler` (Angular `ErrorHandler` → `captureException`; Angular
  swallows app errors before `window.onerror`, so `capture_exceptions` alone reports
  almost no application errors; keep `console.error`). No identifier is written; each
  page load is a fresh anonymous id — error *occurrence* counts, not affected-visitor
  counts, and that is the accepted price of anonymity.
- **Tier 3 — product analytics (banner-gated; DNT/GPC = hard deny, as today):** on
  consent grant the same client upgrades in place (localStorage persistence,
  `$pageview`, the 8-event catalog, later `identify`/groups). Decline and DNT/GPC stay
  Tier 2.
- Privacy policy discloses the posture (§AW2). Session replay off (D5).

### §3.4 Alert model (O4 / D3)

Unlimited count (paid org), **hourly cadence** floor. Port failure/threshold monitors
individually per the §5 disposition table. Absence detection ("the Worker never
started") moves to the **external liveness sweep** (§AW6): a scheduled GitHub Actions
workflow querying the prod project for per-cron heartbeats, failing red + emailing on a
missing series — it runs outside the Worker, which is the property that made "Datadog
owns absence" true, and it replaces all 8 `notify_no_data` monitors with one job.
`job_runs` + `/admin/system` + the daily digest emails remain the in-product record
(unchanged; `ADMIN_PANEL_SPEC.md` §7.2's "Datadog owns absence" is reworded to name the
sweep).

### §3.5 Cardinality budget (O5)

PostHog guardrails at 1,000 metric series per window; series identity includes resource
attributes (`version` doubles every dimension while two deploy versions are live). The
raw `status` tag is dropped (§AW1). §AW4 computes and commits the catalogue-wide
arithmetic and the standing rule: **no new tag without redoing the arithmetic.**

### §3.6 Project topology (O6 / D4)

Two projects, not one project with an `env` filter. Prod history note: pre-migration
events in 354071 carry mixed tiers — filter by `$host` when reading history. Repo
variables `POSTHOG_PROJECT_ID_PROD=354071` / `POSTHOG_PROJECT_ID_NONPROD=525793`.

### §3.7 Audit forward (O7)

`forwardAuditLog` / `forwardWorkflowTransition` keep the injected-forwarder seam, wired
to `logToPosthog` (OTLP logs) with the same entry attributes. **A caller emitting N
entries at once uses `logBatchToPosthog` instead** and drops the forwarder closure
entirely — one request per vendor rather than N (§8.12 / AECI-666). All three such
callers (`routes/promote.ts`, `lib/attestation-notify.ts`, `routes/vendor-shared.ts`)
are batched; the single-entry callers are unchanged. The §26.1
audit-row-in-the-same-batch invariant is untouched — forwarding is post-commit only.
`STAGE_1_SPEC.md` §26.5, ADR 0022's wording, and CLAUDE.md's constraint bullet update in
§AW7 under ADR 0024's authority.

### §3.8 What is knowingly lost or changed (state, don't discover)

Hourly alert cadence (was 5–15 min paging on 4 monitors) · no `notify_no_data` (the
sweep depends on GitHub Actions availability — say so in RUNBOOKS) · PostHog Metrics is
**alpha**, and AECi leans far harder on custom metrics than EV did (the entire
cron-health model) — mitigated by the dual-run window and by `job_runs`/admin panel
being an independent record · no APM/distributed tracing (none was in use; local
`wrangler dev` OTel tracing is unaffected — `docs/local-tracing.md`; its
"outbound-fetch-span proves the forward fired" trick now points at PostHog hosts) ·
server-side flags cost a network round-trip · browser search telemetry becomes
consent-scoped (the `search_performed` enrichment) where the RUM action saw all
searches.

### §3.9 The `aeci.search.query` re-home

The RUM action + its two RUM-sourced Phase-3 dashboard widgets retire; `status`,
`duration_ms`, `results_bucket` fold into the existing `search_performed` event
(consented slice). Accepted narrowing per §3.8.

### §3.10 Vendor identity is Stage-2-native (O10)

The vendor portal exists on `stage-2`, so §AW8 wires `identify(user.id)` after Supabase
auth, `group('vendor', vendor_id, { name })` on vendor-dashboard entry, and
`posthog.reset()` on logout. Server-side mirrors fall back to the service slug
(`aeci-api`) as `distinct_id` — never mint per-request ids.

---

## §4 Workstreams (one PR each; docs ship in the same PR)

| § | Issue | Scope |
|---|---|---|
| — | AECI-640 | Easy wins, base `main`: demo→dev-project repoint, committed `POSTHOG_PROJECT_KEY` vars, deploy markers, operator provisioning (`phx_` key, repo variables, error-tracking toggle, internal-user exclusion) |
| — | AECI-641 | Kickoff: this spec + ADR 0024 + index/CLAUDE.md rows |
| AW1 | AECI-642 | Shared transport → PostHog, dual-emit, rename, audit-forward rewire, drop raw `status` |
| AW2 | AECI-643 | Browser two-mode init, `PosthogErrorHandler`, web vitals, search enrichment, bench error button, privacy-policy disclosure; RUM stays |
| AW3 | AECI-644 | `posthogDistinctId` on genuinely-authed logs only |
| AW4 | AECI-645 | Cardinality arithmetic + tag rules committed to the observability doc |
| AW5 | AECI-646 | Hidden source maps + inject/upload/delete-after; main-workflow sequencing; `actionlint`/`bash -n` |
| AW6 | AECI-647 | `observability/posthog/` + `apply.sh` + individually-ported alerts (hourly) + the external liveness sweep (drilled) + dashboards in both projects |
| AW7 | AECI-648 | Docs sweep (OBSERVABILITY rewrite; RUNBOOKS + POST_LAUNCH_MONITORING reworked, not find-replaced; spec §26.5; CLAUDE.md; purge grep) |
| AW8 | AECI-649 | `docs/ANALYTICS.md`, activation funnel (`search_performed → product_viewed → external_link_clicked`), vendor identify/groups, operator exclusion |
| AW9 | AECI-650 | Feature flags: `featureFlagDefaults` catalogue/type, no-`undefined` signals, keyless determinism, server `isFeatureEnabled` + warning, **flags never alter cacheable SSR output** (§9.1a — browser reconciliation or API-Worker behaviour only) |
| AW-final | AECI-651 | Datadog decommission — gated on `stage-2 → main` + §6 green on prod + a 2–4 week prod soak. Deletes code legs, RUM, `observability/datadog/`, every `DD_*`, CSP hosts, **and the live Datadog monitors/dashboards in the UI** |

`apply.sh` requirements (AW6, from EV verbatim): thin applier over committed JSON; fails
loudly with a per-project failure summary while still completing the run; idempotent by
name; preflight probes every optional scope and reports all misses at once; `--dry-run`
and `--verify`; dashboards created in **both** projects (alerts prod-only); runs on
stock macOS bash 3.2 (no `declare -A`/namerefs/`mapfile`; `:-` guards on array
expansions; no `((${#ARR[@]})) && cmd`); prints a recreate recipe instead of an API call
for anything backed by PostHog Metrics (alpha) or alert-to-insight attachment; reads the
personal key from `POSTHOG_PERSONAL_API_KEY` or `POSTHOG_CLI_API_KEY` (keychain-sourced;
cannot read the GitHub secret).

## §5 Monitor disposition (all 26)

| Datadog monitor | New home |
|---|---|
| Worker error rate high (5xx > 1%/5m) | PostHog alert |
| Algolia sync failed | PostHog alert (or combined any-failure insight — AW6's call, recorded in RUNBOOKS) |
| Home stats compute failed | PostHog alert / combined |
| Data quality job failed | PostHog alert / combined |
| Data quality check — error severity | PostHog alert / combined |
| Retention prune failed | PostHog alert / combined |
| Linear reconcile: persistent stuck | PostHog alert / combined |
| Retention prune runaway (>5,000 rows/1d) | PostHog alert / combined |
| Algolia orphan sweep capped | PostHog alert / combined |
| Detail render slow (p95 >1.5 s MISS) | Alert or dashboard — AW6 judges vs Metrics-alpha insight support |
| Auth sign-in error rate (>30%/15m) | Alert (hourly) or dashboard+digest — AW6 judges |
| Toxicity scoring outage (>50%/15m) | Alert (hourly) or dashboard+digest |
| page_views write errors (>10%/10m) | Alert (hourly) or dashboard+digest |
| Linear pipeline failure (>50%/1h) | Alert (hourly) or dashboard+digest |
| Linear webhook HMAC failures (>3/1h) | Alert (hourly) or dashboard+digest |
| WAF rate-limit spike (>500/15m) | Alert (hourly) or dashboard+digest |
| Retention prune skipped (non-paging) | Digest (already carries it) |
| Data quality warn severity (non-paging) | Digest (already carries it) |
| Algolia sync not running *(no-data)* | Liveness sweep |
| Home stats not running *(no-data)* | Liveness sweep |
| Data quality not running *(no-data)* | Liveness sweep |
| Reconcile sweep not running *(no-data)* | Liveness sweep |
| WAF poll not running *(no-data)* | Liveness sweep |
| Retention prune not running *(no-data)* | Liveness sweep |
| Algolia index drift *(dual: value + no-data)* | Digest (report-only value) + sweep (liveness half) |
| Moderation queue backlog *(dual)* | Dashboard/digest (backlog) + sweep (liveness half) |

Every monitor that lands anywhere other than a PostHog alert is recorded in
`RUNBOOKS.md`'s alert table **with its old threshold**, so re-promotion is a config
change, not archaeology.

## §6 Verification (do, don't assert)

1. Worker metrics in the metrics viewer split by `endpoint` (traffic via the renamed
   traffic-gen e2e spec).
2. Worker logs filtered by `service.name` (`aeci-api`/`aeci-web`) with `env` +
   `version`; saved views per service and `severity_number >= 13`.
3. An audit-bearing write (e.g. review submit) shows its §26.5 forward as a PostHog log;
   locally, the outbound `fetch` span to `us.i.posthog.com` in local tracing confirms
   the forward fired.
4. Browser: `app_started` + `$web_vitals` **pre-consent**; `$pageview` + the 8 events
   **post-consent**; nothing persistent written pre-consent (inspect storage); DNT/GPC
   browser still emits Tier 2, never Tier 3.
5. Angular error capture via the dev-only bench-route throw button (stripped from prod
   bundles — verify the string is absent). Devtools-console throws are not a substitute.
6. Source maps: prod stack unminified; every chunk `Uploaded` under Symbol sets; zero
   `sourceMappingURL` comments in served JS.
7. A promote run: kick-off + job metrics and the `job_failed`/`partial_skipped`/
   `replay_detected` log paths visible in PostHog (`REVIEW_APP_PROMOTE_API.md` §6.3's
   "every rejected promote is observable" survives the vendor swap).
8. The liveness sweep drill: simulate a missing heartbeat, watch the workflow fail red +
   email.
9. An email/side-effect pipe: trigger one; both the metric and any mirrored event arrive
   with expected `outcome` + `template`.
10. `pnpm dev:agent` boots and serves an SSR 200 — separately from `pnpm build` (§2 pnpm
    trap). Full gate green; `actionlint` + `bash -n` locally.

## §7 Operator prerequisites

- Personal `phx_` key scoped to both AECi projects (insight/dashboard/alert write,
  project read; optional project/logs/feature-flag write for `apply.sh` extras) → GH
  secret `POSTHOG_CLI_API_KEY` + operator keychain.
- Repo variables `POSTHOG_PROJECT_ID_PROD=354071` / `POSTHOG_PROJECT_ID_NONPROD=525793`.
- Error-tracking product enabled on both projects; internal-user exclusion configured.
- After AW6: `apply.sh --dry-run` → `apply.sh`; paste dashboard URLs into the
  observability doc.
- At AW-final: delete live Datadog monitors/dashboards in the UI, the per-env
  `DD_API_KEY` Worker secrets, and the `DATADOG_API_KEY`/`DD_APPLICATION_ID`/
  `DD_CLIENT_TOKEN` GH secrets; decide the Datadog account's fate.

---

## §8 As-built amendments (recorded during the build)

Findings that came out of *doing* the migration rather than planning it. Each
one supersedes the corresponding statement above; the original text is left
intact so the delta is legible.

### §8.1 Verified intake facts (AECI-642)

Probed live against `aec-integrations-dev` (525793), not inferred from docs:

| Fact | Detail |
|---|---|
| OTLP logs | `POST https://us.i.posthog.com/i/v1/logs` → `200 {}` |
| OTLP metrics | `POST https://us.i.posthog.com/i/v1/metrics` → `200 {}` |
| Auth | `Authorization: Bearer <phc_ project token>` is **required** on both. The `?api_key=` query form returns `401 {"error":"No token provided"}` — the opposite of `/capture/`, which takes the key in the body. |
| Capture | `/i/v1/e/` **does not exist** (404). Use `/capture/` (or `/i/v0/e/`). A `/i/v1/e/` typo is a silent 404 that reads exactly like a config problem. |
| Number encoding | OTLP metric **data points** use `asDouble`; **attribute values** use `doubleValue`. §2's "numbers → `doubleValue`" rule is about attributes only. |
| Gauge temporality | OTLP's `Gauge` message has **no** `aggregationTemporality` field. §2's DELTA rule applies to the sum and histogram pipes; `submitGauge` omits it rather than sending `1`, which a strict parser could reject. |

### §8.2 The cardinality arithmetic changed the tag vocabulary (AECI-645)

§3.5 anticipated that dropping the raw `status` tag would bring the catalogue
inside PostHog's 1,000-series guardrail. It does not. The full arithmetic
(committed in `docs/OBSERVABILITY.md`) is **≈854 series at steady state** and
**≈1,708 while a deploy has two `version`s live** — over the guardrail on
`version` alone.

Three consequences, all implemented in AECI-642:

1. Raw `status` dropped from `aeci.api.query.duration_ms` as planned. With it,
   that one metric was ~930 series — over the entire budget by itself.
2. Raw `status_code` dropped from `aeci.page.render.duration_ms`. §AW1 did not
   name this one; it is the same defect on the web side.
3. **`host` is a log and event attribute, not a metric attribute.** This is a
   deliberate, arithmetic-backed exception to invariant 4 ("one tag vocabulary
   on all pipes"). In the non-production project the preview tier deploys **one
   Worker per pull request**, so `host` on a metric is unbounded cardinality
   that grows with every PR, forever — and no tag discipline elsewhere would
   recover it. Enforced structurally: `postMetric()` does not accept a
   `Request`, so `host` cannot be re-added to a metric by accident.

### §8.3 `POSTHOG_CLI_API_KEY` scopes (AECI-646)

§7 lists insight/dashboard/alert write + project read, which covers `apply.sh`.
Source-map upload additionally requires **`error tracking write`** and
**`organization read`**. One personal key needs the **union** of both sets.

### §8.4 There is no `staging` build configuration (AECI-646)

§AW5 asks for hidden source maps on "production **and** staging" Angular
configurations. `apps/web/angular.json` has only `production` and
`development`. That is correct and not an omission: AECi promotes **one build
by SHA** across staging → demo → prod (`docs/environments.md`), so `production`
*is* the configuration every deployed tier is built with. The bare
`"sourceMap": true` §AW5 refers to is on `development`, and stays.

### §8.5 `@aeci/shared/posthog` is not in the barrel (AECI-642)

Every other module in `packages/shared/src/index.ts` is a pure declaration.
`posthog.ts` pulls a real npm dependency (`posthog-node`), and the barrel is
imported by browser code — which is exactly the shape of the 327 kB zod
regression recorded in `packages/shared/package.json`. The adapters import the
`@aeci/shared/posthog` subpath instead.

### §8.6 Deploy markers ship two legs, and one works without provisioning (AECI-640)

§AW5's marker requirement is satisfied by `scripts/ci/posthog-deploy-marker.sh`:
a project **annotation** (the line across every insight — needs the personal
`phx_` key, warn-skips without it) and a queryable **`deployment` event** (what
a HogQL query joins against — needs only the publishable token, so it works
today, before any operator step). Verified live: the event arrives with
`env` / `service` / `version` / `deploy_kind` intact.

### §8.7 Operator prerequisites — current state

**Re-checked live 2026-08-26.** Error tracking and web vitals are now enabled on
**both** projects, so §6(4)'s `$web_vitals` check and browser exception capture
are unblocked. Two collection surfaces remain open, both privacy-facing rather
than functional:

| Surface | prod (354071) | non-prod (525793) |
|---|---|---|
| Session replay | **enabled** ❗ | **enabled** ❗ (was off) |
| Heatmaps | **enabled** ❗ | off |

D5 says replay is off at v0 pending a separate privacy review. Today that is
held *only* by `disable_session_recording: true` in `posthog-client.ts` — one
line, no test covering it, and any other PostHog client pointed at these
projects (the toolbar, a future integration) would not inherit it. Turning both
off at the project level makes D5 belt-and-braces.

The table below is the original list; rows marked ✅ are done.

Live check, 2026-08-24. None of these block the code; each gates a capability.

| Prerequisite | State |
|---|---|
| Personal `phx_` key → `POSTHOG_CLI_API_KEY` | ✅ **Created 2026-08-26** (GH secret + `apply.sh` run pending). Was: not provisioned. Deploy annotations and source-map upload warn-skip until it exists. Needs the §8.3 union of scopes. |
| `POSTHOG_PROJECT_ID_PROD` / `_NONPROD` repo variables | **Not set.** The workflows fall back to the literals `354071` / `525793`, so this is a repoint convenience, not a prerequisite. |
| Error tracking (exception autocapture) | ✅ **Enabled on both, 2026-08-26.** Was: disabled on both. Browser and Worker exception capture has nowhere to land until it is enabled. Dashboard-only — the API key available here lacks `product_enablement:write`. |
| Internal-user exclusion | **Not configured.** Until it is, production product analytics carry operator traffic while `page_views` excludes it via verified admin session — so the two surfaces disagree for a reason that looks like a bug. |
| `POSTHOG_KEY_STAGING` / `POSTHOG_KEY_PRODUCTION` GH secrets | **Now unused** — delete. |
| Web vitals (`capturePerformance.web_vitals`) | ✅ **Enabled on both, 2026-08-26.** Was: on in prod, off in non-prod. Enable on 525793 or `$web_vitals` is untestable on every tier you would test on (§8.8). |
| Session replay at the **project** level | **Enabled on prod**, off on non-prod. D5 says replay is off; today only the client's `disable_session_recording` enforces that on production. Turn it off at the project level too. |
| Heatmaps at the **project** level | **Enabled on prod.** Same class as replay — a collection surface D5's privacy review never covered. |

### §8.8 PostHog's remote config is a server-side gate the client cannot override

> **Dated addendum — 2026-08-26, verified live.** The **non-prod project's toggles have since
> been flipped on**, so the disagreement recorded below is no longer the shape it describes.
> Re-fetched from `/array/{token}/config` on 2026-08-26:
>
> | Setting | prod `aec-integrations` (354071) | non-prod `aec-integrations-dev` (525793) |
> |---|---|---|
> | `capturePerformance.web_vitals` | true | **true** _(was `false`)_ |
> | `errorTracking.autocaptureExceptions` | **true** _(was `false`)_ | **true** _(was `false`)_ |
> | `heatmaps` | true | false |
> | `sessionRecording` | enabled (full object) | **enabled (full object)** _(was `false`)_ |
>
> Three consequences:
>
> 1. **`$web_vitals` now fires on preview / staging / demo / stage2.** The "silently does
>    nothing on the tiers you would actually test on" warning below is **historical** — §6(4)
>    is now verifiable on a non-prod tier.
> 2. **Exception autocapture is on for both projects**, so `$exception` now arrives from the
>    window-level path too, not only the manual `captureException` one (which was never gated).
> 3. **D5 is now held by the client alone on BOTH projects.** Replay is enabled at the project
>    level everywhere; the only thing stopping it is `disable_session_recording: true` in
>    `posthog-client.ts`. The "one config regression away" risk stated at the end of this
>    section now applies to **every** tier, not just production, and there is still no test
>    that catches it.
>
> The 2026-08-24 record below is left intact deliberately.


Found during the live verification pass, and **not anticipated anywhere in
§2–§3**: on init, `posthog-js` fetches
`https://us-assets.i.posthog.com/array/{phc_token}/config` and that response
**overrides client-side config for the two operational signals**. For the
non-prod project today it returns:

```json
{ "capturePerformance": { "network_timing": true, "web_vitals": false, … },
  "autocaptureExceptions": false,
  "errorTracking": { "autocaptureExceptions": false, … },
  "sessionRecording": false,
  "analytics": { "endpoint": "/i/v0/e/" } }
```

So setting `capture_performance: { web_vitals: true }` in `posthog.init()` is
**necessary but not sufficient** — `$web_vitals` does not fire until web
vitals is enabled in the **project settings**. The same is true of exception
autocapture. Both are operator toggles, not code.

**And the two projects disagree**, which is the part that will waste someone's
afternoon. Compared live:

| Setting | prod (354071) | non-prod (525793) |
|---|---|---|
| `capturePerformance.web_vitals` | **true** | **false** |
| `errorTracking.autocaptureExceptions` | false | false |
| `heatmaps` | **true** | false |
| `sessionRecording` | **enabled** (full config object) | `false` |

So web vitals works in production and **silently does nothing** on preview,
staging, demo and stage2 — the tiers you would actually test on. A verification
run against the non-prod project will conclude "web vitals is broken" when the
code is fine.

Two consequences worth stating plainly:

1. **§7's operator list was incomplete.** It named "error-tracking product
   enabled on both projects" but not web vitals. Both are required for §6(4)
   to pass, on **both** projects. §8.7 now carries them.
2. **Manual capture is NOT gated.** `posthog.captureException(...)` — the path
   `PosthogErrorHandler` uses, and the load-bearing one per §3.3 — delivers
   `$exception` events even while `autocaptureExceptions` is false. Verified
   live: an uncaught error routed through Angular's global error listener into
   the `ErrorHandler` arrived in the project. What project-level error tracking
   gates is the **issue grouping / Error Tracking product**, not ingestion.
   So the browser error path works today; it just has no console to read it in
   until the toggle is flipped.

**D5 is currently held by the client alone on production.** `sessionRecording`
is `false` on the non-prod project, but production returns a **full session
recording config object** — replay is enabled at the project level there. The
only thing stopping production sessions being recorded today is the client's
`disable_session_recording: true`. That is one config regression away from
recording production visitors without the privacy review D5 requires, and it
would not be caught by any test in this repo. `heatmaps: true` on production is
the same class of thing.

Both are operator toggles (§8.7). Turning them off at the project level makes
D5 belt-and-braces instead of a single point of failure.

### §8.9 Live verification results (2026-08-24, local `dev:agent` + dev project)

What the §6 checklist actually returned, run against `pnpm dev:agent`
(SSR :8790 / API :8789) reporting to `aec-integrations-dev` (525793).

| §6 check | Result |
|---|---|
| 1. Worker metrics reach the intake | ✅ `POST /i/v1/metrics` → 200, repeatedly. PostHog Metrics is alpha and has **no read tool**, so "split by `endpoint`" is unverifiable from here; the intake accepting is the available evidence. |
| 2. Worker logs by `service.name` with `env` + `version` | ✅ Both Workers. Resource attributes arrive complete: `app`, `env: preview`, `host`, `locale`, `service`, **`service.name`**, `source` (`worker` / `worker-angular`), `version` = the real `COMMIT_SHA`, `worker`. The AECI-103 gated `ssr.render` log ported as-is and fires. |
| 3. §26.5 audit forward visible as a PostHog log | ⚠️ Partial. Local tracing shows outbound `fetch` spans to `us.i.posthog.com/i/v1/logs` returning 200, which is the mechanism — but no audit-bearing write was triggered in this pass. |
| 4. Browser Tier 2 pre-consent | ✅ `app_started` arrived **twice, pre-consent, with a stored `denied` decision**, carrying `locale`/`theme`. Zero PostHog storage keys in `localStorage`/`sessionStorage`. `$pageview` correctly absent. ❌ `$web_vitals` — blocked by §8.8, not by the code. |
| 5. Angular error capture | ✅ An uncaught error through Angular's global error listener → `ErrorHandler` → `captureException` arrived as `$exception`. The bench button is correctly **absent** from the production bundle, so the global-listener path stood in for it. |
| 6. Source maps | ✅ 122 `.map` emitted, **0** `sourceMappingURL` comments in served JS, 0 `.css.map`; the skip path deleted all 122 while leaving the 122 chunks. |
| 7. A promote run | ❌ Not run — needs `REVIEW_APP_TOKEN`, absent from local `.dev.vars`. |
| 8. Liveness sweep drill | ✅ Drilled against a stub speaking the real query envelope: fresh → exit 0; missing → exit 1; stale → exit 1; PostHog 5xx / no key → exit 2 ("UNCHECKED, not healthy"). |
| 9. Email/side-effect pipe | ❌ Not run deliberately — local `.dev.vars` holds a live Resend key, so triggering it would send real mail. |
| 10. `dev:agent` boots + SSR 200, separately from `pnpm build` | ✅ SSR 200, `/api/health` 200, `__AECI_POSTHOG__` injected with the committed non-prod key, `__AECI_DD__` still injected. The pnpm strict-layout trap is clear. |

**The dual-run fan-out is proven end to end, not asserted.** In the same local
run, one set of call sites produced `us.i.posthog.com/i/v1/{logs,metrics}` →
**200** *and* `api.us5.datadoghq.com` + `http-intake.logs.us5.datadoghq.com` →
**202**, concurrently.

**Harness notes for whoever re-runs check 4.** Two separate traps, both of which
make a working implementation look broken.

1. **Batching.** `posthog-js` flushes on the visible→hidden transition. An
   automation tab that was *never* visible never makes that transition, and its
   timers are throttled, so events sit in the queue. Dispatch a `pagehide`
   event on `window` to force the flush. With that, `app_started` arrives
   reliably (confirmed twice).

2. **`$web_vitals` cannot be verified from a headless/background tab at all**,
   and this is by design in the `web-vitals` library rather than a PostHog or
   AECi issue: LCP is discarded outright if the page was hidden before first
   paint, and CLS/INP need real visibility and interaction. Re-enabling the
   project toggle (done 2026-08-26) did **not** make it appear locally, because
   the blocker moved from the project setting to the harness.

   **So check 4's `$web_vitals` half is only verifiable in a real, visible
   browser against a deployed tier.** Do it on the first PR preview after this
   branch deploys; do not spend time on it locally. Everything else in check 4 —
   Tier 2 firing pre-consent for a `denied` visitor, no persistent storage,
   `$pageview` correctly absent — is verified and re-verified.

### §8.10 The `aeci.search.query` re-home narrows twice, not once

§3.9 records one narrowing: the RUM action saw every search, the
`search_performed` event sees the consented slice. There is a **second** one it
does not mention.

The RUM action carried an **`index`** dimension (`products` / `vendors` /
`integrations` / `federated`). `search_performed` has no such property — it
reports federated `results_count` and the root index's `processingTimeMS`. So
the **per-index split is gone**, not merely the unconsented traffic, and the
two Phase-3 dashboard widgets that used it are regrouped by `results_bucket`
and by day (AECI-647).

**Largely closed, after the fact.** `search_performed` now carries
`results_products` and `results_vendors` — each index's own `nbHits` on the same
event. Adding a property is not renaming an event, so §1 of
`docs/ANALYTICS.md` permits it.

It is deliberately **not** the RUM shape. RUM fired once *per index*; emitting
per index here would mean two events per search, and `search_performed` would
stop meaning "a search" — which is the first step of the activation funnel
(`ANALYTICS.md` §6). One event with per-index counts answers the question the
`index` dimension answered ("which entity type did this query find?") without
changing what the event counts.

Two things still differ from RUM and are accepted: `duration_ms` remains the
root (products) index's `processingTimeMS` rather than per-index, and there are
only **two** indexes — `/search` runs products and vendors, so there is no
`results_integrations`.

### §8.11 "Dashboards in both projects" — how it was resolved

§4's `apply.sh` requirement says dashboards are created in **both** projects
while alerts stay prod-only. That is implemented and dry-run verified.

What actually ran during the build touched **only** the non-production project
(525793): 7 dashboards and 43 insights. Production creation is deliberately
**operator step 3** in §7 — a build agent writing dashboards into the project
that carries live production data is a different risk class from writing into
an empty dev project, and the applier makes it a one-command step either way.

The one exception, made knowingly: AECI-649's two **product** insights and the
`AECi — Activation` dashboard were created directly in **production**, because
a funnel over `search_performed → product_viewed → external_link_clicked` is
meaningless against an empty project and the production events already exist.
Saved insights page nobody; alerts do. That is the line drawn.

### §8.12 "Emit per call" gains one exception: batched logs (AECI-666)

The transport decision above says **emit per call** — no client-side aggregation,
because `posthog-node`'s metrics client buffers over a 10 s window and a Worker
isolate is gone long before that closes. That reasoning is about *time-windowed*
buffering and it stands. It does **not** cover a caller that already holds N related
lines in hand.

Production found the difference the hard way. A Worker invocation may hold only ~6
connections waiting for response headers, and **the dual-run spends two per
emission** — one PostHog, one Datadog, from the same call site. The promote's §26.5
audit forwards issued one emission per `audit_log` row, so a fat bundle opened 2N
simultaneous connections; past the limit the runtime cancels the stalled responses,
and a cancelled `fetch` returns a promise that **never settles**. Neither the `res.ok`
guard nor the `catch` runs, nothing is logged, and the invocation is eventually killed
as hung — taking every other in-flight hook with it. Measured 2026-08-26: 745 stall
warnings across a 63-promote backfill, 5 invocations killed.

**The exception.** `logBatchToPosthog(ctx, env, request, events[])` posts N
`logRecords` in one OTLP envelope, and `apps/api/src/posthog.ts` fans it out to
`logBatchToDatadog` exactly as the single-event path does. It shares one record
builder with `logToPosthog`, so the per-record envelope is identical by construction
rather than by convention — and the batch carries **one** `timeUnixNano` for all
records, which is correct here because these rows were committed by a single
`db.batch()`.

**Scope of the exception, deliberately narrow:**

- **Logs only.** Metrics are unchanged — still one point per call, still no client
  aggregation. Nothing about the 10 s-window reasoning is revisited.
- **Only when the caller already has the whole set.** This is not a buffer and there
  is no flush timer; it takes an array and posts it. No isolate-lifetime hazard.
- **Never post an empty array** — both senders no-op on `[]` and on a missing key.

Where an upstream has no batch endpoint at all, bound the fan-out instead:
`mapWithConcurrency(items, WORKER_CONNECTION_LIMIT, fn)` (`@aeci/shared/concurrency`).
Batching beats bounding; bounding beats nothing.

**PH-final (AECI-651) is unaffected.** `logBatchToPosthog` collapses by deleting its
one `logBatchToDatadog` line, exactly like every other function in the adapter — and
the connection pressure this section describes halves the moment that leg goes away.

Full incident record and the non-telemetry half of the fix: ADR 0021's 2026-08-27
amendment.

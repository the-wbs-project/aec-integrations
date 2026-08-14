# Phase 7 Completion Report

**Issue:** [AECI-246](https://linear.app/aec-integrations/issue/AECI-246) — Phase 7.12, Phase 7 completion checkpoint (**Stage 1 launch-readiness gate**)
**Spec anchor:** `docs/STAGE_1_SPEC.md` §16 Phase 7 (build-order bullets, lines 1147–1167). Phase 7 = SEO, accessibility, legal, launch polish — **no sibling spec, straight to issues** (AECI-236…245). Companion contracts: §13/§27 (legal), §14.1 (PostHog), §11.1 (Resend), §20.2/§20.5 (IndexNow), §23.1 (data-quality), §15.1 (WAF), §21.3 (a11y), §11.2 (waitlist + DNS cutover).
**Mirrors:** [AECI-67](https://linear.app/aec-integrations/issue/AECI-67) (Phase 2 gate), [AECI-146](https://linear.app/aec-integrations/issue/AECI-146) (Phase 3 gate), [AECI-187](https://linear.app/aec-integrations/issue/AECI-187) (Phase 4 gate), [AECI-207](https://linear.app/aec-integrations/issue/AECI-207) (Phase 5 gate), [AECI-220](https://linear.app/aec-integrations/issue/AECI-220) (Phase 6 gate).
**Blocks:** [AECI-247](https://linear.app/aec-integrations/issue/AECI-247) — Phase 7.13, the DNS cutover (go-live). **Out of scope here** (§"Out of scope" below).
**Evaluated against:** the working tree on `chris/aeci-246-…`, at `main` @ `add1e49`. · **Date:** 2026-07-01 (UTC)

This is the "Phase 7 is Done" gate — and, because Phase 7 is the last build phase, the **Stage 1 launch-readiness gate**. Like the Phase 2–6 gates it **surfaces** open items rather than silently closing them: every AECI-246 acceptance line and every §16 Phase 7 build-order bullet is mapped to ✅ Done / ⚠️ Partial / ❌ Outstanding with concrete file:line evidence, and each non-green item carries an explicit written punt. The non-green items here are almost entirely **human gates** (counsel legal review), **ops/secret provisioning** (the launch-only secrets are unset by design pre-launch), and **deployed-staging confirmation** — not Phase 7 build defects.

**Prerequisites met:** the Phase 2–6 gates are closed. Phase 7 inherits their CI wiring — axe-core + Lighthouse a11y ≥95 (AECI-65), the console-health harness (AECI-162), Lighthouse CI budgets (AECI-188), the SEO/security header set (AECI-89), the write-event/promote pipeline + Cache-Tag purge (AECI-56/139), and the scheduled Worker (moderation/stats/Algolia crons, ADR 0013). Phase 7 was mostly **additive app + infra code + docs — zero migrations**.

**A note on `main`'s two stale AC phrasings (raised, not silently worked around — CLAUDE.md rule):**

- **"both themes"** (AC5) is **stale**. Stage 1 ships a **single light theme** (AECI-226 superseded "both themes always"). The verified reality is *light-only*; there is no dark variant to test. Read AC5 as "light theme."
- **"Loops"** (AC3, AC6) is **stale**. The repo standardized on **Resend** for transactional email + **PostHog** for product analytics (AECI-240 corrected §11.1 / CLAUDE.md; `docs/email.md` is the record). Read "Loops … live" as "Resend + PostHog live" and "Loops waitlist campaign" as "Resend waitlist broadcast."

**Repo-checkable gates run for this report:**

| Gate | Result |
|------|--------|
| `pnpm typecheck` (shared, api, datatool — web excluded by design, no web code changed) | ✅ exit 0 |
| `pnpm lint` (ESLint ×N packages + `check-source-constraints` + Prettier) | ✅ exit 0 · "All matched files use Prettier code style!" |
| `pnpm test` (unit + integration) | ✅ exit 0 · unit + integration suites green (shared / api / datatool / web); web integration: no files |
| `ng extract-i18n` (verification only — **not** committed) | ✅ exit 0 · **826 messages** · committed `src/locale/messages.xlf` untouched (stray default-path artifact removed) · ⚠️ 4 **pre-existing** duplicate-id warnings (`admin.shell.eyebrow`, `admin.shell.nav.reviewers`, `listing.filters.title`, `app.header.account`) — the same 4 the Phase 6 gate flagged (`PHASE_6_COMPLETION.md` §F3); no Phase 7 templates touched here |
| light-only check — `dark:` variants / theme toggle in `apps/web/src` | ✅ none (AECI-226); analytics dimension hard-codes `theme:'light'` |

_This checkpoint changes **only docs** (this report, the launch-cutover runbook, the a11y checklist, and doc-staleness fixes). No application logic changed, so the gates reflect `main` @ `add1e49`._

---

## 1. Verdict

**Phase 7 is functionally complete and Stage-1 launch-ready in code.** Ten of the eleven Phase 7 build issues are merged to `main` and `Done` in Linear (7.1–7.9, 7.11 = AECI-236/237/238/239/240/241/242/154/243/245); the eleventh, **7.10 manual screen-reader pass (AECI-244)**, is a human QA task carried as **Done for this gate per Chris's sign-off** (the on-instruction "continue as if 7.10 has been completed"), with the repeatable procedure now documented in `docs/a11y-manual-testing-checklist.md` (§4.4). Every launch surface exists and renders: IndexNow fires on promote; the four legal pages + About + Contact are routed, cached, i18n-wrapped and footer-linked; PostHog is client-only with locale/theme dimensions; Resend carries the review/account/admin templates + the Supabase magic-link SMTP; the daily 04:00 UTC data-quality job runs the full §23.1 suite and emails a digest; the two Pro-plan WAF rate-limit rules + scraper block are live with an hourly Datadog poll; the non-blocking BrowserStack lane is wired; the waitlist welcome banner + token attribution ship; and the pre-launch Core Web Vitals audit is documented. All admin surfaces are token-only, i18n-wrapped, and light-only.

**What this checkpoint delivers (docs only — §4):** this report; the **DNS-cutover runbook** the AC requires (`docs/launch-cutover-runbook.md`, incl. a drafted Resend waitlist broadcast); the **a11y manual-testing checklist** (7.10's repeatability deliverable); the **§16 Phase 7 checkbox** staleness fix; and a `CLAUDE.md` source-of-truth row for the runbook.

**What is *not* green — and why none is a Phase 7 build defect:**

- **Counsel legal review (AC2)** — the four legal pages render but carry a "Draft, pending legal review" disclaimer with a blank `effective_date`/`counsel_approved_*`. Counsel review + publish is a **human launch gate** → **§F1**.
- **Launch secrets / ops (AC3, AC4)** — "IndexNow firing / PostHog live / data-quality emailing / WAF→Datadog visible / BrowserStack green" are all **fail-open/no-op until their secrets are set**, which is the intended pre-launch posture. The launch-only secrets (`INDEXNOW_KEY_PRODUCTION` + key file, `RESEND_API_KEY_*`, `POSTHOG_KEY`, `DATA_QUALITY_EMAIL_*`, `CF_ANALYTICS_API_TOKEN`, `BROWSERSTACK_*`, `GOOGLE_INDEXING_SA_*`, prod Algolia, `ANTHROPIC_API_KEY`) are provisioned at cutover → **§F2** (and the runbook §4.2).
- **Deployed-staging full-surface acceptance (AC5)** — the live home/search/detail/auth/reviews/requests/admin E2E + axe + Lighthouse + console-clean pass with real auth needs a deployed origin + secrets → **§F3** (the Stage-1 analogue of the per-phase §F1 punts).
- **BrowserStack one-off full real-device sweep + a11y audit (AC4)** — the CI lane is wired but **inert until the personal-subscription `BROWSERSTACK_*` secrets are set** (skips green); the pre-launch full sweep is pending → **§F4**.

None blocks a merge of *this checkpoint*; each is a launch-day/ops step tracked below and in the runbook.

---

## 2. Acceptance checklist

### 2a. AECI-246 acceptance criteria

| AC | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| 1 | Every Phase 7.1–7.11 + 7.8 item verified → produce `docs/PHASE_7_COMPLETION.md` (✅/❌ with issue link) | ✅ | This document. Per-item mapping + file:line evidence in §2b; 10/11 issues merged `Done` (7.1–7.9, 7.11), 7.10 carried Done per Chris (§1). |
| 2 | Legal pages **counsel-reviewed** + published; About/Contact live | ⚠️ | **Pages live ✅, counsel review ❌ (human gate).** Four legal routes render from `apps/web/src/content/legal/*.md` via `legal-page.ts`; About `about/about.ts` + Contact `contact/contact.ts` live + footer-linked (`layout/site-footer.ts`). But the legal frontmatter is `effective_date:`(blank) + "Draft, pending legal review". **Counsel sign-off + publish → §F1.** |
| 3 | ~~PostHog + Loops~~ **PostHog + Resend** live; data-quality job running + emailing; IndexNow firing on writes | ⚠️ | **Code shipped ✅, live requires secrets ⚠️.** "Loops"→Resend/PostHog (§1). PostHog `analytics/posthog-client.ts` (gated `POSTHOG_KEY`); Resend `lib/email.ts` (gated `RESEND_API_KEY`); data-quality `scheduled.ts:151` `DATA_QUALITY_CRON='0 4 * * *'` → `runDataQualityJob` (`lib/data-quality.ts` + `data-quality-email.ts`); IndexNow `promote.ts:389` `notifyIndexNowAfterPromote` → `lib/indexnow.ts` (gated `INDEXNOW_KEY`+`PUBLIC_SITE_URL`). **Secrets/deploy → §F2.** |
| 4 | WAF rate limits active; cross-browser smoke (BrowserStack 7.8) green; **screen-reader pass done**; perf/CWV within budget | ⚠️ | **WAF active ✅** (`docs/waf-rate-limits.md` — 2 Pro rules + scraper block live; hourly Datadog poll `scheduled.ts:160` `WAF_CRON`, needs `CF_ANALYTICS_API_TOKEN` → §F2). **BrowserStack ⚠️** — lane wired, inert until `BROWSERSTACK_*` → §F4. **Screen-reader ✅** per Chris + `docs/a11y-manual-testing-checklist.md` (§4.4). **Perf/CWV ✅** `docs/PERFORMANCE_AUDIT.md` (AECI-245); warn-level Lighthouse perf misses noted there. |
| 5 | Full Stage-1 acceptance: home/search/detail/auth/reviews/requests/admin green on staging; ~~both themes~~ light theme; axe + Lighthouse; no console errors; `ng extract-i18n` clean | ⚠️ | **CI-green ✅, deployed-staging run ⚠️.** All surfaces routed (§2b surface table). "both themes"→light-only (§1). axe + Lighthouse a11y≥95 + console-health enforced in CI (AECI-65/162/188); `ng extract-i18n` verification in §"Verification". **Live staging full-surface pass with real auth → §F3.** |
| 6 | ~~Loops~~ **Resend** waitlist campaign drafted + ready to send; DNS-cutover runbook prepared (the 7.13 step) | ✅ | **Runbook created:** `docs/launch-cutover-runbook.md` (built from §11.2 + `environments.md` apex-cutover steps), incl. a **drafted Resend waitlist broadcast** (subject + body) → "campaign drafted + ready to send." The actual send + DNS flip are 7.13 ops (AECI-247), out of scope. |
| 7 | Outstanding items → follow-up issue or explicit punt to Stage 2 | ✅ | Four punts written in §3 (F1 counsel review, F2 launch secrets/ops, F3 deployed-staging acceptance, F4 BrowserStack sweep). Per the checkpoint convention, they're **documented as punts for Chris to file** — this gate creates no Linear issues. Spec'd Stage-2 deferrals listed in §3 "Not a defect." |

### 2b. §16 Phase 7 build-order bullets (7.1–7.11)

| §16 Phase 7 item | Issue | PR | Status | Evidence |
|-----------|-------|----|--------|----------|
| 7.1 IndexNow on the write-event pipeline (§20.2/§20.5) | AECI-236 | #380 | ✅ | `apps/api/src/lib/indexnow.ts` (`callIndexNow`, gated `INDEXNOW_KEY`, never throws); `routes/promote-indexnow-urls.ts` (`affectedUrlsForPromote`); wired post-commit `routes/promote.ts:389` (`notifyIndexNowAfterPromote`, `ctx.waitUntil`, reads `INDEXNOW_KEY`+`PUBLIC_SITE_URL`). Metric `aeci.indexnow.submit`. Google Indexing ping is the sibling AECI-263. |
| 7.2 Legal pages (Terms/Privacy/Review-Guidelines/Listing-Accuracy; §13/§27) | AECI-237 | #372 | ✅ (counsel = §F1) | `apps/web/src/content/legal/{terms-of-service,privacy-policy,review-guidelines,listing-accuracy-policy}.md` (versioned frontmatter); `app/legal/legal-page.ts` + `legal-content.ts`; `/legal/*` routes (cacheable 24h, indexable, canonical); footer `layout/site-footer.ts`. Content is counsel-review-pending drafts (§F1). |
| 7.3 About + Contact pages | AECI-238 | #360 | ✅ | `app/about/about.ts` (`/about`, cacheable, indexable, OG/canonical); `app/contact/contact.ts` (`/contact`, `mailto:`, non-cacheable fail-closed). Both footer-linked. |
| 7.4 PostHog (events + locale/theme dims; §14.1) | AECI-239 | #363 | ✅ (live = §F2) | `apps/web/src/posthog-bootstrap-inject.ts` (SSR-injected config, gated `POSTHOG_KEY`); `app/analytics/posthog-client.ts` (client-only, `autocapture:false`, `respect_dnt:true`); `analytics-dimensions.ts` (`{locale,theme}` registered before first event); `posthog.provider.ts`. §14.1 event set; CSP `connect-src` (AECI-89). |
| 7.5 Resend transactional email (§11.1) | AECI-240 | #379 | ✅ (live = §F2) | `apps/api/src/lib/email.ts` — review submitted/approved/rejected, account-deletion, stuck-request admin alert; fire-and-forget (`waitUntil`), gated `RESEND_API_KEY`+`EMAIL_FROM`, 5s timeout, `aeci.email.send`. Magic-link = Supabase→Resend SMTP (`docs/email.md`). Retro-filled the AECI-202/214 deferred sends. |
| 7.6 Daily data-quality job (full §23.1 + email) | AECI-241 | #381 | ✅ (live = §F2/F3) | `apps/api/src/lib/data-quality.ts` (10 read-only §23.1 checks); `data-quality-email.ts` (`buildDataQualityDigest`, always emails so silence = failure); `scheduled.ts:151` `DATA_QUALITY_CRON='0 4 * * *'` → `runDataQualityJob` → `sendEmail` to `DATA_QUALITY_EMAIL_TO`. Metrics `aeci.data_quality.*`. No auto-remediation. |
| 7.7 WAF rate limits (§15.1) | AECI-242 | #373 | ✅ (token = §F2) | `docs/waf-rate-limits.md` — 2/2 Pro rate-limit slots live (`/api/requests/*` + `/api/reviews`, 5/60s per IP, 1h block) + scraper-UA block + managed WAF. Datadog visibility: `scheduled.ts:160` `WAF_CRON='0 * * * *'` → `runWafMetricsJob` → `aeci.waf.ratelimit.blocked` (AECI-262, needs `CF_ANALYTICS_API_TOKEN`). Config-as-code intentionally deferred. |
| 7.8 Cross-browser QA via BrowserStack (ADR 0012) | AECI-154 | #400 | ✅ wired (sweep = §F4) | `.github/workflows/browserstack.yml` (non-blocking: `workflow_run` post-deploy + dispatch + weekly); `apps/web/browserstack.yml`; `apps/web/playwright.browserstack.config.ts` (5 read-only journeys; real iOS Safari / Android Chrome / desktop Safari / Firefox / Edge). Inert until `BROWSERSTACK_*` (skips green). Pre-launch full sweep + a11y audit → §F4. |
| 7.9 Waitlist welcome banner + token attribution (§11.2) | AECI-243 | #365 | ✅ | `app/waitlist/waitlist-welcome.ts` (dismissible, SSR-neutral, `afterNextRender`); `waitlist-welcome.service.ts` (`welcomeState()` reads `location.search`; `logAttribution` → `POST /api/page-views` `{ref_source:'waitlist',ref_token}`; localStorage dedupe + dismiss). Rendered once in app shell. |
| 7.10 Manual screen-reader pass (VoiceOver/NVDA; §21.3) | AECI-244 | — | ✅ per Chris | Carried Done for this gate per instruction (§1). Repeatable procedure documented in `docs/a11y-manual-testing-checklist.md` (§4.4): home / product detail / review submission / login / account / admin queue; VoiceOver + NVDA + keyboard-only. axe + Lighthouse a11y≥95 already automated (AECI-65). Linear status → §"Hand-off". |
| 7.11 Performance / Core Web Vitals audit | AECI-245 | #371 | ✅ | `docs/PERFORMANCE_AUDIT.md` — Lighthouse perf + CWV (LCP/INP/CLS) on home/detail/search/browse vs Phase 2 §12 budgets + deployed-staging RUM (Datadog). Lighthouse CI error-gates a11y/BP/SEO/TBT/TTFB (`.lighthouserc.cjs`); perf/LCP/CLS are warn-level (documented follow-ups). |

**Full Stage-1 surface (AC5) — every launch route exists** (`apps/web/src/app/app.routes.ts`, 33 paths):

| Surface | Route(s) |
|---|---|
| Home | `''` |
| Search | `search` |
| Detail | `products/:slug`, `vendors/:slug`, `integrations/:id` (+ `products`, taxonomy `categories`/`audiences`/`phases` (+`:slug`)) |
| Auth | `auth/login`, `account` (SSR-gated) |
| Reviews | `products/:slug/review` (SSR-gated) |
| Requests | `products/:slug/{claim,correction}`, vendor variants |
| Admin | `admin`, `admin/reviews`, `admin/requests`, `admin/reviewers` (token-only) |
| Static/legal | `about`, `contact`, `legal/{terms,privacy,review-guidelines,listing-accuracy}`, `**` (404) |

**Score: AC — 3 ✅ / 4 ⚠️ · §16 Phase 7 items — 11 ✅ (7.10 per Chris) / 0 ⚠️ / 0 ❌.** Every AC ⚠️ is a human gate (§F1), an ops/secret flip (§F2), a deployed-env confirmation (§F3), or the BrowserStack sweep (§F4) — not a Phase 7 build defect.

---

## 3. Outstanding items — follow-ups & punts

> Per the checkpoint convention (Phase 2–6, per Chris's standing instruction), outstanding items are **documented here as punts for Chris to file**; this checkpoint creates no Linear issues. All four are **launch-day / cutover** steps captured in `docs/launch-cutover-runbook.md`.

### F1 — Counsel legal review + publish (human launch gate)

The four legal pages (`apps/web/src/content/legal/*.md`) render from counsel-review-pending **template drafts** — frontmatter `effective_date:` is blank and each page shows a "Draft, pending legal review" disclaimer. Launch requires counsel to review Terms / Privacy / Review Guidelines / Listing Accuracy, then set `effective_date` + `counsel_approved_by` + `counsel_approved_on` (→ version 1.0) and remove the disclaimer, per §27's change workflow. This is a **human gate the checkpoint can't self-certify**; it must be closed before the DNS cutover.

### F2 — Launch secrets / ops provisioning (the "live" in AC3/AC4)

The Phase 7 integrations are built to **fail open / no-op without their secrets** (the correct pre-launch posture) — so "live" is a provisioning step, not code. Set at/before cutover (many are noted unset in project memory), per the runbook §4.2:

- **IndexNow (7.1):** `INDEXNOW_KEY_PRODUCTION` + host the key file at the site root + `PUBLIC_SITE_URL`=apex; Google Indexing `GOOGLE_INDEXING_SA_EMAIL_PRODUCTION` + `_PRIVATE_KEY_PRODUCTION` (AECI-263).
- **PostHog (7.4):** `POSTHOG_KEY` (+ `POSTHOG_HOST`).
- **Resend (7.5):** `RESEND_API_KEY` (single shared, un-suffixed) + `EMAIL_FROM`; Supabase→Resend SMTP configured (`docs/email.md`).
- **Data-quality (7.6):** deployed cron (staging+prod) + `DATA_QUALITY_EMAIL_FROM`/`_TO` (Chris + Bill).
- **WAF→Datadog (7.7):** `CF_ANALYTICS_API_TOKEN` (Zone Analytics: Read) for `aeci.waf.ratelimit.blocked` (AECI-262).
- **Toxicity (Phase 5/6 dep):** `ANTHROPIC_API_KEY_{STAGING,PRODUCTION}` (AECI-258); **prod Algolia** `ALGOLIA_APP_ID` + `ALGOLIA_ADMIN_KEY_PRODUCTION` (fail-closed on prod promote).

### F3 — Deployed-staging full-surface acceptance (AC5)

The live home/search/detail/auth/reviews/requests/admin pass on **deployed staging with real auth** — axe AA + Lighthouse + console-cleanliness + a no-error run of the review-submission, claim/correction, and admin-moderation flows. Structure is covered by component + Chromium e2e in CI; the authed-admin live pass needs a real admin session (the AECI-205 precedent — `requireAdmin()` can't be `page.route`-stubbed). This is the Stage-1 analogue of the per-phase §F1 operational punts; run with the staging access/secrets Chris provides.

### F4 — BrowserStack one-off full real-device sweep + a11y audit (AC4)

The non-blocking lane (AECI-154) is wired but **inert until the personal-subscription `BROWSERSTACK_USERNAME`/`BROWSERSTACK_ACCESS_KEY` are set** (it skips green today). Before launch: set the secrets, run the full real-device sweep (real iOS Safari + Android Chrome + desktop Safari/Firefox/Edge) and the BrowserStack accessibility audit as the launch gate ADR 0012 calls for.

### Not a defect — deferred items are spec'd, not missed

Per §16 Phase 7: integration-page JSON-LD (→ Stage 2) and the sitemap index/sub-sitemap split (only needed beyond 50k URLs) are **explicitly deferred**. The Google Indexing API ping shipped separately as AECI-263. WAF config-as-code (Terraform) is a deliberate post-launch upgrade (`docs/waf-rate-limits.md`). **The DNS cutover itself is 7.13 (AECI-247)** — out of scope for this gate.

---

## 4. Work done in this issue

_This checkpoint changed **only documentation** — no application logic. The Phase 7 features shipped in AECI-236…245._

### 4.1 This report (`docs/PHASE_7_COMPLETION.md`)

The Phase 7 launch-readiness verification: AC + §16-bullet mapping with file:line evidence, the four launch punts (§3), and the two stale-AC corrections ("both themes"→light-only, "Loops"→Resend/PostHog).

### 4.2 DNS-cutover runbook (`docs/launch-cutover-runbook.md`)

The AC6 deliverable — the go-live runbook for 7.13 (AECI-247), built from §11.2 + `docs/environments.md`'s apex-cutover steps: pre-cutover gates, the ordered cutover (provision launch secrets → `ALLOW_INDEXING="true"` → `PUBLIC_SITE_URL`→`www.` → move `aecintegrations.com`+`www` off the landing Worker onto `aeci-web-production` → apex→`www` 301 (canonical host is `www.`, ADR 0011 amendment 2026-07-05) → one-time **Resend** waitlist broadcast), a **drafted broadcast email** (subject + body — the "campaign drafted + ready to send"), post-cutover verification (dual `/api/version`+`/_version` SHA gate, indexable headers, sitemap, IndexNow ping, RUM CWV), and a rollback note. Added a `CLAUDE.md` source-of-truth row for it.

### 4.3 §16 Phase 7 checkbox staleness fix (`docs/STAGE_1_SPEC.md`)

The §16 Phase 7 list had only 7.1/7.7/7.8 checked while 7.2–7.6, 7.9, 7.11 were merged `Done`. Flipped those `[ ]`→`[x]` with issue/PR refs (consistent with the existing 7.1/7.7/7.8 lines), marked 7.10 done (per Chris) and 7.12 done (this gate). No prose/scope change.

### 4.4 a11y manual-testing checklist (`docs/a11y-manual-testing-checklist.md`)

7.10's "document the procedure for repeatability" deliverable (AECI-244) — a repeatable VoiceOver/NVDA + keyboard-only checklist across home / product detail / review submission / login / account / admin moderation queue, with a pass/fail log template. **Procedure only — no fabricated findings.** Lets "7.10 completed" (per Chris's sign-off) rest on a real, repeatable artifact.

---

## 5. Notes & known debt

- **Note A — pre-launch "no-op without secrets" is by design.** IndexNow, PostHog, Resend, the data-quality email, the WAF→Datadog poll, the toxicity scorer, and Algolia all **never throw** and silently no-op / skip without their secrets. With the launch secrets unset (the current posture), the site renders cleanly and the integrations sit dormant — "not live yet," not "broken." §F2 is the flip.
- **Note B — deployed-env behavior is operational.** As with every prior gate, "the staging flow works" / "the cron emails" / "IndexNow pings" / "monitors live" describe the shipped *capability* + its tests; live behavior is only fully observable against a deployed CF environment (Miniflare ≠ the edge; crons/webhooks/WAF need the real platform). Tracked in §F2/§F3/§F4.
- **Note C — light-only (AECI-226).** Stage 1 ships one light theme; no `dark:` variants exist and the analytics `theme` dimension hard-codes `'light'`. The "both themes" AC phrasing is stale (§1).
- **Note D — "Loops" is historical.** Transactional email is **Resend**; product analytics is **PostHog**; mailboxes are Microsoft 365 (`docs/email.md`, AECI-240). Any "Loops" in issue text / older spec prose is superseded.
- **Note E — build noise (non-blocking).** `ng extract-i18n` / vitest print "File not found in TypeScript compilation" notes for `packages/shared/src/**` re-exports (bundled correctly, outside the web tsconfig program) — documented since AECI-67; build-config notes, not runtime issues.

---

## 6. Design sign-off (AECI-220/207/187/146/67 convention)

- The Phase 7 launch surfaces (legal, About, Contact) reuse the established catalog token + type vocabulary and the static-page render pattern, so they read as the **same publication** as the directory (the Anchor-Site Rule). Legal/About/Contact are content pages built from existing tokens — no dedicated design-direction doc / recorded Mobbin anchor; if Chris wants a recorded anchor for the static pages that's a small follow-up, not a blocker.
- a11y: axe AA + Lighthouse a11y ≥95 are enforced in CI (AECI-65) on the Phase 2–4 public pages; the legal/About/Contact pages are covered by their own specs + axe. The **manual VoiceOver/NVDA pass (7.10)** is carried Done per Chris (§1) with the repeatable checklist in §4.4; the **deployed-staging authed-page axe/LH pass** rides §F3.
- The **formal `/impeccable` craft + polish history per launch surface, or Chris's explicit sign-off, is a human gate** this report can't self-certify — flagged for Chris to confirm.

---

## 7. Hand-off

**Punts documented for Chris to file** (no issues created by this checkpoint, per convention):

- **F1** — counsel legal review + publish (set `effective_date`/`counsel_approved_*`, drop the draft disclaimer). Human launch gate.
- **F2** — provision the launch secrets / ops flips (IndexNow + key file, PostHog, Resend + Supabase SMTP, data-quality cron + recipients, `CF_ANALYTICS_API_TOKEN`, prod Algolia, `ANTHROPIC_API_KEY`, Google Indexing). See runbook §4.2.
- **F3** — deployed-staging full-surface acceptance (authed home/search/detail/auth/reviews/requests/admin, axe + Lighthouse + console).
- **F4** — set `BROWSERSTACK_*`, run the one-off full real-device sweep + accessibility audit.

**Linear housekeeping:** AECI-246 moved to **In Progress** at start (assignment: the claude.ai Linear connector needs re-auth this session — see the closing note). **AECI-244 (7.10)** is carried Done for this gate per Chris's instruction; flip it to **Done** in Linear to match (it's the only Phase 7 issue not already `Done`).

**Ready to mark Phase 7 Done — and clear the Stage 1 launch-readiness gate (unblocking 7.13 / AECI-247)** once Chris confirms:

1. The launch punts (§F1 counsel review, §F2 secrets/ops, §F3 deployed-staging acceptance, §F4 BrowserStack sweep) are acceptable as **cutover steps** (per the runbook), not build blockers — matching how Phase 2/4/5/6 deferred their live apply.
2. 7.10 (manual screen-reader pass) is signed off per the §4.4 checklist, and AECI-244 flipped to Done.
3. The design sign-off in §6 (per-surface craft/polish history or explicit sign-off).

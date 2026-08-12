# Analytics Baseline

**Version:** 1.0 · **Date:** 2026-07-11 · **Owner:** Chris · **Issue:** AECI-326

The pre-marketing measurement baseline: what is instrumented, the starting numbers, and how to
read them each week. Companion to [`OBSERVABILITY.md`](./OBSERVABILITY.md) (the instrumentation
*catalog*) — this doc is the point-in-time *record*. The point is to confirm we can measure what
marketing produces **before** we produce it.

## Instrumentation status (as of 2026-07-11)

| Signal | Source | Status | Notes |
|---|---|---|---|
| **Pageviews** (client) | PostHog `capture_pageview: 'history_change'` (`apps/web/src/app/analytics/`) | Built; **live once `POSTHOG_KEY` is set** | Auto-captures initial load + SPA navigations, consent-gated. |
| **Mailing-list signup** (client) | PostHog `mailing_list_signup` event, fired on a genuine new subscribe (AECI-326) from the shared band (`home/home-closing-cta.ts` + the directory/detail mounts, AECI-327) and the `/updates` page (AECI-536) | Built; live once `POSTHOG_KEY` is set | Consent-gated → *consented funnel only*. `source`: `home_closing_cta` / `mailing_list_band` / `updates_page`. |
| **Mailing-list signup** (server, authoritative) | `mailing_list` D1 table via `POST /api/subscribe`; mirrored to Datadog `aeci.email.send{template:landing-signup}` on each new insert | **Live** (consent-independent) | The true signup count. Read this for the number; read PostHog for funnel/attribution. |
| **Core Web Vitals** (field) | Datadog RUM `@datadog/browser-rum` (`apps/web/src/app/datadog.provider.ts`) | Built; **live once `DD_APPLICATION_ID` + `DD_CLIENT_TOKEN` are set** | RUM collects LCP/CLS/INP/FCP/TTFB automatically on init. `aeci` RUM app, us5. |
| **Server pageviews / entry pages** | `page_views` D1 table via `POST /api/page-views` | **Live** (consent-independent) | Write-only today (no reporting endpoint); query D1 directly for entry-page counts. The 2026-07-12 AECI-280 pull found 4,917 rows (3,237 in 7d) — but `cf_bot_score` is null on every row (CF Pro exposes no bot score), so the human/bot/synthetic split is **unclassified**. Since **AECI-575** it captures **public routes only** — `/admin/*` and `/account` are excluded at both writers and filtered out on read (see the 2026-08-12 addendum below). |

### Provisioning dependency (why prod was dark)

Verified against live prod on 2026-07-11: the served HTML on `www.aecintegrations.com` injected
only `__AECI_ALGOLIA__` + `__AECI_SUPABASE__` config — **no `__AECI_POSTHOG__`, no `__AECI_DD__`**.
Injection is gated on the Worker secrets existing, so PostHog and Datadog **RUM** were **not
capturing anything in production**. AECI-326 makes both durable: PostHog was already CI-pushed
(from `POSTHOG_KEY_{STAGING,PRODUCTION}`); the RUM credentials are now CI-pushed too (shared
un-suffixed `DD_APPLICATION_ID` / `DD_CLIENT_TOKEN`, all four deploy/promote workflows). **Both go
live once the GitHub secret *values* are set** (see [`OBSERVABILITY.md` → Credentials](./OBSERVABILITY.md#credentials)).

## Baseline (the recorded snapshot)

> **As of 2026-07-11, AECi is pre-launch and pre-marketing.** The mailing list holds ~1 real
> subscriber. Client-side traffic and Core Web Vitals capture in **production** were *dark* at the
> time of writing — PostHog and Datadog RUM are fully built but their Worker secrets were
> unprovisioned, so no pageviews, signup events, or field CWV were being recorded in prod; AECI-326
> switches both on (code + durable CI wiring; awaiting the secret values). Consequently weekly
> visitors and top entry pages are effectively **nil-to-negligible** and not yet meaningfully
> measurable from the analytics dashboards; the home page (`/`) is the sole broadly-shared entry
> point pre-launch, and the authoritative signup count (the `mailing_list` D1 table) reads ~1. This
> baseline exists to prove the *instrumentation* works — per the issue, "this is about
> instrumentation, not numbers" — so that once the secrets are set and the site launches, weekly
> visitors, signups, and top entry pages accrue against a known zero.

Re-read and update this snapshot ~1 week after the analytics secrets are provisioned (first real
numbers), and again at launch.

> **AECI-280 addendum (2026-07-12).** The server-side `page_views` D1 table is **not** nil — it holds
> 4,917 rows (3,237 in the last 7 days; 646 product-page views across 124 products) since 2026-06-23.
> But `cf_bot_score` is **null on every row** (Cloudflare **Pro** exposes no bot score), so this volume
> is *unclassified*: an unknown — pre-marketing, likely large — share is bots / crawlers / synthetic
> monitoring, not human demand. **PostHog** (still dark until `POSTHOG_KEY_PRODUCTION` is set) therefore
> remains the signal for real human traffic + funnel; AECI-280 added a prod preflight nudge for that
> secret in `promote-to-prod.yml` and it also feeds the deferred trending PostHog join. The pull was
> taken to tune the home **trending** card — see [`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md)
> (2026-07-12 entry) and the `TRENDING_MIN_VIEWS` floor (`POST_LAUNCH_MONITORING.md` §3).

> **AECI-575 addendum (2026-08-12) — `page_views` is public routes only.** What the table "sees"
> narrowed: operator-only surfaces (`/admin/*` and `/account`) no longer produce rows, and the rows
> already in the table are filtered out on read. Before this, every admin click wrote a `page_views`
> row from the operator's own ISP and the daily digest counted it as a visitor — on the 2026-08-10
> digest day **67 of the 92 "human" page views came from AS23700 (Jakarta), the operator's own ISP**
> (`ADMIN_PANEL_SPEC.md` §14.2). The prefix list is `UNTRACKED_ROUTE_PREFIXES` in `@aeci/shared`,
> enforced at both writers (`PageViewTracker.fire()` and the SSR Worker's `firePageView()`) and in
> the daily digest's reads (`apps/api/src/lib/analytics-digest.ts`).
>
> Two consequences when reading numbers across this date. **(1)** Digest human counts for days
> *before* 2026-08-12 are now reported lower than they were in the email sent at the time — that is
> the intended retroactive correction, not a data loss; the rows are still in D1 and an ad-hoc query
> without the filter still sees them. **(2)** This is the *precise* half of internal-traffic
> filtering, with zero false positives. The coarse remainder — genuine visitors who happen to share
> the operator's ISP — is `ANALYTICS_INTERNAL_ASNS` (`ADMIN_PANEL_SPEC.md` §13 D10), still unbuilt,
> so the human count remains an **upper bound**.

## How to read the numbers (weekly, going forward)

Once the secrets are provisioned (config injected — verify with
`curl -s https://www.aecintegrations.com/ | grep -oE '__AECI_(POSTHOG|DD)__'`):

- **Weekly visitors + pageviews** — PostHog UI (Web Analytics / Insights), filter to production.
  Cross-check against the Datadog **Phase-2 Traffic** dashboard (top routes by request count; us5).
- **Signups** — authoritative count = the `mailing_list` D1 table (from `apps/api`:
  `wrangler d1 execute aeci-app-production --env production --remote --command "select count(*) from mailing_list"`).
  Funnel/attribution (UTM, `source`) = the PostHog `mailing_list_signup` event.
- **Top entry pages** — PostHog referrers/entry-path breakdown; or the server-side `page_views` D1
  table for a consent-independent view. Public routes only — `/admin/*` and `/account` are excluded
  (AECI-575); add `and path not like '/admin%' and path not like '/account%'` to any ad-hoc query so
  it matches what the digest reports.
- **Core Web Vitals** — Datadog **RUM → Performance / Core Web Vitals** for the `aeci` app (us5),
  filter `env:production` (LCP, CLS, INP). Thin sample pre-launch — re-read post-launch.

## Verification checklist (closes AECI-326 "Done when")

1. **Signup fires as a tracked event** — ✅ code: `home-closing-cta.ts` calls
   `Analytics.mailingListSignup({ source: 'home_closing_cta' })` on `created`; covered by the
   analytics + closing-CTA specs. (AECI-536 adds the `/updates` page firing the same event with
   `source: 'updates_page'`, covered by `updates.component.spec.ts`.)
2. **PostHog captures pageviews + signup** — gated on `POSTHOG_KEY` (CI-wired; set the GH secret,
   then confirm `__AECI_POSTHOG__` in the HTML and the event in the PostHog UI).
3. **Datadog RUM reports CWV** — gated on `DD_APPLICATION_ID` + `DD_CLIENT_TOKEN` (now CI-wired; set
   the GH secrets, then confirm `__AECI_DD__` in the HTML and CWV populating in the RUM app).
4. **Baseline written** — ✅ this document.

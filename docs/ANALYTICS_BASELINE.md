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
| **Mailing-list signup** (client) | PostHog `mailing_list_signup` event, fired from `home/home-closing-cta.ts` on a genuine new subscribe (AECI-326) | Built (this change); live once `POSTHOG_KEY` is set | Consent-gated → *consented funnel only*. `source: home_closing_cta`. |
| **Mailing-list signup** (server, authoritative) | `mailing_list` D1 table via `POST /api/subscribe`; mirrored to Datadog `aeci.email.send{template:landing-signup}` on each new insert | **Live** (consent-independent) | The true signup count. Read this for the number; read PostHog for funnel/attribution. |
| **Core Web Vitals** (field) | Datadog RUM `@datadog/browser-rum` (`apps/web/src/app/datadog.provider.ts`) | Built; **live once `DD_APPLICATION_ID` + `DD_CLIENT_TOKEN` are set** | RUM collects LCP/CLS/INP/FCP/TTFB automatically on init. `aeci` RUM app, us5. |
| **Server pageviews / entry pages** | `page_views` D1 table via `POST /api/page-views` | **Live** (consent-independent) | Write-only today (no reporting endpoint); query D1 directly for entry-page counts. |

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

## How to read the numbers (weekly, going forward)

Once the secrets are provisioned (config injected — verify with
`curl -s https://www.aecintegrations.com/ | grep -oE '__AECI_(POSTHOG|DD)__'`):

- **Weekly visitors + pageviews** — PostHog UI (Web Analytics / Insights), filter to production.
  Cross-check against the Datadog **Phase-2 Traffic** dashboard (top routes by request count; us5).
- **Signups** — authoritative count = the `mailing_list` D1 table (from `apps/api`:
  `wrangler d1 execute aeci-app-production --env production --remote --command "select count(*) from mailing_list"`).
  Funnel/attribution (UTM, `source`) = the PostHog `mailing_list_signup` event.
- **Top entry pages** — PostHog referrers/entry-path breakdown; or the server-side `page_views` D1
  table for a consent-independent view.
- **Core Web Vitals** — Datadog **RUM → Performance / Core Web Vitals** for the `aeci` app (us5),
  filter `env:production` (LCP, CLS, INP). Thin sample pre-launch — re-read post-launch.

## Verification checklist (closes AECI-326 "Done when")

1. **Signup fires as a tracked event** — ✅ code: `home-closing-cta.ts` calls
   `Analytics.mailingListSignup({ source: 'home_closing_cta' })` on `created`; covered by the
   analytics + closing-CTA specs.
2. **PostHog captures pageviews + signup** — gated on `POSTHOG_KEY` (CI-wired; set the GH secret,
   then confirm `__AECI_POSTHOG__` in the HTML and the event in the PostHog UI).
3. **Datadog RUM reports CWV** — gated on `DD_APPLICATION_ID` + `DD_CLIENT_TOKEN` (now CI-wired; set
   the GH secrets, then confirm `__AECI_DD__` in the HTML and CWV populating in the RUM app).
4. **Baseline written** — ✅ this document.

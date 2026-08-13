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
| **Server pageviews / entry pages** | `page_views` D1 table via `POST /api/page-views` | **Live** (consent-independent) | Readable since AECI-574 — see "The consent-independent read path" below. The 2026-07-12 AECI-280 pull found 4,917 rows (3,237 in 7d) — but `cf_bot_score` is null on every row (CF Pro exposes no bot score), so the human/bot/synthetic split is **unclassified**. |

### The consent-independent read path (updated 2026-08-12, AECI-574)

The row above previously read *"write-only today (no reporting endpoint); query D1
directly"*. **That is no longer true.** `page_views` now has a first-class read
surface — the admin panel's three endpoints (`docs/ADMIN_PANEL_SPEC.md` §6,
`API_CONTRACTS.md` §6.10), behind `requireAdmin()`:

- `GET /api/admin/overview` — the daily bundle, reporting the same numbers as the
  05:00 analytics digest email for the day it covers.
- `GET /api/admin/metrics/timeseries` — human/bot views and unique visitors per
  day over any window, plus catalog additions and new sign-ins.
- `GET /api/admin/traffic/breakdown` — grouped by source, country, path, product,
  or bot.

This matters for the same reason the panel exists: **PostHog sees only consented
traffic**, and a single-page arrival from a search engine never grants consent —
on 2026-08-10 the digest counted 92 human page views across four sources and
PostHog recorded essentially none of them. `page_views` is the consent-independent
record; read it for *what happened*, and PostHog for *the consented funnel*.

Three limits travel with those numbers and are returned as machine-readable notes
on every response rather than left to the reader:

- **Bot classification is incomplete before ~2026-08-05.** Rows with
  `is_bot IS NULL` are counted as human by the digest's `is_bot IS NOT 1`
  predicate. AECI-582 runs the backfill; until then the flag is derived from the
  window's actual contents, so it retires itself.
- **`referrer_source` is null on every row before August** and is not
  backfillable — the header was never stored.
- **`Direct` is a mixed bucket** — `PageViewTracker` POSTs on every SPA
  navigation and the same-origin `Referer` classifies as `Direct`. AECI-585 adds
  the flag that separates in-app hops from true arrivals.

**No session identifier was introduced, deliberately** (`ADMIN_PANEL_SPEC.md` §13
**D7**). A "visitor" is defined as a distinct `(user_agent_hash, cf_asn)` pair
inside the window — which over-counts on browser updates and under-counts behind
shared NAT, and says so next to the number. Minting a real session id would create
a durable first-party identifier, and it is precisely the *absence* of one — a UA
**hash** and a referrer **host**, never the full URL or query — that makes the
`page_views` write defensible as consent-independent in the first place. The three
dead columns (`user_id`, `session_id`, `profile_role`) are dropped rather than
filled (AECI-585).

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
   analytics + closing-CTA specs. (AECI-536 adds the `/updates` page firing the same event with
   `source: 'updates_page'`, covered by `updates.component.spec.ts`.)
2. **PostHog captures pageviews + signup** — gated on `POSTHOG_KEY` (CI-wired; set the GH secret,
   then confirm `__AECI_POSTHOG__` in the HTML and the event in the PostHog UI).
3. **Datadog RUM reports CWV** — gated on `DD_APPLICATION_ID` + `DD_CLIENT_TOKEN` (now CI-wired; set
   the GH secrets, then confirm `__AECI_DD__` in the HTML and CWV populating in the RUM app).
4. **Baseline written** — ✅ this document.

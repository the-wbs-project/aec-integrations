# Phase 5 operational verification (AECI-233)

**Status:** runbook ready — live run pending an operator.
**Issue:** [AECI-233](https://linear.app/aec-integrations/issue/AECI-233) · **Spec:** `docs/STAGE_1_PHASE_5_SPEC.md` (all) + `docs/STAGE_1_SPEC.md` §16 Phase 5.

## Why this exists

Phase 5 (auth & reviews) is **fully merged and green in CI** — the shipped capability and its
tests are recorded in [`docs/PHASE_5_COMPLETION.md`](./PHASE_5_COMPLETION.md). What remains can't
be exercised from a static workspace: it needs a **deployed staging origin, real auth (magic link +
Google OAuth), and the live Datadog org**. This is the deferred *deployed-env confirmation only* —
the exact analogue of [AECI-222](https://linear.app/aec-integrations/issue/AECI-222) (Phase 4
operational verification) and [AECI-161](https://linear.app/aec-integrations/issue/AECI-161)
(Phase 2 Datadog live-apply).

This runbook is the single place to **execute** the verification and **record** the result. Work
through Parts A–D against staging, then fill the [sign-off tables](#sign-off). No application code
changes are part of this issue — Phase 5 ships already.

> **Pre-flight fix already landed in this branch.** `observability/datadog/dashboard-auth-reviews.json`
> had `reflow_type: "fixed"` paired with `layout_type: "ordered"` — the same defect that made
> AECI-222's first apply reject (an ordered dashboard requires `"auto"`). It is corrected to `"auto"`
> here so the Part D apply succeeds first try; the three monitor JSON files are unchanged (their
> `@NOTIFICATION_CHANNEL_TBD` placeholder is intentional — substituted at apply time, per
> [`docs/OBSERVABILITY.md`](./OBSERVABILITY.md) "Monitors").

## Prerequisites

| Need | Detail |
|---|---|
| **Staging origin** | `https://staging.aecintegrations.com` — behind **Cloudflare Access** (same allowlist as PR previews). Humans: OTP-to-email. Automation (axe/LH/curl): the `aeci-gh-actions` service token → `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers. See [`docs/access.md`](./access.md) §2. |
| **Supabase auth** | One shared project `ktuhnlypztujpsseujzx` serves every env (ADR 0017). Its **Redirect URLs** already allow-list `https://staging.aecintegrations.com/**`, so deployed magic links carry the **staging** callback. If a magic link instead points at `localhost`, the allow-list regressed — see `docs/environments.md` §"Deployed Supabase Auth". |
| **Test accounts** (shared auth project) | A **normal** user; an **admin** (D1 `profiles.role = 'admin'` keyed to the account's Supabase `auth.users.id`); a **banned** user (`profiles.banned_at` set); and a **Google** account for the OAuth path. Seeded out-of-band via `scripts/seed-staging-users.sql` (auth is never sourced from prod — ADR 0017). |
| **Staging D1** | `aeci-app-staging`. Already holds ~211 synthetic **approved** demo reviews across the 43 real products (id prefix `aeceed00-`) — handy for the ≥5 gate, but pick a product deliberately for A6. Query it with `wrangler d1 execute aeci-app-staging --remote --env staging`. |
| **Datadog (Part D)** | Site `us5.datadoghq.com`. `DD_API_KEY` (the existing Worker key works for writes) **and** `DD_APP_KEY` (**operator-only**, never a Worker secret). |

---

## Part A — End-to-end happy path

Drive this as one continuous session (the metrics in the right column feed the Part D dashboard, so
do Part A **before** confirming the dashboard widgets). Each row cites the emitting code path.

| # | Action | Expected result | Metric (code path) |
|---|---|---|---|
| A1 | Sign in via **magic link** (request link → open the staging callback link) | Session set; header shows signed-in state | `aeci.auth.signin{method:magic_link,outcome:success}` — `apps/web/src/server/routes/auth-callback.ts` |
| A2 | Sign out, then sign in via **Google OAuth** | Session set; PKCE `/auth/callback` completes; profile ensured | `aeci.auth.signin{method:google,outcome:success}` — same callback |
| A3 | As the normal user, submit a review at `/products/<slug>/review` | 201 / redirect to the product; review lands **`pending`** | `aeci.review.submit{outcome:ok}` — `apps/api/src/routes/reviews.ts` |
| A4 | As **admin**, **approve** that review in `/admin/reviews` | Review → `approved`; product review count recomputed; product cache-tag purged | `aeci.moderation.action{action:approve,outcome:ok}` — `apps/api/src/routes/admin-reviews.ts` |
| A5 | As **admin**, **reject** a second pending review (reason is **required**) | Review → `rejected` with the reason stored; reject with empty reason is refused | `aeci.moderation.action{action:reject,outcome:ok}` |
| A6 | View the product page / `GET /api/products/<slug>/reviews` | The **approved** review appears in the public list (no PII). On a product crossing **5 approved**, the rating **summary/averages appear**; below 5 they stay hidden with the threshold note | `apps/web/src/app/products/product-reviews.ts` (≥5 gate) |
| A7 | As the normal user, **delete the account** at `/account` (confirm dialog) | Account gone; the user's review **survives but is anonymized**: `reviewer_id → NULL`, `anonymized_at` stamped, body/title intact | `apps/api/src/routes/account.ts` (single GDPR batch) |

**A7 verification query** (the row must survive with a nulled, stamped reviewer):

```bash
wrangler d1 execute aeci-app-staging --remote --env staging \
  --command "SELECT id, status, reviewer_id, anonymized_at, substr(title,1,20) AS title FROM reviews WHERE id = '<the-A3-review-id>';"
# Expect: status unchanged (e.g. approved), reviewer_id = NULL, anonymized_at = a timestamp, title intact.
```

---

## Part B — Deny paths (observed live)

| # | Action | Expected | Code path |
|---|---|---|---|
| B1 | **Banned** user submits a review (`POST /api/reviews`) | `403` with code **`REVIEW_BANNED`** | `apps/api/src/lib/authz.ts` (ban check) |
| B2 | **Non-admin** opens `/admin` (or `/admin/reviews`) | The **404 surface** (no admin UI revealed; not a 403) | `apps/web/src/app/admin/admin-shell.ts` (resolver maps 401/403 → 404) |
| B3 | **Unauthenticated** opens `/products/<slug>/review` (and `/account`, `/admin`) | Redirect to `/auth/login?return=<path>` | `apps/web/src/server-runtime.ts` (SSR auth gate) |

---

## Part C — axe + Lighthouse on the auth-gated pages

The CI axe/Lighthouse jobs only reach **public** pages — they have no session, so
`/products/<slug>/review`, `/account`, `/admin`, and `/admin/reviews` are never audited there. Run
them here against staging with a **real** authenticated context.

**1. Capture an authenticated browser state once.** Sign in (Part A), then save Playwright
`storageState` — it carries the Supabase session cookies **and** the Cloudflare Access cookie:

```bash
cd apps/web
# Headed sign-in → writes .auth/staging.json (gitignored). Reuse it for both axe and a fresh page.
npx playwright open --save-storage=.auth/staging.json https://staging.aecintegrations.com/auth/login
```

**2. axe (`@axe-core/playwright`)** — a one-off script that loads each gated page with that state and
asserts zero `error`/`serious` violations (WCAG-A/AA tags, the same set the CI suite uses in
`apps/web/e2e/phase2-a11y.spec.ts`):

```js
// apps/web/scripts/axe-authed.mjs  (one-off; run from apps/web)
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const BASE = 'https://staging.aecintegrations.com';
const PAGES = ['/products/<slug>/review', '/account', '/admin', '/admin/reviews'];
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: '.auth/staging.json' });
for (const path of PAGES) {
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocking = violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  console.log(path, blocking.length ? '❌ ' + blocking.map((v) => v.id).join(',') : '✅ clean');
  await page.close();
}
await browser.close();
```

```bash
node scripts/axe-authed.mjs   # from apps/web
```

**3. Lighthouse (authenticated, best-effort).** Lighthouse CI's URL list is local/public-only, so run
the `lighthouse` CLI directly with the session + Access cookies via `--extra-headers`. Extract the
`Cookie` value from `.auth/staging.json` (the `sb-…-auth-token…` chunked cookies + `CF_Authorization`),
then:

```bash
npx lighthouse "https://staging.aecintegrations.com/account" \
  --only-categories=accessibility,best-practices,seo \
  --extra-headers='{"Cookie":"<sb-...-auth-token=...; CF_Authorization=...>"}' \
  --chrome-flags="--headless=new" --quiet --output=json --output-path=/tmp/lh-account.json
```

**Acceptance:** zero axe `error`/`serious`; Lighthouse a11y/best-practices/SEO at or above the
documented budgets. Interpret deployed scores per the OBSERVABILITY/Lighthouse notes — a deployed
**best-practices ≈ 82** is the Cloudflare `/cdn-cgi/challenge-platform` script, **not** a code
regression (see the `project_deployed_lighthouse_bp_cloudflare_challenge` context). The gated pages
are non-indexed by design, so SEO `noindex` findings are expected, not failures.

---

## Part D — Live Datadog apply (us5)

Apply the **fixed** dashboard + the three Phase 5 monitors, substituting the notification handle at
apply time (the committed JSON keeps the `@NOTIFICATION_CHANNEL_TBD` placeholder — do **not** commit
the resolved handle). From the repo root:

```bash
export DD_API_KEY=...   # existing Worker key works for writes
export DD_APP_KEY=...    # operator app key — NOT a Worker secret
DD=https://api.us5.datadoghq.com
HANDLE='@chrisw@thewbsproject.com'   # resolved Datadog email handle (AECI-222)

# 1) Dashboard — capture the returned id/url
curl -sX POST "$DD/api/v1/dashboard" \
  -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  -H 'Content-Type: application/json' \
  -d @observability/datadog/dashboard-auth-reviews.json | tee /tmp/dash.json | jq -r '.url'
# Full Live URL = https://us5.datadoghq.com + the .url field above.

# 2) The three Phase 5 monitors — substitute the handle inline
for m in monitor-auth-error-rate monitor-toxicity-outage monitor-moderation-queue-age; do
  sed "s/@NOTIFICATION_CHANNEL_TBD/$HANDLE/" "observability/datadog/$m.json" \
  | curl -sX POST "$DD/api/v1/monitor" \
      -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
      -H 'Content-Type: application/json' -d @- | jq -r '"\(.id)\t\(.name)"';
done
```

**One-time manual step:** enable **percentile aggregations** for the distribution metric
`aeci.toxicity.api.duration_ms` (Datadog → **Metrics → Summary** → the metric → Advanced), or the
p50/p95/p99 latency widget renders empty (OBSERVABILITY.md distribution-metric gotcha).

**Verify after apply:**
- The dashboard renders all **8** widgets (template variable `env` → `staging`).
- The Part A traffic populated `aeci.auth.signin` (by `outcome`/`method`), `aeci.review.submit`
  (by `outcome`), and `aeci.moderation.action` (by `action`/`outcome`) within ~5 min.
- The two **moderation-queue gauges** (`queue_depth`, `queue_oldest_age_hours`) report only from the
  **06:00 UTC** API-Worker cron — they appear after the next run, not from on-demand traffic.
- Monitor states are as designed: the **auth** and **toxicity** monitors are traffic-driven (no
  `notify_no_data` — they sit OK/quiet at low volume; the failure *ratio* is the signal), and the
  **moderation-queue** monitor doubles as the cron-liveness check (`notify_no_data` ≈ 26h).
- Paste the full dashboard Live URL into [`docs/OBSERVABILITY.md`](./OBSERVABILITY.md) (the Phase 5
  "Live URL" line) **and** the sign-off table below.

---

## Sign-off

Fill these in during the live run (date `YYYY-MM-DD`, operator initials). The four checkboxes map to
the four AECI-233 acceptance criteria.

### AC1 — End-to-end on staging

| Step | Expected | Observed | Date | By |
|---|---|---|---|---|
| A1 magic-link sign-in | session + `signin{magic_link,success}` | | | |
| A2 Google OAuth sign-in | session + `signin{google,success}` | | | |
| A3 submit review | `pending` + `review.submit{ok}` | | | |
| A4 approve | `approved` + `moderation.action{approve,ok}` + purge | | | |
| A5 reject | `rejected` (reason required) + `moderation.action{reject,ok}` | | | |
| A6 public list + ≥5 gate | approved review shown; averages flip at 5 | | | |
| A7 account delete | `reviewer_id` NULL, `anonymized_at` set, row survives | | | |

### AC2 — Deny paths

| Step | Expected | Observed | Date | By |
|---|---|---|---|---|
| B1 banned submit | `403 REVIEW_BANNED` | | | |
| B2 non-admin `/admin` | 404 surface | | | |
| B3 unauthenticated gated page | `/auth/login?return=` redirect | | | |

### AC3 — axe + Lighthouse (authed)

| Page | axe (0 error/serious) | LH a11y / BP / SEO | Date | By |
|---|---|---|---|---|
| `/products/<slug>/review` | | | | |
| `/account` | | | | |
| `/admin` | | | | |
| `/admin/reviews` | | | | |

### AC4 — Live Datadog apply

| Item | Value |
|---|---|
| Dashboard Live URL | _paste here + into OBSERVABILITY.md_ |
| Monitors created (3 ids) | |
| `aeci.auth.signin` / `review.submit` / `moderation.action` flowing | |
| Percentile aggregations enabled for `aeci.toxicity.api.duration_ms` | |
| Applied (date / operator) | |

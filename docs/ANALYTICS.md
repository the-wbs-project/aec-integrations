# Product Analytics

**Status:** the source of truth for AECi's **product** analytics — the event
catalogue, the naming and privacy rules, the activation funnel, and the identity
model. Introduced by AECI-649 (§AW8 of `POSTHOG_MIGRATION_SPEC.md`).

**Scope.** This is the product companion to [`OBSERVABILITY.md`](./OBSERVABILITY.md).
The split is by question, not by vendor — both land in PostHog:

| Ask | Doc |
|---|---|
| "Is the system healthy?" — logs, metrics, errors, alerts, crons | `OBSERVABILITY.md` |
| "Are people getting value?" — events, funnels, retention, flags | **this file** |

The third surface is the `page_views` D1 table + `/admin` (§14.2), which is
**consent-independent** and sees the Cloudflare request context PostHog cannot.
When the two disagree on a count, `page_views` is the authoritative number and
PostHog is the authoritative *funnel* — see "Consent shapes every number" below.

---

## 1. Naming conventions

These describe what the codebase already does. AECI-649 codified them rather
than changing anything, because the only alternative was renaming shipped
events, and that is the one thing you must not do.

- **Events are `snake_case`, `object_verb`.** `product_viewed`, not
  `viewProduct` or `Product Viewed`. The object first is what makes the event
  list sort into something readable once there are forty of them.
- **Properties are `snake_case`.** `results_count`, not `resultsCount`.
- **Never rename a shipped event.** PostHog has no rename-and-backfill. A rename
  does not move history — it **splits the series**, so every funnel, insight and
  alert built on the old name silently stops counting on deploy day while the
  chart still renders. If a name is wrong, the cheap fix is to leave it and
  document what it means; the expensive fix is to add the new name, run both,
  and retire the old one on a stated date.
- **Feature-flag keys are `kebab-case` and feature-scoped** (AECI-650). Different
  namespace, different convention, deliberately — so a flag key never reads like
  an event name.

## 2. Never in a property

**Record identifiers and shapes. Never contents.** A property is a
permanently-retained, queryable, exportable string attached to a person. Treat
every one as if it will be read by someone who should not have seen it, because
eventually it will be.

| Never send | Send instead | Why |
|---|---|---|
| Review body text | `product_id`, `review_id` | Free text is unbounded, may quote a vendor, and is the thing a review-moderation dispute turns on. Read it from D1 with an audit trail. |
| Reviewer or claimant email address | nothing, or the Supabase `user.id` via `identify()` | An email is a direct identifier. `identify()` already links the person; duplicating the email into a property makes it searchable by anyone with project read. |
| Request / correction description text | `request_id`, `target_type`, `slug` | Same as review bodies. The description frequently names individuals at a vendor. |
| Vendor contact names, phone numbers | `vendor_id` | Direct identifiers with no analytical use. |
| Anything from a form the user typed | the outcome of the submission | If you find yourself wanting the input, what you actually want is a funnel step. |
| A raw URL containing a token | the route pattern | Unsubscribe and magic-link URLs carry credentials. |

**One grandfathered exception: `search_performed.query`.**

This one *is* the search term the visitor typed, and it ships. It is documented
here rather than quietly tolerated because it is a real exception to the rule
above, and the reasoning has to survive the next reader:

- It is the single highest-value analytics property AECi has. "What did people
  search for and not find" is the demand signal the whole catalogue-growth loop
  runs on, and there is no identifier-shaped substitute for it.
- It is consent-gated (Tier 3 — see §5), so it is only ever recorded for a
  visitor who accepted the banner.
- It is a search term for **software integrations**, not a health condition or a
  legal question. The sensitivity profile of the corpus is genuinely low.

That is the whole case. It does not generalise: it is not a licence to send
other free text, and a second exception needs its own written argument here.

## 3. Required context

Two dimensions ride **every** event, merged in by `analyticsDimensions()`
(`apps/web/src/app/analytics/analytics-dimensions.ts`) for custom events and
registered as PostHog super-properties before the first auto-pageview:

- **`locale`** — from `<html lang>`, set by the SSR Worker's URL-prefix locale
  dispatch. `en-US` today.
- **`theme`** — from `<html data-theme>`. Always `light` today (dark was removed
  in AECI-226) and emitted anyway, so the schema is already correct on the day
  dark returns with the Stage 2 vendor portal.

Beyond those, an event carries the identifiers needed to join it back to the
catalogue and nothing else. If a property is not going to be used in a
breakdown, a filter, or a funnel step definition, it should not be sent.

## 4. Event catalogue

Every shipped product event. **A new event is not shipped until it has a row
here** — see §7.

| Event | Fired from | Properties | Notes |
|---|---|---|---|
| `$pageview` | automatic (`capture_pageview: 'history_change'`) | PostHog defaults + the two super-properties | Covers SPA navigations, because the Angular Router drives `history.pushState`. Consented visitors only. |
| `app_started` | app bootstrap (AECI-643) | the two dimensions | **Tier 2** — fires for *every* visitor, consented or not. A liveness beacon: it is how you tell "nobody visited" from "the bundle is broken". |
| `search_performed` | `search-controller.ts`, once per distinct non-empty query when the root stats settle | `query`, `results_count`, `filters_applied[]`, `status`, `duration_ms`, `results_bucket` | The empty initial `/search` load is skipped. The last three properties arrived in AECI-643, absorbing the retiring `aeci.search.query` Datadog RUM action (§3.9) — which means search *latency* is now a consented-slice number where RUM saw every search. |
| `product_viewed` | `products/product-detail.ts` (`afterNextRender`) | `product_id`, `source` | `source` is `search` / `browse` / `direct`, derived from the previous in-app route. |
| `integration_viewed` | `integrations/integration-detail.ts` | `integration_id` | |
| `external_link_clicked` | the `[aecTrackExternalLink]` directive on outbound detail-page anchors | `destination`, `source` | **The one that matters most.** The outbound click to a vendor is what the product actually sells; see §6. |
| `review_submitted` | `reviews/review-form.ts` on submit success | `product_id` | Body text deliberately absent (§2). |
| `claim_requested` | `requests/request-form-body.ts` on submit success | `target_type`, `slug`, `request_id` | See the deviation note below. |
| `correction_requested` | `requests/request-form-body.ts` on submit success | `target_type`, `slug`, `request_id` | Same. |
| `mailing_list_signup` | the shared signup band + `/updates`, on `created` only | `source` | `home_closing_cta` / `mailing_list_band` / `updates_page`. Re-submitting an existing email is not tracked. |
| `deployment` | CI (`scripts/ci/posthog-deploy-marker.sh`, AECI-640) | `env`, `service`, `version`, `deploy_kind`, `app`, `workflow`, `run_url` | Not a user event — `$process_person_profile: false`, `distinct_id: aeci-ci`. It exists so "which deploy introduced this" is a query rather than a memory. |

**Documented deviation — the claim/correction identifier.** The Stage 1 spec
§14.1 names `vendor_id` / `product_id` on these two events. The request form
holds only `(target_type, slug)` by design and the submit response returns only
`request_id` — the client never sees the UUID. So the events record the honest
client-available identifier. The slug is 1:1 with the entity and joins back
fine; resolving the UUID would cost a round-trip for no analytical gain.

## 5. Consent shapes every number

AECi runs a **two-mode** PostHog client (AECI-643 / §3.3). This is the single
most important thing to understand before reading any chart here.

| Tier | Runs for | Carries | Persistence |
|---|---|---|---|
| **1 — server** | always, no consent concept | Worker logs, all metrics, audit forwards, deploy markers | n/a |
| **2 — browser operational** | **every visitor, including DNT/GPC** | errors, `$web_vitals`, `app_started` | **memory only** — no identifier, no localStorage, no cookie |
| **3 — product analytics** | consented visitors only; DNT/GPC are a hard deny | `$pageview` + the event catalogue above, `identify`, groups | localStorage |

Consequences you must hold in your head when reading a number:

- **Every event in §4 except `app_started` and `deployment` is a
  consented-slice count, not a total.** It is a funnel, not a census.
- The authoritative, consent-independent counts live elsewhere: page views in
  the `page_views` D1 table, mailing-list signups in the `mailing_list` table,
  reviews and requests in their own tables. When a stakeholder asks "how many",
  answer from D1; when they ask "how many *converted*", answer from PostHog.
- Tier 2 writes no identifier, so each page load is a fresh anonymous id. Error
  counts are therefore **occurrence** counts, not affected-visitor counts. That
  is the accepted price of running ops telemetry without asking permission.
- **Session replay is off** (D5). Enabling it is a separate privacy review, not
  a config toggle.

## 6. The activation funnel

`search_performed` → `product_viewed` → `external_link_clicked`

That is the product thesis expressed as three events. Someone arrives with a
question, finds a candidate, and leaves for the vendor — the outbound click is
the moment AECi delivered what it promised, which is why `external_link_clicked`
is the terminal step and not `product_viewed`.

Two deeper-commitment steps sit past it, measured separately because they are
contribution rather than consumption:

- `review_submitted` — the visitor gave something back to the catalogue.
- `claim_requested` — a **vendor** found their own listing, which is the Stage 2
  vendor-portal top of funnel.

All five events already exist. Building these is insight work, not
instrumentation work: nothing in the app needs to change to answer them.

## 7. Adding an event — the checklist

1. **Check it doesn't already exist.** Read §4. An event that nearly fits is
   almost always better than a new one, because a new name splits the analysis
   even when it doesn't split a series.
2. **Name it `object_verb`, `snake_case`**, and pick the name as if you can
   never change it — because you can't (§1).
3. **Check every property against §2.** Identifiers and shapes, never contents.
   If you want free text, you want a funnel step instead.
4. **Add a row to the catalogue in §4 in the same PR.** Not "later", not a
   follow-up issue. An event that ships without its row is an event that, in
   eight months, nobody can explain, and that is how event catalogues rot —
   one reasonable exception at a time.

## 8. Identity and vendor groups

The vendor portal exists on `stage-2`, so identity is Stage-2-native rather than
retrofitted (§3.10).

- **`identify(user.id)` after Supabase auth.** The Supabase user id and nothing
  else — never the email (§2). This is what turns a stream of anonymous events
  into "this person searched, then reviewed".
- **`group('vendor', vendor_id, { name })` on vendor-dashboard entry.** This is
  the B2B piece and it is the reason groups exist here at all: it makes "how
  many **vendors** activated" answerable, which a per-person count cannot
  approximate. One vendor with four seats is one activated vendor, not four.
- **`posthog.reset()` on logout.** Without it, the next anonymous session on
  that browser is attributed to the person who just left — which is both wrong
  and, on a shared machine, a privacy problem.
- **Server-side events fall back to the service slug (`aeci-api`) as
  `distinct_id`.** Never mint a per-request id: a synthetic id creates a bogus
  person on every request and corrupts every person-linked view in the project.
  The same rule governs `posthogDistinctId` on logs (AECI-644) — emit it only
  where a genuine Supabase user id is in hand, and omit the attribute entirely
  otherwise.

## 9. Operator hygiene

- **Exclude internal users.** Chris's consented browser feeds the production
  project, while the `page_views` table already excludes him via his verified
  admin session (verified live 2026-08-24). Until the exclusion is configured,
  production product analytics carry operator traffic and `page_views` does not
  — so the two surfaces disagree for a reason that looks like a bug. Configure
  PostHog's "filter internal and test users" on project 354071.
- **Demo does not report to production.** Since AECI-640, preview / staging /
  demo / stage2 all report to `aec-integrations-dev` (525793) and production is
  the only tier on `aec-integrations` (354071). Events in 354071 from **before**
  that change carry mixed tiers — filter by `$host` when reading history.

## 10. Related

- [`OBSERVABILITY.md`](./OBSERVABILITY.md) — logs, metrics, alerts, the metric
  catalogue and its cardinality budget.
- [`POSTHOG_MIGRATION_SPEC.md`](./POSTHOG_MIGRATION_SPEC.md) — the migration
  contract, the consent decision record, and the project topology.
- [`ANALYTICS_BASELINE.md`](./ANALYTICS_BASELINE.md) — the AECI-326
  starting-numbers snapshot and the weekly read procedure.
- [`ADMIN_PANEL_SPEC.md`](./ADMIN_PANEL_SPEC.md) §7 — the consent-independent
  operator console over `page_views`.

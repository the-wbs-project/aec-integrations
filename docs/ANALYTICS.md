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
| `$identify` | automatic, on `identify(user.id)` after consented sign-in (AECI-649) | PostHog defaults | The Supabase user id and nothing else — **never** the email (§2). Consent-gated: a signed-in visitor who declined, or who sends DNT/GPC, stays anonymous. |
| `$groupidentify` | automatic, on `group('vendor', vendor_id, { name })` at vendor-dashboard entry | `vendor_id`, `name` | The B2B piece — it is what makes "how many **vendors** activated" answerable. One vendor with four seats is one activated vendor. |
| `app_started` | app bootstrap (AECI-643) | the two dimensions | **Tier 2** — fires for *every* visitor, consented or not. A liveness beacon: it is how you tell "nobody visited" from "the bundle is broken". |
| `search_performed` | `search-controller.ts`, once per distinct non-empty query when the root stats settle | `query`, `results_count`, `results_products`, `results_vendors`, `filters_applied[]`, `status`, `duration_ms`, `results_bucket` | The empty initial `/search` load is skipped. `status` / `duration_ms` / `results_bucket` arrived in AECI-643, absorbing the retiring `aeci.search.query` Datadog RUM action (§3.9) — so search *latency* is now a consented-slice number where RUM saw every search. `results_products` / `results_vendors` split the federated total, because 8 hits being 8 products or 8 vendors are different demand signals. Only two indexes: `/search` does not search integrations. |
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

  Two consequences worth knowing, both established by reading the SDK source
  rather than assuming (AECI-649):

  1. **`reset()` clears the super-properties**, so the `locale` and `theme`
     dimensions §3 says ride *every* event would silently stop riding the
     automatic ones (`$pageview`, `$exception`, `$web_vitals`) after a logout.
     Custom events survive because `capture()` merges them per call — which is
     exactly what would make the bug hard to spot. The reset path therefore
     re-registers the dimensions immediately, and a test pins the order.
  2. **The client stays on Tier 3 after logout**, with a fresh anonymous id.
     That is correct, not an oversight: signing out does not withdraw consent,
     and a consented signed-out visitor is simply a consented anonymous
     visitor. Downgrading to Tier 2 would stop `$pageview` for someone who is
     still consented.
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

## 10. Feature flags

Flags are the *other* thing PostHog does for AECi, and they are governed here
because they share the browser client, the consent posture and the key
namespace with events. Introduced by AECI-650 (§AW9). The mechanism lives in
`apps/web/src/app/analytics/feature-flags.ts`; that file's header is the
long-form version of everything below.

### 10.1 The catalogue is the type

`featureFlagDefaults` is a committed map of every flag key to the value the app
must behave correctly under when PostHog has not answered:

```ts
export const featureFlagDefaults = {
  'example-placeholder': false,
} as const satisfies Record<string, boolean>;

export type FeatureFlag = keyof typeof featureFlagDefaults;
```

`FeatureFlag` is *derived from* the catalogue, so `flags.flag('serch-v2')` is a
**compile error** rather than a flag that quietly reads `false` forever. That
inversion is the point: at runtime an unknown key and a switched-off flag are
indistinguishable, which is the most common way flag plumbing fails silently.

**User-visible flags default to `false`** — the unflagged path is the shipped
path, so a PostHog outage degrades to today's behaviour rather than to a
half-rolled-out one.

`example-placeholder` is exactly what it says. AECI-650 delivered the mechanism
before there was a surface to gate; the row exists only because an empty map
types `FeatureFlag` as `never` and makes every call site a compile error.
Delete it in the PR that adds the first real flag.

### 10.2 There is no `undefined` third state

`flag(key)` returns `Signal<boolean>`, never `Signal<boolean | undefined>`. The
signal is *created* at the committed default and is only ever replaced by a
real evaluation once the `/flags` response lands. There is no window in which a
caller can observe `undefined`.

That is a deliberate narrowing of the SDK, which does have a third state:
`posthog.isFeatureEnabled(key)` returns `undefined` both before flags load and
for a key the project does not define. Exposing it would force every call site
to handle "not loaded yet", and they would not; they would write `if (flag())`
and ship the wrong branch for the first few hundred milliseconds of every page
load. The collapse to a boolean therefore happens once, at the seam.

Three behaviours follow from the same rule:

- **A flip propagates without a redeploy.** The service subscribes to
  `onFeatureFlags`, which fires when `/flags` first answers *and* on every later
  change, so toggling a flag in the PostHog UI moves a live page.
- **Late subscribers adopt the current value.** A component that mounts after
  the response landed is seeded from the loaded client, not left on the default
  until the next change (which may never come).
- **Signal identity is stable.** Repeated `flag('x')` calls return the same
  signal instance, so a template binding does not churn.

Reads pass `send_event: false`, mirroring `sendFeatureFlagEvents: false` on the
Worker seam: reading a flag must not capture a `$feature_flag_called` event
into the Tier 2 pre-consent slice, and AECi runs no PostHog experiments, which
are the only consumer of those events.

### 10.3 Keyless tiers are deterministic

With no `window.__AECI_POSTHOG__` (bare local dev, an unprovisioned tier) the
client boot resolves `null`, nothing subscribes, and every flag stands at its
default. **Nothing is fetched.** Local dev behaves identically on every machine
and never depends on the network, which is the browser-side twin of the
transport's "no project key means total no-op" invariant
(`POSTHOG_MIGRATION_SPEC.md` §2, invariant 3).

### 10.4 Flags never alter cacheable SSR output

**This is the AECi-specific rule, and it is the one that will hurt if it is
forgotten.**

The Workers Cache is keyed by **URL** and nothing about the visitor
(`CACHE_STRATEGY.md` §4a, `STAGE_1_SPEC.md` §9.1a). If a flag reached an SSR
render decision, the **first visitor's flag evaluation would be baked into the
cached HTML and served to everyone**, including every visitor in the other
variant. It is the same trap as the theme cookie, with a worse failure mode: a
mis-served theme is visible, a mis-served variant is not, so the experiment
just reports nonsense.

Two consequences:

1. **Flag-gated UI reconciles post-hydration** — the pattern `ReviewCta`
   (`apps/web/src/app/reviews/review-cta.ts`) and `ConsentBanner` already use:
   render the visitor-neutral default during SSR, let the browser move it
   afterwards. Follow that pattern; do not invent a second mechanism. Here it
   costs nothing extra, because §10.2 already guarantees the signal starts at
   the default, which is also what keeps hydration matching (server render and
   first client render read the identical value).
2. **Server-side flag checks are for API-Worker behaviour only** — never for an
   SSR render decision.

The rule is enforced **by construction**, not by discipline: `FeatureFlags`
resolves no value on the server (the constructor returns early, and the SDK is
browser-only), so an SSR pass can only ever see defaults. The one way to break
it is to call the Worker-side helper from SSR code, which is what rule 2
forbids.

### 10.5 Server-side evaluation, and its price

`isFeatureEnabled(env, key, distinctId, fallback)` in
`packages/shared/src/posthog.ts` (AECI-642) is the Worker-side check. Two
things to know before reaching for it:

- **It costs a network round-trip per call.** Local evaluation would require a
  personal API key (`phx_`) or a project secret key inside the client, and
  neither may ever become a Worker secret — a publishable-token-only telemetry
  surface is one of the properties this migration bought. So the round trip is
  **genuinely unavailable, not merely unimplemented**. Budget for it at the call
  site; do not reach for `secretKey`.
- **It returns `fallback` on anything going wrong** — missing project key,
  evaluation error, or a flag the project does not define. Same no-third-state
  discipline as the browser side.

Server-side flags have no catalogue equivalent today because the type lives in
`apps/web`. Pass the same kebab-case key and the same default you would use in
the browser.

### 10.6 Conventions

- **Keys are `kebab-case` and feature-scoped** (`vendor-seat-invites`, not
  `newFlag` or `flag_2`). A different namespace from events (`snake_case
  object_verb`) on purpose, so a flag key never reads like an event name (§1).
- **Check a flag at route or feature level, never in a leaf component.** One
  check that picks a branch is reviewable; twenty checks sprinkled through a
  component tree are a permanent second code path.
- **Flags are scaffolding, not architecture.** Remove the flag, its catalogue
  row and the dead branch **within weeks of full rollout**. A flag that outlives
  its rollout has become architecture, and nobody ever deletes architecture.
- **Never gate a security or authorization decision on a flag.** Authorization
  is `docs/AUTH_AND_RLS.md`'s three layers; a client-evaluated boolean is a
  presentation detail.

### 10.7 Adding a flag — the checklist

1. **Check the flag is the right tool.** If the branch will live forever it is
   configuration, not a flag. If it varies by entitlement it is a capability
   (`STAGE_2_PAID_TIERS_SPEC.md` §8), not a flag.
2. **Name it `kebab-case` and feature-scoped**, and decide the default as "what
   must happen when PostHog is unreachable". User-visible means `false`.
3. **Add it to `featureFlagDefaults` in the same PR.** Not "later", not a
   follow-up issue: the catalogue is the type, so a flag that is not in it does
   not compile, and a flag added without a row here is one nobody can explain in
   eight months.
4. **Put the check at route or feature level**, and make the flagged branch
   reconcile post-hydration if it renders on a cacheable route (§10.4).
5. **Create the flag in BOTH PostHog projects** — `aec-integrations-dev`
   (525793) for preview / staging / demo / stage2 and `aec-integrations`
   (354071) for production. A flag that exists only in prod reads as its default
   everywhere else, which looks exactly like a broken rollout.
6. **Write down the removal trigger** in the issue: what has to be true before
   the flag and its branch are deleted.

## 11. Related

- [`OBSERVABILITY.md`](./OBSERVABILITY.md) — logs, metrics, alerts, the metric
  catalogue and its cardinality budget.
- [`POSTHOG_MIGRATION_SPEC.md`](./POSTHOG_MIGRATION_SPEC.md) — the migration
  contract, the consent decision record, and the project topology.
- [`ANALYTICS_BASELINE.md`](./ANALYTICS_BASELINE.md) — the AECI-326
  starting-numbers snapshot and the weekly read procedure.
- [`ADMIN_PANEL_SPEC.md`](./ADMIN_PANEL_SPEC.md) §7 — the consent-independent
  operator console over `page_views`.

import {
  ApiErrorCode,
  CategoryDetailSchema,
  AudienceDetailSchema,
  PhaseDetailSchema,
  TradeDetailSchema,
} from '@aeci/shared';
import { Hono } from 'hono';

import { getDb } from './db/client';
import type { Env } from './env';
import { ApiError, errorHandler } from './errors';
import { requireAdmin, requireAuth, requireVendor, type AuthzVariables } from './lib/authz';
import { resolveClaimantIdentity } from './lib/claimant-identity';
import { sendClaimDecisionEmail, sendSeatInvite } from './lib/email';
import { pushRequestResolutionToLinear } from './lib/linear';
import { requireReviewAppAuth } from './lib/review-auth';
import { requireUserAuth } from './lib/user-auth';
import type { UserAuthVariables } from './lib/user-auth';
import {
  createDeleteAccountHandler,
  createGetAccountHandler,
  createUpdateAccountHandler,
} from './routes/account';
import { createGetAccountReviewsHandler } from './routes/account-reviews';
import { createAdminClaimsListHandler, createModerateClaimHandler } from './routes/admin-claims';
import { createSetConnectorCatalogManagementHandler } from './routes/admin-connector-catalogs';
import {
  createAdminConnectorAuditHandler,
  createAdminConnectorCatalogDetailHandler,
  createAdminConnectorCatalogsListHandler,
  createAdminConnectorPairsHandler,
  createAdminConnectorStubsHandler,
} from './routes/admin-connectors';
import { createSetVendorEntitlementHandler } from './routes/admin-entitlements';
import {
  createAdminRevokeSeatHandler,
  createAdminVendorAuditHandler,
  createAdminVendorDetailHandler,
  createAdminVendorsListHandler,
} from './routes/admin-vendors';
import { createAdminUserDetailHandler, createAdminUsersListHandler } from './routes/admin-users';
import {
  createAdminRequestsListHandler,
  createModerateRequestHandler,
} from './routes/admin-requests';
import {
  createBanReviewerHandler,
  createBannedReviewersListHandler,
} from './routes/admin-reviewers';
import { createAdminAudienceHandler } from './routes/admin-audience';
import { createAdminCatalogCoverageHandler } from './routes/admin-catalog';
import { createAdminFeedbackHandler } from './routes/admin-feedback';
import { createAdminOverviewHandler } from './routes/admin-overview';
import { createAdminTimeseriesHandler } from './routes/admin-metrics';
import { createAdminPageViewsHandler } from './routes/admin-page-views';
import { createAdminTrafficBreakdownHandler } from './routes/admin-traffic';
import { createAdminSummaryHandler } from './routes/admin-summary';
import { createAdminSystemHandler } from './routes/admin-system';
import { createEnsureProfileHandler } from './routes/auth-profile';
import { createAuthWhoamiHandler } from './routes/auth-whoami';
import { bookmarkMiddleware } from './bookmark-middleware';
import { metricsMiddleware } from './metrics-middleware';
import { createHealthHandler } from './routes/health';
import {
  createIntegrationDetailHandler,
  createIntegrationsListHandler,
  createPairTimelineHandler,
  createProductPairHandler,
} from './routes/integrations';
import {
  createFeedbackHandler,
  createSubscribeHandler,
  createUnsubscribeHandler,
} from './routes/landing-forms';
import { createPageViewsHandler } from './routes/page-views';
import { createProductFacetsHandler } from './routes/product-facets';
import { createAdminReviewsListHandler, createModerateReviewHandler } from './routes/admin-reviews';
import { createProductReviewsListHandler } from './routes/product-reviews';
import { createProductDetailHandler, createProductsListHandler } from './routes/products';
import { createPromoteJobHandler } from './routes/promote-jobs';
import {
  createConnectorCatalogKickoffHandler,
  createPromoteKickoffHandler,
} from './routes/promote-kickoff';
import { createClaimSubmitHandler, createCorrectionSubmitHandler } from './routes/requests';
import { createSubmitReviewHandler } from './routes/reviews';
import { createStatsHomeHandler } from './routes/stats';
import { createLinearWebhookHandler } from './routes/webhooks';
import { createTaxonomyHandler } from './routes/taxonomy';
import { createTaxonomyDetailHandler } from './routes/taxonomy-detail';
import { createTaxonomyListHandler } from './routes/taxonomy-list';
import {
  createUpdateVendorProductHandler,
  createUpdateVendorProfileHandler,
  createVendorMeHandler,
  createVendorSeatsHandler,
} from './routes/vendor';
import { createListVendorNotificationsHandler } from './routes/vendor-notifications';
import {
  createDeleteProductVersionHandler,
  createListProductVersionsHandler,
  createProductVersionHandler,
  createUpdateProductVersionHandler,
} from './routes/vendor-product-versions';
import {
  createListVendorIntegrationsHandler,
  createRetractVendorAttestationHandler,
  createUpsertVendorAttestationHandler,
  createVendorClaimHandler,
} from './routes/vendor-attestations';
import { createListDataObjectsHandler } from './routes/vendor-data-objects';
import {
  createRemoveSeatHandler,
  createRevokeSeatInviteHandler,
  createSeatInviteHandler,
} from './routes/vendor-seat-invites';
import {
  createAcceptSeatInviteHandler,
  createSeatInvitePreviewHandler,
} from './routes/seat-invites';
import { createVendorUpdatesHandler } from './routes/vendor-updates';
import { createVendorDetailHandler, createVendorsListHandler } from './routes/vendors';
import { createVersionHandler } from './routes/version';
import { queue, scheduled } from './scheduled';

const app = new Hono<{ Bindings: Env }>();

// AECI-66 / Phase 2 §14 — time every request and emit
// `aeci.api.query.duration_ms` tagged by endpoint + status. Registered first so
// it wraps the legacy routes, the Phase 2.8 sub-router, and the `*` fallthrough.
app.use('*', metricsMiddleware());

// AECI-250 — emit the D1 Sessions API `x-d1-bookmark` on write responses (for
// read-your-writes on the next request). Hono's `route()` flattens the sub-routers
// onto this app and runs them on the SAME context, so a write handler's
// `writeDb(c, …)` → `c.set('dbCtx', …)` is readable here. Reads never set `dbCtx`,
// so this is a no-op on the read path. Registered after metrics so it shares the
// same post-`next()` `finally` shape.
app.use('*', bookmarkMiddleware());

// AECI-101 — the root app gets the same `errorHandler()` as the Phase 2.8
// sub-router, so the legacy routes below and the `*` fall-throughs emit the
// canonical `docs/API_CONTRACTS.md` §3.3 envelope on the error path. Sub-app
// errors don't bubble to a parent `onError`, so `phase28` keeps its own (below).
app.onError(errorHandler());

// Legacy routes (predating Phase 2.8). `page-views` now throws `ApiError` /
// `ZodError` (rendered by the root `onError` above into the §3.3 envelope).
// `health` / `version` return responses directly and don't throw today, so the
// root `onError` is uniformity/future-proofing for them — not a behavior change.
app.get('/api/health', createHealthHandler());
app.get('/api/version', createVersionHandler());
app.post('/api/page-views', createPageViewsHandler());

// Phase 2.8 sub-router (AECI-54). `errorHandler()` converts thrown
// `ApiError` / `ZodError` instances into the canonical envelope documented in
// `docs/API_CONTRACTS.md` §3.3 so the SSR client (`server-api-client.ts`)
// receives structured error info.
const phase28 = new Hono<{ Bindings: Env }>();
phase28.onError(errorHandler());

phase28.get('/api/products', createProductsListHandler());
// AECI-143 — scoped facet counts. MUST register before `/api/products/:slug` so
// the static `facets` segment is not captured as a `:slug`.
phase28.get('/api/products/facets', createProductFacetsHandler());
phase28.get('/api/products/:slug', createProductDetailHandler());
// AECI-199 — public approved-reviews list. Longer literal path than `:slug`, so
// Hono matching order vs the detail route is unambiguous.
phase28.get('/api/products/:slug/reviews', createProductReviewsListHandler());
// AECI-294 — product-PAIR read (Stage 1.5 §7). `:slug` is the context product;
// reuses the `:slug` param name (Hono forbids differing names at one position).
phase28.get('/api/products/:slug/integrations/:otherSlug', createProductPairHandler());
// AECI-303 — the pair's per-claim attestation HISTORY (§9.1). Registered after the
// pair read; the longer literal path makes matching order unambiguous either way.
// Lazy and browser-fetched on demand, never by SSR: history is the gateable depth,
// so it must not land in the pair page's shared edge-cache entry.
phase28.get('/api/products/:slug/integrations/:otherSlug/timeline', createPairTimelineHandler());

phase28.get('/api/vendors', createVendorsListHandler());
phase28.get('/api/vendors/:slug', createVendorDetailHandler());

phase28.get('/api/integrations', createIntegrationsListHandler());
phase28.get('/api/integrations/:id', createIntegrationDetailHandler());

phase28.get('/api/categories', createTaxonomyListHandler('categories'));
phase28.get(
  '/api/categories/:slug',
  createTaxonomyDetailHandler({
    resource: 'category',
    schema: CategoryDetailSchema,
  }),
);
phase28.get('/api/audiences', createTaxonomyListHandler('audiences'));
phase28.get(
  '/api/audiences/:slug',
  createTaxonomyDetailHandler({
    resource: 'audience',
    schema: AudienceDetailSchema,
  }),
);
phase28.get('/api/phases', createTaxonomyListHandler('phases'));
phase28.get(
  '/api/phases/:slug',
  createTaxonomyDetailHandler({
    resource: 'phase',
    schema: PhaseDetailSchema,
  }),
);
// AECI-541 — the fourth facet (§5.5a). Ungated: sub-`TRADE_PUBLISH_MIN_PRODUCTS`
// terms are listed and resolve, and each surface applies the floor itself.
phase28.get('/api/trades', createTaxonomyListHandler('trades'));
phase28.get(
  '/api/trades/:slug',
  createTaxonomyDetailHandler({
    resource: 'trade',
    schema: TradeDetailSchema,
  }),
);

phase28.get('/api/taxonomy', createTaxonomyHandler());

// Phase 4.4 (AECI-179) — home stats, read straight from the `stats_cache`
// `home.*` keys (filled daily by 4.3). Never live-aggregates; a sparse cache
// returns empty-but-valid defaults, never a 500.
phase28.get('/api/stats/home', createStatsHomeHandler());

// Vendor requests (AECI-128) — claim & correction form submissions. Public (no
// auth). Insert into `vendor_requests` with an audit + genesis workflow transition;
// the Phase 6 pipeline (Linear issue creation, domain-match + duplicate flags,
// reconciliation sweep, admin moderation) hangs off the submit + the seams in
// `routes/requests.ts` / `lib/linear.ts`. No n8n (dropped — STAGE_1_PHASE_6_SPEC.md §4).
phase28.post('/api/requests/correction', createCorrectionSubmitHandler());
phase28.post('/api/requests/claim', createClaimSubmitHandler());

// Landing lead-capture (ADR 0016 / AECI-257) — the feedback + mailing-list signup
// forms, moved off Supabase Postgres onto D1. Public (no auth), no audit row
// (write-once analytics, §26.1 exemption). `subscribe` is idempotent on email.
// Reached only over the service binding (the pre-launch `apps/landing` Worker was
// retired at the apex cutover, AECI-247/277; the sole caller is now the unified
// home's closing-CTA island via the SSR `/api/*` passthrough), like every other
// route — no new public ingress.
phase28.post('/api/feedback', createFeedbackHandler());
phase28.post('/api/subscribe', createSubscribeHandler());
// Mailing-list opt-out (AECI-537). Token-keyed soft-delete; serves both the
// `/unsubscribe` page (JSON body) and the welcome email's RFC 8058 one-click
// header (`?token=` query). No public ingress — reached via the SSR `/api/*`
// passthrough (byte-for-byte; no geo forwarding needed).
phase28.post('/api/unsubscribe', createUnsubscribeHandler());

// Inbound Linear webhook (AECI-212 / Phase 6.5) — the Linear → Site half of the
// moderation sync. Public URL; auth is the `Linear-Signature` HMAC verified
// inside the handler against `LINEAR_WEBHOOK_SIGNING_SECRET` (no user session).
// On an Issue state change it updates the matching `vendor_requests.status` and
// records a `workflow_transitions` + `audit_log` row. Reached only over the
// service binding like every other route. See `routes/webhooks.ts`.
phase28.post('/api/webhooks/linear', createLinearWebhookHandler());

app.route('/', phase28);

// Review-app promotion endpoints — kick-off + poll (AECI-563 / ADR 0021). Own
// sub-router so its `onError` opts into `logClientErrors`: every rejected promote
// (400 malformed/validation, 401 bad token, 413 oversize, 503 misconfigured, 500
// fault) emits a detailed Datadog log under `source:review-app-promote` with the
// same `trace_id` the caller gets, so the review app's operator can diagnose a
// failed push from Datadog alone (docs/REVIEW_APP_PROMOTE_API.md §6) rather than
// the HTTP response body. Registered before the `/api/*` 404 catch-all (below) so
// they match; reached only over the service binding like every other route.
//
//   - POST /api/promote          — validate, start the promote Workflow, 202 { jobId }.
//   - POST /api/promote/connector-catalog
//                                — one PAGE of one connector catalogue (AECI-714).
//   - GET  /api/promote/jobs/:id — status + the committed result, for BOTH kinds.
//
// The commit no longer happens on the request: a client that walks away can no
// longer strand a committed promote's IDs (AECI-561). A failure inside the Workflow
// therefore never reaches this `onError` — the Workflow logs it itself, so §6.1's
// "every rejection is in Datadog" still holds for `SLUG_CONFLICT` / `INTERNAL_ERROR`.
const reviewPromote = new Hono<{ Bindings: Env }>();
reviewPromote.onError(errorHandler({ logClientErrors: true, source: 'review-app-promote' }));
reviewPromote.post('/api/promote', requireReviewAppAuth(), createPromoteKickoffHandler());
// Same sub-router deliberately: it inherits `requireReviewAppAuth()` and the
// `source: 'review-app-promote'` onError, so a rejected connector page is diagnosable
// from the logs plane exactly like a rejected product push. Polled on the SAME job
// route below — there is one job protocol, not two.
reviewPromote.post(
  '/api/promote/connector-catalog',
  requireReviewAppAuth(),
  createConnectorCatalogKickoffHandler(),
);
reviewPromote.get('/api/promote/jobs/:id', requireReviewAppAuth(), createPromoteJobHandler());
app.route('/', reviewPromote);

// AECI-193 auth-spike sub-router. Own router because `requireUserAuth()`
// extends `Variables` (`c.get('user')`), which the `phase28` type doesn't
// carry. The route itself is THROWAWAY(AECI-193) — remove with the real 5.5
// authz middleware — but `requireUserAuth()` (lib/user-auth.ts) is permanent.
// Reached only over the service binding like every other route: no wrangler
// ingress change, so "no new public API surface" holds.
const authSpike = new Hono<{ Bindings: Env; Variables: UserAuthVariables }>();
authSpike.onError(errorHandler());
authSpike.get('/api/auth/whoami', requireUserAuth(), createAuthWhoamiHandler());
app.route('/', authSpike);

// Phase 5.4 user-auth sub-router (AECI-195) — PERMANENT, unlike the spike
// above. Same Variables-extended shape because `requireUserAuth()` sets
// `c.get('user')`. `/api/auth/profile/ensure` is the defensive profile-ensure
// the SSR `/auth/callback` handler calls after the PKCE code exchange.
const authUser = new Hono<{ Bindings: Env; Variables: UserAuthVariables }>();
authUser.onError(errorHandler());
authUser.post('/api/auth/profile/ensure', requireUserAuth(), createEnsureProfileHandler());
app.route('/', authUser);

// Phase 5.6 review-submit sub-router (AECI-197) — the first authenticated user
// *write*. Own router because `requireAuth()` sets `c.get('auth')`
// (`AuthzVariables`), a different shape from the `authUser`/`authSpike` routers
// above (`requireUserAuth()` → `c.get('user')`). `bannedCode: REVIEW_BANNED`
// makes the banned rejection a 403 `REVIEW_BANNED` per API_CONTRACTS.md §6.6.
// Reached only over the service binding like every other route.
const authReviews = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
authReviews.onError(errorHandler());
authReviews.post(
  '/api/reviews',
  requireAuth({ bannedCode: ApiErrorCode.REVIEW_BANNED }),
  createSubmitReviewHandler(),
);
app.route('/', authReviews);

// Phase 5.11 account sub-router (AECI-202) — the signed-in user's own account
// surface (read identity, edit display name, GDPR delete). Same `AuthzVariables`
// shape as `authReviews`, so its own router + `onError`. Plain `requireAuth()`
// (no `bannedCode`): there is no review-specific banned semantics here, so the
// default `FORBIDDEN` applies. NOTE: `requireAuth()` 403s a banned user before
// the handler, so erasure-for-banned-users is NOT reachable here — accepted for
// AECI-202 (the AC scopes errors to UNAUTHENTICATED); revisit if right-to-
// erasure must bypass a ban (would need an `allowBanned` middleware seam).
const authAccount = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
authAccount.onError(errorHandler());
authAccount.get('/api/account', requireAuth(), createGetAccountHandler());
authAccount.get('/api/account/reviews', requireAuth(), createGetAccountReviewsHandler());
authAccount.patch('/api/account', requireAuth(), createUpdateAccountHandler());
authAccount.delete('/api/account', requireAuth(), createDeleteAccountHandler());
app.route('/', authAccount);

// Phase 5.12 + 5.13 admin sub-router (AECI-203 + AECI-204). Every route is
// `requireAdmin()`-gated: it sets `c.get('auth')` (`AuthzVariables`, same shape
// as `authReviews`) AND enforces `role === 'admin'` before the handler, so
// neither the badge read nor the moderation write can run without an admin
// identity (no `bannedCode` — a banned admin gets the default `403 FORBIDDEN`).
// Registered before the `/api/*` 404 catch-all so they can match; reached only
// over the service binding, no ingress.
//   - GET   /api/admin/summary      (5.12) — admin shell badge feed (pending
//     review count); also the SSR `/admin` gate signal (200 = admin, 401/403 →
//     the resolver renders a 404).
//   - GET   /api/admin/reviews      (5.13) — paginated moderation queue.
//   - PATCH /api/admin/reviews/:id  (5.13) — approve/reject a review.
//   - GET   /api/admin/requests     (6.9)  — paginated vendor-requests queue.
//   - PATCH /api/admin/requests/:id (6.9)  — resolve/reject a vendor request.
//   - GET   /api/admin/claims       (S2 §5, AECI-521) — the claim-review queue:
//     pending vendor CLAIMS enriched with the §5 reviewer-assist signals (existing
//     seats, prior requests) on top of the shared `domain_match` / `has_auth_account`.
//     Read-only; the reviewer decides (no auto-grant).
//   - PATCH /api/admin/claims/:id   (S2 §3, AECI-519) — approve (grant a verified
//     vendor account) / reject a vendor CLAIM. Sibling of the requests PATCH: a
//     claim grants a `vendor_admin` seat + flips `vendors.verified` in one batch,
//     rather than a plain resolve. The `/admin/claims` LIST is AECI-521.
//   - GET   /api/admin/reviewers    (6.11) — paginated currently-banned reviewers.
//     SUPERSEDED AS A SCREEN by `GET /api/admin/users?banned=true` (AECI-692),
//     which is the same `banned_at IS NOT NULL` predicate with filters, search
//     and paging. Kept as an endpoint; `/admin/reviewers` now redirects.
//   - PATCH /api/admin/reviewers/:id(6.11) — ban/unban a reviewer. Unchanged by
//     AECI-692 and still the SOLE writer of `profiles.banned_at` anywhere —
//     `/admin/users/:id` is now the surface that calls it, but it added no
//     second writer (`banned-at-writers.spec.ts` asserts this at the source).
//   - PATCH /api/admin/vendors/:id/entitlement (S2 §5, AECI-532) — set / renew /
//     clear a vendor's paid entitlement. The ONLY writer that can take
//     `vendors.verified` back down, and it does so through the entitlement row:
//     `verified` is never in the payload, it follows in the same `db.batch` via
//     `lib/vendor-entitlement.ts` (the mirror's sole writer, §2.1). Audit-only —
//     no `workflow_instances` row, because that CHECK is closed (§1.2). Clearing
//     is NOT a seat revoke and NOT a ban (§5.2): seats, logins and the dashboard
//     survive, read-only.
//   - PATCH /api/admin/connector-catalogs/:id (AECI-720) — the per-iPaaS management
//     cutoff. Flips `connector_catalogs.managed_by`; `vendor` freezes the review
//     lane for that catalogue and the promote arm then refuses its pages with
//     `CATALOG_VENDOR_MANAGED`. Audit-only (no workflow row, closed CHECK) and no
//     purge — nothing reads that table yet. Reversible: "one-way forever" governs
//     the data direction, not the flag. Grants no seat (§8.9(2)/(3)).
//   - GET    /api/admin/vendors                   (S2 §5.6, AECI-652) — paginated
//     vendor list + name/slug search. The way in for a vendor that never filed a
//     claim; before this the entitlement control could only be reached through a
//     `/admin/claims` card, which made concierge onboarding unreachable.
//   - GET    /api/admin/vendors/:id               (S2 §5.6, AECI-652) — basics,
//     entitlement, the seat roster + pending invites, and product / integration /
//     claim counts. Two D1 round trips: a 404 gate, then ONE `db.batch` of six
//     reads (a batch for the round trip, not for atomicity — and deliberately not
//     a `UNION`, which D1 caps at 5 compound terms).
//   - GET    /api/admin/vendors/:id/audit         (S2 §5.6, AECI-652) — the FIRST
//     read surface `audit_log` has ever had, and the first reader of
//     `audit_log_entity_idx`. `?scope=all|entity|actor`. Entity scope is four
//     OR'd disjuncts because `entity_id = <vendor>` misses more than it catches:
//     a rejected claim's metadata carries no `vendor_id`, a revoked seat's row
//     files under the seat's `profiles.id` — which no longer points at the vendor
//     by the time anyone reads it — and a seat ban/unban files under the seat's
//     `profiles.id` with no `vendor_id` either. See `auditScopeWhere`.
//   - DELETE /api/admin/vendors/:id/seats/:userId (S2 §5.6, AECI-652) — revoke one
//     seat, AECi-side. Composes `revokeSeatStatements` unchanged, so the
//     `vendor_claim.seat_revoked` row rides the same `db.batch` and NO statement
//     names `vendors`: revoking a seat is orthogonal to the entitlement and never
//     moves the mirror (§5.2). Ban/unban stays on `/api/admin/reviewers/:id`.
//   - GET    /api/admin/users                     (AP §5.8, AECI-692) — paginated
//     PROFILES-first user list; filters `role` / `banned` / `has_seat`, search by
//     display name and (only when the term contains `@`) by exact email.
//     Profiles-first because ONE Supabase project backs every environment
//     (ADR 0017), so GoTrue's own user list rendered on prod would include
//     staging and preview signups. `perPage` caps at 50, not the shared 100:
//     each row costs one GoTrue GET in waves of WORKER_CONNECTION_LIMIT.
//   - GET    /api/admin/users/:id                 (AP §5.8, AECI-692) — profile,
//     auth account, the ONE vendor seat, live pending invites, and counts
//     (reviews by status, invites sent, entitlements granted, best-effort
//     request matches). Three round trips in a forced order: D1, then the seam
//     to learn the address, then the two reads keyed BY that address — invites
//     and requests are addressed to an email, not a user id, so without the seam
//     they are genuinely unknowable and report `null`, never `[]` or `0`.
//     No page-view stats, ever: AECI-585 dropped the join column and
//     `ADMIN_PANEL_SPEC.md` §9 item 7 forbids visitor↔account correlation.
//
// Phase 8.3 (AECI-574 P1.1, AECI-577 P1.3) adds the admin panel's READ endpoints
// to the same router — no new gate, `requireAdmin()` stays the single enforcement
// point (`ADMIN_PANEL_SPEC.md` §6/§9.1). All are `GET`, write nothing (no
// `audit_log` row — reads emit none), and are non-cacheable by construction
// (`json()` sets `private, no-store`; `/admin/*` is absent from
// `ROUTE_CACHE_PATTERNS` in the SSR Worker, §9.2):
//   - GET /api/admin/overview           — the §5.1 bundle; `?day=` picks a UTC
//     day (default: the digest's prior complete day), `?recompute=1` additionally
//     runs the ten data-quality checks + the Algolia drift count (§13 D8 — still
//     a pure read: writes nothing, sends nothing).
//   - GET /api/admin/metrics/timeseries — one metric, day-bucketed, live
//     aggregation (P2.1 swaps in `metrics_daily` behind the same contract).
//   - GET /api/admin/traffic/breakdown  — grouped counts by
//     source|country|path|product|bot.
//   - GET /api/admin/page-views         — the §5.2 Activity feed: individual
//     visits, newest first, paginated + filtered, `entity`-hydrated. Every
//     `page_views` read here inherits §13 D12's `/admin/*` + `/account` exclusion
//     as a floor beneath the caller's filters.
// Phase 8.3 P1.5 (AECI-579) adds the catalog readout on the same terms:
//   - GET /api/admin/catalog/coverage   — the §5.5 gap lists, promotion funnel,
//     taxonomy usage, and claim/attestation coverage. Exact counts + capped
//     samples; `?sample=0` returns counts only. The catalog TIME SERIES stays on
//     `/api/admin/metrics/timeseries` (`catalog.*`), not here.
// Phase 8.3 P1.6 (AECI-580) adds the System bundle on the same terms:
//   - GET /api/admin/system             — the §5.6 bundle: API-Worker version,
//     one liveness row per cron, read from `job_runs` since AECI-583 (§7.2);
//     rows still read `unknown` when a job has no recorded run yet, which is
//     NOT the same as "not running" — Datadog no-data monitors own absence.
//     Plus the Algolia watermark, D1 size + per-table row counts,
//     and — behind the same `?recompute=1` flag, sharing `/overview`'s
//     implementation — the ten data-quality checks and the drift count.
// Phase 8.3 P5.1 (AECI-586) adds the Audience pair on the same terms:
//   - GET /api/admin/audience           — the §5.4 bundle: lifetime subscriber
//     stocks, the day-bucketed growth/churn series, UTM + signup geography, and
//     the feedback counts. Derived LIVE from `mailing_list`, not from
//     `metrics_daily`: `unsubscribed_at` is a soft delete and no row is ever
//     removed, so the population on a past day is exactly recoverable — the
//     property §4 shows the catalog stocks lack.
//   - GET /api/admin/feedback           — the feedback inbox, paginated. The FIRST
//     read surface that table has ever had; until now an operator email was the
//     only way anyone saw a submission.
const authAdmin = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
authAdmin.onError(errorHandler());
authAdmin.get('/api/admin/summary', requireAdmin(), createAdminSummaryHandler());
authAdmin.get('/api/admin/reviews', requireAdmin(), createAdminReviewsListHandler());
authAdmin.patch('/api/admin/reviews/:id', requireAdmin(), createModerateReviewHandler());
authAdmin.get('/api/admin/requests', requireAdmin(), createAdminRequestsListHandler());
// Phase 6.6 / AECI-213: wire the real site → Linear sync (issue transition +
// comment + site-originated `workflow_transition`) into the resolve/reject seam.
// `pushRequestResolutionToLinear` is a silent no-op without `LINEAR_API_KEY`.
authAdmin.patch(
  '/api/admin/requests/:id',
  requireAdmin(),
  createModerateRequestHandler(getDb, pushRequestResolutionToLinear),
);
// Stage 2 / AECI-521: the claim-review LIST (reviewer-assist signals). Read-only,
// clones the requests LIST; the reviewer decides on the assembled evidence.
authAdmin.get('/api/admin/claims', requireAdmin(), createAdminClaimsListHandler());
// Stage 2 / AECI-519: the claim → verified-account grant. `resolveClaimantIdentity`
// reports `unavailable` (→503) wherever `SUPABASE_SERVICE_ROLE_KEY` is absent — local
// dev and PR previews, since AECI-530 CI-pushes it on staging/demo/production.
// AECI-528 injects the real claim-decision email sender (`sendClaimDecisionEmail`,
// `lib/email.ts`) into the post-commit seam; it fail-opens to `'skipped'` without
// `RESEND_API_KEY`/`EMAIL_FROM`.
authAdmin.patch(
  '/api/admin/claims/:id',
  requireAdmin(),
  createModerateClaimHandler(getDb, resolveClaimantIdentity, sendClaimDecisionEmail),
);
authAdmin.get('/api/admin/reviewers', requireAdmin(), createBannedReviewersListHandler());
authAdmin.patch('/api/admin/reviewers/:id', requireAdmin(), createBanReviewerHandler());
// Stage 2 / AECI-532: the admin entitlement action (set / renew / clear). Owns the
// un-verify half that AECI-520 left unowned, and clears the bit through the
// entitlement row — never by writing the mirror (§5.1 / §2.1).
authAdmin.patch(
  '/api/admin/vendors/:id/entitlement',
  requireAdmin(),
  createSetVendorEntitlementHandler(),
);
// Stage 2 / AECI-652: the admin vendor surface (§5.6). Three reads plus one seat
// revoke. Registered AFTER the entitlement PATCH so the literal `/entitlement`
// and `/seats/:userId` segments are unambiguous against the bare `/:id`; Hono's
// trie separates them by segment count anyway, but the order documents intent.
// The GETs write nothing — reads emit no `audit_log` row (§9.3). The DELETE does
// write, and reuses `revokeSeatStatements`, so its audit row rides the same
// `db.batch` and NO statement names `vendors` — a seat revoke is orthogonal to
// the entitlement and never moves the mirror (§5.2).
authAdmin.get('/api/admin/vendors', requireAdmin(), createAdminVendorsListHandler());
authAdmin.get('/api/admin/vendors/:id', requireAdmin(), createAdminVendorDetailHandler());
authAdmin.get('/api/admin/vendors/:id/audit', requireAdmin(), createAdminVendorAuditHandler());
authAdmin.delete(
  '/api/admin/vendors/:id/seats/:userId',
  requireAdmin(),
  createAdminRevokeSeatHandler(),
);
// AECI-692: the admin user surface (§5.8). Two READS and nothing else — ban and
// reinstate reuse `PATCH /api/admin/reviewers/:id` above completely unchanged, so
// there is still exactly one writer of `profiles.banned_at` in the codebase, and
// seat revoke stays on the vendor roster where the blast radius is visible.
// Literal segment before the bare `/:id`, matching the vendors block.
authAdmin.get('/api/admin/users', requireAdmin(), createAdminUsersListHandler());
authAdmin.get('/api/admin/users/:id', requireAdmin(), createAdminUserDetailHandler());
// AECI-720: the per-iPaaS management cutoff. Flips `connector_catalogs.managed_by`,
// which freezes the review lane for that catalogue — `POST /api/promote/connector-catalog`
// then refuses every page for it with `CATALOG_VENDOR_MANAGED`. Audit-only, no
// `workflow_instances` row (that CHECK is closed, §1.2) and NO cache purge: nothing reads
// `connector_catalogs` CACHEABLY - AECI-722 reads it, but only on the uncacheable /admin
// surface, so there is still no tag to purge. The flag is reversible; what is
// one-way is the DATA direction, which the promote refusal delivers. Grants no seat — see
// `STAGE_2_SPEC.md` §8.9(2)/(3); the screen that calls this is AECI-722's.
authAdmin.patch(
  '/api/admin/connector-catalogs/:id',
  requireAdmin(),
  createSetConnectorCatalogManagementHandler(),
);
// AECI-722: the connector admin surface (§5.9) - the FIRST read layer over the six
// AECI-714 tables. Five GETs, registered AFTER the PATCH above so the literal
// `/stubs`, `/pairs` and `/audit` segments are unambiguous against the bare `/:id`;
// Hono's trie separates them by segment count anyway, but the order documents intent
// and matches the vendors and users blocks.
//
// Every one of them WRITES NOTHING - no `audit_log` row (§6's convention, ADR 0022's
// scoping), no purge and no `Cache-Tag`. Mapping decisions are deliberately NOT
// writable here: the sync upserts `connector_stub_mappings` wholesale, so an
// AECi-authored decision is exactly the row it would clobber. That returns at
// AECI-724 time gated on `managed_by = 'vendor'` - the argument is in
// `packages/shared/src/api/admin-connectors.ts`.
authAdmin.get(
  '/api/admin/connector-catalogs',
  requireAdmin(),
  createAdminConnectorCatalogsListHandler(),
);
authAdmin.get(
  '/api/admin/connector-catalogs/:id',
  requireAdmin(),
  createAdminConnectorCatalogDetailHandler(),
);
authAdmin.get(
  '/api/admin/connector-catalogs/:id/stubs',
  requireAdmin(),
  createAdminConnectorStubsHandler(),
);
authAdmin.get(
  '/api/admin/connector-catalogs/:id/pairs',
  requireAdmin(),
  createAdminConnectorPairsHandler(),
);
authAdmin.get(
  '/api/admin/connector-catalogs/:id/audit',
  requireAdmin(),
  createAdminConnectorAuditHandler(),
);
// Admin panel reads (AECI-574, AECI-577, AECI-579, AECI-580, AECI-586).
// Registered after the moderation routes; no path collides with
// `/api/admin/re*` or `/api/admin/summary`.
authAdmin.get('/api/admin/overview', requireAdmin(), createAdminOverviewHandler());
authAdmin.get('/api/admin/metrics/timeseries', requireAdmin(), createAdminTimeseriesHandler());
authAdmin.get('/api/admin/traffic/breakdown', requireAdmin(), createAdminTrafficBreakdownHandler());
authAdmin.get('/api/admin/page-views', requireAdmin(), createAdminPageViewsHandler());
authAdmin.get('/api/admin/catalog/coverage', requireAdmin(), createAdminCatalogCoverageHandler());
authAdmin.get('/api/admin/system', requireAdmin(), createAdminSystemHandler());
authAdmin.get('/api/admin/audience', requireAdmin(), createAdminAudienceHandler());
authAdmin.get('/api/admin/feedback', requireAdmin(), createAdminFeedbackHandler());
app.route('/', authAdmin);

// Stage 2 vendor-portal sub-router (AECI-520, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4).
// Same shape as `authAdmin` but gated by `requireVendor()`: valid JWT, not banned,
// `role === 'vendor_admin'`, non-null `vendor_id`. A site `admin` is rejected here
// on purpose — there is no impersonation at launch, admins act via `/api/admin/*`.
//
// The guard only establishes WHICH vendor is calling; there is no RLS behind it,
// so every handler additionally scopes its queries by `c.get('auth').vendorId` and
// proves ownership of any client-supplied id before writing.
//   - GET   /api/vendor/me           — dashboard payload (vendor + products +
//     request status + seat count).
//   - GET   /api/vendor/seats        — the vendor's seat roster (read-only).
//   - PATCH /api/vendor/profile      — edit the caller's own vendor row.
//   - PATCH /api/vendor/products/:id — edit an owned product (cross-vendor → 404).
//
// Stage 2 / AECI-607 adds the product-version CRUD on the same sub-router. Two
// gates, in this order: ownership → 404 (as above), then `vendors.verified` → 403
// on the WRITES only — authoring is a Verified-vendor capability
// (`STAGE_2_ATTESTATIONS_SPEC.md` §1), while the list stays readable so the
// dashboard can render a read-only tab instead of 403-ing a vendor out of its
// own data.
//   - GET    /api/vendor/products/:id/versions            — ordered by sort_key.
//   - POST   /api/vendor/products/:id/versions            — create (201).
//   - PATCH  /api/vendor/products/:id/versions/:versionId — edit.
//   - DELETE /api/vendor/products/:id/versions/:versionId — remove (204).
//
// Stage 2 / AECI-302 adds the in-portal notification list. It reads the same
// `audit_log` `notification.sent` rows the §7 detector sweep writes — no separate
// store (`STAGE_2_ATTESTATIONS_SPEC.md` §7.3) — scoped to the caller's vendor, and
// not verified-gated (reading is not the capability).
//   - GET   /api/vendor/notifications — the last 90 days of detector nudges.
//
// Stage 2 / AECI-301 adds the attestation authoring surface — the first code that
// can write a `vendor_a`/`vendor_b` attestation, and therefore the first that can
// move a claim off `unverified` (`STAGE_2_ATTESTATIONS_SPEC.md` §5). Same two
// gates and the same order, but at INTEGRATION grain: which slot the caller may
// fill comes from `lib/attestation-authority.ts` (product ownership, never the
// request), a miss is a 404, and only then is `vendors.verified` checked. `GET`
// is not Verified-gated, for the same reason the version list is not.
//   - GET    /api/vendor/integrations                — the attestable surface.
//   - POST   /api/vendor/claims                      — create a claim (201).
//   - PUT    /api/vendor/claims/:claimId/attestation — assert or deny.
//   - DELETE /api/vendor/claims/:claimId/attestation — retract (204).
//
// Stage 2 / AECI-606 adds the vocabulary the §6 picker offers, so a vendor never
// has to guess a find-only `data_object` term. It is the ONE route on this
// sub-router with neither an ownership check nor a `vendor_id` filter — the
// vocabulary is AECi-curated and holds no vendor-owned rows, so the filter would
// be vacuous rather than omitted (`docs/AUTH_AND_RLS.md` §4.4). Not
// verified-gated either, for the same reason the two lists above are not.
//   - GET   /api/vendor/data-objects — the closed `data_object` vocabulary.
//
// Stage 2 / AECI-627 adds the surface's polling endpoint — six per-scope
// `updated_at` cursors in one response, so the dashboard can refetch only the
// section that moved instead of reloading (ADR 0023 chose this over Durable-Object
// WebSockets / SSE; `STAGE_2_REALTIME_SPEC.md` §2). It is a pure read, so it writes
// no `audit_log` row, and it is NOT verified-gated. The rule that makes it correct:
// each cursor reuses the scoping predicate of the endpoint it is a cursor for —
// see the route module's header for what breaks when one drifts.
//   - GET   /api/vendor/updates — per-scope freshness cursors + `server_time`.
const authVendor = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
authVendor.onError(errorHandler());
authVendor.get('/api/vendor/me', requireVendor(), createVendorMeHandler());
authVendor.get('/api/vendor/seats', requireVendor(), createVendorSeatsHandler());
authVendor.get(
  '/api/vendor/notifications',
  requireVendor(),
  createListVendorNotificationsHandler(),
);
authVendor.patch('/api/vendor/profile', requireVendor(), createUpdateVendorProfileHandler());
// Registered BEFORE `/api/vendor/products/:id` so the more specific version
// paths are not shadowed by the product PATCH's parameterised route.
authVendor.get(
  '/api/vendor/products/:id/versions',
  requireVendor(),
  createListProductVersionsHandler(),
);
authVendor.post(
  '/api/vendor/products/:id/versions',
  requireVendor(),
  createProductVersionHandler(),
);
authVendor.patch(
  '/api/vendor/products/:id/versions/:versionId',
  requireVendor(),
  createUpdateProductVersionHandler(),
);
authVendor.delete(
  '/api/vendor/products/:id/versions/:versionId',
  requireVendor(),
  createDeleteProductVersionHandler(),
);
authVendor.patch('/api/vendor/products/:id', requireVendor(), createUpdateVendorProductHandler());
// AECI-301. No path overlap with the product routes above, so ordering is free.
authVendor.get('/api/vendor/integrations', requireVendor(), createListVendorIntegrationsHandler());
authVendor.post('/api/vendor/claims', requireVendor(), createVendorClaimHandler());
authVendor.put(
  '/api/vendor/claims/:claimId/attestation',
  requireVendor(),
  createUpsertVendorAttestationHandler(),
);
authVendor.delete(
  '/api/vendor/claims/:claimId/attestation',
  requireVendor(),
  createRetractVendorAttestationHandler(),
);
// AECI-606. Guard only — no authority resolution and no verified gate; see the
// route module's header for why that is the contract rather than an omission.
authVendor.get('/api/vendor/data-objects', requireVendor(), createListDataObjectsHandler());
// AECI-627. No path overlap with anything above, so ordering is free.
authVendor.get('/api/vendor/updates', requireVendor(), createVendorUpdatesHandler());
//
// Stage 2 / AECI-664 adds the OWNER half of seat management — the first writes on
// this surface that change who can reach it. Three gates in order: `requireVendor()`
// (which vendor), `requireSeatOwner()` inside each handler (`profiles.seat_owner`,
// re-read from D1 every request so a demotion lands on the next call), then the
// `vendor_id` filter that is the actual authorization. Deliberately NOT
// capability-gated: seats are not a paid feature, and gating removal on a live
// entitlement would stop a lapsed vendor revoking a departed employee's access
// (§11a). `DELETE /seats/:userId` is the first HTTP surface `revokeSeatStatements`
// has ever had — AECI-524 shipped the builder unwired.
//   - POST   /api/vendor/seats/invites     — invite a colleague (201).
//   - DELETE /api/vendor/seats/invites/:id — revoke a pending invite (204).
//   - DELETE /api/vendor/seats/:userId     — remove a seat (204).
//
// The invites routes are registered BEFORE `/seats/:userId` so the literal
// `invites` segment can never be parsed as a user id.
authVendor.post(
  '/api/vendor/seats/invites',
  requireVendor(),
  createSeatInviteHandler(getDb, sendSeatInvite),
);
authVendor.delete(
  '/api/vendor/seats/invites/:id',
  requireVendor(),
  createRevokeSeatInviteHandler(),
);
authVendor.delete('/api/vendor/seats/:userId', requireVendor(), createRemoveSeatHandler());
app.route('/', authVendor);

// Stage 2 / AECI-664 — the INVITEE half, on its own prefix and its own router.
// `requireAuth()`, NOT `requireVendor()`: the caller is signed in but is not a
// vendor admin yet, which is the entire point. It is not under `/api/vendor/*`
// precisely so that a future prefix-level vendor guard cannot silently lock the
// one endpoint that has to be reachable by a non-vendor.
//
// The token in the URL identifies an invite; it never authorizes one. Redeeming
// requires the session's VERIFIED email to equal the invited address, so a
// forwarded or prefetched link grants nothing. GET describes, POST mutates — mail
// scanners fetch what they are sent, and a GET that redeemed would be spent by the
// invitee's own security appliance before they clicked (the `/unsubscribe`
// confirm-then-POST discipline, AECI-537).
//   - GET  /api/seat-invites/:token        — preview + redeemability verdict.
//   - POST /api/seat-invites/:token/accept — attach the seat.
const authSeatInvites = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
authSeatInvites.onError(errorHandler());
authSeatInvites.get('/api/seat-invites/:token', requireAuth(), createSeatInvitePreviewHandler());
authSeatInvites.post(
  '/api/seat-invites/:token/accept',
  requireAuth(),
  createAcceptSeatInviteHandler(),
);
app.route('/', authSeatInvites);

// Catch-alls throw so the root `onError` renders the canonical §3.3 envelope
// (AECI-101) — an unmatched `/api/*` route parses with `ApiErrorSchema` too.
app.all('/api/*', () => {
  throw new ApiError(404, 'NOT_FOUND', 'API route not found');
});
app.all('*', () => {
  throw new ApiError(404, 'NOT_FOUND', 'Route not found');
});

// The API Worker gains `scheduled` + `queue` handlers (daily Algolia jobs)
// alongside its Hono `fetch`. The explicit arrow wrapper (not a bare `app.fetch`
// reference) keeps Hono's request handling intact. Cron triggers + queue
// producer/consumer bindings are registered per-env in `wrangler.jsonc` (staging
// + production only). The cron `scheduled` handler enqueues a job; the `queue`
// consumer runs it (ADR 0013) — see `src/scheduled.ts`. Crons: AECI-178 07:00 UTC
// home-stats compute; AECI-139 08:00 UTC Algolia sync; AECI-140 09:00 UTC drift
// check.
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled,
  queue,
};

// The promote ingest Workflow (AECI-563 / ADR 0021). Wrangler resolves a Workflow's
// `class_name` off the Worker's MAIN module, so the class must be re-exported here —
// the `workflows` binding block in `wrangler.jsonc` alone is not enough.
export { PromoteWorkflow } from './workflows/promote-workflow';

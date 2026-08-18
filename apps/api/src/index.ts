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
import { sendClaimDecisionEmail } from './lib/email';
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
import { createPromoteKickoffHandler } from './routes/promote-kickoff';
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
//   - GET  /api/promote/jobs/:id — status + the committed ID map.
//
// The commit no longer happens on the request: a client that walks away can no
// longer strand a committed promote's IDs (AECI-561). A failure inside the Workflow
// therefore never reaches this `onError` — the Workflow logs it itself, so §6.1's
// "every rejection is in Datadog" still holds for `SLUG_CONFLICT` / `INTERNAL_ERROR`.
const reviewPromote = new Hono<{ Bindings: Env }>();
reviewPromote.onError(errorHandler({ logClientErrors: true, source: 'review-app-promote' }));
reviewPromote.post('/api/promote', requireReviewAppAuth(), createPromoteKickoffHandler());
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
//   - PATCH /api/admin/reviewers/:id(6.11) — ban/unban a reviewer.
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
const authVendor = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
authVendor.onError(errorHandler());
authVendor.get('/api/vendor/me', requireVendor(), createVendorMeHandler());
authVendor.get('/api/vendor/seats', requireVendor(), createVendorSeatsHandler());
authVendor.patch('/api/vendor/profile', requireVendor(), createUpdateVendorProfileHandler());
authVendor.patch('/api/vendor/products/:id', requireVendor(), createUpdateVendorProductHandler());
app.route('/', authVendor);

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

import {
  ApiErrorCode,
  CategoryDetailSchema,
  AudienceDetailSchema,
  PhaseDetailSchema,
} from '@aeci/shared';
import { Hono } from 'hono';

import type { Env } from './env';
import { ApiError, errorHandler } from './errors';
import { requireAdmin, requireAuth, type AuthzVariables } from './lib/authz';
import { requireReviewAppAuth } from './lib/review-auth';
import { requireUserAuth } from './lib/user-auth';
import type { UserAuthVariables } from './lib/user-auth';
import {
  createDeleteAccountHandler,
  createGetAccountHandler,
  createUpdateAccountHandler,
} from './routes/account';
import { createGetAccountReviewsHandler } from './routes/account-reviews';
import {
  createAdminRequestsListHandler,
  createModerateRequestHandler,
} from './routes/admin-requests';
import {
  createBanReviewerHandler,
  createBannedReviewersListHandler,
} from './routes/admin-reviewers';
import { createAdminSummaryHandler } from './routes/admin-summary';
import { createEnsureProfileHandler } from './routes/auth-profile';
import { createAuthWhoamiHandler } from './routes/auth-whoami';
import { metricsMiddleware } from './metrics-middleware';
import { createHealthHandler } from './routes/health';
import {
  createIntegrationDetailHandler,
  createIntegrationsListHandler,
} from './routes/integrations';
import { createPageViewsHandler } from './routes/page-views';
import { createProductFacetsHandler } from './routes/product-facets';
import { createAdminReviewsListHandler, createModerateReviewHandler } from './routes/admin-reviews';
import { createProductReviewsListHandler } from './routes/product-reviews';
import { createProductDetailHandler, createProductsListHandler } from './routes/products';
import { createPromoteHandler } from './routes/promote';
import { createClaimSubmitHandler, createCorrectionSubmitHandler } from './routes/requests';
import { createSubmitReviewHandler } from './routes/reviews';
import { createStatsHomeHandler } from './routes/stats';
import { createLinearWebhookHandler } from './routes/webhooks';
import { createTaxonomyHandler } from './routes/taxonomy';
import { createTaxonomyDetailHandler } from './routes/taxonomy-detail';
import { createTaxonomyListHandler } from './routes/taxonomy-list';
import { createVendorDetailHandler, createVendorsListHandler } from './routes/vendors';
import { createVersionHandler } from './routes/version';
import { queue, scheduled } from './scheduled';

const app = new Hono<{ Bindings: Env }>();

// AECI-66 / Phase 2 §14 — time every request and emit
// `aeci.api.query.duration_ms` tagged by endpoint + status. Registered first so
// it wraps the legacy routes, the Phase 2.8 sub-router, and the `*` fallthrough.
app.use('*', metricsMiddleware());

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

phase28.get('/api/vendors', createVendorsListHandler());
phase28.get('/api/vendors/:slug', createVendorDetailHandler());

phase28.get('/api/integrations', createIntegrationsListHandler());
phase28.get('/api/integrations/:id', createIntegrationDetailHandler());

phase28.get('/api/categories', createTaxonomyListHandler('categories'));
phase28.get(
  '/api/categories/:slug',
  createTaxonomyDetailHandler({
    delegate: (p) => p.taxonomyCategory,
    relationKey: 'productCategories',
    resource: 'category',
    schema: CategoryDetailSchema,
  }),
);
phase28.get('/api/audiences', createTaxonomyListHandler('audiences'));
phase28.get(
  '/api/audiences/:slug',
  createTaxonomyDetailHandler({
    delegate: (p) => p.taxonomyAudience,
    relationKey: 'productAudiences',
    resource: 'audience',
    schema: AudienceDetailSchema,
  }),
);
phase28.get('/api/phases', createTaxonomyListHandler('phases'));
phase28.get(
  '/api/phases/:slug',
  createTaxonomyDetailHandler({
    delegate: (p) => p.taxonomyPhase,
    relationKey: 'productPhases',
    resource: 'phase',
    schema: PhaseDetailSchema,
  }),
);

phase28.get('/api/taxonomy', createTaxonomyHandler());

// Phase 4.4 (AECI-179) — home stats, read straight from the `stats_cache`
// `home.*` keys (filled daily by 4.3). Never live-aggregates; a sparse cache
// returns empty-but-valid defaults, never a 500.
phase28.get('/api/stats/home', createStatsHomeHandler());

// Vendor requests (AECI-128) — claim & correction form submissions. Public (no
// auth until Phase 5); insert into `vendor_requests` with an audit row. The
// Phase 6 moderation pipeline (n8n/Linear/admin, including duplicate detection)
// is out of scope — see `routes/requests.ts`.
phase28.post('/api/requests/correction', createCorrectionSubmitHandler());
phase28.post('/api/requests/claim', createClaimSubmitHandler());

// Inbound Linear webhook (AECI-212 / Phase 6.5) — the Linear → Site half of the
// moderation sync. Public URL; auth is the `Linear-Signature` HMAC verified
// inside the handler against `LINEAR_WEBHOOK_SIGNING_SECRET` (no user session).
// On an Issue state change it updates the matching `vendor_requests.status` and
// records a `workflow_transitions` + `audit_log` row. Reached only over the
// service binding like every other route. See `routes/webhooks.ts`.
phase28.post('/api/webhooks/linear', createLinearWebhookHandler());

// Review-app push endpoint (promotion). Bearer-auth middleware runs first so an
// unauthenticated request never reaches the DB; both it and the handler throw
// `ApiError`/`ZodError`, which `errorHandler()` renders as the canonical
// envelope. See `docs/REVIEW_APP_PROMOTE_API.md`.
phase28.post('/api/promote', requireReviewAppAuth(), createPromoteHandler());

app.route('/', phase28);

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
//   - GET   /api/admin/reviewers    (6.11) — paginated currently-banned reviewers.
//   - PATCH /api/admin/reviewers/:id(6.11) — ban/unban a reviewer.
const authAdmin = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
authAdmin.onError(errorHandler());
authAdmin.get('/api/admin/summary', requireAdmin(), createAdminSummaryHandler());
authAdmin.get('/api/admin/reviews', requireAdmin(), createAdminReviewsListHandler());
authAdmin.patch('/api/admin/reviews/:id', requireAdmin(), createModerateReviewHandler());
authAdmin.get('/api/admin/requests', requireAdmin(), createAdminRequestsListHandler());
authAdmin.patch('/api/admin/requests/:id', requireAdmin(), createModerateRequestHandler());
authAdmin.get('/api/admin/reviewers', requireAdmin(), createBannedReviewersListHandler());
authAdmin.patch('/api/admin/reviewers/:id', requireAdmin(), createBanReviewerHandler());
app.route('/', authAdmin);

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

import {
  createGetLogoHandler,
  createUploadLogoHandler,
  createUpdateAdminLogoHandler,
} from './routes/logos';
import {
  createAdminVendorFieldOverridesHandler,
  createLiftFieldOverrideHandler,
  createSetFieldOverrideHandler,
} from './routes/admin-field-overrides';
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
import { requireThreadsEnabled } from './lib/claim-threads';
import { resolveClaimantIdentity } from './lib/claimant-identity';
import { sendClaimDecisionEmail, sendSeatInvite } from './lib/email';
import { pushRequestResolutionToLinear } from './lib/linear';
import { requireReviewAppAuth } from './lib/review-auth';
import { healMissingProfile } from './lib/profile-provisioning';
import { requireUserAuth } from './lib/user-auth';
import type { UserAuthVariables } from './lib/user-auth';
import {
  createDeleteAccountHandler,
  createGetAccountHandler,
  createUpdateAccountHandler,
} from './routes/account';
import { createGetAccountReviewsHandler } from './routes/account-reviews';
import { createActivityArrivalHandler } from './routes/activity-arrival';
import { createIndexNowRunnerRouter } from './routes/internal-indexnow';
import { createAdminAuditLogHandler } from './routes/admin-audit';
import {
  createAdminClaimAuditHandler,
  createAdminClaimDetailHandler,
  createAdminClaimsListHandler,
  createModerateClaimHandler,
  createSaveClaimNotesHandler,
} from './routes/admin-claims';
import { createSetConnectorCatalogManagementHandler } from './routes/admin-connector-catalogs';
import { createAdminUpdateConnectorStubMappingHandler } from './routes/admin-connector-stub-mappings';
import { createVendorUpdateConnectorStubMappingHandler } from './routes/vendor-connector-stub-mappings';
import {
  createAdminConnectorAuditHandler,
  createAdminConnectorCatalogDetailHandler,
  createAdminConnectorCatalogsListHandler,
  createAdminConnectorPairsHandler,
  createAdminConnectorStubsHandler,
} from './routes/admin-connectors';
import {
  createBanTermLicensesHandler,
  createGrantLicensesHandler,
  createUpdateLicenseHandler,
} from './routes/admin-licenses';
import {
  createAdminRevokeSeatHandler,
  createProvisionSeatHandler,
  createReturnRecordsHandler,
  createAdminVendorAuditHandler,
  createAdminVendorProductsHandler,
  createAdminVendorDetailHandler,
  createAdminVendorsListHandler,
} from './routes/admin-vendors';
import { createAdminVendorAcceptancesHandler } from './routes/admin-vendor-acceptances';
import {
  createAdminUpdateBillingEmailHandler,
  createAdminVendorBillingHandler,
} from './routes/admin-vendors-billing';
import { createAdminUserDetailHandler, createAdminUsersListHandler } from './routes/admin-users';
import {
  createAdminRequestsListHandler,
  createModerateRequestHandler,
} from './routes/admin-requests';
import {
  createAdminListingRequestsListHandler,
  createModerateListingRequestHandler,
} from './routes/admin-listing-requests';
import { createListingRequestHandler } from './routes/listing-requests';
import { createConfirmRequestHandler } from './routes/request-confirmations';
import {
  createAdminProductRequestsListHandler,
  createDecideProductRequestHandler,
} from './routes/admin-product-requests';
import {
  createListVendorProductRequestsHandler,
  createVendorProductRequestHandler,
} from './routes/vendor-product-requests';
import {
  createAdminLicenseReleaseRequestsListHandler,
  createDecideLicenseReleaseRequestHandler,
} from './routes/admin-license-release-requests';
import { createVendorLicenseReleaseRequestHandler } from './routes/vendor-license-release';
import {
  createAssignVendorLicenseHandler,
  createUpdateVendorLicenseHandler,
} from './routes/vendor-licenses';
import {
  createBanReviewerHandler,
  createBannedReviewersListHandler,
} from './routes/admin-reviewers';
import { createAdminAudienceHandler } from './routes/admin-audience';
import { createAdminCatalogCoverageHandler } from './routes/admin-catalog';
import { createAdminFeedbackHandler } from './routes/admin-feedback';
import { createAdminSubscribersHandler } from './routes/admin-subscribers';
import {
  createAdminThreadDetailHandler,
  createAdminThreadsListHandler,
} from './routes/admin-threads';
import {
  createAdminEmailSearchHandler,
  createAdminEmailSendsHandler,
  createAdminEmailSummaryHandler,
} from './routes/admin-email';
import {
  createAdminEmailSwitchesHandler,
  createSetAdminEmailSwitchHandler,
} from './routes/admin-email-switches';
import {
  createAdminReindexListHandler,
  createAdminReindexSubmissionsHandler,
  createClearReindexRowHandler,
} from './routes/admin-reindex';
import { createAdminOverviewHandler } from './routes/admin-overview';
import { createAdminTimeseriesHandler } from './routes/admin-metrics';
import { createAdminPageViewsHandler } from './routes/admin-page-views';
import { createAdminTrafficBreakdownHandler } from './routes/admin-traffic';
import { createAdminSummaryHandler } from './routes/admin-summary';
import { createAdminSystemHandler } from './routes/admin-system';
import { createEnsureProfileHandler } from './routes/auth-profile';
import { createAuthWhoamiHandler } from './routes/auth-whoami';
import { activityMiddleware } from './activity-middleware';
import { bookmarkMiddleware } from './bookmark-middleware';
import { metricsMiddleware } from './metrics-middleware';
import { rateLimit } from './rate-limit-middleware';
import {
  createAddAbuseCostEntryHandler,
  createLiftVendorSuspensionHandler,
  createResendSuspensionNoticeHandler,
  createRetryTerminationRefundsHandler,
  createStartSuspensionStage2Handler,
  createSuspendVendorHandler,
  createTerminateVendorHandler,
  createVendorSuspensionStateHandler,
  createVoidAbuseCostEntryHandler,
} from './routes/admin-vendor-suspension';
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
import { createPageViewsHandler, createTurnstileVerdictHandler } from './routes/page-views';
import { createProductFacetsHandler } from './routes/product-facets';
import { createAdminReviewsListHandler, createModerateReviewHandler } from './routes/admin-reviews';
import { createProductReviewsListHandler } from './routes/product-reviews';
import { createProductDetailHandler, createProductsListHandler } from './routes/products';
import { createPromoteJobHandler } from './routes/promote-jobs';
import {
  createConnectorCatalogKickoffHandler,
  createPromoteKickoffHandler,
} from './routes/promote-kickoff';
import {
  createClaimSubmitHandler,
  createClaimTargetHandler,
  createCorrectionSubmitHandler,
} from './routes/requests';
import {
  createSlugRedirectResolveHandler,
  createSlugRedirectsListHandler,
} from './routes/slug-redirects';
import { createSubmitReviewHandler } from './routes/reviews';
import { createStatsHomeHandler } from './routes/stats';
import {
  createLinearWebhookHandler,
  createResendWebhookHandler,
  createStripeWebhookHandler,
} from './routes/webhooks';
import { createSitemapFragmentHandler } from './routes/sitemap';
import { createTaxonomyHandler } from './routes/taxonomy';
import { createTaxonomyDetailHandler } from './routes/taxonomy-detail';
import { createTaxonomyListHandler } from './routes/taxonomy-list';
import {
  createUpdateVendorProductHandler,
  createUpdateVendorProfileHandler,
  createVendorMeHandler,
  createVendorSeatsHandler,
} from './routes/vendor';
import {
  createReviewVendorProductHandler,
  createReviewVendorProductIntegrationsHandler,
  createReviewVendorProfileHandler,
} from './routes/vendor-review';
import {
  createVendorChecklistHandler,
  createVendorProductChecklistHandler,
} from './routes/vendor-checklist';
import { createListVendorNotificationsHandler } from './routes/vendor-notifications';
import { createListVendorRecrawlSubmissionsHandler } from './routes/vendor-recrawl-submissions';
import {
  createGetNotificationPreferencesHandler,
  createMarketingMuteHandler,
  createNudgeMuteHandler,
  createUpdateNotificationPreferencesHandler,
} from './routes/notification-preferences';
import {
  createDecideContestHandler,
  createListVendorContestsHandler,
  createSubmitContestHandler,
  createWithdrawContestHandler,
} from './routes/vendor-contests';
import {
  createEditReviewResponseHandler,
  createListVendorReviewsHandler,
  createSubmitReviewResponseHandler,
  createWithdrawReviewResponseHandler,
} from './routes/vendor-review-responses';
import { createClaimIntegrationHandler } from './routes/vendor-integration-claims';
import { createUpdateVendorIntegrationHandler } from './routes/vendor-integration-edits';
import {
  createRestoreIntegrationHandler,
  createRetireIntegrationHandler,
} from './routes/vendor-integration-retire';
import { createCreateVendorIntegrationHandler } from './routes/vendor-integration-create';
import {
  createDeleteIntegrationLinkHandler,
  createPutIntegrationLinkHandler,
} from './routes/vendor-integration-links';
import {
  createAdminRestoreIntegrationHandler,
  createAdminRetireIntegrationHandler,
  createAdminVendorIntegrationsHandler,
} from './routes/admin-integration-retire';
import {
  createAdminContestsListHandler,
  createModerateContestHandler,
} from './routes/admin-contests';
import { createDecideContestProtestHandler } from './routes/admin-contest-protests';
import {
  createAdminReviewResponsesListHandler,
  createDecideReviewResponseHandler,
} from './routes/admin-review-responses';
import {
  createFileContestProtestHandler,
  createReplyContestProtestHandler,
  createWithdrawContestProtestHandler,
} from './routes/vendor-contest-protests';
import {
  createDeleteProductVersionHandler,
  createListProductVersionsHandler,
  createProductVersionHandler,
  createUpdateProductVersionHandler,
} from './routes/vendor-product-versions';
import {
  createListVendorIntegrationsHandler,
  createDeleteVendorClaimHandler,
  createRetractVendorAttestationHandler,
  createUpsertVendorAttestationHandler,
  createVendorClaimHandler,
} from './routes/vendor-attestations';
import {
  createDeleteThreadMessageHandler,
  createGetVendorThreadHandler,
  createListIntegrationThreadsHandler,
  createPostThreadMessageHandler,
  createRequestThreadHelpHandler,
} from './routes/vendor-threads';
import {
  createGetVendorThreadByIdHandler,
  createListVendorThreadsHandler,
} from './routes/vendor-thread-by-id';
import { createListDataObjectsHandler } from './routes/vendor-data-objects';
import { createListVendorProductConnectorsHandler } from './routes/vendor-connectors';
import { createVendorConnectorCatalogHandler } from './routes/vendor-connector-catalog';
import {
  createRemoveSeatHandler,
  createResendSeatInviteHandler,
  createRevokeSeatInviteHandler,
  createSeatInviteHandler,
} from './routes/vendor-seat-invites';
import {
  createAcceptSeatClaimHandler,
  createDeclineSeatClaimHandler,
  type SendSeatClaimDeclinedEmail,
} from './routes/vendor-seat-claims';
import { createVendorBillingHandler } from './routes/vendor-billing';
import { createVendorBillingAcceptancesHandler } from './routes/vendor-billing-acceptances';
import { createUpdateBillingEmailHandler } from './routes/vendor-billing-email';
import {
  createAddStripeLicensesHandler,
  createStripeCheckoutHandler,
  createStripePortalHandler,
} from './routes/vendor-billing-stripe';
import { createCreateVendorProductHandler } from './routes/vendor-product-create';
import {
  createAcceptVendorProposalHandler,
  createDeclineVendorProposalHandler,
  createListVendorProposalsHandler,
} from './routes/vendor-proposals';
import {
  createAcceptSeatInviteHandler,
  createSeatInvitePreviewHandler,
} from './routes/seat-invites';
import { createVendorUpdatesHandler } from './routes/vendor-updates';
import {
  createListVendorHistoryHandler,
  createVendorHistoryCsvHandler,
  createVendorHistoryFollowUpHandler,
} from './routes/vendor-history';
import { createVendorDetailHandler, createVendorsListHandler } from './routes/vendors';
import { createVersionHandler } from './routes/version';
import { queue, scheduled } from './scheduled';

const app = new Hono<{ Bindings: Env }>();

// AECI-66: time every request and emit `aeci.api.query.duration_ms` tagged by
// endpoint and status. Registered first so it wraps every route, the `*`
// fallthrough included.
app.use('*', metricsMiddleware());

// AECI-250 — emit the D1 Sessions API `x-d1-bookmark` on write responses (for
// read-your-writes on the next request). Hono's `route()` flattens the sub-routers
// onto this app and runs them on the SAME context, so a write handler's
// `writeDb(c, …)` → `c.set('dbCtx', …)` is readable here. Reads never set `dbCtx`,
// so this is a no-op on the read path. Registered after metrics so it shares the
// same post-`next()` `finally` shape.
app.use('*', bookmarkMiddleware());

// AECI-1208 — one `user_activity_daily` row per signed-in user per UTC day. Same
// post-`next()` shape: it reads the `auth` session a sub-router's guard set, and
// writes in `waitUntil`, throttled per isolate, never on `DELETE /api/account`.
// A per-user service log (ADR 0022, 2026-10-02 amendment), so no audit row.
app.use('*', activityMiddleware());

// AECI-101 — the root app gets the same `errorHandler()` as the Phase 2.8
// sub-router, so the legacy routes below and the `*` fall-throughs emit the
// canonical `docs/API_CONTRACTS.md` §3.3 envelope on the error path. Sub-app
// errors don't bubble to a parent `onError`, so `phase28` keeps its own (below).
app.onError(errorHandler());
app.get('/api/logos/:key', createGetLogoHandler());

// Root-app routes, registered before the `phase28` sub-router. Their errors render
// through the root `onError` above.
app.get('/api/health', createHealthHandler());
app.get('/api/version', createVersionHandler());
app.post('/api/page-views', createPageViewsHandler());
// AECI-1457 / AECI-1330: a landing view's Turnstile verdict, `{ cf_ray, token }`.
// Anonymous, reached through the SSR `/api/*` passthrough like the beacon above.
// Each accepted post spends one siteverify subrequest, so it takes the `token`
// bucket keyed by IP (`cf-connecting-ip` crosses the service binding), the same
// registration as `/api/unsubscribe`. A 429 costs one verdict, never a page view.
app.post(
  '/api/page-views/turnstile',
  rateLimit('token', { by: 'ip' }),
  createTurnstileVerdictHandler(),
);

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

// AECI-978 — the retired-slug map (`STAGE_3_SPEC.md` §2.6 option B). The resolve
// route is called by the product/vendor detail resolvers ONLY after their own read
// missed; the list route feeds `sitemap.xml` and the IndexNow drain. The bare list
// path is registered first so `slug-redirects` is never captured as an `:entity`.
phase28.get('/api/slug-redirects', createSlugRedirectsListHandler());
phase28.get('/api/slug-redirects/:entity/:fromSlug', createSlugRedirectResolveHandler());

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

// AECI-1505 — the stored catalog fragment of `sitemap.xml`, streamed from
// `TAXONOMY_KV`. The SSR `/sitemap.xml` route is its caller; it is `<url>`
// elements, not a document. Built inline on a cold KV miss.
phase28.get('/api/sitemap.xml', createSitemapFragmentHandler());

// Phase 4.4 (AECI-179) — home stats, read straight from the `stats_cache`
// `home.*` keys (filled daily by 4.3). Never live-aggregates; a sparse cache
// returns empty-but-valid defaults, never a 500.
phase28.get('/api/stats/home', createStatsHomeHandler());

// Vendor requests (AECI-128): claim and correction form submissions. Public (no
// auth). An anonymous claim is parked until its emailed link is clicked (AECI-1435).
// Insert into `vendor_requests` with an audit row and a genesis workflow transition.
// The Phase 6 pipeline (Linear issue, domain-match and duplicate flags,
// reconciliation sweep, admin moderation) hangs off the seams in
// `routes/requests.ts` and `lib/linear.ts`.
phase28.post('/api/requests/correction', createCorrectionSubmitHandler());
phase28.post('/api/requests/claim', createClaimSubmitHandler());
// AECI-1293: "Not listed? Type it in" in the claim dialog, a `listing_requests` row
// (`VENDOR_PROGRAM_PAGE_SPEC.md` §15.4). Under `/api/requests/`, so zone Rule A caps it
// per IP like the claim route, and like it, it carries no in-Worker bucket
// (`docs/waf-rate-limits.md` §6.2).
phase28.post('/api/requests/listing', createListingRequestHandler());
// AECI-1435 (ADR 0043): an anonymous claim or listing request waits in
// `request_confirmations` until the typed address clicks the emailed link. The
// `/claims/confirm` page POSTs the token here on its button, never on load. Under
// `/api/requests/`, so zone Rule A caps it per IP, and the `token` bucket keyed by IP
// (never by the token, the invite-accept reasoning) bounds a token grind in-Worker.
phase28.post(
  '/api/requests/confirm',
  rateLimit('token', { by: 'ip' }),
  createConfirmRequestHandler(),
);
// AECI-1368: which company a claim would land on and whether it has an owner seat
// (`{ vendor_id, has_seats }`), so the claim form can show the routed disclosure
// before submit. A public read: no auth, no `rateLimit()`, `private, no-store`.
phase28.get('/api/requests/claim-target/:type/:slug', createClaimTargetHandler());

// Lead capture (AECI-257): the feedback and mailing-list signup forms. Public (no
// auth), no audit row (write-once analytics, §26.1 exemption). `subscribe` is
// idempotent on email. Reached through the SSR `/api/*` passthrough like every
// other route.
phase28.post('/api/feedback', createFeedbackHandler());
phase28.post('/api/subscribe', createSubscribeHandler());
// Mailing-list opt-out (AECI-537). Token-keyed soft-delete; serves both the
// `/unsubscribe` page (JSON body) and the welcome email's RFC 8058 one-click
// header (`?token=` query). No public ingress — reached via the SSR `/api/*`
// passthrough (byte-for-byte; no geo forwarding needed).
// AECI-773: the only anonymous write on this router with no WAF rule behind it —
// Rule A's predicate matches `/api/requests/*`, `/api/subscribe` and
// `/api/feedback`, and stops there. Every request is an unbounded D1 UPDATE
// keyed on a token the caller supplies, so the `token` bucket bounds the read
// cost of a scripted loop. Keyed by IP for the same reason as the invite redeem.
//
// Interop caveat: the RFC 8058 one-click path is POSTed automatically by mail
// security appliances, and a 429 there reads to the mail client as a broken
// unsubscribe. 10 per 10 s per IP sits far above any appliance's cadence.
phase28.post('/api/unsubscribe', rateLimit('token', { by: 'ip' }), createUnsubscribeHandler());
// AECI-1204: the one-click mute for the attestation nudge digest. Same shape and
// the same reasoning as the mailing-list opt-out above: an anonymous, token-keyed
// write reached through the SSR `/api/*` passthrough, POSTed by the digest's RFC
// 8058 `List-Unsubscribe` header (`?token=`) and by the `/notifications/mute` page
// (JSON body). The `token` bucket, keyed by IP, never by the token.
phase28.post(
  '/api/notifications/nudges/mute',
  rateLimit('token', { by: 'ip' }),
  createNudgeMuteHandler(),
);
// AECI-1305: the one-click marketing opt-out for `vendor-claim-nudge`. The nudge mute
// above, for its own token and column: POSTed by the email's `List-Unsubscribe`
// header (`?token=`) and by `/notifications/mute?list=marketing` (JSON body).
phase28.post(
  '/api/notifications/marketing/mute',
  rateLimit('token', { by: 'ip' }),
  createMarketingMuteHandler(),
);

// Inbound Linear webhook (AECI-212 / Phase 6.5) — the Linear → Site half of the
// moderation sync. Public URL; auth is the `Linear-Signature` HMAC verified
// inside the handler against `LINEAR_WEBHOOK_SIGNING_SECRET` (no user session).
// On an Issue state change it updates the matching `vendor_requests.status` and
// records a `workflow_transitions` + `audit_log` row. Reached only over the
// service binding like every other route. See `routes/webhooks.ts`.
// AECI-773: deliberately NOT rate-limited. HMAC-gated from a single Linear
// egress, and Linear RETRIES — so a 429 here drops a legitimate delivery. If a
// blanket POST middleware is ever proposed, this route is the first thing it
// would silently catch.
phase28.post('/api/webhooks/linear', createLinearWebhookHandler());
// Inbound Resend delivery webhook (AECI-1222). Public URL, reached through the SSR `/api/*`
// passthrough like the Linear route. Auth is the Svix signature verified inside the handler
// against `RESEND_WEBHOOK_SECRET`; unset → every delivery 401s. Deliberately NOT rate-limited,
// for the Linear route's reasons: signature-gated, no actor to key on, and Resend retries, so
// a 429 drops a legitimate event. See `routes/webhooks.ts`.
phase28.post('/api/webhooks/resend', createResendWebhookHandler());
// Inbound Stripe billing webhook (AECI-1500, E9.2). Public URL through the same passthrough;
// the zone's WAF skip rule matches this exact path. Auth is the `Stripe-Signature` HMAC
// verified inside the handler against `STRIPE_WEBHOOK_SECRET`; unset → every event 401s.
// No authz and deliberately NOT rate-limited, for the Linear and Resend reasons. It writes
// licenses through the one Stripe sync (`lib/stripe-licenses.ts`).
phase28.post('/api/webhooks/stripe', createStripeWebhookHandler());

app.route('/', phase28);

// Review-app promotion endpoints, kick-off and poll (ADR 0021). Own sub-router so
// its `onError` opts into `logClientErrors`: every rejected promote (400, 401, 413,
// 503, 500) emits a detailed log under `source:review-app-promote` with the same
// `trace_id` the caller gets, so the review app's operator can diagnose a failed
// push from PostHog Logs alone (`docs/REVIEW_APP_PROMOTE_API.md` §6.3). Registered
// before the `/api/*` 404 catch-all (below) so they match.
//
//   - POST /api/promote          — validate, start the promote Workflow, 202 { jobId }.
//   - POST /api/promote/connector-catalog
//                                — one PAGE of one connector catalogue (AECI-714).
//   - GET  /api/promote/jobs/:id — status + the committed result, for BOTH kinds.
//
// The commit runs in the Workflow, never on the request. A failure inside the
// Workflow never reaches this `onError`; the Workflow logs it itself, so every
// rejection is still logged for `SLUG_CONFLICT` / `INTERNAL_ERROR`.
const reviewPromote = new Hono<{ Bindings: Env }>();
reviewPromote.onError(errorHandler({ logClientErrors: true, source: 'review-app-promote' }));
// AECI-773: deliberately NOT rate-limited, and `docs/REVIEW_APP_PROMOTE_API.md`
// §6 publishes that fact to the review app's own repo. A first-party trusted
// caller, and the connector arm is PAGED — a catalogue sync legitimately fires
// many pages back to back, so a limiter would throttle our own ingest. The real
// control is idempotency: the `promote_jobs` PK ledger row and the connector
// planner's upserts keyed on the review app's record ids.
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

// The IndexNow runner's two internal routes (AECI-1476 / §20.2). A GitHub Actions
// runner reads the day's drain set, sends it to IndexNow from a non-Cloudflare IP,
// and posts the result back; the Worker keeps every decision and ledger write.
//   - POST /api/internal/indexnow/batch
//   - POST /api/internal/indexnow/batch/:batchId/result
// Bearer `INDEXNOW_RUNNER_TOKEN`, own sub-router and `onError`. Deliberately NOT
// rate-limited (`docs/waf-rate-limits.md` §6.2): token-gated, machine to machine,
// once a day, and a 429 would cost the day's submission. See `routes/internal-indexnow.ts`.
app.route('/', createIndexNowRunnerRouter());

// AECI-193 auth-spike sub-router. Own router because `requireUserAuth()`
// extends `Variables` (`c.get('user')`), which the `phase28` type doesn't
// carry. `/api/auth/whoami` is still the auth-chain smoke test behind the SSR
// `/auth/whoami` route and its e2e spec.
const authSpike = new Hono<{ Bindings: Env; Variables: UserAuthVariables }>();
authSpike.onError(errorHandler());
authSpike.get('/api/auth/whoami', requireUserAuth(), createAuthWhoamiHandler());
app.route('/', authSpike);

// Phase 5.4 user-auth sub-router (AECI-195). Same Variables-extended shape
// because `requireUserAuth()` sets `c.get('user')`. `/api/auth/profile/ensure` is
// the PRIMARY profile creator the SSR `/auth/callback` handler calls after the
// PKCE code exchange; since AECI-770 that call is fatal and retried
// (`AUTH_AND_RLS.md` §3.1a).
const authUser = new Hono<{ Bindings: Env; Variables: UserAuthVariables }>();
authUser.onError(errorHandler());
// AECI-773: `rateLimit` AFTER the guard so the counter is keyed on the verified
// JWT `sub` rather than on a NAT. This is a `profiles` upsert, so an unbounded
// loop is a D1 write loop — but it is also the last hop of every sign-in, so a
// mis-set limit here is a login outage. The `write` bucket's 30/60s is the
// loosest in the set and one sign-in spends one of them per attempt — up to 3
// since the AECI-770 retry, still far inside the bucket.
authUser.post(
  '/api/auth/profile/ensure',
  requireUserAuth(),
  rateLimit('write'),
  createEnsureProfileHandler(),
);
app.route('/', authUser);

// Phase 5.6 review-submit sub-router (AECI-197) — the first authenticated user
// *write*. Own router because `requireAuth()` sets `c.get('auth')`
// (`AuthzVariables`), a different shape from the `authUser`/`authSpike` routers
// above (`requireUserAuth()` → `c.get('user')`). `bannedCode: REVIEW_BANNED`
// makes the banned rejection a 403 `REVIEW_BANNED` per API_CONTRACTS.md §6.6.
// Reached only over the service binding like every other route.
const authReviews = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
authReviews.onError(errorHandler());
// AECI-773: two layers, because neither alone is what §15.1 asked for. This
// burst cap is per AUTHENTICATED USER, which zone Rule B (per IP) cannot express.
// The hourly half lives in the handler as a D1 count (`routes/reviews.ts`),
// because `simple.period` maxes at 60 s. WAF Rule B stays the edge brake.
authReviews.post(
  '/api/reviews',
  requireAuth({ bannedCode: ApiErrorCode.REVIEW_BANNED }),
  rateLimit('write'),
  createSubmitReviewHandler(),
);
app.route('/', authReviews);

// Phase 5.11 account sub-router (AECI-202) — the signed-in user's own account
// surface (read identity, edit display name, GDPR delete). Same `AuthzVariables`
// shape as `authReviews`, so its own router + `onError`. Plain `requireAuth()`
// (no `bannedCode`): there is no review-specific banned semantics here, so the
// default `FORBIDDEN` applies. NOTE: `requireAuth()` 403s a banned user before
// the handler, so erasure-for-banned-users is NOT reachable here (accepted in
// AECI-202). Letting erasure bypass a ban would need an `allowBanned` seam.
const authAccount = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
authAccount.onError(errorHandler());
// AECI-770: the ONLY guard with the self-heal hook. The header's `RoleStatus`
// probes this on every signed-in page view, so a user whose first-sign-in
// profile-ensure failed gets their `profiles` row here on the next page load,
// and a failure that persists answers 503 `PROFILE_UNAVAILABLE` instead of a 401.
// Every other `requireAuth()` stays strict.
authAccount.get(
  '/api/account',
  requireAuth({ onMissingProfile: healMissingProfile() }),
  createGetAccountHandler(),
);
authAccount.get('/api/account/reviews', requireAuth(), createGetAccountReviewsHandler());
authAccount.patch('/api/account', requireAuth(), rateLimit('write'), createUpdateAccountHandler());
// AECI-773: `DELETE /api/account` is DELIBERATELY NOT rate-limited. Erasure is a
// legal obligation (`docs/AUTH_AND_RLS.md` §8), the second call is a no-op, and
// the whole abuse ceiling is one account erasing itself. A 429 must never be the
// reason an erasure fails. The accepted cost is that a hammering loop reaches the
// GoTrue seam and a `reviews`-touching batch; the control is `requireAuth()`.
authAccount.delete('/api/account', requireAuth(), createDeleteAccountHandler());
app.route('/', authAccount);

// AECI-1208 arrival beacon. `requireAuth()` then `rateLimit('write')`, the write
// convention (`docs/waf-rate-limits.md` §6.2): a once-per-landing D1 upsert keyed on
// the verified user. It writes the caller's own activity row and nothing else.
const authActivity = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
authActivity.onError(errorHandler());
authActivity.post(
  '/api/activity/arrival',
  requireAuth(),
  rateLimit('write'),
  createActivityArrivalHandler(),
);
app.route('/', authActivity);

// Admin sub-router (AECI-203 onward, `ADMIN_PANEL_SPEC.md` §6). Every route is
// `requireAdmin()`-gated: it sets `c.get('auth')` (`AuthzVariables`) AND enforces
// `role === 'admin'` before the handler. `requireAdmin()` is the single
// enforcement point (§9.1). Registered before the `/api/*` 404 catch-all so the
// routes can match. `GET /api/admin/summary` is also the SSR `/admin` gate signal
// (200 = admin, 401/403 → the resolver renders a 404).
//
// Reads write no `audit_log` row and are non-cacheable by construction (`json()`
// sets `private, no-store`, and `/admin/*` is absent from the SSR Worker's
// `ROUTE_CACHE_PATTERNS`, §9.2). Writes are the named exceptions in
// `ADMIN_PANEL_SPEC.md` §2. Each route's contract is in its route module's header.
// Two constraints worth knowing here:
//   - `GET /api/admin/users` is profiles-first because ONE Supabase project backs
//     every environment (ADR 0017). Its `perPage` caps at 50, not 100, because
//     each row costs one GoTrue GET.
//   - `GET /api/admin/users/:id` carries no page-view stats, ever:
//     `ADMIN_PANEL_SPEC.md` §9 item 7 forbids visitor-to-account correlation.
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
// AECI-1293: the listing request queue, the second section of /admin/requests.
// Moderation is a resolve/reject with its audit row, like the requests PATCH above,
// and like it carries no limiter (`docs/waf-rate-limits.md` §6.2).
authAdmin.get(
  '/api/admin/listing-requests',
  requireAdmin(),
  createAdminListingRequestsListHandler(),
);
authAdmin.patch(
  '/api/admin/listing-requests/:id',
  requireAdmin(),
  createModerateListingRequestHandler(),
);
// AECI-1377 (§4.7.6): the product request queue on /admin/requests. A decision is
// one batch with a race sentinel, its audit row and the vendor's portal row; the
// decision email goes after commit. No limiter, like the listing requests above.
authAdmin.get(
  '/api/admin/product-requests',
  requireAdmin(),
  createAdminProductRequestsListHandler(),
);
authAdmin.patch(
  '/api/admin/product-requests/:id',
  requireAdmin(),
  createDecideProductRequestHandler(),
);
// AECI-1373 (E4.4, ADMIN_PANEL_SPEC.md §5.17): early-unassign requests, the fourth
// section of /admin/requests. The read is never rate-limited and audits nothing. The
// decision is a write: an approve unassigns the license through lib/license.ts, and
// both outcomes write their audit and portal rows in one batch with race sentinels.
authAdmin.get(
  '/api/admin/license-release-requests',
  requireAdmin(),
  createAdminLicenseReleaseRequestsListHandler(),
);
authAdmin.patch(
  '/api/admin/license-release-requests/:id',
  requireAdmin(),
  rateLimit('write'),
  createDecideLicenseReleaseRequestHandler(),
);
// Stage 2 / AECI-521: the claim-review LIST (reviewer-assist signals). Read-only,
// clones the requests LIST; the reviewer decides on the assembled evidence.
authAdmin.get('/api/admin/claims', requireAdmin(), createAdminClaimsListHandler());
// Stage 2 / AECI-739: one claim, plus the explanation behind the queue's duplicate
// chip (§5.2 step 5). Read-only, no audit row.
authAdmin.get('/api/admin/claims/:id', requireAdmin(), createAdminClaimDetailHandler());
// AECI-1276: the claim's audit trail (`vendor_request` rows for this id). Read-only.
authAdmin.get('/api/admin/claims/:id/audit', requireAdmin(), createAdminClaimAuditHandler());
// AECI-653: the global audit-log viewer, every `audit_log` row, filtered. Read-only:
// no audit row, no `rateLimit()`. `entity_id` without `entity_type` and a lone
// `actor_type` are 400s, because neither shape can start from an index.
authAdmin.get('/api/admin/audit', requireAdmin(), createAdminAuditLogHandler());
// Stage 2 / AECI-739: the operator note (§5.2 step 6) — a sub-resource, not a third
// `ModerateClaimSchema.action`, because a note changes no status and is writable at
// all four of them. One `db.batch` carrying the UPDATE + its audit row.
authAdmin.patch('/api/admin/claims/:id/notes', requireAdmin(), createSaveClaimNotesHandler());
// Stage 2 / AECI-519: the claim → verified-account grant. `resolveClaimantIdentity`
// reports `unavailable` (→503) wherever `SUPABASE_SERVICE_ROLE_KEY` is absent, which
// is local dev (CI pushes it on staging, demo and production).
// AECI-528 injects the real claim-decision email sender (`sendClaimDecisionEmail`,
// `lib/email.ts`) into the post-commit seam; it fail-opens to `'skipped'` without
// `RESEND_API_KEY`/`EMAIL_FROM`.
authAdmin.patch(
  '/api/admin/claims/:id',
  requireAdmin(),
  createModerateClaimHandler(getDb, resolveClaimantIdentity, sendClaimDecisionEmail),
);
// AECI-1008: integration field contests, the AECi queue. The PATCH is the eighth
// named write exception in `ADMIN_PANEL_SPEC.md`: a DECISION write. An accept
// files a `REVIEW - ` Linear issue post-commit, and since AECI-1005 also writes the
// catalog when the integration is claimed or an owner is approved (ADR 0035).
authAdmin.get('/api/admin/contests', requireAdmin(), createAdminContestsListHandler());
authAdmin.patch(
  '/api/admin/contests/:id',
  requireAdmin(),
  rateLimit('write'),
  createModerateContestHandler(),
);
// AECI-1009: AECi rules on a protest. ADVICE ONLY: it writes the protest columns and
// nothing else (no catalog write, no purge, no Linear issue). Same named decision-write
// exception as the contest PATCH above.
authAdmin.patch(
  '/api/admin/contests/:id/protest',
  requireAdmin(),
  rateLimit('write'),
  createDecideContestProtestHandler(),
);
// AECI-1177: vendor replies to reviews, the pre-moderation queue
// (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11c). The PATCH is the tenth named write
// exception in `ADMIN_PANEL_SPEC.md`: a MODERATION write on vendor-authored content
// that never touches the review. The read is never rate-limited; the write is.
authAdmin.get(
  '/api/admin/review-responses',
  requireAdmin(),
  createAdminReviewResponsesListHandler(),
);
authAdmin.patch(
  '/api/admin/review-responses/:id',
  requireAdmin(),
  rateLimit('write'),
  createDecideReviewResponseHandler(),
);
// AECI-1539: the read-only admin view of private row threads
// (`STAGE_2_ATTESTATIONS_SPEC.md` §15.12, `ADMIN_PANEL_SPEC.md` §5.19). Two reads, no
// write, no limiter: AECi reads every thread, deleted text included, and acts only
// when a seat asks, by email.
authAdmin.get('/api/admin/threads', requireAdmin(), createAdminThreadsListHandler());
authAdmin.get('/api/admin/threads/:id', requireAdmin(), createAdminThreadDetailHandler());
authAdmin.get('/api/admin/reviewers', requireAdmin(), createBannedReviewersListHandler());
authAdmin.patch(
  '/api/admin/reviewers/:id',
  requireAdmin(),
  rateLimit('write'),
  createBanReviewerHandler(),
);
// AECI-1623: suspend, then terminate (`ADMIN_PANEL_SPEC.md` §5.7). One read with no
// limiter, and every write behind `rateLimit('write')` after the guard.
authAdmin.get(
  '/api/admin/vendors/:id/suspension',
  requireAdmin(),
  createVendorSuspensionStateHandler(),
);
authAdmin.post(
  '/api/admin/vendors/:id/suspend',
  requireAdmin(),
  rateLimit('write'),
  createSuspendVendorHandler(),
);
authAdmin.post(
  '/api/admin/vendors/:id/suspension/resend-notice',
  requireAdmin(),
  rateLimit('write'),
  createResendSuspensionNoticeHandler(),
);
authAdmin.post(
  '/api/admin/vendors/:id/suspension/stage-2',
  requireAdmin(),
  rateLimit('write'),
  createStartSuspensionStage2Handler(),
);
authAdmin.post(
  '/api/admin/vendors/:id/suspension/cost-log',
  requireAdmin(),
  rateLimit('write'),
  createAddAbuseCostEntryHandler(),
);
authAdmin.post(
  '/api/admin/vendors/:id/suspension/cost-log/:entryId/void',
  requireAdmin(),
  rateLimit('write'),
  createVoidAbuseCostEntryHandler(),
);
authAdmin.post(
  '/api/admin/vendors/:id/suspension/lift',
  requireAdmin(),
  rateLimit('write'),
  createLiftVendorSuspensionHandler(),
);
authAdmin.post(
  '/api/admin/vendors/:id/suspension/terminate',
  requireAdmin(),
  rateLimit('write'),
  createTerminateVendorHandler(),
);
authAdmin.post(
  '/api/admin/vendors/:id/suspension/refunds/retry',
  requireAdmin(),
  rateLimit('write'),
  createRetryTerminationRefundsHandler(),
);
// AECI-955: the admin logo upload and the vendor and product logo PATCHes
// (`STAGE_2_5_SPEC.md` §11). Writes, so `rateLimit('write')` after the guard.
authAdmin.post(
  '/api/admin/logo',
  requireAdmin(),
  rateLimit('write'),
  createUploadLogoHandler('admin'),
);
authAdmin.patch(
  '/api/admin/vendors/:id/logo',
  requireAdmin(),
  rateLimit('write'),
  createUpdateAdminLogoHandler('vendor'),
);
authAdmin.patch(
  '/api/admin/products/:id/logo',
  requireAdmin(),
  rateLimit('write'),
  createUpdateAdminLogoHandler('product'),
);
// Stage 2 / AECI-652: the admin vendor surface (§5.6). The literal sub-paths are
// unambiguous against the bare `/:id`: Hono's trie separates them by segment count.
authAdmin.get('/api/admin/vendors', requireAdmin(), createAdminVendorsListHandler());
authAdmin.get('/api/admin/vendors/:id', requireAdmin(), createAdminVendorDetailHandler());
authAdmin.get(
  '/api/admin/vendors/:id/products',
  requireAdmin(),
  createAdminVendorProductsHandler(),
);
authAdmin.get('/api/admin/vendors/:id/audit', requireAdmin(), createAdminVendorAuditHandler());
// AECI-1362 (E2.4): one vendor's agreement acceptances with their evidence columns. A
// read; 404 on an unknown vendor.
authAdmin.get(
  '/api/admin/vendors/:id/acceptances',
  requireAdmin(),
  createAdminVendorAcceptancesHandler(),
);
// AECI-1372 (E4.3): the read-only Billing tab: billing account, owner seats, every
// license, acceptances and (from E4.4) early-unassign requests. A read: no audit, no
// limiter; 404 on an unknown vendor, 200 with `billing_account: null` when it has none.
authAdmin.get('/api/admin/vendors/:id/billing', requireAdmin(), createAdminVendorBillingHandler());
// AECI-1046: the vendor-held integrations a vendor owns (the Integrations tab), and the
// admin retire and restore of one. The ninth named write exception in
// `ADMIN_PANEL_SPEC.md`: a MODERATION write on a vendor's listing, on the owner
// retire's batch (`integration-retire-write.ts`). Reads write nothing.
authAdmin.get(
  '/api/admin/vendors/:id/integrations',
  requireAdmin(),
  createAdminVendorIntegrationsHandler(),
);
// AECI-1237: the admin field correction with a lock, and its lift
// (STAGE_2_VENDOR_PORTAL_SPEC.md §11d.5). Writes are rate-limited after the guard;
// the per-vendor list is a read.
authAdmin.post(
  '/api/admin/field-overrides',
  requireAdmin(),
  rateLimit('write'),
  createSetFieldOverrideHandler(),
);
authAdmin.post(
  '/api/admin/field-overrides/:id/lift',
  requireAdmin(),
  rateLimit('write'),
  createLiftFieldOverrideHandler(),
);
authAdmin.get(
  '/api/admin/vendors/:id/field-overrides',
  requireAdmin(),
  createAdminVendorFieldOverridesHandler(),
);
authAdmin.post(
  '/api/admin/integrations/:id/retire',
  requireAdmin(),
  rateLimit('write'),
  createAdminRetireIntegrationHandler(),
);
authAdmin.post(
  '/api/admin/integrations/:id/restore',
  requireAdmin(),
  rateLimit('write'),
  createAdminRestoreIntegrationHandler(),
);
// AECI-1479: the admin seat provision. It writes the profile and an audit row, and a
// first seat stamps ownership and dispatches the review-app sync. A write, so
// `rateLimit('write')` after the guard.
authAdmin.post(
  '/api/admin/vendors/:id/seats',
  requireAdmin(),
  rateLimit('write'),
  createProvisionSeatHandler(),
);
// AECI-1370 (E4.1): grant N complimentary or invoice licenses on the vendor's billing
// account, through `grantLicensesStatements` (`lib/license.ts`). Idempotent on the
// body's `grant_id`. A write, so `rateLimit('write')` after the guard.
authAdmin.post(
  '/api/admin/vendors/:id/licenses',
  requireAdmin(),
  rateLimit('write'),
  createGrantLicensesHandler(),
);
// AECI-1589: after an unban, grant one complimentary license per product the ban took
// off Managed, assigned at grant, each with its own end date. Idempotent on `grant_id`.
// A write, so `rateLimit('write')` after the guard.
authAdmin.post(
  '/api/admin/vendors/:id/licenses/ban-term',
  requireAdmin(),
  rateLimit('write'),
  createBanTermLicensesHandler(),
);
// AECI-1381: AECi sets or clears the vendor's billing email, through
// `billingEmailStatements` (`lib/billing-account.ts`), the vendor route's builder. A
// write, so `rateLimit('write')` after the guard. Audit only: no email, no purge.
authAdmin.put(
  '/api/admin/vendors/:id/billing/email',
  requireAdmin(),
  rateLimit('write'),
  createAdminUpdateBillingEmailHandler(),
);
// AECI-1371 (E4.2): extend, re-reference or revoke one license, through
// `setLicensesTermStatements` / `endLicensesStatements` (`lib/license.ts`). A write,
// so `rateLimit('write')` after the guard.
authAdmin.patch(
  '/api/admin/licenses/:id',
  requireAdmin(),
  rateLimit('write'),
  createUpdateLicenseHandler(),
);
// AECI-1234: the admin seat revoke. It writes the profile, an audit row and one portal
// notice on the vendor feed, through `revokeSeatStatements`. NO statement names
// `vendors`: a seat revoke never moves the licenses or the mirror (§5.2). A write,
// so `rateLimit('write')` after the guard.
authAdmin.delete(
  '/api/admin/vendors/:id/seats/:userId',
  requireAdmin(),
  rateLimit('write'),
  createAdminRevokeSeatHandler(),
);
// AECI-1415 (ADR 0042): "Return records to AECi", refused while any seat remains.
authAdmin.post(
  '/api/admin/vendors/:id/return-to-aeci',
  requireAdmin(),
  rateLimit('write'),
  createReturnRecordsHandler(),
);
// AECI-692: the admin user surface (§5.8). Two READS and nothing else — ban and
// reinstate reuse `PATCH /api/admin/reviewers/:id` above completely unchanged, so
// there is still exactly one writer of `profiles.banned_at` in the codebase, and
// seat revoke stays on the vendor roster where the blast radius is visible.
// Literal segment before the bare `/:id`, matching the vendors block.
authAdmin.get('/api/admin/users', requireAdmin(), createAdminUsersListHandler());
authAdmin.get('/api/admin/users/:id', requireAdmin(), createAdminUserDetailHandler());
// AECI-720: the per-iPaaS management cutoff. Flips `connector_catalogs.managed_by`,
// which freezes the review lane for that catalogue: `POST /api/promote/connector-catalog`
// then refuses every page for it with `CATALOG_VENDOR_MANAGED`. Audit-only, no
// `workflow_instances` row (that CHECK is closed, §1.2) and NO cache purge: only the
// uncacheable /admin surface reads `connector_catalogs`. The flag is reversible; what is
// one-way is the DATA direction, which the promote refusal delivers. Grants no seat
// (`STAGE_2_SPEC.md` §8.9(2)/(3)).
authAdmin.patch(
  '/api/admin/connector-catalogs/:id',
  requireAdmin(),
  createSetConnectorCatalogManagementHandler(),
);
// AECI-722: the connector admin surface (§5.9), five GETs over the connector tables.
// Every one WRITES NOTHING: no `audit_log` row, no purge and no `Cache-Tag`. Mapping
// authoring is the separate AECI-724 PATCH below, gated on `managed_by = 'vendor'`
// so it never writes a row the sync would clobber.
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
// AECI-724: AECi-side mapping authoring, the first catalog-CONTENT write on this
// console. Gated on `managed_by = 'vendor'` (409 `CATALOG_REVIEW_MANAGED` otherwise),
// the exact complement of the promote refusal, so the sync and this route never write
// the same row. Audit row in the same batch (filed under the catalogue), purge of the
// reach line's `product:*` tags post-commit. The seat holder's twin is on `authVendor`.
authAdmin.patch(
  '/api/admin/connector-stub-mappings/:id',
  requireAdmin(),
  createAdminUpdateConnectorStubMappingHandler(),
);
// Admin panel reads (AECI-574 onward). Pure reads: no audit row, no `rateLimit()`.
authAdmin.get('/api/admin/overview', requireAdmin(), createAdminOverviewHandler());
authAdmin.get('/api/admin/metrics/timeseries', requireAdmin(), createAdminTimeseriesHandler());
authAdmin.get('/api/admin/traffic/breakdown', requireAdmin(), createAdminTrafficBreakdownHandler());
authAdmin.get('/api/admin/page-views', requireAdmin(), createAdminPageViewsHandler());
authAdmin.get('/api/admin/catalog/coverage', requireAdmin(), createAdminCatalogCoverageHandler());
authAdmin.get('/api/admin/system', requireAdmin(), createAdminSystemHandler());
authAdmin.get('/api/admin/audience', requireAdmin(), createAdminAudienceHandler());
authAdmin.get('/api/admin/feedback', requireAdmin(), createAdminFeedbackHandler());
authAdmin.get('/api/admin/subscribers', requireAdmin(), createAdminSubscribersHandler());

// §5.11 / AECI-946 — the Google re-crawl worklist. The GET is a plain admin read;
// the DELETE is the Done button and carries NO `rateLimit()`, matching every other
// `requireAdmin()` write (`waf-rate-limits.md` §6.2: hand-granted role, no
// anonymous path, and every write audits in-batch — a limiter would only risk
// 429-ing the burst this screen exists to support).
authAdmin.get('/api/admin/reindex', requireAdmin(), createAdminReindexListHandler());
// AECI-1188 — the submission history. A read: no audit row, no `rateLimit()`. The
// literal path never meets `/:id`, which is registered for DELETE only.
authAdmin.get(
  '/api/admin/reindex/submissions',
  requireAdmin(),
  createAdminReindexSubmissionsHandler(),
);
authAdmin.delete('/api/admin/reindex/:id', requireAdmin(), createClearReindexRowHandler());
// §5.14 / AECI-1223 — the email screen. Three READS over `notification_sends` and
// `notification_delivery_events`; no audit row, no `rateLimit()` (reads are never
// limited). The address search is a POST so the address rides the body and never a
// logged URL; the GET list refuses an `address` parameter (`ADDRESS_NOT_ALLOWED_IN_URL`).
authAdmin.get('/api/admin/email/summary', requireAdmin(), createAdminEmailSummaryHandler());
authAdmin.get('/api/admin/email/sends', requireAdmin(), createAdminEmailSendsHandler());
authAdmin.post('/api/admin/email/sends/search', requireAdmin(), createAdminEmailSearchHandler());
// §5.14 / AECI-1224 — the sending switches. The GET is a read (no audit, no limiter). The
// PUT pauses or resumes one template or the support copy on THIS tier: a write that audits
// in its own batch and carries `rateLimit('write')` after the guard (`waf-rate-limits.md`
// §6.2). It refuses to pause a non-pausable entry (`NOTIFICATION_NOT_PAUSABLE`).
authAdmin.get('/api/admin/email/switches', requireAdmin(), createAdminEmailSwitchesHandler());
authAdmin.put(
  '/api/admin/email/switches/:key',
  requireAdmin(),
  rateLimit('write'),
  createSetAdminEmailSwitchHandler(),
);
app.route('/', authAdmin);

// Stage 2 vendor-portal sub-router (AECI-520, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4).
// Same shape as `authAdmin` but gated by `requireVendor()`: valid JWT, not banned,
// `role === 'vendor_admin'`, non-null `vendor_id`. A site `admin` is rejected here
// on purpose: there is no impersonation, admins act via `/api/admin/*`.
//
// The guard only establishes WHICH vendor is calling; there is no RLS behind it,
// so every handler additionally scopes its queries by `c.get('auth').vendorId` and
// proves ownership of any client-supplied id before writing.
//
// Capability-gated writes check in this order: ownership → 404, then
// `requireProductCapability(...)` → 403 `ENTITLEMENT_REQUIRED` (AECI-623). Reads
// are never capability-gated, so the dashboard can render a read-only tab instead
// of 403-ing a vendor out of its own data. Where "a seat is the whole gate", the
// route says so.
//
// `GET /api/vendor/updates` (AECI-627, ADR 0023) returns one `updated_at` cursor
// per portal scope (`VENDOR_PORTAL_SCOPES` in `@aeci/shared`). Each cursor must
// reuse the scoping predicate of the endpoint it is a cursor for; the route
// module's header says what breaks when one drifts.
//
// AECI-773: every WRITE below carries `rateLimit('write')`, registered after
// `requireVendor()` so the counter is keyed on the seat rather than on the
// office NAT. **No GET on this router is rate-limited, and none may become so.**
// `GET /api/vendor/updates` is polled every 20 s per focused seat and one poll
// can fan out to a refetch per scope, so a limiter on it would trip inside a
// minute — and its failure mode is silent in both directions: a permanently
// stale portal, or a self-inflicted poll amplifier, with nothing logged either
// way. Reads are never limited on any surface (ADR 0026).
const authVendor = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
authVendor.onError(errorHandler());
authVendor.post(
  '/api/vendor/logo',
  requireVendor(),
  rateLimit('write'),
  createUploadLogoHandler('vendor'),
);
authVendor.get('/api/vendor/me', requireVendor(), createVendorMeHandler());
authVendor.get('/api/vendor/seats', requireVendor(), createVendorSeatsHandler());
// AECI-1217 / `STAGE_2_PAID_TIERS_SPEC.md` §13.10: the checklist reads. Seat-only on
// every plan, and never rate-limited (reads). The product read proves ownership in
// the handler (foreign → 404).
authVendor.get('/api/vendor/checklist', requireVendor(), createVendorChecklistHandler());
authVendor.get(
  '/api/vendor/products/:id/checklist',
  requireVendor(),
  createVendorProductChecklistHandler(),
);
authVendor.get(
  '/api/vendor/notifications',
  requireVendor(),
  createListVendorNotificationsHandler(),
);
// AECI-1187: a read, so no limiter and no capability gate (decision 3).
authVendor.get(
  '/api/vendor/recrawl-submissions',
  requireVendor(),
  createListVendorRecrawlSubmissionsHandler(),
);
// AECI-1204: the caller's own seat's nudge mute. The GET is a read (no limiter);
// the PUT is a write and carries `rateLimit('write')` after the guard. Both act on
// `auth.userId`, never on an id from the request.
authVendor.get(
  '/api/vendor/notification-preferences',
  requireVendor(),
  createGetNotificationPreferencesHandler(),
);
authVendor.put(
  '/api/vendor/notification-preferences',
  requireVendor(),
  rateLimit('write'),
  createUpdateNotificationPreferencesHandler(),
);
authVendor.patch(
  '/api/vendor/profile',
  requireVendor(),
  rateLimit('write'),
  createUpdateVendorProfileHandler(),
);
// AECI-1216 / `STAGE_2_PAID_TIERS_SPEC.md` §13.8: "Looks right". Each stamps a review
// with no content edit. Seat-only on every plan: no `requireCapability`. The two
// product routes prove ownership in the handler (foreign → 404). Each purges, so each
// carries the write limiter for the same reason as the edits they stand beside.
authVendor.post(
  '/api/vendor/profile/review',
  requireVendor(),
  rateLimit('write'),
  createReviewVendorProfileHandler(),
);
authVendor.post(
  '/api/vendor/products/:id/review',
  requireVendor(),
  rateLimit('write'),
  createReviewVendorProductHandler(),
);
authVendor.post(
  '/api/vendor/products/:id/integrations/review',
  requireVendor(),
  rateLimit('write'),
  createReviewVendorProductIntegrationsHandler(),
);
// Registered BEFORE `/api/vendor/products/:id` so the more specific version
// paths are not shadowed by the product PATCH's parameterised route.
authVendor.get(
  '/api/vendor/products/:id/versions',
  requireVendor(),
  createListProductVersionsHandler(),
);
// AECI-1013. Read-only, ownership-checked, outside the AECI-516 cursor — see the
// route module's header for why this read does not poll.
authVendor.get(
  '/api/vendor/products/:id/connectors',
  requireVendor(),
  createListVendorProductConnectorsHandler(),
);
// AECI-1083 / `STAGE_2_SPEC.md` §8.9(1): the connector seat's own catalogue, the read
// behind the portal's Catalogue tab. Ownership (404) then `connector` role (404) in
// the handler; no capability, no entitlement read, and no `rateLimit()` (a read).
// Inside the AECI-516 cursor as the `catalogue` scope, under the same predicate.
authVendor.get(
  '/api/vendor/products/:id/connector-catalog',
  requireVendor(),
  createVendorConnectorCatalogHandler(),
);
authVendor.post(
  '/api/vendor/products/:id/versions',
  requireVendor(),
  rateLimit('write'),
  createProductVersionHandler(),
);
authVendor.patch(
  '/api/vendor/products/:id/versions/:versionId',
  requireVendor(),
  rateLimit('write'),
  createUpdateProductVersionHandler(),
);
authVendor.delete(
  '/api/vendor/products/:id/versions/:versionId',
  requireVendor(),
  rateLimit('write'),
  createDeleteProductVersionHandler(),
);
// This write purges cache tags via its post-commit hook, so an unbounded loop
// here is an edge-cache purge loop — the strongest single reason the bucket exists.
authVendor.patch(
  '/api/vendor/products/:id',
  requireVendor(),
  rateLimit('write'),
  createUpdateVendorProductHandler(),
);
// AECI-1424 (§4.8, ADR 0042 amendment 2026-10-22): an owner adds a product to a company
// that owns its record. The proposal accept's gate order: `requireVendor()`, the limiter,
// then `requireSeatOwner()` and the ownership check inside the handler. Free fields only.
// The product is born owned, so promote never writes it.
authVendor.post(
  '/api/vendor/products',
  requireVendor(),
  rateLimit('write'),
  createCreateVendorProductHandler(),
);
// AECI-301. No path overlap with the product routes above, so ordering is free.
authVendor.get('/api/vendor/integrations', requireVendor(), createListVendorIntegrationsHandler());
// AECI-1011 / ADR 0035 decision 7: a vendor CREATES an integration on one of its own
// products. A SEAT IS THE WHOLE GATE (decision 15): no `requireCapability`. The
// endpoint checks (own product 404, promoted counterpart 404) are in the handler. The
// row is born claimed (`origin = 'vendor'`), so promote never writes it. Duplicates
// warn in the 201 and are never refused (decision 10).
authVendor.post(
  '/api/vendor/integrations',
  requireVendor(),
  rateLimit('write'),
  createCreateVendorIntegrationHandler(),
);
// AECI-1377 (§4.7.6): ask AECi to add the other product of an integration. A seat is
// the whole gate, as for the create above. Under /api/vendor/*, not /api/requests/*:
// an authenticated vendor write, so the in-Worker limiter caps it, not zone Rule A.
// The list read is never rate-limited.
authVendor.get(
  '/api/vendor/product-requests',
  requireVendor(),
  createListVendorProductRequestsHandler(),
);
authVendor.post(
  '/api/vendor/product-requests',
  requireVendor(),
  rateLimit('write'),
  createVendorProductRequestHandler(),
);
authVendor.post(
  '/api/vendor/claims',
  requireVendor(),
  rateLimit('write'),
  createVendorClaimHandler(),
);
// The two attestation writes are the AECI-516 OPTIMISTIC toggles: the client
// applies locally and rolls back with a visible error on failure, so a 429 here
// needs no new UI — the shipped behaviour already handles it correctly.
authVendor.put(
  '/api/vendor/claims/:claimId/attestation',
  requireVendor(),
  rateLimit('write'),
  createUpsertVendorAttestationHandler(),
);
authVendor.delete(
  '/api/vendor/claims/:claimId/attestation',
  requireVendor(),
  rateLimit('write'),
  createRetractVendorAttestationHandler(),
);
authVendor.delete(
  '/api/vendor/claims/:claimId',
  requireVendor(),
  rateLimit('write'),
  createDeleteVendorClaimHandler(),
);
// AECI-1535: private row threads (`STAGE_2_ATTESTATIONS_SPEC.md` §15.6). A SEAT IS
// THE WHOLE GATE, like contests: no capability. AECI-1553: every vendor thread route
// takes `requireThreadsEnabled()` right after the guard, so with `THREADS_ENABLED`
// off it answers 404 before the limiter and the handler (§15.16). The endpoint check
// (404) and the §15.2 test (409) run in the handlers. Writes carry
// `rateLimit('write')` after the guard; the GET does not, and must not.
authVendor.get(
  '/api/vendor/claims/:claimId/thread',
  requireVendor(),
  requireThreadsEnabled(),
  createGetVendorThreadHandler(),
);
// AECI-1546: one summary read per integration page, in place of one GET per row.
// A read: no limiter, and it writes no read marker.
authVendor.get(
  '/api/vendor/integrations/:id/threads',
  requireVendor(),
  requireThreadsEnabled(),
  createListIntegrationThreadsHandler(),
);
authVendor.post(
  '/api/vendor/claims/:claimId/thread/messages',
  requireVendor(),
  requireThreadsEnabled(),
  rateLimit('write'),
  createPostThreadMessageHandler(),
);
authVendor.delete(
  '/api/vendor/claims/:claimId/thread/messages/:messageId',
  requireVendor(),
  requireThreadsEnabled(),
  rateLimit('write'),
  createDeleteThreadMessageHandler(),
);
authVendor.post(
  '/api/vendor/claims/:claimId/thread/help',
  requireVendor(),
  requireThreadsEnabled(),
  rateLimit('write'),
  createRequestThreadHelpHandler(),
);
// AECI-1548 / AECI-1551: one thread by its id, the thread's permanent page, with
// `can_write`. Writes stay on the claim routes above. The stamped pair is the read
// gate (`threadParticipantWhere`). A read, so no rate limit.
authVendor.get(
  '/api/vendor/threads/:threadId',
  requireVendor(),
  requireThreadsEnabled(),
  createGetVendorThreadByIdHandler(),
);
// AECI-1551: the company's Conversations list, every thread it is on, paged. A
// read: no limiter, and it writes no read marker.
authVendor.get(
  '/api/vendor/threads',
  requireVendor(),
  requireThreadsEnabled(),
  createListVendorThreadsHandler(),
);
// AECI-606. Guard only — no authority resolution and no capability gate; see the
// route module's header for why that is the contract rather than an omission.
authVendor.get('/api/vendor/data-objects', requireVendor(), createListDataObjectsHandler());
// AECI-627. No path overlap with anything above, so ordering is free.
authVendor.get('/api/vendor/updates', requireVendor(), createVendorUpdatesHandler());
// AECI-1194: the vendor's change history. A SEAT IS THE WHOLE GATE: no
// `requireCapability` (reads are never gated, PAID_TIERS §4.3), no `rateLimit`
// (reads are never rate-limited), and no audit row.
authVendor.get('/api/vendor/history', requireVendor(), createListVendorHistoryHandler());
authVendor.get('/api/vendor/history.csv', requireVendor(), createVendorHistoryCsvHandler());
// AECI-1160: the search follow-up of one history page. Same gate: a seat, nothing else.
authVendor.get(
  '/api/vendor/history/follow-up',
  requireVendor(),
  createVendorHistoryFollowUpHandler(),
);
// AECI-1008: integration field contests. A SEAT IS THE WHOLE GATE — no
// `requireCapability`, deliberately (the §6.14 exception in
// `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b). Writes carry `rateLimit('write')`; the
// GET does not, and must not.
// AECI-1092: the id may name a connector-evidenced pair, resolved in the handler the
// way the AECI-1089 claim and the AECI-1090 edit resolve it on this same path.
authVendor.post(
  '/api/vendor/integrations/:id/contests',
  requireVendor(),
  rateLimit('write'),
  createSubmitContestHandler(),
);
authVendor.get('/api/vendor/contests', requireVendor(), createListVendorContestsHandler());
authVendor.post(
  '/api/vendor/contests/:id/withdraw',
  requireVendor(),
  rateLimit('write'),
  createWithdrawContestHandler(),
);
authVendor.post(
  '/api/vendor/contests/:id/decision',
  requireVendor(),
  rateLimit('write'),
  createDecideContestHandler(),
);
// AECI-1009: protest a declined (or 30-day-unanswered) contest to AECi. A SEAT IS
// THE WHOLE GATE, the same §11b.2 exception as the contest routes above. Writes carry
// `rateLimit('write')` after the guard; party checks (404) live in the handlers.
authVendor.post(
  '/api/vendor/contests/:id/protest',
  requireVendor(),
  rateLimit('write'),
  createFileContestProtestHandler(),
);
authVendor.post(
  '/api/vendor/contests/:id/protest/reply',
  requireVendor(),
  rateLimit('write'),
  createReplyContestProtestHandler(),
);
authVendor.post(
  '/api/vendor/contests/:id/protest/withdraw',
  requireVendor(),
  rateLimit('write'),
  createWithdrawContestProtestHandler(),
);
// AECI-1176: vendor replies to reviews (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.14).
// Gate order: `requireVendor()` → `rateLimit('write')` → in the handler, the review
// (unknown, unowned and unapproved are one 404) →
// `requireProductCapability(c, review.productId, 'review.reply')` on create and edit
// only → body → state. Withdraw is not capability-gated (§11c.9).
// The GET carries no capability and no `rateLimit()`: reads are never limited.
authVendor.get('/api/vendor/reviews', requireVendor(), createListVendorReviewsHandler());
authVendor.post(
  '/api/vendor/reviews/:reviewId/response',
  requireVendor(),
  rateLimit('write'),
  createSubmitReviewResponseHandler(),
);
authVendor.patch(
  '/api/vendor/reviews/:reviewId/response',
  requireVendor(),
  rateLimit('write'),
  createEditReviewResponseHandler(),
);
authVendor.post(
  '/api/vendor/reviews/:reviewId/response/withdraw',
  requireVendor(),
  rateLimit('write'),
  createWithdrawReviewResponseHandler(),
);
// AECI-1005 / ADR 0035: the recorded owner (`built_by_vendor_id`) claims its
// integration, with no approval. A SEAT IS THE WHOLE GATE (decision 15), exactly as
// for contests above: no `requireCapability`. Gate order is `requireVendor()` →
// `rateLimit('write')` → ownership inside the handler (404, never 403, for a row the
// caller cannot see). Once claimed, promote writes nothing to the row.
authVendor.post(
  '/api/vendor/integrations/:id/claim',
  requireVendor(),
  rateLimit('write'),
  createClaimIntegrationHandler(),
);
// AECI-1010: the owner retires and restores its CLAIMED integration. Same gates as the
// claim above: `requireVendor()` → `rateLimit('write')` → ownership, the entitlement on
// a connector-powered row (AECI-1091, either table) and state inside the handler; on an
// ordinary row a seat is the whole gate. Retire hides the row from
// every count, id set and public read (`lib/live-integration.ts`); nothing is deleted.
authVendor.post(
  '/api/vendor/integrations/:id/retire',
  requireVendor(),
  rateLimit('write'),
  createRetireIntegrationHandler(),
);
authVendor.post(
  '/api/vendor/integrations/:id/restore',
  requireVendor(),
  rateLimit('write'),
  createRestoreIntegrationHandler(),
);
// AECI-1006 / ADR 0035: the claimed owner edits the integration's standard fields
// (the eleven contestable content fields), on an `integrations` row or, since
// AECI-1090, a `connector_evidenced_pairs` row. A SEAT IS THE WHOLE GATE (decision
// 15) on an ordinary row, as for the claim above. The named exception (AECI-1040
// ruling 2): a connector-powered row also needs an active entitlement. Gate order:
// `requireVendor()` → `rateLimit('write')` → ownership → entitlement on a
// connector-powered row → claimed, the last three inside the handler
// (`lib/integration-owner-writes.ts`). The GET list above is a different path.
authVendor.patch(
  '/api/vendor/integrations/:id',
  requireVendor(),
  rateLimit('write'),
  createUpdateVendorIntegrationHandler(),
);
// AECI-724 / `STAGE_2_SPEC.md` §8.9(1)–(2): the connector seat edits a mapping on
// its own catalogue. A SEAT IS THE WHOLE GATE: no `requireCapability` and no
// plan read, because the connector seat deliberately holds no license. Ownership of
// the catalogue's connector-role product (404) and `managed_by = 'vendor'` (409) are
// decided in the handler, in that order.
authVendor.patch(
  '/api/vendor/connector-stub-mappings/:id',
  requireVendor(),
  rateLimit('write'),
  createVendorUpdateConnectorStubMappingHandler(),
);
// AECI-1007 / ADR 0035 decision 6: each endpoint vendor sets its OWN listing and
// docs links on an integration. `:productId` is the endpoint the link speaks for,
// never a source/target position. A SEAT IS THE WHOLE GATE (decision 15): no
// `requireCapability`. Side ownership (404) and the connector-powered 403 are
// decided in the handler, in that order. Integration ownership is not required.
authVendor.put(
  '/api/vendor/integrations/:id/links/:productId/:kind',
  requireVendor(),
  rateLimit('write'),
  createPutIntegrationLinkHandler(),
);
authVendor.delete(
  '/api/vendor/integrations/:id/links/:productId/:kind',
  requireVendor(),
  rateLimit('write'),
  createDeleteIntegrationLinkHandler(),
);
// Stage 2 / AECI-664: the OWNER half of seat management, the writes that change
// who can reach this surface. Three gates in order: `requireVendor()`
// (which vendor), `requireSeatOwner()` inside each handler (`profiles.seat_owner`,
// re-read from D1 every request so a demotion lands on the next call), then the
// `vendor_id` filter that is the actual authorization. Deliberately NOT
// capability-gated: seats are not a paid feature, and gating removal on a live
// entitlement would stop a lapsed vendor revoking a departed employee's access
// (§11a).
//
// The invites routes are registered BEFORE `/seats/:userId` so the literal
// `invites` segment can never be parsed as a user id.
// The TWO `by: 'vendor'` routes on this surface, and they are the two that mail.
// Keyed per vendor rather than per seat because the protected resource is
// vendor-SHARED outbound Resend mail — five seats must not buy five times the
// sends. They share one budget deliberately (no `tag:`): splitting it would let
// an owner spend the create bucket and the resend bucket back to back for twice
// the mail. It is the burst layer BENEATH the D1 caps, which no binding can
// express because `simple.period` maxes at 60 s — `INVITE_DAILY_LIMIT` (10 per
// vendor per rolling 24 h) on create, and on resend a per-invite cooldown plus a
// lifetime send cap (`waf-rate-limits.md` §6.2).
authVendor.post(
  '/api/vendor/seats/invites',
  requireVendor(),
  rateLimit('write', { by: 'vendor' }),
  createSeatInviteHandler(getDb, sendSeatInvite),
);
authVendor.post(
  '/api/vendor/seats/invites/:id/resend',
  requireVendor(),
  rateLimit('write', { by: 'vendor' }),
  createResendSeatInviteHandler(getDb, sendSeatInvite),
);
// The `claim-rejected` sender for the owner decline and the Accept guard. Only the
// guard's system reject passes a `reason` (AECI-1420); a decline never does.
const sendSeatClaimRejected: SendSeatClaimDeclinedEmail = (c, o) =>
  sendClaimDecisionEmail(c, {
    decision: 'rejected',
    to: o.to,
    targetName: o.vendorName,
    ...(o.reason ? { reason: o.reason } : {}),
  });
// AECI-1368: the owner's decision on a claim routed to their company
// (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11a.10). Both mail (the seat invite, or the
// claim-rejected), so both take the per-vendor `write` bucket the invite routes
// share, and the invite cap counts an accept's invite. `requireSeatOwner()` runs inside
// each handler. A claim not on this vendor, not routed, or decided is a 404.
// Registered before `/seats/:userId` like the invite routes, so the literal `claims`
// segment is never read as a user id (those are DELETEs, but the order keeps the rule
// one rule).
authVendor.post(
  '/api/vendor/seats/claims/:id/accept',
  requireVendor(),
  rateLimit('write', { by: 'vendor' }),
  // AECI-1420: the Accept guard sends the reasoned `claim-rejected` on an account conflict.
  createAcceptSeatClaimHandler(getDb, sendSeatInvite, sendSeatClaimRejected),
);
authVendor.post(
  '/api/vendor/seats/claims/:id/decline',
  requireVendor(),
  rateLimit('write', { by: 'vendor' }),
  createDeclineSeatClaimHandler(getDb, sendSeatClaimRejected),
);
authVendor.delete(
  '/api/vendor/seats/invites/:id',
  requireVendor(),
  rateLimit('write'),
  createRevokeSeatInviteHandler(),
);
authVendor.delete(
  '/api/vendor/seats/:userId',
  requireVendor(),
  rateLimit('write'),
  createRemoveSeatHandler(),
);
// AECI-1387 (E5.1): the owner's Billing tab read: billing account, every license on
// it with its open early-unassign request, and the products a pool license can go on.
// `requireVendor()`, then `requireSeatOwner()` inside the handler. A read, so no
// `rateLimit()`, and no capability gate (API_CONTRACTS §6.14 invariant 3, the fourth
// named exception).
authVendor.get('/api/vendor/billing', requireVendor(), createVendorBillingHandler());
// AECI-1362 (E2.4): the vendor's agreement acceptances, for the Billing tab (decision 17,
// `VENDOR_SIGNUP_PROCESS.md` §2). The seat-management gate order: `requireVendor()`,
// then `requireSeatOwner()` inside the handler (owner seats only), then the vendor
// filter. A read, so no `rateLimit()`.
authVendor.get(
  '/api/vendor/billing/acceptances',
  requireVendor(),
  createVendorBillingAcceptancesHandler(),
);
// AECI-1389 (E5.3, decision 16): an owner seat sets or clears the billing email. The
// seat-management gate order: `requireVendor()`, the limiter, then `requireSeatOwner()`
// inside the handler. Audit only: no email to the other owners, no cache purge.
authVendor.put(
  '/api/vendor/billing/email',
  requireVendor(),
  rateLimit('write'),
  createUpdateBillingEmailHandler(),
);
// AECI-1501 (E9.3): the owner's Stripe routes. Buy (a Checkout Session), add licenses
// to the live subscription, and open the Customer Portal. The Billing gate order:
// `requireVendor()`, the limiter, then `requireSeatOwner()` and the tier gate (`503
// STRIPE_UNAVAILABLE`) inside each handler. None writes a license: the Stripe webhook
// does.
authVendor.post(
  '/api/vendor/billing/checkout',
  requireVendor(),
  rateLimit('write'),
  createStripeCheckoutHandler(),
);
authVendor.post(
  '/api/vendor/billing/licenses/add',
  requireVendor(),
  rateLimit('write'),
  createAddStripeLicensesHandler(),
);
authVendor.post(
  '/api/vendor/billing/portal',
  // AECI-1623: the one route a suspended vendor's seat may reach (ruling 6).
  requireVendor({ allowSuspended: true }),
  rateLimit('write'),
  createStripePortalHandler(),
);
// AECI-1373 (E4.4, decision 11): an owner seat asks AECi to free a license early. The
// seat-management gate order: `requireVendor()`, the limiter, then `requireSeatOwner()`
// inside the handler. E5 ships the portal button.
authVendor.post(
  '/api/vendor/licenses/:id/release-request',
  requireVendor(),
  rateLimit('write'),
  createVendorLicenseReleaseRequestHandler(),
);
// AECI-1388 (E5.2, §3 step 6 and decision 11): an owner seat puts a pool license on a
// product, and flags a license to free its slot at renewal, through `lib/license.ts`.
// The seat-management gate order: `requireVendor()`, the limiter, then
// `requireSeatOwner()` inside the handler. No capability gate (the fourth named
// exception). The assign purges the product, the products index and the vendor.
authVendor.post(
  '/api/vendor/licenses/:id/assign',
  requireVendor(),
  rateLimit('write'),
  createAssignVendorLicenseHandler(),
);
authVendor.patch(
  '/api/vendor/licenses/:id',
  requireVendor(),
  rateLimit('write'),
  createUpdateVendorLicenseHandler(),
);
// AECI-1417 (E6b.5, ADR 0042): the owner's "Proposed products". The Billing gate order:
// `requireVendor()`, the limiter on the two writes, then `requireSeatOwner()` inside each
// handler. The read is never limited. An accept creates the product exactly as proposed
// and purges what a promote create purges; a decline records the decision only.
authVendor.get('/api/vendor/proposals', requireVendor(), createListVendorProposalsHandler());
authVendor.post(
  '/api/vendor/proposals/:id/accept',
  requireVendor(),
  rateLimit('write'),
  createAcceptVendorProposalHandler(),
);
authVendor.post(
  '/api/vendor/proposals/:id/decline',
  requireVendor(),
  rateLimit('write'),
  createDeclineVendorProposalHandler(),
);
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
// AECI-773: the `token` bucket, keyed by IP — deliberately NOT by the token. The
// token is the attacker-controlled value, so a per-token key hands every guess
// its own fresh budget, i.e. no limit at all. Keying by IP is what makes a grind
// cost something and makes it visible.
//
// The GET above is NOT limited, and this is the one place that tension is real:
// it is the cheaper enumeration oracle of the pair. Reads stay unlimited anyway,
// because the value of that invariant is that it has no exceptions to reason
// about, and the token it guards is a 122-bit `crypto.randomUUID()` that no
// achievable request rate meaningfully erodes. A grinder is visible by its 404
// rate; make that observable rather than carving the rule.
authSeatInvites.post(
  '/api/seat-invites/:token/accept',
  requireAuth(),
  rateLimit('token', { by: 'ip' }),
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

// The API Worker exports `scheduled` and `queue` handlers alongside its Hono
// `fetch`. The explicit arrow wrapper (not a bare `app.fetch` reference) keeps
// Hono's request handling intact. Cron triggers and queue bindings are registered
// per env in `wrangler.jsonc` (staging, demo and production). The cron
// `scheduled` handler enqueues a job or runs it inline, and the `queue` consumer
// runs queued ones (ADR 0013, `src/scheduled.ts`).
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled,
  queue,
};

// The promote ingest Workflow (AECI-563 / ADR 0021). Wrangler resolves a Workflow's
// `class_name` off the Worker's MAIN module, so the class must be re-exported here —
// the `workflows` binding block in `wrangler.jsonc` alone is not enough.
export { PromoteWorkflow } from './workflows/promote-workflow';

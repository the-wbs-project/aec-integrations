import { CategoryDetailSchema, AudienceDetailSchema, PhaseDetailSchema } from '@aeci/shared';
import { Hono } from 'hono';

import type { Env } from './env';
import { ApiError, errorHandler } from './errors';
import { requireReviewAppAuth } from './lib/review-auth';
import { metricsMiddleware } from './metrics-middleware';
import { createCategoriesListHandler } from './routes/categories';
import { createHealthHandler } from './routes/health';
import {
  createIntegrationDetailHandler,
  createIntegrationsListHandler,
} from './routes/integrations';
import { createPageViewsHandler } from './routes/page-views';
import { createProductDetailHandler, createProductsListHandler } from './routes/products';
import { createPromoteHandler } from './routes/promote';
import { createClaimSubmitHandler, createCorrectionSubmitHandler } from './routes/requests';
import { createTaxonomyHandler } from './routes/taxonomy';
import { createTaxonomyDetailHandler } from './routes/taxonomy-detail';
import { createVendorDetailHandler, createVendorsListHandler } from './routes/vendors';
import { createVersionHandler } from './routes/version';

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
phase28.get('/api/products/:slug', createProductDetailHandler());

phase28.get('/api/vendors', createVendorsListHandler());
phase28.get('/api/vendors/:slug', createVendorDetailHandler());

phase28.get('/api/integrations', createIntegrationsListHandler());
phase28.get('/api/integrations/:id', createIntegrationDetailHandler());

phase28.get('/api/categories', createCategoriesListHandler());
phase28.get(
  '/api/categories/:slug',
  createTaxonomyDetailHandler({
    delegate: (p) => p.taxonomyCategory,
    relationKey: 'productCategories',
    resource: 'category',
    schema: CategoryDetailSchema,
  }),
);
phase28.get(
  '/api/audiences/:slug',
  createTaxonomyDetailHandler({
    delegate: (p) => p.taxonomyAudience,
    relationKey: 'productAudiences',
    resource: 'audience',
    schema: AudienceDetailSchema,
  }),
);
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

// Vendor requests (AECI-128) — claim & correction form submissions. Public (no
// auth until Phase 5); insert into `vendor_requests` with an audit row. The
// Phase 6 moderation pipeline (n8n/Linear/admin, including duplicate detection)
// is out of scope — see `routes/requests.ts`.
phase28.post('/api/requests/correction', createCorrectionSubmitHandler());
phase28.post('/api/requests/claim', createClaimSubmitHandler());

// Review-app push endpoint (promotion). Bearer-auth middleware runs first so an
// unauthenticated request never reaches the DB; both it and the handler throw
// `ApiError`/`ZodError`, which `errorHandler()` renders as the canonical
// envelope. See `docs/REVIEW_APP_PROMOTE_API.md`.
phase28.post('/api/promote', requireReviewAppAuth(), createPromoteHandler());

app.route('/', phase28);

// Catch-alls throw so the root `onError` renders the canonical §3.3 envelope
// (AECI-101) — an unmatched `/api/*` route parses with `ApiErrorSchema` too.
app.all('/api/*', () => {
  throw new ApiError(404, 'NOT_FOUND', 'API route not found');
});
app.all('*', () => {
  throw new ApiError(404, 'NOT_FOUND', 'Route not found');
});

export default app;

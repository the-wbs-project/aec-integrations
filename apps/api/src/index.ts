import { Hono } from 'hono';

import type { Env } from './env';
import { errorHandler } from './errors';
import { notFound } from './http';
import { requireReviewAppAuth } from './lib/review-auth';
import { metricsMiddleware } from './metrics-middleware';
import { createCategoriesListHandler, createCategoryDetailHandler } from './routes/categories';
import { createDisciplineDetailHandler } from './routes/disciplines';
import { createHealthHandler } from './routes/health';
import {
  createIntegrationDetailHandler,
  createIntegrationsListHandler,
} from './routes/integrations';
import { createPageViewsHandler } from './routes/page-views';
import { createPhaseDetailHandler } from './routes/phases';
import { createProductDetailHandler, createProductsListHandler } from './routes/products';
import { createPromoteHandler } from './routes/promote';
import { createTaxonomyHandler } from './routes/taxonomy';
import { createVendorDetailHandler, createVendorsListHandler } from './routes/vendors';
import { createVersionHandler } from './routes/version';

const app = new Hono<{ Bindings: Env }>();

// AECI-66 / Phase 2 §14 — time every request and emit
// `aeci.api.query.duration_ms` tagged by endpoint + status. Registered first so
// it wraps the legacy routes, the Phase 2.8 sub-router, and the `*` fallthrough.
app.use('*', metricsMiddleware());

// Legacy routes (predating Phase 2.8). Keep their existing error shape via the
// `apps/api/src/http.ts` helpers — migrating them to the canonical §3.3
// envelope is a follow-up cleanup ticket, intentionally out of scope for AECI-54.
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
phase28.get('/api/categories/:slug', createCategoryDetailHandler());

phase28.get('/api/disciplines/:slug', createDisciplineDetailHandler());
phase28.get('/api/phases/:slug', createPhaseDetailHandler());

phase28.get('/api/taxonomy', createTaxonomyHandler());

// Review-app push endpoint (promotion). Bearer-auth middleware runs first so an
// unauthenticated request never reaches the DB; both it and the handler throw
// `ApiError`/`ZodError`, which `errorHandler()` renders as the canonical
// envelope. See `docs/REVIEW_APP_PROMOTE_API.md`.
phase28.post('/api/promote', requireReviewAppAuth(), createPromoteHandler());

app.route('/', phase28);

app.all('/api/*', () => notFound('API route not found'));
app.all('*', () => notFound());

export default app;

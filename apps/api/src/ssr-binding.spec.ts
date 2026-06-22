/**
 * SSR Worker → API Worker service-binding round-trip (AECI-54 AC), on the
 * Drizzle/D1 path (ADR 0016 / AECI-253).
 *
 * Why this lives in apps/api rather than apps/web:
 *   - The contract under test is the API Worker's wire format, not the SSR
 *     client. Owning the test here keeps API changes from breaking SSR specs.
 *   - We don't import `createServerApiClient` from apps/web (no cross-app
 *     imports in the build). Instead we replicate the relevant wire behaviour:
 *     wrap a Hono app as a `Fetcher`, dispatch a `Request` whose URL host is the
 *     SSR client's `https://api` placeholder, and parse the response.
 *
 * The dispatched URL (`https://api/api/products/procore`) matches the form
 * documented in `docs/STAGE_1_SPEC.md` §6.2 and `docs/API_CONTRACTS.md` §8.3 and
 * asserted in `apps/web/src/server-api-client.spec.ts`.
 *
 * DB-touching routes run the REAL handlers against the in-memory D1 harness
 * (`makeTestDb`); the error-envelope routes (page-views 400, unmatched 404) boot
 * the real `app` from `index.ts`, which needs no DB on those paths.
 */

import { ApiErrorSchema, ProductDetailSchema } from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { products, productVendors, vendors } from './db/schema';
import type { Env } from './env';
import { errorHandler } from './errors';
import app from './index';
import { createIntegrationDetailHandler } from './routes/integrations';
import { createProductDetailHandler } from './routes/products';
import { makeTestDb, type TestDb } from './test/d1';
import { fakeExecutionContext, TEST_ENV } from './test/helpers';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

/**
 * A `Fetcher` over a Hono app that mounts the DB-touching read handlers wired to
 * the harness — the same shape Cloudflare passes via `env.API` in production. The
 * `https://api/...` host is preserved on the dispatched request (Hono routes by
 * pathname), so the SSR-client URL shape is exercised.
 */
function harnessFetcher(): Fetcher {
  const inner = new Hono<{ Bindings: Env }>();
  inner.onError(errorHandler());
  inner.get('/api/products/:slug', createProductDetailHandler(t.factory));
  inner.get('/api/integrations/:id', createIntegrationDetailHandler(t.factory));
  return {
    fetch: ((request: Request | string | URL) =>
      inner.fetch(request as Request, TEST_ENV, fakeExecutionContext())) as Fetcher['fetch'],
  } as Fetcher;
}

/** A `Fetcher` over the REAL `app` (index.ts). Used for the error-envelope routes
 *  that never touch the DB. */
function realAppFetcher(): Fetcher {
  return {
    fetch: ((request: Request | string | URL) =>
      app.fetch(request as Request, TEST_ENV, fakeExecutionContext())) as Fetcher['fetch'],
  } as Fetcher;
}

describe('SSR Worker → API Worker service binding round-trip', () => {
  it('returns a schema-valid ProductDetail when called via env.API.fetch(...)', async () => {
    await t.db
      .insert(vendors)
      .values({ id: '00000000-0000-4000-8000-0000000000a1', slug: 'procore', companyName: 'Procore' });
    await t.db
      .insert(products)
      .values({ id: '00000000-0000-4000-8000-0000000000b1', slug: 'procore', name: 'Procore' });
    await t.db.insert(productVendors).values({
      productId: '00000000-0000-4000-8000-0000000000b1',
      vendorId: '00000000-0000-4000-8000-0000000000a1',
      isPrimary: true,
    });

    const env = { API: harnessFetcher() };
    const response = await env.API.fetch(new Request('https://api/api/products/procore'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const parsed = ProductDetailSchema.parse(await response.json());
    expect(parsed.slug).toBe('procore');
    expect(parsed.vendor?.slug).toBe('procore');
  });

  it('returns the canonical ApiError envelope on a 404 (parseable by ApiErrorSchema)', async () => {
    const env = { API: harnessFetcher() };
    // Nothing seeded → a missing integration 404s with the canonical envelope.
    const response = await env.API.fetch(
      new Request('https://api/api/integrations/00000000-0000-4000-8000-000000999999'),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const parsed = ApiErrorSchema.parse(await response.json());
    expect(parsed.error.code).toBe('NOT_FOUND');
    expect(parsed.trace_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('returns the canonical ApiError envelope on a page-views 400 (AECI-101)', async () => {
    // The legacy `/api/page-views` route is mounted on the root app, which
    // registers `onError(errorHandler())`. A bad body must come back as the
    // canonical envelope so an SSR caller's `ApiErrorSchema.safeParse` succeeds.
    // Validation fails before any DB write, so the real app needs no DB here.
    const request = new Request('https://api/api/page-views', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}), // missing required `route`
    });
    const response = await realAppFetcher().fetch(request);

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const parsed = ApiErrorSchema.parse(await response.json());
    expect(parsed.error.code).toBe('VALIDATION_FAILED');
    expect(parsed.error.field).toBe('route');
    expect(parsed.trace_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('returns the canonical ApiError envelope on an unmatched /api route 404 (AECI-101)', async () => {
    // The root `*` catch-all throws `ApiError(404, NOT_FOUND)` so an unknown
    // `/api/*` path also parses with `ApiErrorSchema`.
    const response = await realAppFetcher().fetch(new Request('https://api/api/does-not-exist'));

    expect(response.status).toBe(404);
    const parsed = ApiErrorSchema.parse(await response.json());
    expect(parsed.error.code).toBe('NOT_FOUND');
    expect(parsed.trace_id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

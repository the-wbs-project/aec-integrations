/**
 * SSR Worker → API Worker → mocked Prisma round-trip (AECI-54 AC).
 *
 * Why this lives in apps/api rather than apps/web:
 *   - The contract under test is the API Worker's wire format, not the SSR
 *     client. Owning the test here keeps API changes from breaking SSR specs
 *     and vice versa.
 *   - We don't import `createServerApiClient` from apps/web (no cross-app
 *     imports in the build). Instead we replicate the relevant wire behaviour:
 *     wrap our Hono app as a `Fetcher`, dispatch a `Request` whose URL host
 *     is the SSR client's `https://api` placeholder, parse the response.
 *
 * The dispatched URL (`https://api/api/products/procore`) matches the form
 * documented in `docs/STAGE_1_SPEC.md` §6.2 and `docs/API_CONTRACTS.md` §8.3
 * and asserted in `apps/web/src/server-api-client.spec.ts`.
 */

import { ApiErrorSchema, ProductDetailSchema } from '@aeci/shared';
import { describe, expect, it, vi } from 'vitest';

import app from './index';
import type { Env } from './env';
import { fakeExecutionContext } from './test/helpers';
import { procoreProductDetailRow, reviztoProductRow } from './test/fixtures/products';

const TEST_ENV: Env = { DATABASE_URL: 'prisma://test', ENV: 'preview' };

/**
 * Build a `Fetcher` that hands requests to the Hono app under test. Mirrors
 * the shape Cloudflare passes via `env.API` in production. Prisma is mocked
 * at the module level so the round-trip doesn't reach a real DB.
 */
function fetcherForApp(): Fetcher {
  return {
    fetch: ((request: Request | string | URL, _init?: RequestInit) => {
      // Hono accepts (request, env, ctx); pass our TEST_ENV explicitly.
      return app.fetch(request as Request, TEST_ENV, fakeExecutionContext());
    }) as Fetcher['fetch'],
  } as Fetcher;
}

vi.mock('./prisma', () => {
  return {
    getPrisma: () => ({
      product: {
        findUnique: vi.fn(async () => procoreProductDetailRow),
        findMany: vi.fn(async () => [reviztoProductRow]),
        count: vi.fn(async () => 1),
      },
      vendor: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        count: vi.fn(async () => 0),
      },
      integration: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        count: vi.fn(async () => 0),
      },
      taxonomyCategory: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        count: vi.fn(async () => 0),
      },
      taxonomyDiscipline: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        count: vi.fn(async () => 0),
      },
      taxonomyPhase: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        count: vi.fn(async () => 0),
      },
    }),
  };
});

describe('SSR Worker → API Worker service binding round-trip', () => {
  it('returns a schema-valid ProductDetail when called via env.API.fetch(...)', async () => {
    const env = { API: fetcherForApp() };
    const request = new Request('https://api/api/products/procore');
    const response = await env.API.fetch(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await response.json();
    const parsed = ProductDetailSchema.parse(body);
    expect(parsed.slug).toBe('procore');
    expect(parsed.vendor?.slug).toBe('procore');
    expect(parsed.related_products.map((p) => p.slug)).toEqual(['revizto']);
  });

  it('returns the canonical ApiError envelope on 404 (parseable by ApiErrorSchema)', async () => {
    const env = { API: fetcherForApp() };
    // Override the product.findUnique mock to return null for this request.
    const realFetcher = fetcherForApp();
    const interceptingFetcher: Fetcher = {
      fetch: realFetcher.fetch,
    } as Fetcher;
    // The default mock returns the seeded row regardless of slug — to simulate
    // a miss without restructuring the module mock, request a different shape
    // via a deliberately-unknown UUID path on the integrations endpoint, which
    // returns null and 404s.
    const request = new Request(
      'https://api/api/integrations/00000000-0000-4000-8000-000000999999',
    );
    const response = await interceptingFetcher.fetch(request);

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await response.json();
    const parsed = ApiErrorSchema.parse(body);
    expect(parsed.error.code).toBe('NOT_FOUND');
    expect(parsed.trace_id).toMatch(/^[0-9a-f-]{36}$/i);
    // Silence unused var.
    void env;
  });

  it('returns the canonical ApiError envelope on a page-views 400 (AECI-101)', async () => {
    // The legacy `/api/page-views` route is mounted on the root app, which now
    // registers `onError(errorHandler())`. A bad body must come back as the
    // canonical envelope so an SSR caller's `ApiErrorSchema.safeParse` succeeds.
    const request = new Request('https://api/api/page-views', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}), // missing required `route`
    });
    const response = await fetcherForApp().fetch(request);

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const parsed = ApiErrorSchema.parse(await response.json());
    expect(parsed.error.code).toBe('VALIDATION_FAILED');
    expect(parsed.error.field).toBe('route');
    expect(parsed.trace_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('returns the canonical ApiError envelope on an unmatched /api route 404 (AECI-101)', async () => {
    // The root `*` catch-all now throws `ApiError(404, NOT_FOUND)` so an unknown
    // `/api/*` path also parses with `ApiErrorSchema`.
    const request = new Request('https://api/api/does-not-exist');
    const response = await fetcherForApp().fetch(request);

    expect(response.status).toBe(404);
    const parsed = ApiErrorSchema.parse(await response.json());
    expect(parsed.error.code).toBe('NOT_FOUND');
    expect(parsed.trace_id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

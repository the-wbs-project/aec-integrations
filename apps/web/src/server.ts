/**
 * Cloudflare Worker entry for the AEC Integrations web app.
 *
 * Hono dispatches `/api/*` routes; everything else falls through to Angular
 * SSR via `@angular/ssr`. The `API` binding is the private API Worker — see
 * `wrangler.jsonc` and `server-api-client.ts`. Edge cache, KV, and
 * cookie-stripping middleware land in subsequent issues.
 */

import { AngularAppEngine, createRequestHandler } from '@angular/ssr';
import { Hono } from 'hono';

import type { ApiError } from '@aeci/shared';

import {
  ServerApiError,
  createServerApiClient,
} from './server-api-client';

// Re-exported until SSR data loaders begin parsing API responses against the
// shared envelope (Phase 2). Importing the type here also verifies the
// `@aeci/shared` workspace dependency resolves through Angular's strict
// TypeScript compilation pipeline.
export type { ApiError };

export type Bindings = {
  ASSETS: Fetcher;
  API: Fetcher;
};

const angularApp = new AngularAppEngine({
  allowedHosts: ['localhost', '127.0.0.1'],
});

const angularHandler = createRequestHandler(async (req) => {
  const res = await angularApp.handle(req);
  return res ?? new Response('Page not found.', { status: 404 });
});

const app = new Hono<{ Bindings: Bindings }>();

// Proxies the private API Worker's health endpoint through the service
// binding. Real callers in Phase 2 use `createServerApiClient(env)` from
// SSR data loaders; this route exists so the binding is exercised end-to-end
// from a public surface (AECI-30 acceptance criterion).
app.get('/api/health', async (c) => {
  const api = createServerApiClient(c.env);
  try {
    const body = await api.request<unknown>('/api/health');
    return c.json(body as Record<string, unknown>);
  } catch (error) {
    if (error instanceof ServerApiError) {
      return c.json(
        {
          ok: false,
          source: 'api-binding',
          status: error.status,
          code: error.code,
          message: error.message,
        },
        { status: 502 },
      );
    }
    throw error;
  }
});

// Anything not matched by an explicit Hono route falls through to Angular SSR.
app.all('*', async (c) => {
  return (
    (await angularHandler(c.req.raw)) ??
    new Response('Page not found.', { status: 404 })
  );
});

export default app;

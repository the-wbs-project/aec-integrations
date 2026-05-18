/**
 * Cloudflare Worker entry for the AEC Integrations web app.
 *
 * Thin shim: constructs the Angular SSR renderer and hands it to the
 * Angular-free runtime in `./server-runtime`. All routing, classification,
 * cookie hygiene, cache integration, and the `/api/*` service-binding
 * passthrough live in `server-runtime.ts` so they can be unit-tested under
 * plain-Node Vitest without booting Angular.
 *
 * See `server-runtime.ts` for the route-classification matrix and the §9.1 /
 * §9.1a / §9.1b / §7a.3 contracts this Worker enforces.
 */

import { AngularAppEngine, createRequestHandler } from '@angular/ssr';

import type { ApiError } from '@aeci/shared';

import { createApp, type SsrRenderer } from './server-runtime';

// Re-exported until SSR data loaders begin parsing API responses against the
// shared envelope (Phase 2). Importing the type here also verifies the
// `@aeci/shared` workspace dependency resolves through Angular's strict
// TypeScript compilation pipeline.
export type { ApiError };

export type { Bindings } from './server-runtime';

const angularApp = new AngularAppEngine({
  allowedHosts: ['localhost', '127.0.0.1'],
});

const angularHandler = createRequestHandler(async (req) => {
  const res = await angularApp.handle(req);
  return res ?? new Response('Page not found.', { status: 404 });
});

const angularRenderer: SsrRenderer = async (request) => {
  const res = await angularHandler(request);
  return res ?? new Response('Page not found.', { status: 404 });
};

const app = createApp({ ssrRenderer: angularRenderer });
export default app;

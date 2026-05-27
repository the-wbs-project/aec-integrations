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

import { AngularAppEngine } from '@angular/ssr';

import type { ApiError } from '@aeci/shared';

import { injectDatadogBootstrap } from './server-bootstrap-inject';
import { logToDatadog } from './server-datadog';
import { createApp, type SsrRenderer } from './server-runtime';

// Re-exported until SSR data loaders begin parsing API responses against the
// shared envelope (Phase 2). Importing the type here also verifies the
// `@aeci/shared` workspace dependency resolves through Angular's strict
// TypeScript compilation pipeline.
export type { ApiError };

export type { Bindings } from './server-runtime';

// `AngularAppEngine` is a module-scope singleton per Angular's docs
// ("should be instantiated once and used as a singleton across the
// server-side application"). Per-request env-driven `allowedHosts` is
// therefore not an option — Cloudflare's `env` binding is only available
// inside `fetch`. The hostname allowlist instead lives in
// `apps/web/angular.json` at `projects.web.architect.build.options.security.allowedHosts`,
// where Angular baked it into the build manifest. That list covers:
//   - `localhost`, `127.0.0.1`               (local dev)
//   - `*.workers.dev`                        (`workers_dev: true` preview deploys)
//   - `aecintegrations.com`                  (production custom domain — Phase 7)
//   - `*.aecintegrations.com`                (future `www.` / `staging.`)
// See AECI-42 for the cutover context. Keep this list and `wrangler.jsonc`
// routes in sync.
const angularApp = new AngularAppEngine();

// Note: we bypass `createRequestHandler` (which wraps a `(req) => ...`
// handler) because we need to forward the runtime's per-request
// `AeciRequestContext` as the second arg to `angularApp.handle(req, ctx)` —
// `@angular/ssr` v21 wires that arg into DI as `REQUEST_CONTEXT` whenever
// `RenderMode.Server` is in effect (see `@angular/ssr/fesm2022/ssr.mjs:1270`).
// Resolvers retrieve it with `inject(REQUEST_CONTEXT)`.
const angularRenderer: SsrRenderer = async (request, ctx) => {
  const res = await angularApp.handle(request, ctx);
  return res ?? new Response('Page not found.', { status: 404 });
};

const app = createApp({
  ssrRenderer: angularRenderer,
  transformResponse: async (res, env, request, ctx) => {
    const injected = await injectDatadogBootstrap(res, env);
    // Smoke signal: every SSR render emits a Datadog log so we can verify
    // the API↔Worker↔Datadog pipe end-to-end without instrumenting feature
    // code. Dev volume is tiny; tighten or sample in Phase 2 if needed.
    const { pathname, search } = new URL(request.url);
    logToDatadog(ctx, env, request, {
      message: 'ssr.render',
      path: pathname,
      query: search || undefined,
      method: request.method,
      status: injected.status,
    });
    return injected;
  },
});
export default app;

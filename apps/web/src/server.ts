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

import { injectAlgoliaBootstrap } from './algolia-bootstrap-inject';
import { injectDatadogBootstrap } from './server-bootstrap-inject';
import { logToDatadog, shouldEmitRenderLog } from './server-datadog';
import { injectHtmlLangDir } from './server-html-dir-inject';
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
//   - `aecintegrations.com`                  (landing apex; the web app uses demo.)
//   - `*.aecintegrations.com`                (web prod `demo.`, plus `staging.`)
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
    // Chain the bootstrap injections: Algolia operates on the DD-injected
    // response so both `<script>` tags land before `</head>`. Each is a no-op
    // when its public config is absent (AECI-31 / AECI-134).
    const ddInjected = await injectDatadogBootstrap(res, env);
    const algoliaInjected = await injectAlgoliaBootstrap(ddInjected, env);
    // Rewrite `<html lang/dir>` from the request's locale prefix (AECI-153).
    // No-op on the shipping en-US LTR path (matches the index.html default);
    // only a non-default/RTL locale pays a body pass. `request` is the source
    // of the locale. Cache-safe — `dir`/`lang` are URL-derived (§7a.3a).
    const injected = await injectHtmlLangDir(algoliaInjected, request);
    // Pipe-health/error smoke signal. The per-render *volume* signal lives in
    // the bounded `aeci.ssr.render` count metric (server-runtime.ts); this log
    // is gated by `shouldEmitRenderLog` to errors (every env) + all non-prod
    // renders, so prod 2xx traffic doesn't flood the logs intake (AECI-103).
    if (shouldEmitRenderLog(env, injected.status)) {
      const { pathname, search } = new URL(request.url);
      logToDatadog(ctx, env, request, {
        message: 'ssr.render',
        path: pathname,
        query: search || undefined,
        method: request.method,
        status: injected.status,
      });
    }
    return injected;
  },
});
export default app;

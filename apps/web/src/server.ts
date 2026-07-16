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
// `#cloudflare-workers` (this package's `imports` map) resolves to the real
// `cloudflare:workers` for wrangler/workerd but to a Node stub during Angular's
// route extraction, which runs this bundle in plain Node (the `cloudflare:`
// scheme is unloadable there). See `cloudflare-workers.stub.mjs` / ADR 0020 §2.
import { WorkerEntrypoint } from '#cloudflare-workers';

import type { ApiError } from '@aeci/shared';

import { injectAlgoliaBootstrap } from './algolia-bootstrap-inject';
import { injectPostHogBootstrap } from './posthog-bootstrap-inject';
import { injectDatadogBootstrap } from './server-bootstrap-inject';
import { logToDatadog, shouldEmitRenderLog } from './server-datadog';
import { injectHtmlLangDir } from './server-html-dir-inject';
import { cacheGateway, createApp, type Bindings, type SsrRenderer } from './server-runtime';
import { injectSupabaseBootstrap } from './supabase-bootstrap-inject';

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
    // Chain the bootstrap injections: each operates on the previous one's
    // output so all `<script>` tags land before `</head>`. Each is a no-op
    // when its public config is absent (AECI-31 / AECI-134 / AECI-194 / AECI-239).
    const ddInjected = await injectDatadogBootstrap(res, env);
    const algoliaInjected = await injectAlgoliaBootstrap(ddInjected, env);
    const supabaseInjected = await injectSupabaseBootstrap(algoliaInjected, env);
    const posthogInjected = await injectPostHogBootstrap(supabaseInjected, env);
    // Rewrite `<html lang/dir>` from the request's locale prefix (AECI-153).
    // No-op on the shipping en-US LTR path (matches the index.html default);
    // only a non-default/RTL locale pays a body pass. `request` is the source
    // of the locale. Cache-safe — `dir`/`lang` are URL-derived (§7a.3a).
    const injected = await injectHtmlLangDir(posthogInjected, request);
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

/**
 * Cached SSR entrypoint (WC-4 / AECI-318). Native Workers Cache sits *in front
 * of* this entrypoint (`exports.Renderer.cache.enabled: true`, per env in
 * `apps/web/wrangler.jsonc`), so a HIT skips the render. It simply delegates to
 * the Hono `app` — all routing, `/api/*` passthrough, auth gates, cookie
 * hygiene, SSR render, and `Cache-Control`/`Cache-Tag` emission are unchanged.
 * The gateway (`cacheGateway`, the default export) reaches it through the
 * `ctx.exports` loopback with a normalized `cf.cacheKey`. Forwarding
 * `this.env`/`this.ctx` keeps Hono's `waitUntil` (Datadog forwards, page-views)
 * working within this entrypoint's lifetime.
 */
export class Renderer extends WorkerEntrypoint<Bindings> {
  override fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }
}

// The default export is the cache-key-normalizing gateway (its own cache is
// disabled so it runs on every request); it forwards to `Renderer` above. See
// `cacheGateway` in `server-runtime.ts` and ADR 0020 §2.
export default cacheGateway;

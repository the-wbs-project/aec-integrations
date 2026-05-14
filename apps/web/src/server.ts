/**
 * Cloudflare Worker entry for the AEC Integrations web app.
 *
 * Hono dispatches `/api/*` routes; everything else falls through to Angular
 * SSR via `@angular/ssr`. Edge cache, KV, cookie-stripping middleware, and
 * the private API Worker (service binding) all land in subsequent issues.
 */

import { AngularAppEngine, createRequestHandler } from '@angular/ssr';
import { Hono } from 'hono';

export type Bindings = {
  ASSETS: Fetcher;
};

const angularApp = new AngularAppEngine({
  allowedHosts: ['localhost', '127.0.0.1'],
});

const angularHandler = createRequestHandler(async (req) => {
  const res = await angularApp.handle(req);
  return res ?? new Response('Page not found.', { status: 404 });
});

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/health', (c) => c.json({ ok: true }));

// Anything not matched by an explicit Hono route falls through to Angular SSR.
app.all('*', async (c) => {
  return (
    (await angularHandler(c.req.raw)) ??
    new Response('Page not found.', { status: 404 })
  );
});

export default app;

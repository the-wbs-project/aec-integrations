// ---------------------------------------------------------------------------
// Cloudflare Worker entry — Hono app that serves the API and Angular SPA.
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import health from './routes/health';
import meta from './routes/meta';
import tools from './routes/tools';
import vendors from './routes/vendors';

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// CORS — allow any origin for the API routes during development.
// Tighten `origin` in production if needed.
// ---------------------------------------------------------------------------
app.use('/api/*', cors());

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.route('/api/health', health);
app.route('/api/meta', meta);
app.route('/api/tools', tools);
app.route('/api/vendors', vendors);

// ---------------------------------------------------------------------------
// Static assets + SPA fallback
// ---------------------------------------------------------------------------
// For any non-API request, try to serve a static asset first.
// If the asset binding returns a 404, serve index.html so Angular's
// client-side router can handle the route.
// ---------------------------------------------------------------------------
app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);

  if (res.status === 404) {
    // SPA fallback — rewrite to /index.html
    const fallbackUrl = new URL('/index.html', c.req.url);
    const fallbackReq = new Request(fallbackUrl.toString(), c.req.raw);
    return c.env.ASSETS.fetch(fallbackReq);
  }

  return res;
});

export default app;

// ---------------------------------------------------------------------------
// Cloudflare Worker entry — Hono app for the API + Angular SPA, plus the
// WorkflowRun Durable Object class export.
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env';
import health from './routes/health';
import tools from './routes/tools';
import workflows from './routes/workflows';

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());

app.route('/api/health', health);
app.route('/api/tools', tools);
app.route('/api/workflows', workflows);

// ---------------------------------------------------------------------------
// Static assets + SPA fallback. Wrangler's `not_found_handling: "single-page-application"`
// already rewrites missing routes to index.html, so this is just a passthrough
// to the ASSETS binding.
// ---------------------------------------------------------------------------
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export { WorkflowRun } from './durable-objects/WorkflowRun';
export default app;

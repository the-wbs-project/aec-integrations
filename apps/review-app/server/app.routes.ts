// ---------------------------------------------------------------------------
// Cloudflare Worker entry — Hono app for the API + Angular SPA, plus the
// per-workflow WorkflowEntrypoint class exports.
//
// Wires:
//   • Data API (vendors / tools / meta / health)
//   • Workflow API (list / options / run / status / recent runs)
//   • Reports API (ad-hoc weekly cost report enqueue)
//   • Debug API (SERP / page render — moved off /api/tools to avoid clashing
//     with the data CRUD route)
//   • Weekly cost report:
//       cron trigger → enqueue a job onto REPORTS_QUEUE
//       queue consumer → run the report (cron + ad-hoc HTTP both flow through here)
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env';
import { requireAuth, verifyAccessToken, type AuthVariables } from './middleware/auth';
import health from './routes/health';
import meta from './routes/meta';
import stats from './routes/stats';
import products from './routes/products';
import integrations from './routes/integrations';
import vendors from './routes/vendors';
import workflows from './routes/workflows';
import reports from './routes/reports';
import productsDebug from './routes/products-debug';

// Hosts allowed to open the runs WebSocket. Match by hostname (not full
// origin) so http/https + ports + the workers.dev preview all work without
// having to enumerate every variant. wrangler dev simulates the production
// custom domain, so http://review.aecintegrations.com shows up locally.
const WS_ALLOWED_HOSTS = new Set(['review.aecintegrations.com']);
const WORKERS_DEV_HOST = /^[\w-]+\.workers\.dev$/;

function isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return true; // non-browser callers (curl, server-to-server)
    let host: string;
    let hostname: string;
    try {
        const u = new URL(origin);
        host = u.host;
        hostname = u.hostname;
    } catch {
        return false;
    }
    if (WS_ALLOWED_HOSTS.has(hostname)) return true;
    if (WORKERS_DEV_HOST.test(host)) return true;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    return false;
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use('/api/*', cors());

// Public probes — must be reachable without a token. Mounted before requireAuth.
app.route('/api/health', health);

// Live run feed — single WebSocket forwarded to the singleton RunsHub DO.
// Browsers can't set Authorization headers on WebSocket upgrades, so the
// token is passed as a `?token=` query param and verified inline here.
// Mounted BEFORE the global requireAuth so the header-based check doesn't
// reject WS upgrades that authenticate via query param instead.
app.get('/api/runs/ws', async (c) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
        return c.text('Expected websocket', 426);
    }
    const origin = c.req.header('origin');
    if (!isAllowedOrigin(origin)) {
        return c.text(`Origin not allowed: ${origin}`, 403);
    }
    const url = new URL(c.req.raw.url);
    const token = url.searchParams.get('token');
    const user = await verifyAccessToken(token, c.env);
    if (!user) {
        return c.text('Unauthenticated', 401);
    }
    const id = c.env.RUNS_HUB.idFromName('singleton');
    const stub = c.env.RUNS_HUB.get(id);
    const forward = new URL('https://runs-hub.internal/ws');
    forward.searchParams.set('channel', url.searchParams.get('channel') ?? 'recent');
    const runId = url.searchParams.get('runId');
    if (runId) forward.searchParams.set('runId', runId);
    return stub.fetch(forward.toString(), c.req.raw);
});

// Everything below requires a valid Supabase access token.
app.use('/api/*', requireAuth());

// Data
app.route('/api/meta', meta);
app.route('/api/products', products);
app.route('/api/integrations', integrations);
app.route('/api/vendors', vendors);
app.route('/api/stats', stats);

// Workflow orchestration
app.route('/api/workflows', workflows);
app.route('/api/reports', reports);

// Debug helpers (SERP / page render)
app.route('/api/debug', productsDebug);

// SPA fallback — wrangler's `not_found_handling: "single-page-application"`
// rewrites missing routes to index.html, so this is just a passthrough.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export const APP_ROUTES = app.fetch;
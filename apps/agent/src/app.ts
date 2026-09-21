import { env } from 'cloudflare:workers';
import { setProvider } from '@flue/runtime';
import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';

// The internal test chat page, inlined into the bundle at build time. Serving it
// from the Worker rather than from a Cloudflare `assets` binding is deliberate:
// assets are served AHEAD of the Worker, which would put an ungated page on a
// Worker whose whole point is that nothing on it is public. `vite.config.ts`
// sets `publicDir: false` so this file has exactly one delivery path.
import chatPage from '../public/index.html?raw';
import { requireAccess, type AccessVariables } from './access';
import { Catalog, CatalogClaude } from './agents/catalog';
import type { Env } from './env';
import { reindexRoutes } from './routes/reindex';

/**
 * The AI Gateway every model call from this Worker routes through.
 *
 * ── WHY IT IS PINNED, AND WHY HERE ──────────────────────────────────────────
 * Flue's `cloudflare` provider omits `gateway` by default, which routes through
 * Cloudflare's ACCOUNT-DEFAULT gateway — shared with everything else on the
 * account. Pinning a named gateway isolates this spike's traffic in AI Gateway
 * analytics and logs, which is the whole reason it is named after the spike.
 *
 * The provider's `gateway` option is tri-state: omitted means the default
 * gateway, an options object replaces it, and `false` bypasses the gateway
 * entirely. We pass an options object.
 *
 * **One constant, one registration.** `setProvider()` is module-scope and
 * process-wide, so this covers BOTH agents — the id is not repeated in
 * `agents/catalog.ts`, and adding a third agent inherits it. A user
 * registration wins over the generated worker entry's, which is why this must
 * live in `app.ts` rather than in an agent module.
 *
 * It rides the EXISTING `AI` binding. No new binding, no secret: AI Gateway
 * authenticates the Anthropic leg against Cloudflare Unified Billing credits.
 *
 * A plain constant rather than a var, deliberately: an unset var would silently
 * fall back to the default gateway, which is exactly the outcome this exists to
 * prevent, and it would do so with nothing logged.
 */
const AI_GATEWAY_ID = 'aeci-agent-test';

setProvider(
  cloudflareBindingProvider({
    binding: (env as unknown as Env).AI,
    gateway: { id: AI_GATEWAY_ID },
  }),
);

/**
 * The route map. Flue mounts nothing on its own: an agent is registered by the
 * `'use agent'` scan, but it is only reachable over HTTP because this file
 * mounts it.
 *
 * ── AUTH COVERS THE AGENT MOUNTS, AND THAT IS THE POINT ─────────────────────
 * A Flue agent router has NO built-in authentication — anyone who can reach a
 * conversation URL can read and drive that conversation. `requireAccess()` (the
 * byte-for-byte copy of `apps/datatool/src/access.ts`) is registered with
 * `app.use('*', …)` BEFORE every `app.route(...)` below, so it runs ahead of the
 * mounted routers too: `app.route()` merges a sub-app's routes into this router,
 * and Hono dispatches handlers in registration order, so a wildcard middleware
 * registered first matches every later path including the merged ones.
 *
 * Registration order is therefore load-bearing. `src/app.spec.ts` asserts a 403
 * on an agent path with no credential, so a future edit that moves the `use()`
 * below a `route()` fails a test rather than silently opening the agent.
 *
 * `/health` is deliberately INSIDE the gate as well. It is an unauthenticated
 * liveness probe for nobody — this Worker is hand-deployed and not routed — and
 * an open endpoint on a gated Worker is the thing that later gets "just one more
 * field" added to it.
 */
const app = new Hono<{ Bindings: Env; Variables: AccessVariables }>();

app.use('*', requireAccess());

app.get('/health', (c) => c.json({ status: 'ok' }));

/**
 * `GET /` — the internal test chat page.
 *
 * It is a developer tool, not a product surface: no i18n, no design system, no
 * framework, no npm dependency. The rules in `CLAUDE.md` that govern rendered UI
 * apply to `apps/web`, and this is not that. It posts to the agent mounts below
 * and reads the reply from the documented SSE updates stream.
 *
 * It carries NO credential of its own. The browser reaches it the same way it
 * reaches every other route here — a Cloudflare Access assertion, or the bearer
 * token the page asks for and keeps in `sessionStorage`.
 */
app.get('/', (c) =>
  c.body(chatPage, 200, {
    'content-type': 'text/html; charset=utf-8',
    // Nothing on this Worker is public, and the page names both mounts.
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
  }),
);

// One mount per agent. The mount PATH is not part of the storage identity, so
// re-mounting needs no migration; the exported function NAME is, and does.
app.route('/agents/catalog', createAgentRouter(Catalog));
app.route('/agents/catalog-claude', createAgentRouter(CatalogClaude));

// The operator surface: `POST /admin/reindex` rebuilds the R2 corpus AI Search
// indexes. Mounted AFTER the `use('*', …)` above for the same registration-order
// reason the agent mounts are, and `src/routes/reindex.spec.ts` asserts the 403.
app.route('/admin', reindexRoutes);

export default app;

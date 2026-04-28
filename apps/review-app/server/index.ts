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
import health from './routes/health';
import meta from './routes/meta';
import stats from './routes/stats';
import tools from './routes/tools';
import vendors from './routes/vendors';
import workflows from './routes/workflows';
import reports from './routes/reports';
import toolsDebug from './routes/tools-debug';
import { runWeeklyCostReport } from './services/reports/weeklyCostReport';
import type { ReportJob } from './services/reports/types';
import { AUTO_ENRICH_QUEUE_NAME, type AutoEnrichJob } from './services/autoEnrich/types';
import { runVendorAutoEnrich } from './services/autoEnrich/runAutoEnrich';

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

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());

// Data
app.route('/api/health', health);
app.route('/api/meta', meta);
app.route('/api/tools', tools);
app.route('/api/vendors', vendors);
app.route('/api/stats', stats);

// Workflow orchestration
app.route('/api/workflows', workflows);
app.route('/api/reports', reports);

// Live run feed — single WebSocket forwarded to the singleton RunsHub DO.
app.get('/api/runs/ws', (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('Expected websocket', 426);
  }
  const origin = c.req.header('origin');
  if (!isAllowedOrigin(origin)) {
    return c.text(`Origin not allowed: ${origin}`, 403);
  }
  const id = c.env.RUNS_HUB.idFromName('singleton');
  const stub = c.env.RUNS_HUB.get(id);
  const url = new URL(c.req.raw.url);
  const forward = new URL('https://runs-hub.internal/ws');
  forward.searchParams.set('channel', url.searchParams.get('channel') ?? 'recent');
  const runId = url.searchParams.get('runId');
  if (runId) forward.searchParams.set('runId', runId);
  return stub.fetch(forward.toString(), c.req.raw);
});

// Debug helpers (SERP / page render)
app.route('/api/debug', toolsDebug);

// SPA fallback — wrangler's `not_found_handling: "single-page-application"`
// rewrites missing routes to index.html, so this is just a passthrough.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

// Singleton Durable Object that owns the live run registry / WebSocket fan-out.
export { RunsHub } from './do/runs-hub';

// One Cloudflare Workflow class per workflow. Each is bound under its own
// WF_* binding in wrangler.jsonc.
export { VendorGithubWorkflow } from './workflows/vendor/github';
export { VendorFundingWorkflow } from './workflows/vendor/funding';
export { VendorScoreWorkflow } from './workflows/vendor/score';
export { VendorOrchestratorWorkflow } from './workflows/vendor/orchestrator';
export { VendorOverviewWorkflow } from './workflows/vendor/overview';
export { ToolApiCheckWorkflow } from './workflows/tool/apiCheck';
export { ToolMarketplaceWorkflow } from './workflows/tool/marketplace';
export { ToolIpaasWorkflow } from './workflows/tool/ipaas';
export { ToolReviewsWorkflow } from './workflows/tool/reviews';
export { ToolSearchDemandWorkflow } from './workflows/tool/searchDemand';
export { ToolRedditWorkflow } from './workflows/tool/reddit';
export { ToolIntegrationCountWorkflow } from './workflows/tool/integrationCount';
export { ToolScoreWorkflow } from './workflows/tool/score';
export { ToolOrchestratorWorkflow } from './workflows/tool/orchestrator';
export { ToolResearchWorkflow } from './workflows/tool/research';

// Worker module export — delegates fetch to Hono and adds scheduled() + queue().
export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 14 * * 1') {
      const job: ReportJob = { kind: 'weekly-cost-report', triggeredBy: 'cron' };
      ctx.waitUntil(env.REPORTS_QUEUE.send(job));
    } else if (event.cron === '*/12 * * * *') {
      const job: AutoEnrichJob = {
        kind: 'vendor-auto-enrich',
        count: 5,
        model: 'claude-sonnet-4-6',
        triggeredBy: 'cron',
      };
      ctx.waitUntil(env.VENDOR_AUTO_ENRICH_QUEUE.send(job));
    } else {
      console.warn('[scheduled] unknown cron expression:', event.cron);
    }
  },

  async queue(
    batch: MessageBatch<ReportJob | AutoEnrichJob>,
    env: Env,
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (batch.queue === AUTO_ENRICH_QUEUE_NAME) {
          const body = message.body as AutoEnrichJob;
          if (body.kind === 'vendor-auto-enrich') {
            await runVendorAutoEnrich(env, {
              count: body.count,
              model: body.model,
              triggeredBy: body.triggeredBy,
            });
          }
        } else {
          const body = message.body as ReportJob;
          if (body.kind === 'weekly-cost-report') {
            await runWeeklyCostReport(env, { lookbackDays: body.lookbackDays });
          }
        }
        message.ack();
      } catch (err) {
        console.error(
          `[queue:${batch.queue}] job failed (id=${message.id}, attempts=${message.attempts}): ${String(err)}`,
        );
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, ReportJob | AutoEnrichJob>;

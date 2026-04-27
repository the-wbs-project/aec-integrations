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
import tools from './routes/tools';
import vendors from './routes/vendors';
import workflows from './routes/workflows';
import runs from './routes/runs';
import reports from './routes/reports';
import toolsDebug from './routes/tools-debug';
import { runWeeklyCostReport } from './services/reports/weeklyCostReport';
import type { ReportJob } from './services/reports/types';

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());

// Data
app.route('/api/health', health);
app.route('/api/meta', meta);
app.route('/api/tools', tools);
app.route('/api/vendors', vendors);

// Workflow orchestration
app.route('/api/workflows', workflows);
app.route('/api/runs', runs);
app.route('/api/reports', reports);

// Debug helpers (SERP / page render)
app.route('/api/debug', toolsDebug);

// SPA fallback — wrangler's `not_found_handling: "single-page-application"`
// rewrites missing routes to index.html, so this is just a passthrough.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

// One Cloudflare Workflow class per workflow. Each is bound under its own
// WF_* binding in wrangler.jsonc.
export { VendorLinkedinWorkflow } from './workflows/vendor/linkedin';
export { VendorGithubWorkflow } from './workflows/vendor/github';
export { VendorCompanySizeWorkflow } from './workflows/vendor/companySize';
export { VendorFundingWorkflow } from './workflows/vendor/funding';
export { VendorPressWorkflow } from './workflows/vendor/press';
export { VendorBlogRecencyWorkflow } from './workflows/vendor/blogRecency';
export { VendorScoreWorkflow } from './workflows/vendor/score';
export { VendorOrchestratorWorkflow } from './workflows/vendor/orchestrator';
export { ToolApiCheckWorkflow } from './workflows/tool/apiCheck';
export { ToolMarketplaceWorkflow } from './workflows/tool/marketplace';
export { ToolIpaasWorkflow } from './workflows/tool/ipaas';
export { ToolReviewsWorkflow } from './workflows/tool/reviews';
export { ToolSearchDemandWorkflow } from './workflows/tool/searchDemand';
export { ToolRedditWorkflow } from './workflows/tool/reddit';
export { ToolIntegrationCountWorkflow } from './workflows/tool/integrationCount';
export { ToolScoreWorkflow } from './workflows/tool/score';
export { ToolOrchestratorWorkflow } from './workflows/tool/orchestrator';

// Worker module export — delegates fetch to Hono and adds scheduled() + queue().
export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const job: ReportJob = { kind: 'weekly-cost-report', triggeredBy: 'cron' };
    ctx.waitUntil(env.REPORTS_QUEUE.send(job));
  },

  async queue(batch: MessageBatch<ReportJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (message.body.kind === 'weekly-cost-report') {
          await runWeeklyCostReport(env, { lookbackDays: message.body.lookbackDays });
        }
        message.ack();
      } catch (err) {
        console.error(
          `[queue] job failed (id=${message.id}, attempts=${message.attempts}): ${String(err)}`,
        );
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, ReportJob>;

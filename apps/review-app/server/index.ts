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
import { APP_QUEUE } from './app.queues';
import { APP_ROUTES } from './app.routes';
import { APP_SCHEDULED } from './app.scheduled';
import type { Env } from './env';
import type { AutoEnrichJob } from './services/autoEnrich/types';
import type { ReportJob } from './services/reports/types';

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
  fetch: APP_ROUTES,
  scheduled: APP_SCHEDULED,
  queue: APP_QUEUE,
} satisfies ExportedHandler<Env, ReportJob | AutoEnrichJob>;

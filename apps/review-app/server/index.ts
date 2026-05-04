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
import { AeciReviewMcp } from './mcp/agent';

// Singleton Durable Object that owns the live run registry / WebSocket fan-out.
export { RunsHub } from './do/runs-hub';

// Remote MCP server (Streamable HTTP transport) — McpAgent backs onto a
// SQLite-backed Durable Object bound as MCP_OBJECT.
export { AeciReviewMcp } from './mcp/agent';

// One Cloudflare Workflow class per workflow. Each is bound under its own
// WF_* binding in wrangler.jsonc.
export { VendorGithubWorkflow } from './workflows/vendor/github';
export { VendorFundingWorkflow } from './workflows/vendor/funding';
export { VendorScoreWorkflow } from './workflows/vendor/score';
export { VendorOrchestratorWorkflow } from './workflows/vendor/orchestrator';
export { VendorOverviewWorkflow } from './workflows/vendor/overview';
export { ProductOverviewWorkflow } from './workflows/product/overview';
export { ProductApiCheckWorkflow } from './workflows/product/apiCheck';
export { ProductMarketplaceWorkflow } from './workflows/product/marketplace';
export { ProductIpaasWorkflow } from './workflows/product/ipaas';
export { ProductReviewsWorkflow } from './workflows/product/reviews';
export { ProductSearchDemandWorkflow } from './workflows/product/searchDemand';
export { ProductRedditWorkflow } from './workflows/product/reddit';
export { ProductScoreWorkflow } from './workflows/product/score';
export { ProductOrchestratorWorkflow } from './workflows/product/orchestrator';
export { ProductResearchWorkflow } from './workflows/product/research';
export { ProductIntegrationsWebsiteWorkflow } from './workflows/product/integrationsWebsite';
export { ProductIntegrationsIpaasWorkflow } from './workflows/product/integrationsIpaas';
export { ProductIntegrationsMarketplacesWorkflow } from './workflows/product/integrationsMarketplaces';
export { ProductIntegrationsG2Workflow } from './workflows/product/integrationsG2';
export { ProductIntegrationsGithubWorkflow } from './workflows/product/integrationsGithub';
export { ProductIntegrationsWebWorkflow } from './workflows/product/integrationsWeb';
export { ProductIntegrationsDiscoveryWorkflow } from './workflows/product/integrationsDiscovery';

// Streamable-HTTP MCP handler. Built once at module init; the McpAgent SDK
// internally routes to the MCP_OBJECT Durable Object.
const MCP_HANDLER = AeciReviewMcp.serve('/mcp');

// Worker module export — delegates fetch to MCP for /mcp* and Hono for the
// rest. Also wires scheduled() + queue() consumers.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      // TODO: re-enable bearer-token auth (MCP_TOKEN) before exposing publicly.
      return MCP_HANDLER.fetch(request, env, ctx);
    }
    return APP_ROUTES(request, env, ctx);
  },
  scheduled: APP_SCHEDULED,
  queue: APP_QUEUE,
} satisfies ExportedHandler<Env, ReportJob | AutoEnrichJob>;

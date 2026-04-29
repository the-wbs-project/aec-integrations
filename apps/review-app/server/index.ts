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
export { ToolOverviewWorkflow } from './workflows/tool/overview';
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

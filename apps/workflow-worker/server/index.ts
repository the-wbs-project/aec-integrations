// ---------------------------------------------------------------------------
// Cloudflare Worker entry — Hono app for the API + Angular SPA, plus the
// per-workflow WorkflowEntrypoint class exports.
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

// SPA fallback — wrangler's `not_found_handling: "single-page-application"`
// rewrites missing routes to index.html, so this is just a passthrough.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

// One Cloudflare Workflow class per workflow. Each is bound under its own
// WORKFLOW_RUNNER-style binding in wrangler.jsonc.
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

export default app;

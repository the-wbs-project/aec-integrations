// ---------------------------------------------------------------------------
// Cloudflare Worker environment bindings, vars, and secrets.
//
// `Cloudflare.Env` is generated from wrangler.jsonc by `wrangler types` and
// declared globally in worker-configuration.d.ts at the app root. We extend
// it here to:
//   • narrow BROWSER to a puppeteer-compatible type
//   • narrow Queue<...> bindings with their job payload types
//   • narrow the workflow bindings to a single shared RunParams payload
//   • narrow AIRTABLE_TABLES from the wrangler literal to a typed interface
//   • declare production-only secrets that wrangler can't infer from config
//
// Run `npm run cf-typegen` after editing wrangler.jsonc to refresh
// worker-configuration.d.ts.
// ---------------------------------------------------------------------------
import type puppeteer from '@cloudflare/puppeteer';
import type { RunParams } from './lib/workflow-meta';
import type { ReportJob } from './services/reports/types';
import type { AutoEnrichJob } from './services/autoEnrich/types';

/**
 * Type of the BROWSER binding accepted by puppeteer.launch(). Computed from
 * the SDK rather than hard-coding `BrowserWorker` so this stays portable
 * across @cloudflare/puppeteer versions.
 */
export type BrowserBinding = Parameters<typeof puppeteer.launch>[0];

export interface AirtableTables {
  tools: string;
  vendors: string;
  categories: string;
  projectPhases: string;
  disciplines: string;
  toolIntegrations: string;
  runs: string;
}

/**
 * Search tool exposed to Claude.
 *   - 'searchapi' → custom `web_search` tool backed by SearchAPI.io. Cheap,
 *     compact tool_results (just title/link/snippet). Default.
 *   - 'web'       → Anthropic's built-in `web_search_20250305`. Fallback
 *     when SEARCHAPI_API_KEY is unset.
 */
export type SearchTool = 'searchapi' | 'web';

/**
 * Workflow binding map. Every entry maps a binding name to `Workflow<RunParams>`
 * — every workflow class accepts the same payload shape, so we share the type.
 * Keep this in sync with the WF_* bindings in wrangler.jsonc.
 */
type WorkflowBindings = {
  WF_VENDOR_GITHUB: Workflow<RunParams>;
  WF_VENDOR_FUNDING: Workflow<RunParams>;
  WF_VENDOR_SCORE: Workflow<RunParams>;
  WF_VENDOR_ORCHESTRATOR: Workflow<RunParams>;
  WF_VENDOR_OVERVIEW: Workflow<RunParams>;
  WF_TOOL_API_CHECK: Workflow<RunParams>;
  WF_TOOL_MARKETPLACE: Workflow<RunParams>;
  WF_TOOL_IPAAS: Workflow<RunParams>;
  WF_TOOL_REVIEWS: Workflow<RunParams>;
  WF_TOOL_SEARCH_DEMAND: Workflow<RunParams>;
  WF_TOOL_REDDIT: Workflow<RunParams>;
  WF_TOOL_INTEGRATION_COUNT: Workflow<RunParams>;
  WF_TOOL_SCORE: Workflow<RunParams>;
  WF_TOOL_ORCHESTRATOR: Workflow<RunParams>;
  WF_TOOL_RESEARCH: Workflow<RunParams>;
};

/**
 * Production-only secrets. Wrangler can't infer these from wrangler.jsonc
 * because they're set via `wrangler secret put` (or .dev.vars). Listed here
 * so call sites get types instead of `unknown`.
 *
 * AIRTABLE_TOKEN is intentionally absent — wrangler picks it up from .dev.vars
 * and emits it on Cloudflare.Env directly.
 */
interface ManualSecrets {
  /** SearchAPI.io key. If unset the worker auto-falls back to Anthropic web_search_20250305. */
  SEARCHAPI_API_KEY: string;
  /** Optional GitHub PAT to raise REST rate limits. */
  GITHUB_TOKEN?: string;
  /** Cloudflare API token with `AI Gateway: Read` for the weekly cost report. */
  CF_API_TOKEN: string;
  /** Scrapfly anti-scraping proxy key for Crunchbase fetches. Optional. */
  SCRAPFLY_API_KEY?: string;
  /** Supabase project JWT secret (HS256). Used to verify access tokens in auth middleware. */
  SUPABASE_JWT_SECRET: string;
  /**
   * Bearer token for the /mcp endpoint. Currently unused — the MCP route is
   * open. Set via `wrangler secret put MCP_TOKEN` when re-enabling auth.
   */
  MCP_TOKEN?: string;
}

/**
 * Bindings whose generated type from wrangler.jsonc is too loose. We override
 * them here to recover payload types (queues, workflows) and SDK-specific
 * shapes (puppeteer's BrowserBinding).
 */
interface OverriddenBindings extends WorkflowBindings {
  BROWSER: BrowserBinding;
  REPORTS_QUEUE: Queue<ReportJob>;
  VENDOR_AUTO_ENRICH_QUEUE: Queue<AutoEnrichJob>;
  AIRTABLE_TABLES: AirtableTables;
  SEARCH_TOOL: SearchTool;
}

/**
 * Final Env consumed throughout the worker. Composed from the wrangler-
 * generated bindings minus the keys we override, then merged with our
 * narrowed overrides and production-only secrets.
 */
export type Env = Omit<Cloudflare.Env, keyof OverriddenBindings> &
  OverriddenBindings &
  ManualSecrets;

export const CACHE_TTL_S = 60 * 60 * 24; // 1 day, matches n8n-utils

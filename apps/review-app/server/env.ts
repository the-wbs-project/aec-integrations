// ---------------------------------------------------------------------------
// Cloudflare Worker environment bindings, vars, and secrets.
//
// Single source of truth for the merged aeci-review worker. Both the data
// API (vendors/tools/meta) and the workflow API/runners reference this Env.
// ---------------------------------------------------------------------------
import type puppeteer from '@cloudflare/puppeteer';
import type { RunParams } from './lib/workflow-meta';
import type { ReportJob } from './services/reports/types';
// `SendEmail` is the runtime type of a `send_email` binding, exposed as a
// global by @cloudflare/workers-types.

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
}

/**
 * Search tool exposed to Claude.
 *   - 'searchapi' → custom `web_search` tool backed by SearchAPI.io. Cheap,
 *     compact tool_results (just title/link/snippet). Default.
 *   - 'web'       → Anthropic's built-in `web_search_20250305`. Fallback
 *     when SEARCHAPI_API_KEY is unset.
 */
export type SearchTool = 'searchapi' | 'web';

export interface Env {
  // Static bindings
  ASSETS: Fetcher;
  KV_CACHE: KVNamespace;
  BROWSER: BrowserBinding;
  /**
   * Workers AI binding. We use it via `env.AI.gateway(AI_GATEWAY_ID).run(...)`
   * to issue universal-endpoint requests to Anthropic through the Cloudflare
   * AI Gateway — no batch API, no SDK, no manual gateway URL.
   */
  AI: Ai;

  // Workflow bindings — one per WorkflowEntrypoint class, declared in
  // wrangler.jsonc. The route layer dispatches via env[bindingName] using
  // the registry → binding map in `workflows/registry.ts`.
  WF_VENDOR_LINKEDIN: Workflow<RunParams>;
  WF_VENDOR_GITHUB: Workflow<RunParams>;
  WF_VENDOR_COMPANY_SIZE: Workflow<RunParams>;
  WF_VENDOR_FUNDING: Workflow<RunParams>;
  WF_VENDOR_PRESS: Workflow<RunParams>;
  WF_VENDOR_BLOG_RECENCY: Workflow<RunParams>;
  WF_VENDOR_SCORE: Workflow<RunParams>;
  WF_VENDOR_ORCHESTRATOR: Workflow<RunParams>;
  WF_TOOL_API_CHECK: Workflow<RunParams>;
  WF_TOOL_MARKETPLACE: Workflow<RunParams>;
  WF_TOOL_IPAAS: Workflow<RunParams>;
  WF_TOOL_REVIEWS: Workflow<RunParams>;
  WF_TOOL_SEARCH_DEMAND: Workflow<RunParams>;
  WF_TOOL_REDDIT: Workflow<RunParams>;
  WF_TOOL_INTEGRATION_COUNT: Workflow<RunParams>;
  WF_TOOL_SCORE: Workflow<RunParams>;
  WF_TOOL_ORCHESTRATOR: Workflow<RunParams>;

  // Email — `send_email` binding for the weekly cost report.
  REPORT_EMAIL: SendEmail;

  // Queue — produces + consumes weekly-cost-report jobs (cron + ad-hoc).
  REPORTS_QUEUE: Queue<ReportJob>;

  // Vars
  SEARCH_TOOL: SearchTool;
  AIRTABLE_BASE_ID: string;
  AIRTABLE_TABLES: AirtableTables;
  DEFAULT_MODEL: string;
  AI_GATEWAY_ID: string;
  CF_ACCOUNT_ID: string;
  REPORT_FROM: string;
  REPORT_FROM_NAME: string;
  REPORT_REPLY_TO: string;
  REPORT_TO: string;
  /** USD cost per SearchAPI.io search. Stored as string in wrangler.jsonc; parseFloat at use site. */
  SEARCHAPI_COST_PER_SEARCH: string;

  // Secrets
  SEARCHAPI_API_KEY: string;
  AIRTABLE_TOKEN: string;
  GITHUB_TOKEN?: string;
  CF_API_TOKEN: string;
}

export const CACHE_TTL_S = 60 * 60 * 24; // 1 day, matches n8n-utils

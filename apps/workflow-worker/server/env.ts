// ---------------------------------------------------------------------------
// Cloudflare Worker environment bindings, vars, and secrets.
// ---------------------------------------------------------------------------
import type puppeteer from '@cloudflare/puppeteer';
import type { RunParams } from './lib/workflow-meta';

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

export type SearchProvider = 'serpapi' | 'searchapi';
export type SearchTool = 'web' | 'serpapi';

export interface Env {
  // Static bindings
  ASSETS: Fetcher;
  KV_CACHE: KVNamespace;
  BROWSER: BrowserBinding;

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

  // Vars
  SEARCH_PROVIDER: SearchProvider;
  SEARCH_TOOL: SearchTool;
  AIRTABLE_BASE_ID: string;
  AIRTABLE_TABLES: AirtableTables;
  DEFAULT_MODEL: string;
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;

  // Secrets
  /**
   * Cloudflare AI Gateway authentication token. Sent as
   * `cf-aig-authorization: Bearer <token>`. With BYOK enabled on the gateway,
   * the Anthropic key is stored in the gateway itself and we don't need to
   * send it from the worker.
   */
  CF_AI_GATEWAY_TOKEN: string;
  /**
   * Optional fallback if BYOK isn't configured on the gateway. When unset
   * the SDK is given a placeholder string (the gateway injects the real key).
   */
  ANTHROPIC_API_KEY?: string;
  SERP_API_KEY: string;
  SEARCHAPI_API_KEY: string;
  AIRTABLE_TOKEN: string;
  GITHUB_TOKEN?: string;
}

export const CACHE_TTL_S = 60 * 60 * 24; // 1 day, matches n8n-utils

// ---------------------------------------------------------------------------
// Cloudflare Worker environment bindings, vars, and secrets.
// ---------------------------------------------------------------------------
import type puppeteer from '@cloudflare/puppeteer';

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
  // Bindings
  ASSETS: Fetcher;
  KV_CACHE: KVNamespace;
  BROWSER: BrowserBinding;
  WORKFLOW_RUN: DurableObjectNamespace;

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

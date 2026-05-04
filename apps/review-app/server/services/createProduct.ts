// ---------------------------------------------------------------------------
// createProductAndStartOrchestrator
//
// Shared helper used by both POST /api/products (HTTP) and the MCP
// `create_product_and_research` tool. Creates a minimal Airtable product row
// (research_status="Pending"), invalidates the products cache, and (unless
// skipOrchestrator is set) spawns WF_PRODUCT_ORCHESTRATOR against the new
// record so the standard enrichment pipeline runs against it.
//
// Mirrors createVendor.ts.
// ---------------------------------------------------------------------------
import type { Env } from '../env';
import { createRecord, tableId } from './airtable';
import { cacheInvalidate } from './cache';
import { resolveSearchTool } from '../lib/llm';
import { notifyRunStarted } from '../lib/notify-run-started';
import type { RunParams } from '../lib/workflow-meta';

const VALID_MODEL = /^claude-(opus|sonnet|haiku)-[\w.-]+$/;

export interface CreateProductOptions {
  name: string;
  website?: string;
  description?: string;
  /** Override the orchestrator's Claude model. Defaults to env.DEFAULT_MODEL. */
  model?: string;
  /** Override the search tool. Defaults to env.SEARCH_TOOL (resolved). */
  searchTool?: 'searchapi' | 'web';
  /** Force-rerun every leaf enrichment regardless of staleness. */
  forceRefresh?: boolean;
  /** If true, create the record only — no orchestrator. */
  skipOrchestrator?: boolean;
  /** Where the call originated (drives the run-feed UI badge). */
  triggeredBy?: 'http' | 'mcp';
}

export interface CreateProductResult {
  recordId: string;
  /** Present when the orchestrator was spawned. */
  run?: {
    runId: string;
    workflow: 'product-orchestrator';
    model: string;
  };
}

export class CreateProductValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreateProductValidationError';
  }
}

export async function createProductAndStartOrchestrator(
  env: Env,
  opts: CreateProductOptions,
): Promise<CreateProductResult> {
  const name = opts.name?.trim();
  if (!name) {
    throw new CreateProductValidationError('name is required');
  }

  const model = opts.model ?? env.DEFAULT_MODEL;
  if (!VALID_MODEL.test(model)) {
    throw new CreateProductValidationError(`Invalid model: ${model}`);
  }

  // ----- 1. Create the Airtable row -----------------------------------------
  const fields: Record<string, unknown> = {
    Name: name,
    research_status: 'Pending',
  };
  if (opts.website?.trim()) fields['website'] = opts.website.trim();
  if (opts.description?.trim()) fields['description'] = opts.description.trim();

  const created = await createRecord(env, 'products', fields);
  const recordId = created.id;

  await cacheInvalidate(env.KV_CACHE, `table:${tableId(env, 'products')}`);

  if (opts.skipOrchestrator) {
    return { recordId };
  }

  // ----- 2. Spawn the product orchestrator ----------------------------------
  const searchTool = resolveSearchTool(env, opts.searchTool ?? env.SEARCH_TOOL ?? 'searchapi');
  const forceRefresh = opts.forceRefresh === true;
  const runId = crypto.randomUUID();
  const params: RunParams = { recordId, model, searchTool, forceRefresh };

  await env.WF_PRODUCT_ORCHESTRATOR.create({ id: runId, params });

  try {
    await notifyRunStarted(env, {
      runId,
      workflow: 'product-orchestrator',
      recordId,
      recordLabel: name,
      triggeredBy: opts.triggeredBy ?? 'http',
      forceRefresh,
      model,
    });
  } catch (err) {
    console.error('[createProduct] notifyRunStarted failed', runId, String(err));
  }

  return {
    recordId,
    run: { runId, workflow: 'product-orchestrator', model },
  };
}

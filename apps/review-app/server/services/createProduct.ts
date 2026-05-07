// ---------------------------------------------------------------------------
// createProductAndStartOrchestrator
//
// Shared helper used by both POST /api/products (HTTP) and the MCP
// `create_product_and_research` tool. Creates a minimal Airtable product row
// (research_status="Pending"), invalidates the products cache, and (unless
// skipOrchestrator is set) enqueues an `enrich-product` playbook job with
// `force_refresh: true` so the scheduled dispatcher picks it up and runs the
// standard enrichment pass.
//
// The function name is preserved for backwards compatibility; "orchestrator"
// now refers to the playbook-driven enrichment, not the dormant
// `product-orchestrator` Cloudflare Workflow.
// ---------------------------------------------------------------------------
import type { Env } from '../env';
import { createRecord, tableId } from './airtable';
import { cacheInvalidate } from './cache';
import { enqueue } from './promptQueue';

export interface CreateProductOptions {
  name: string;
  website?: string;
  description?: string;
  /** Force-rerun every leaf enrichment regardless of staleness. */
  forceRefresh?: boolean;
  /** If true, create the record only — no enrichment job is queued. */
  skipOrchestrator?: boolean;
  /** Where the call originated (used as `requested_by` on the queue row). */
  triggeredBy?: 'http' | 'mcp';
  /** Optional explicit requestedBy override (e.g. cron job name). */
  requestedBy?: string;
  /**
   * Optional host product record IDs — set when the caller already knows
   * this is a plug-in / extension (e.g. a SketchUp extension).
   */
  extensionOf?: string[];
  /**
   * Optional vendor record ID — set when the caller already knows which
   * vendor makes this product (e.g. seed playbooks). Populates the linked
   * `vendors` field at creation time so the product is correctly
   * attributed even if a follow-up update_product never lands.
   */
  vendorId?: string;
  /** @deprecated Workflows are no longer the active path; kept for callers. */
  model?: string;
  /** @deprecated Workflows are no longer the active path; kept for callers. */
  searchTool?: 'searchapi' | 'web';
}

export interface CreateProductResult {
  recordId: string;
  /** Present when an `enrich-product` playbook job was enqueued. */
  queue?: {
    queueRecordId: string;
    playbookSlug: 'enrich-product';
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

  // ----- 1. Create the Airtable row -----------------------------------------
  const fields: Record<string, unknown> = {
    Name: name,
    research_status: 'Pending',
  };
  if (opts.website?.trim()) fields['website'] = opts.website.trim();
  if (opts.description?.trim()) fields['description'] = opts.description.trim();
  if (opts.extensionOf && opts.extensionOf.length > 0) {
    fields['extension_of'] = opts.extensionOf;
  }
  if (opts.vendorId?.trim()) {
    fields['vendors'] = [opts.vendorId.trim()];
  }

  const created = await createRecord(env, 'products', fields);
  const recordId = created.id;

  await cacheInvalidate(env.KV_CACHE, `table:${tableId(env, 'products')}`);

  if (opts.skipOrchestrator) {
    return { recordId };
  }

  // ----- 2. Enqueue an `enrich-product` playbook job ------------------------
  const requestedBy = opts.requestedBy ?? `${opts.triggeredBy ?? 'http'}:create_product_and_research`;
  const queueResult = await enqueue(env, {
    playbookSlug: 'enrich-product',
    targetRecordId: recordId,
    forceRefresh: opts.forceRefresh === true,
    requestedBy,
  });

  return {
    recordId,
    queue: {
      queueRecordId: queueResult.recordId,
      playbookSlug: 'enrich-product',
    },
  };
}

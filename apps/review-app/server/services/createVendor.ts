// ---------------------------------------------------------------------------
// createVendorAndStartOrchestrator
//
// Shared helper used by both POST /api/vendors (HTTP) and the MCP
// `create_vendor_and_research` tool. Creates a minimal Airtable vendor row,
// invalidates the vendors cache, and (unless skipOrchestrator is set)
// enqueues an `enrich-vendor` playbook job with `force_refresh: true` so the
// scheduled dispatcher picks it up and runs the standard enrichment pass.
//
// The function name is preserved for backwards compatibility with existing
// callers; "orchestrator" now refers to the playbook-driven enrichment, not
// the dormant `vendor-orchestrator` Cloudflare Workflow.
// ---------------------------------------------------------------------------
import type { Env } from '../env';
import { createRecord, tableId } from './airtable';
import { cacheInvalidate } from './cache';
import { enqueue } from './promptQueue';

export interface CreateVendorOptions {
  companyName: string;
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
  /** @deprecated Workflows are no longer the active path; kept for callers. */
  model?: string;
  /** @deprecated Workflows are no longer the active path; kept for callers. */
  searchTool?: 'searchapi' | 'web';
}

export interface CreateVendorResult {
  recordId: string;
  /** Present when an `enrich-vendor` playbook job was enqueued. */
  queue?: {
    queueRecordId: string;
    playbookSlug: 'enrich-vendor';
  };
}

export class CreateVendorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreateVendorValidationError';
  }
}

export async function createVendorAndStartOrchestrator(
  env: Env,
  opts: CreateVendorOptions,
): Promise<CreateVendorResult> {
  const companyName = opts.companyName?.trim();
  if (!companyName) {
    throw new CreateVendorValidationError('companyName is required');
  }

  // ----- 1. Create the Airtable row -----------------------------------------
  const fields: Record<string, unknown> = { company_name: companyName };
  if (opts.website?.trim()) fields['website'] = opts.website.trim();
  if (opts.description?.trim()) fields['description'] = opts.description.trim();

  const created = await createRecord(env, 'vendors', fields);
  const recordId = created.id;

  await cacheInvalidate(env.KV_CACHE, `table:${tableId(env, 'vendors')}`);

  if (opts.skipOrchestrator) {
    return { recordId };
  }

  // ----- 2. Enqueue an `enrich-vendor` playbook job -------------------------
  const requestedBy = opts.requestedBy ?? `${opts.triggeredBy ?? 'http'}:create_vendor_and_research`;
  const queueResult = await enqueue(env, {
    playbookSlug: 'enrich-vendor',
    targetRecordId: recordId,
    forceRefresh: opts.forceRefresh === true,
    requestedBy,
  });

  return {
    recordId,
    queue: {
      queueRecordId: queueResult.recordId,
      playbookSlug: 'enrich-vendor',
    },
  };
}

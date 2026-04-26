// ---------------------------------------------------------------------------
// V00 — Vendor orchestrator (v1 simplification).
// Source: artifacts/n8n-workflows/AECi-V00-Orchestrator.json
//
// In n8n the orchestrator chained the V01–V06 sub-workflows. In this worker
// each leaf workflow is its own Cloudflare Workflow class — chaining them is
// deferred. For now the orchestrator just delegates to V07 score logic so
// invoking 'vendor-orchestrator' on a record gives you a fresh
// vendor_data_completeness reading without re-running the leaf enrichments.
// ---------------------------------------------------------------------------
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../../env';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import { getRecord, updateRecord } from '../../services/airtable';

export const meta: WorkflowMeta = {
  slug: 'vendor-orchestrator',
  description:
    'V1 orchestrator stub — recomputes vendor completeness only. Leaf-workflow chaining is deferred.',
  table: 'vendors',
};

const SIGNAL_FIELDS = [
  'github_org',
  'linkedin_followers',
  'company_size',
  'funding_stage',
  'press_count_12mo',
  'blog_last_post_days_ago',
] as const;

export class VendorOrchestratorWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  override async run(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId } = event.payload;

    const record = await checkpoint(step, 'fetch-record', () =>
      getRecord(this.env, 'vendors', recordId),
    );

    const populated = SIGNAL_FIELDS.filter((f) => {
      const v = record.fields[f];
      return v !== null && v !== undefined && v !== '';
    }).length;
    const completeness = populated / SIGNAL_FIELDS.length;
    const enrichmentStatus =
      completeness >= 0.75 ? 'enriched' : completeness >= 0.4 ? 'partial' : 'error';

    const fields = {
      vendor_data_completeness: completeness,
      vendor_enrichment_status: enrichmentStatus,
      last_enriched_at: new Date().toISOString(),
    };

    await checkpoint(step, 'write-fields', () =>
      updateRecord(this.env, 'vendors', recordId, fields),
    );

    return {
      fields,
      fieldsUpdated: Object.keys(fields),
      status: 'success' as const,
      note: `${populated}/${SIGNAL_FIELDS.length} signals populated`,
    };
  }
}

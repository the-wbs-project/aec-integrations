// ---------------------------------------------------------------------------
// V07 — Vendor data completeness recalculation.
// Source: artifacts/n8n-workflows/AECi-V07-ScoreRecalculate.json
//
// Pure function — no LLM, no external APIs. Counts how many of six enrichment
// signals are populated, classifies the vendor as enriched/partial/error, and
// writes the result back to Airtable.
// ---------------------------------------------------------------------------
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../../env';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import { getRecord, updateRecord } from '../../services/airtable';

export const meta: WorkflowMeta = {
  slug: 'vendor-score',
  description:
    'Recompute vendor_data_completeness + vendor_enrichment_status from the six enrichment signals.',
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

export class VendorScoreWorkflow extends WorkflowEntrypoint<Env, RunParams> {
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

    let enrichmentStatus: 'enriched' | 'partial' | 'error';
    if (completeness >= 0.75) enrichmentStatus = 'enriched';
    else if (completeness >= 0.4) enrichmentStatus = 'partial';
    else enrichmentStatus = 'error';

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

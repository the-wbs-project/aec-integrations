// ---------------------------------------------------------------------------
// V07 — Vendor data completeness recalculation.
// Source: artifacts/n8n-workflows/AECi-V07-ScoreRecalculate.json
//
// Pure function — no LLM, no external APIs. Counts how many of six enrichment
// signals are populated and classifies the vendor as enriched/partial/error.
// ---------------------------------------------------------------------------
import type { CustomWorkflow } from '../types';
import type { AirtableRecord } from '../../services/airtable';

const SIGNAL_FIELDS = [
  'github_org',
  'linkedin_followers',
  'company_size',
  'funding_stage',
  'press_count_12mo',
  'blog_last_post_days_ago',
] as const;

export const workflow: CustomWorkflow = {
  kind: 'custom',
  description: 'Recompute vendor_data_completeness + vendor_enrichment_status from the six enrichment signals.',
  table: 'vendors',

  async run(_env, record: AirtableRecord) {
    const populated = SIGNAL_FIELDS.filter((f) => {
      const v = record.fields[f];
      return v !== null && v !== undefined && v !== '';
    }).length;
    const completeness = populated / SIGNAL_FIELDS.length;

    let status: 'enriched' | 'partial' | 'error';
    if (completeness >= 0.75) status = 'enriched';
    else if (completeness >= 0.4) status = 'partial';
    else status = 'error';

    const fields = {
      vendor_data_completeness: completeness,
      vendor_enrichment_status: status,
      last_enriched_at: new Date().toISOString(),
    };
    return {
      fields,
      fieldsUpdated: ['vendor_data_completeness', 'vendor_enrichment_status', 'last_enriched_at'],
      status: 'success' as const,
      note: `${populated}/${SIGNAL_FIELDS.length} signals populated`,
    };
  },
};

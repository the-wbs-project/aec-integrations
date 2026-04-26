// ---------------------------------------------------------------------------
// T08 — Tool priority scoring.
// Source: artifacts/n8n-workflows/AECi-T08-Score.json
//
// Reads the tool record, fetches its linked vendor (if any), runs the same
// scoring math n8n's Code node uses, writes the four scores + tier.
// ---------------------------------------------------------------------------
import type { CustomWorkflow } from '../types';
import { getRecord, asStringArray, type AirtableRecord } from '../../services/airtable';
import { computePriorityScore, type ToolFields, type VendorFields } from '../../tasks/computePriorityScore';

export const workflow: CustomWorkflow = {
  kind: 'custom',
  description: 'Recompute integration/demand/outreach/priority scores for a tool.',
  table: 'tools',

  async run(env, record: AirtableRecord) {
    const tool = record.fields as ToolFields & Record<string, unknown>;
    const vendorIds = asStringArray(record.fields['vendors']);
    let vendor: VendorFields | null = null;
    if (vendorIds.length > 0) {
      try {
        const v = await getRecord(env, 'vendors', vendorIds[0]);
        vendor = v.fields as VendorFields;
      } catch {
        vendor = null;
      }
    }

    const score = computePriorityScore(tool, vendor);

    const fields = {
      integration_score: score.integration_score,
      demand_score: score.demand_score,
      outreach_score: score.outreach_score,
      priority_score: score.priority_score,
      priority_tier: score.priority_tier,
      emerging_flag: score.emerging_flag,
      last_scored_at: new Date().toISOString(),
    };
    return {
      fields,
      fieldsUpdated: Object.keys(fields),
      status: 'success' as const,
      note: `tier ${score.priority_tier}, priority ${score.priority_score}`,
    };
  },
};

// ---------------------------------------------------------------------------
// T08 — Tool priority scoring.
// Source: artifacts/n8n-workflows/AECi-T08-Score.json
//
// Reads the tool record, fetches its linked vendor (if any), runs the same
// scoring math n8n's Code node uses, writes the four scores + tier.
// ---------------------------------------------------------------------------
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../../env';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import { getRecord, updateRecord, asStringArray } from '../../services/airtable';
import {
  computePriorityScore,
  type ToolFields,
  type VendorFields,
} from '../../tasks/computePriorityScore';

export const meta: WorkflowMeta = {
  slug: 'tool-score',
  description: 'Recompute integration/demand/outreach/priority scores for a tool.',
  table: 'tools',
};

export class ToolScoreWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  override async run(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId } = event.payload;

    const record = await checkpoint(step, 'fetch-tool', () =>
      getRecord(this.env, 'tools', recordId),
    );

    const tool = record.fields as ToolFields & Record<string, unknown>;
    const vendorIds = asStringArray(record.fields['vendors']);

    let vendor: VendorFields | null = null;
    if (vendorIds.length > 0) {
      vendor = await checkpoint(step, 'fetch-vendor', async () => {
        try {
          const v = await getRecord(this.env, 'vendors', vendorIds[0]);
          return v.fields as VendorFields;
        } catch {
          return null;
        }
      });
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

    await checkpoint(step, 'write-fields', () =>
      updateRecord(this.env, 'tools', recordId, fields),
    );

    return {
      fields,
      fieldsUpdated: Object.keys(fields),
      status: 'success' as const,
      note: `tier ${score.priority_tier}, priority ${score.priority_score}`,
    };
  }
}

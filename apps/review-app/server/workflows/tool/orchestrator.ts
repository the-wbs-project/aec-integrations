// ---------------------------------------------------------------------------
// T00 — Tool orchestrator (v1 simplification).
// Source: artifacts/n8n-workflows/AECi-T00-Orchestrator.json
//
// In n8n the orchestrator chained the T01–T07 sub-workflows. In this worker
// each leaf workflow is its own Cloudflare Workflow class — chaining them is
// deferred. For now the orchestrator just delegates to T08 score logic so
// invoking 'tool-orchestrator' on a record gives you a fresh set of priority
// scores without re-running the leaf enrichments.
// ---------------------------------------------------------------------------
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { ErrorCapturingWorkflow } from '../../lib/error-capturing-workflow';
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
  slug: 'tool-orchestrator',
  description:
    'V1 orchestrator stub — recomputes tool priority scores only. Leaf-workflow chaining is deferred.',
  table: 'tools',
};

export class ToolOrchestratorWorkflow extends ErrorCapturingWorkflow {
  override async runImpl(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
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

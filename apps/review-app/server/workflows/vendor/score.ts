// ---------------------------------------------------------------------------
// V07 — Vendor Quality Score (VQS).
//
// Pure function — no LLM, no external APIs. Reads enriched fields off the
// Airtable record and computes a 0–100 vendor score with three pillars
// (Credibility, Momentum, Fit) plus tier / confidence / flags.
//
// The math + Airtable write live in `services/scoring.ts`. This workflow
// class is a dormant wrapper kept so the WF_VENDOR_SCORE binding still
// works for emergency direct invocation (POST /api/workflows/vendor-score/run).
// The active path goes through `update_vendor` (synchronous) and the
// `compute_vendor_score` MCP tool.
// ---------------------------------------------------------------------------
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { ErrorCapturingWorkflow } from '../../lib/error-capturing-workflow';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import { scoreVendor, computeVqs } from '../../services/scoring';

export const meta: WorkflowMeta = {
  slug: 'vendor-score',
  description:
    'Compute the Vendor Quality Score (Credibility / Momentum / Fit) plus tier, confidence, and flags.',
  table: 'vendors',
};

// Re-export so existing importers (tests, scripts) keep working.
export { computeVqs };

export class VendorScoreWorkflow extends ErrorCapturingWorkflow {
  override async runImpl(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId } = event.payload;
    const { fields, summary } = await checkpoint(step, 'score-vendor', () =>
      scoreVendor(this.env, recordId),
    );
    return {
      fields,
      fieldsUpdated: Object.keys(fields),
      status: 'success' as const,
      note: summary,
    };
  }
}

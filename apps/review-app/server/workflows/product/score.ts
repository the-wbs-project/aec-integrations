// ---------------------------------------------------------------------------
// T08 — Tool priority score.
//
// Pure function — no LLM, no external APIs. Reads enriched fields off the
// Airtable record (and the linked vendor's `founded_year` for the emerging
// flag) and computes the 2-pillar priority score plus tier, completeness,
// confidence, and flags.
//
// The math + Airtable write live in `services/scoring.ts`. This workflow
// class is a dormant wrapper kept so the WF_PRODUCT_SCORE binding still
// works for emergency direct invocation (POST /api/workflows/product-score/run).
// The active path goes through `update_product` (synchronous) and the
// `compute_product_score` MCP tool.
// ---------------------------------------------------------------------------
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { ErrorCapturingWorkflow } from '../../lib/error-capturing-workflow';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import { scoreProduct, computeToolScore } from '../../services/scoring';

export const meta: WorkflowMeta = {
  slug: 'product-score',
  description:
    'Compute the tool priority score (Integration / Demand) plus tier, completeness, confidence, and flags.',
  table: 'products',
};

// Re-export so existing importers (tests, scripts) keep working.
export { computeToolScore };

export class ProductScoreWorkflow extends ErrorCapturingWorkflow {
  override async runImpl(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId } = event.payload;
    const { fields, summary } = await checkpoint(step, 'score-product', () =>
      scoreProduct(this.env, recordId),
    );
    return {
      fields,
      fieldsUpdated: Object.keys(fields),
      status: 'success' as const,
      note: summary,
    };
  }
}

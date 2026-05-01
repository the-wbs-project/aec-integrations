// ---------------------------------------------------------------------------
// T08 — Tool priority score.
//
// Pure function — no LLM, no external APIs. Reads enriched fields off the
// Airtable record (and the linked vendor's `founded_year` for the emerging
// flag) and computes the 2-pillar priority score plus tier, completeness,
// confidence, and flags.
//
// Mirrors the shape of `vendor/score.ts`. See `planning/tool-scoring.md`
// for the math spec.
// ---------------------------------------------------------------------------
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { ErrorCapturingWorkflow } from '../../lib/error-capturing-workflow';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import {
  getRecord,
  updateRecord,
  asStringArray,
  type AirtableRecord,
} from '../../services/airtable';
import {
  computePriorityScore,
  PRIORITY_INPUT_FIELDS,
  type ToolFields,
  type VendorFields,
  type PriorityTier,
} from '../../tasks/computePriorityScore';

export const meta: WorkflowMeta = {
  slug: 'product-score',
  description:
    'Compute the tool priority score (Integration / Demand) plus tier, completeness, confidence, and flags.',
  table: 'products',
};

interface ScoreOutput {
  integration_score: number | null;
  demand_score: number | null;
  priority_score: number | null;
  priority_tier: PriorityTier;
  emerging_flag: boolean;
  priority_confidence: 'high' | 'medium' | 'low';
  priority_flags: string;
  tool_data_completeness: number;
  tool_enrichment_status: 'enriched' | 'partial' | 'error';
  last_tool_enriched_at: string;
  last_scored_at: string;
  [key: string]: unknown;
}

function confidenceFor(
  pillarsPresent: number,
  totalPopulated: number,
): 'high' | 'medium' | 'low' {
  if (pillarsPresent === 2 && totalPopulated >= 6) return 'high';
  if (pillarsPresent >= 1 && totalPopulated >= 3) return 'medium';
  return 'low';
}

/**
 * Compute the score for a tool record. Pure function — separated from the
 * workflow class so it can be unit-tested without spinning up the runtime.
 */
export function computeToolScore(
  record: AirtableRecord,
  vendor: VendorFields | null,
): ScoreOutput {
  const tool = record.fields as ToolFields & Record<string, unknown>;
  const result = computePriorityScore(tool, vendor);

  // ----- Completeness: ratio of populated input fields out of the 10 ------
  // (5 integration + 5 demand). `g2_rating` / `capterra_rating` aren't counted
  // separately — they only matter when their respective review counts exist,
  // which the count fields already capture.
  const populatedFields = PRIORITY_INPUT_FIELDS.filter((f) => {
    const v = record.fields[f];
    if (v === null || v === undefined || v === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  }).length;
  const completeness = populatedFields / PRIORITY_INPUT_FIELDS.length;
  const enrichmentStatus: 'enriched' | 'partial' | 'error' =
    completeness >= 0.75 ? 'enriched' : completeness >= 0.4 ? 'partial' : 'error';

  // ----- Confidence ratchets on populated pillars + signal density --------
  const pillarsPresent =
    (result.integration_score !== null ? 1 : 0) +
    (result.demand_score !== null ? 1 : 0);
  const totalPopulated = result.integration_populated + result.demand_populated;

  // ----- Flags: missing-source markers + structural problems --------------
  const flags: string[] = [];
  if (record.fields['marketplace_checked_at'] === undefined) flags.push('missing_marketplace_check');
  if (record.fields['api_docs_checked_at'] === undefined) flags.push('missing_api_docs_check');
  if (record.fields['ipaas_checked_at'] === undefined) flags.push('missing_ipaas_check');
  if (record.fields['reviews_checked_at'] === undefined) flags.push('missing_reviews_check');
  if (record.fields['search_checked_at'] === undefined) flags.push('missing_search_check');
  if (record.fields['reddit_checked_at'] === undefined) flags.push('missing_reddit_check');
  const vendorIds = asStringArray(record.fields['vendors']);
  if (vendorIds.length === 0) flags.push('no_vendor_linked');
  else if (vendor === null) flags.push('vendor_unenriched');
  if (result.priority_score === null) flags.push('unscored');
  if (result.emerging_flag) flags.push('emerging');

  const now = new Date().toISOString();
  return {
    integration_score: result.integration_score,
    demand_score: result.demand_score,
    priority_score: result.priority_score,
    priority_tier: result.priority_tier,
    emerging_flag: result.emerging_flag,
    priority_confidence: confidenceFor(pillarsPresent, totalPopulated),
    priority_flags: JSON.stringify(flags),
    tool_data_completeness: completeness,
    tool_enrichment_status: enrichmentStatus,
    last_tool_enriched_at: now,
    last_scored_at: now,
  };
}

export class ProductScoreWorkflow extends ErrorCapturingWorkflow {
  override async runImpl(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId } = event.payload;

    const record = await checkpoint(step, 'fetch-tool', () =>
      getRecord(this.env, 'products', recordId),
    );

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

    const fields = computeToolScore(record, vendor);

    await checkpoint(step, 'write-fields', () =>
      updateRecord(this.env, 'products', recordId, fields),
    );

    return {
      fields,
      fieldsUpdated: Object.keys(fields),
      status: 'success' as const,
      note:
        fields.priority_score === null
          ? `Unscored — ${fields.priority_flags}`
          : `priority=${fields.priority_score} (Tier ${fields.priority_tier}, ${fields.priority_confidence})`,
    };
  }
}

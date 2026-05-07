// ---------------------------------------------------------------------------
// MCP scoring tools — synchronous Vendor Quality Score (VQS) and Tool
// Priority Score (T08) computation.
//
// Pure math, no LLM. Both tools fetch the record, compute the score, write
// it back to Airtable, and return the values. They live next to
// research-tools.ts because they're the same shape (one record_id in,
// computed fields out).
//
// `update_vendor` and `update_product` already call `scoreVendor` /
// `scoreProduct` synchronously today, so playbooks should NOT also call
// these tools after a successful update. They're here for explicit re-scoring
// from playbooks that didn't do an `update_*` (e.g. when only the linked
// vendor changed and a product needs to recompute).
// ---------------------------------------------------------------------------
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { scoreVendor, scoreProduct } from '../../services/scoring';
import { err, ok, toMessage } from '../helpers';

export function registerScoringTools(server: McpServer, getEnv: () => Env): void {
  server.tool(
    'compute_vendor_score',
    'Recompute the Vendor Quality Score (Credibility / Momentum / Fit) for a vendor and write the result to Airtable. Pure math — no LLM, no external APIs. Use this only when you need to re-score without first calling update_vendor (e.g. when an upstream signal changed via direct Airtable edit). update_vendor already calls scoreVendor synchronously, so do not chain this after a successful update_vendor.',
    {
      record_id: z
        .string()
        .min(1)
        .describe('Airtable record ID of the vendor, e.g. "rec0123…".'),
    },
    async (input) => {
      try {
        const { fields, summary } = await scoreVendor(getEnv(), input.record_id);
        return ok({
          record_id: input.record_id,
          summary,
          fields,
        });
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );

  server.tool(
    'compute_product_score',
    'Recompute the tool priority score (Integration / Demand pillars + tier + emerging-flag heuristic) for a product and write the result to Airtable. Reads the product\'s linked vendor for the emerging-flag founded_year check. Pure math — no LLM, no external APIs. update_product already calls scoreProduct synchronously, so do not chain this after a successful update_product.',
    {
      record_id: z
        .string()
        .min(1)
        .describe('Airtable record ID of the product, e.g. "rec0123…".'),
    },
    async (input) => {
      try {
        const { fields, summary } = await scoreProduct(getEnv(), input.record_id);
        return ok({
          record_id: input.record_id,
          summary,
          fields,
        });
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );
}

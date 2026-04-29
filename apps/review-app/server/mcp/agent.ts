// ---------------------------------------------------------------------------
// AeciReviewMcp — remote MCP server hosted by this Worker.
//
// Exposes one tool today: `create_vendor_and_research`, which seeds a minimal
// vendor row in Airtable and spawns the vendor enrichment orchestrator. The
// tool returns the new Airtable record ID and the orchestrator run ID so the
// caller can poll status via /api/workflows/vendor-orchestrator/runs/:runId.
//
// Mounted at /mcp by index.ts and gated by a Bearer MCP_TOKEN there.
// ---------------------------------------------------------------------------
import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../env';
import {
  CreateVendorValidationError,
  createVendorAndStartOrchestrator,
} from '../services/createVendor';

// We don't pass our narrowed `Env` to McpAgent because its constraint
// (`extends Cloudflare.Env`) clashes with our `BROWSER` override. Cast at
// each use site instead so tools still get our typed bindings.
export class AeciReviewMcp extends McpAgent {
  server = new McpServer({ name: 'aeci-review-mcp', version: '1.0.0' });

  private get appEnv(): Env {
    return this.env as unknown as Env;
  }

  async init() {
    this.server.tool(
      'create_vendor_and_research',
      'Create a new vendor record from minimal LLM-research info, then start the vendor enrichment orchestrator. Returns the new Airtable record ID and the orchestrator run ID.',
      {
        company_name: z
          .string()
          .min(1)
          .describe('The vendor company name. Required.'),
        website: z
          .string()
          .url()
          .optional()
          .describe('Primary marketing site, e.g. https://acme.com.'),
        description: z
          .string()
          .optional()
          .describe('Short freeform description (1–3 sentences).'),
        force_refresh: z
          .boolean()
          .optional()
          .describe(
            'If true, the orchestrator re-runs every leaf enrichment regardless of staleness.',
          ),
        model: z
          .string()
          .optional()
          .describe(
            "Override the orchestrator's Claude model (e.g. claude-sonnet-4-6). Defaults to env.DEFAULT_MODEL.",
          ),
        skip_orchestrator: z
          .boolean()
          .optional()
          .describe(
            'If true, only create the Airtable row; do not start the enrichment workflow.',
          ),
      },
      async (input) => {
        try {
          const result = await createVendorAndStartOrchestrator(this.appEnv, {
            companyName: input.company_name,
            website: input.website,
            description: input.description,
            forceRefresh: input.force_refresh,
            model: input.model,
            skipOrchestrator: input.skip_orchestrator,
            triggeredBy: 'mcp',
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        } catch (err) {
          const message =
            err instanceof CreateVendorValidationError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
          return {
            isError: true,
            content: [{ type: 'text', text: message }],
          };
        }
      },
    );
  }
}

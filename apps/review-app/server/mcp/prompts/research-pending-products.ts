// ---------------------------------------------------------------------------
// MCP prompt: research_pending_products
//
// Surfaces the canonical research playbook (playbooks/research-pending-products.md)
// to MCP clients as a slash command. In claude.ai with this connector enabled
// the user types `/` and picks "research_pending_products" — the full playbook
// is injected as a user message and the client-side model executes it using
// the regular MCP tools (list_products, update_product, etc.).
//
// The playbook .md is bundled as a raw string at build time via the Wrangler
// `Text` rule in wrangler.jsonc, so this file is the only place that needs
// updating if the import path changes.
//
// No tokens are spent server-side: the prompt callback is a pure string concat.
// ---------------------------------------------------------------------------
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
// Bundled at build time as a string (see wrangler.jsonc → rules → Text).
import promptBody from '../../../../../playbooks/research-pending-products.md';

export function registerResearchPrompts(server: McpServer): void {
  server.prompt(
    'research_pending_products',
    'Research pending products in the AECi Review base using the standard playbook. Optionally pass a free-form scope (e.g. "the first 20 pending in BIM").',
    {
      invocation: z
        .string()
        .optional()
        .describe(
          'Free-form scope for this run, e.g. "the first 20 pending products" or "everything pending in the Estimating category". Appended to the playbook verbatim.',
        ),
    },
    ({ invocation }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              invocation && invocation.trim().length > 0
                ? `${promptBody}\n\n---\n\n**This invocation:** ${invocation}`
                : promptBody,
          },
        },
      ],
    }),
  );
}

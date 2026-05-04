// ---------------------------------------------------------------------------
// MCP product tools: list, get, create+research, update.
// ---------------------------------------------------------------------------
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import {
  fetchIntegrations,
  fetchProducts,
  tableId,
  updateRecord,
} from '../../services/airtable';
import { cacheInvalidate } from '../../services/cache';
import {
  buildLookupMaps,
  hydrateProduct,
  hydrateProductDetail,
} from '../../hydrate';
import {
  CreateProductValidationError,
  createProductAndStartOrchestrator,
} from '../../services/createProduct';
import { err, ok, toMessage } from '../helpers';

const PRODUCT_PATCH_FIELD_MAP: Record<string, string> = {
  name: 'Name',
  description: 'description',
  website: 'website',
  tool_integrations_url: 'tool_integrations_url',
  api_docs_url: 'api_docs_url',
  has_api_docs: 'has_api_docs',
  research_status: 'research_status',
  promotion_status: 'promotion_status',
  research_notes: 'research_notes',
  tool_integration_check_notes: 'tool_integration_check_notes',
  admin_notes: 'admin_notes',
  category: 'category',
  supported_disciplines: 'supported_disciplines',
  supported_project_phases: 'supported_project_phases',
  vendors: 'vendors',
};

export function registerProductTools(
  server: McpServer,
  getEnv: () => Env,
): void {
  // -------------------------------------------------------------------------
  // list_products
  // -------------------------------------------------------------------------
  server.tool(
    'list_products',
    'List products (a.k.a. tools). Filter by search, category/discipline/phase ID, research_status, priority tier, vendor ID, or include_rejected. Default sort is by name. Use this to find a product before calling get_product / update_product, or to check whether a product already exists before create_product_and_research.',
    {
      search: z
        .string()
        .optional()
        .describe(
          'Substring matched (case-insensitive) against name, description, and linked vendor names.',
        ),
      category_id: z.string().optional().describe('Filter to products linked to this category record ID.'),
      discipline_id: z.string().optional(),
      phase_id: z.string().optional(),
      vendor_id: z.string().optional().describe('Filter to products linked to this vendor record ID.'),
      research_status: z
        .string()
        .optional()
        .describe('Exact match on research_status (e.g. "Pending", "Done").'),
      priority_tier: z.string().optional(),
      enrichment_status: z.string().optional(),
      include_rejected: z
        .boolean()
        .optional()
        .describe(
          'When true, include products with promotion_status="rejected". Defaults to false.',
        ),
      offset: z.number().int().min(0).optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Defaults to 50. Max 200.'),
    },
    async (input) => {
      const env = getEnv();
      try {
        const [raw, maps] = await Promise.all([
          fetchProducts(env),
          buildLookupMaps(env),
        ]);
        let hydrated = raw.map((r) => hydrateProduct(r, maps));
        const search = input.search?.trim().toLowerCase();
        if (search) {
          hydrated = hydrated.filter((p) => {
            const haystack = [
              p.name,
              p.description ?? '',
              ...p.vendors.map((v) => v.name),
            ]
              .join(' ')
              .toLowerCase();
            return haystack.includes(search);
          });
        }
        if (input.category_id) {
          hydrated = hydrated.filter((p) =>
            p.categories.some((c) => c.id === input.category_id),
          );
        }
        if (input.discipline_id) {
          hydrated = hydrated.filter((p) =>
            p.disciplines.some((d) => d.id === input.discipline_id),
          );
        }
        if (input.phase_id) {
          hydrated = hydrated.filter((p) =>
            p.phases.some((ph) => ph.id === input.phase_id),
          );
        }
        if (input.vendor_id) {
          hydrated = hydrated.filter((p) =>
            p.vendors.some((v) => v.id === input.vendor_id),
          );
        }
        if (input.research_status) {
          hydrated = hydrated.filter((p) => p.researchStatus === input.research_status);
        }
        if (input.priority_tier) {
          hydrated = hydrated.filter((p) => p.priorityTier === input.priority_tier);
        }
        if (input.enrichment_status) {
          hydrated = hydrated.filter((p) => p.toolEnrichmentStatus === input.enrichment_status);
        }
        if (!input.include_rejected) {
          hydrated = hydrated.filter((p) => p.promotionStatus !== 'rejected');
        }
        hydrated.sort((a, b) => a.name.localeCompare(b.name));

        const offset = Math.max(0, input.offset ?? 0);
        const limit = Math.min(200, input.limit ?? 50);
        const total = hydrated.length;
        const data = hydrated.slice(offset, offset + limit).map((p) => ({
          id: p.id,
          name: p.name,
          website: p.website,
          vendors: p.vendors,
          categories: p.categories,
          researchStatus: p.researchStatus,
          promotionStatus: p.promotionStatus,
          priorityTier: p.priorityTier,
          priorityScore: p.priorityScore,
          integrationCount: p.integrationCount,
          hasApiDocs: p.hasApiDocs,
        }));
        return ok({ data, total, offset, limit });
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_product
  // -------------------------------------------------------------------------
  server.tool(
    'get_product',
    'Fetch a single product by Airtable record ID. Returns the full ProductDetail including integrations as source/target, integrated products, and the integrations-discovery summary + unresolved candidates.',
    {
      record_id: z
        .string()
        .min(1)
        .describe('Airtable record ID, e.g. "rec0123456789ABCD".'),
    },
    async (input) => {
      const env = getEnv();
      try {
        const [products, integrations, maps] = await Promise.all([
          fetchProducts(env),
          fetchIntegrations(env),
          buildLookupMaps(env),
        ]);
        const record = products.find((r) => r.id === input.record_id);
        if (!record) return err(`Product not found: ${input.record_id}`);
        return ok(hydrateProductDetail(record, maps, integrations, products));
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // create_product_and_research
  // -------------------------------------------------------------------------
  server.tool(
    'create_product_and_research',
    'Create a new product record from minimal LLM-research info, then start the product enrichment orchestrator (research → overview → leaf enrichments → score). Returns the new Airtable record ID and the orchestrator run ID. Use list_products first to confirm the product does not already exist — there is no built-in dedupe.',
    {
      name: z
        .string()
        .min(1)
        .describe('The product name as it appears on the vendor site (drop legal suffixes).'),
      website: z
        .string()
        .url()
        .optional()
        .describe('Primary marketing URL for the product, e.g. https://acme.com/widget.'),
      description: z
        .string()
        .optional()
        .describe('Short freeform description (1–3 sentences). Will be overwritten by the research step.'),
      force_refresh: z
        .boolean()
        .optional()
        .describe('Forces the orchestrator to re-run every leaf regardless of staleness. No-op for new records.'),
      model: z
        .string()
        .optional()
        .describe(
          "Override the orchestrator's Claude model (e.g. claude-sonnet-4-6). Defaults to env.DEFAULT_MODEL.",
        ),
      skip_orchestrator: z
        .boolean()
        .optional()
        .describe('If true, only create the Airtable row; do not start the enrichment workflow.'),
    },
    async (input) => {
      try {
        const result = await createProductAndStartOrchestrator(getEnv(), {
          name: input.name,
          website: input.website,
          description: input.description,
          forceRefresh: input.force_refresh,
          model: input.model,
          skipOrchestrator: input.skip_orchestrator,
          triggeredBy: 'mcp',
        });
        return ok(result);
      } catch (e) {
        if (e instanceof CreateProductValidationError) return err(e.message);
        return err(toMessage(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // update_product
  // -------------------------------------------------------------------------
  server.tool(
    'update_product',
    'Patch fields on an existing product record. Only provided fields are written. Linked-record fields (category, supported_disciplines, supported_project_phases, vendors) accept arrays of Airtable record IDs (use list_vendors / list_meta-style lookups to get IDs). Returns the updated ProductDetail.',
    {
      record_id: z
        .string()
        .min(1)
        .describe('Airtable record ID of the product to update.'),
      name: z.string().optional(),
      description: z.string().optional(),
      website: z.string().optional(),
      tool_integrations_url: z.string().optional(),
      api_docs_url: z.string().optional(),
      has_api_docs: z.boolean().optional(),
      research_status: z.string().optional(),
      promotion_status: z
        .enum(['pending', 'ready', 'promoted', 'retracted', 'rejected'])
        .optional(),
      research_notes: z.string().optional(),
      tool_integration_check_notes: z.string().optional(),
      admin_notes: z.string().optional(),
      category: z
        .array(z.string())
        .optional()
        .describe('Array of category record IDs.'),
      supported_disciplines: z
        .array(z.string())
        .optional()
        .describe('Array of discipline record IDs.'),
      supported_project_phases: z
        .array(z.string())
        .optional()
        .describe('Array of project-phase record IDs.'),
      vendors: z
        .array(z.string())
        .optional()
        .describe('Array of vendor record IDs.'),
    },
    async (input) => {
      const env = getEnv();
      const fields: Record<string, unknown> = {};
      for (const [key, airtableKey] of Object.entries(PRODUCT_PATCH_FIELD_MAP)) {
        const value = (input as Record<string, unknown>)[key];
        if (value !== undefined) fields[airtableKey] = value;
      }
      if (Object.keys(fields).length === 0) {
        return err('No editable fields provided.');
      }
      try {
        const updated = await updateRecord(
          env,
          'products',
          input.record_id,
          fields,
        );
        await cacheInvalidate(env.KV_CACHE, `table:${tableId(env, 'products')}`);
        const [integrations, maps, products] = await Promise.all([
          fetchIntegrations(env),
          buildLookupMaps(env),
          fetchProducts(env),
        ]);
        return ok(hydrateProductDetail(updated, maps, integrations, products));
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );
}

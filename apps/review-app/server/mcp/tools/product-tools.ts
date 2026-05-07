// ---------------------------------------------------------------------------
// MCP product tools: list, get, create+research, update.
// ---------------------------------------------------------------------------
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import {
  fetchIntegrations,
  fetchProducts,
  getRecord,
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
  CreateProductDuplicateError,
  CreateProductValidationError,
  createProductAndStartOrchestrator,
} from '../../services/createProduct';
import { findProductMatches } from '../../services/productMatch';
import { scoreProduct } from '../../services/scoring';
import { buildRejectedProductIds, err, ok, toMessage } from '../helpers';

const PRODUCT_PATCH_FIELD_MAP: Record<string, string> = {
  name: 'Name',
  description: 'description',
  website: 'website',
  tool_integrations_url: 'tool_integrations_url',
  api_docs_url: 'api_docs_url',
  has_api_docs: 'has_api_docs',
  api_docs_checked_at: 'api_docs_checked_at',
  research_status: 'research_status',
  promotion_status: 'promotion_status',
  product_role: 'product_role',
  extension_of: 'extension_of',
  research_notes: 'research_notes',
  tool_integration_check_notes: 'tool_integration_check_notes',
  admin_notes: 'admin_notes',
  category: 'category',
  supported_disciplines: 'supported_disciplines',
  supported_project_phases: 'supported_project_phases',
  vendors: 'vendors',
  // usefulness is a JSON object that gets stringified on the way to Airtable
  // (it's stored in a long-text cell). Hydration parses it back out.
  usefulness: 'usefulness',
  // Reviews leaf (G2 + Capterra). Mirrors workflows/product/reviews.ts +
  // overview.ts. Set reviews_checked_at to the current ISO timestamp when
  // any of the rating/count fields land.
  g2_rating: 'g2_rating',
  g2_review_count: 'g2_review_count',
  g2_url: 'g2_url',
  capterra_rating: 'capterra_rating',
  capterra_review_count: 'capterra_review_count',
  capterra_url: 'capterra_url',
  reviews_checked_at: 'reviews_checked_at',
  // Marketplace leaf. Mirrors workflows/product/marketplace.ts.
  marketplace_count: 'marketplace_count',
  source_marketplaces: 'source_marketplaces',
  marketplace_checked_at: 'marketplace_checked_at',
  // iPaaS leaf. Mirrors workflows/product/ipaas.ts.
  ipaas_count: 'ipaas_count',
  ipaas_platforms: 'ipaas_platforms',
  ipaas_checked_at: 'ipaas_checked_at',
};

const MARKETPLACE_NAMES = ['Procore', 'ACC', 'Trimble', 'Bluebeam'] as const;
const IPAAS_PLATFORM_NAMES = ['Zapier', 'Make', 'Workato'] as const;

const usefulnessEntrySchema = z.object({
  id: z.string().min(1).describe('Airtable record ID of the discipline / phase.'),
  name: z.string().min(1).describe('Display name of the discipline / phase.'),
  points: z
    .array(z.string().min(1))
    .min(1)
    .max(8)
    .describe('1–8 short bullets describing how this discipline / phase uses the product.'),
});

const usefulnessSchema = z.object({
  disciplines: z.array(usefulnessEntrySchema),
  phases: z.array(usefulnessEntrySchema),
});

export function registerProductTools(
  server: McpServer,
  getEnv: () => Env,
): void {
  // -------------------------------------------------------------------------
  // list_products
  // -------------------------------------------------------------------------
  server.tool(
    'list_products',
    'List products (a.k.a. tools). Filter by search, category/discipline/phase ID, research_status, priority tier, or vendor ID. Default sort is by name. Products with promotion_status="rejected" are always excluded — there is no opt-in to include them. Use this to find a product before calling get_product / update_product, or to check whether a product already exists before create_product_and_research.',
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
      product_role: z
        .enum(['application', 'connector', 'hybrid'])
        .optional()
        .describe(
          'Filter to products with this role. Use "connector" to find iPaaS / integration platforms (Zapier, n8n, Lindy, etc.). Products with no role set are treated as "application".',
        ),
      extension_of_id: z
        .string()
        .optional()
        .describe(
          'Filter to products whose `extension_of` includes this product record ID. E.g. pass SketchUp\'s id to find all SketchUp plug-ins.',
        ),
      is_extension: z
        .boolean()
        .optional()
        .describe(
          'true → only products that are extensions of another product (extension_of non-empty). false → only standalone products.',
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
        if (input.product_role) {
          hydrated = hydrated.filter(
            (p) => (p.productRole ?? 'application') === input.product_role,
          );
        }
        if (input.extension_of_id) {
          hydrated = hydrated.filter((p) =>
            p.extensionOf.some((h) => h.id === input.extension_of_id),
          );
        }
        if (input.is_extension !== undefined) {
          hydrated = hydrated.filter(
            (p) => p.extensionOf.length > 0 === input.is_extension,
          );
        }
        hydrated = hydrated.filter((p) => p.promotionStatus !== 'rejected');
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
          productRole: p.productRole,
          extensionOf: p.extensionOf,
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
        const detail = hydrateProductDetail(record, maps, integrations, products);
        if (detail.promotionStatus === 'rejected') {
          return err(`Product ${input.record_id} is rejected and is not exposed via MCP.`);
        }
        const rejectedProductIds = buildRejectedProductIds(products);
        const isOk = (otherId: string | undefined): boolean =>
          !!otherId && !rejectedProductIds.has(otherId);
        const filteredDetail = {
          ...detail,
          integrationsAsSource: detail.integrationsAsSource.filter((i) =>
            isOk(i.targetProduct?.id),
          ),
          integrationsAsTarget: detail.integrationsAsTarget.filter((i) =>
            isOk(i.sourceProduct?.id),
          ),
          integratedProducts: detail.integratedProducts.filter(
            (p) => !rejectedProductIds.has(p.id),
          ),
          poweredIntegrations: detail.poweredIntegrations.filter(
            (i) => isOk(i.sourceProduct?.id) && isOk(i.targetProduct?.id),
          ),
        };
        return ok(filteredDetail);
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
    'Create a new product record from minimal LLM-research info, then start the product enrichment orchestrator (research → overview → leaf enrichments → score). Returns the new Airtable record ID and the orchestrator run ID. A server-side duplicate guard runs before insertion: if a high-confidence match exists (same normalized name, same website hostname, or shared vendor + token-subset name), the tool returns `{ duplicate: true, matches: [...] }` instead of creating — adopt the existing record id from `matches[0].product.id`, or retry with `allow_duplicate: true` if you are sure it is a distinct product. Pass `vendor_id` whenever the vendor is known up front (seed playbooks always do) so the linked `vendors` field is populated at creation time and so the duplicate guard can use vendor scoping.',
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
      extension_of: z
        .array(z.string())
        .optional()
        .describe(
          'Array of host product record IDs this product is an extension/plug-in of (e.g. SketchUp\'s id for a SketchUp plug-in). Most extensions have one host; some target several.',
        ),
      vendor_id: z
        .string()
        .optional()
        .describe(
          'Airtable record ID of the vendor that makes this product. Sets the linked-record `vendors` field at creation time so the product is correctly attributed even if a follow-up update_product never lands. Always supply this from seed playbooks where the vendor is known.',
        ),
      allow_duplicate: z
        .boolean()
        .optional()
        .describe(
          'Bypass the server-side duplicate guard. Only set after inspecting the `matches` returned by a prior duplicate response and confirming the new row is genuinely a distinct product (e.g. a vendor with two similarly-named SKUs). Defaults to false.',
        ),
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
          extensionOf: input.extension_of,
          vendorId: input.vendor_id,
          allowDuplicate: input.allow_duplicate,
          triggeredBy: 'mcp',
        });
        return ok({ duplicate: false, ...result });
      } catch (e) {
        if (e instanceof CreateProductDuplicateError) {
          // Not a true error — surface the existing record(s) so the caller
          // can adopt one without a second round-trip. Caller flips
          // `allow_duplicate: true` to override.
          return ok({
            duplicate: true,
            matches: e.matches,
            hint:
              'A high-confidence duplicate already exists. Adopt matches[0].product.id ' +
              'instead of creating, or retry with allow_duplicate: true if this is ' +
              'genuinely a distinct product.',
          });
        }
        if (e instanceof CreateProductValidationError) return err(e.message);
        return err(toMessage(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // find_product
  // -------------------------------------------------------------------------
  server.tool(
    'find_product',
    'Look up an existing product by candidate name, website, and/or vendor. Returns ranked matches with confidence (high|medium|low) and the reason(s) each candidate matched. High-confidence signals: exact normalized-name match, shared website hostname, or shared vendor + token-subset name. Use this BEFORE create_product_and_research to avoid duplicates — name-only substring search via list_products misses common cases (acronyms, legal suffixes, casing). Pass at least one of `name` or `website`. Rejected products are excluded.',
    {
      name: z
        .string()
        .optional()
        .describe(
          'Candidate product name (e.g. "Bluebeam Revu", "Autodesk Construction Cloud", "ACC"). Will be normalized (lowercased, legal suffixes stripped, punctuation dropped) before comparison.',
        ),
      website: z
        .string()
        .optional()
        .describe(
          'Candidate product website. Hostname is extracted and lowercased before comparison; bare hostnames ("acme.com") are accepted.',
        ),
      vendor_id: z
        .string()
        .optional()
        .describe(
          'Optional Airtable vendor record ID. When provided, the matcher upgrades token-subset name matches scoped to this vendor to high confidence (handles "ACC" ↔ "Autodesk Construction Cloud" within Autodesk).',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Maximum matches to return. Defaults to 10.'),
    },
    async (input) => {
      const env = getEnv();
      const name = input.name?.trim();
      const website = input.website?.trim();
      if (!name && !website) {
        return err('Must provide at least one of `name` or `website`.');
      }
      try {
        const matches = await findProductMatches(env, {
          name,
          website,
          vendorId: input.vendor_id,
        });
        const limit = input.limit ?? 10;
        return ok({
          matches: matches.slice(0, limit),
          total: matches.length,
        });
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // update_product
  // -------------------------------------------------------------------------
  server.tool(
    'update_product',
    'Patch fields on an existing product record. Only provided fields are written. Linked-record fields (category, supported_disciplines, supported_project_phases, vendors) accept arrays of Airtable record IDs (use list_vendors / list_meta-style lookups to get IDs). Also accepts the leaf-scoring inputs the cloud product-orchestrator writes (g2_*, capterra_*, has_api_docs / api_docs_url, marketplace_count + source_marketplaces, ipaas_count + ipaas_platforms, plus the `*_checked_at` timestamps that clear the matching `missing_*_check` flag). After the patch, priority_score / priority_tier / priority_flags / tool_data_completeness / tool_enrichment_status are recomputed synchronously — never set those yourself. Returns the updated ProductDetail with score_summary.',
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
      product_role: z
        .enum(['application', 'connector', 'hybrid'])
        .optional()
        .describe(
          'Classify the product. "connector" marks iPaaS / integration platforms (Zapier, n8n, Lindy). "hybrid" is an application that also exposes a connector platform. Defaults to "application" when unset.',
        ),
      extension_of: z
        .array(z.string())
        .optional()
        .describe(
          'Array of host product record IDs this product is an extension/plug-in of (e.g. SketchUp\'s id for a SketchUp plug-in). Pass [] to clear. Most extensions have one host; some target several (a plug-in that ships for Revit AND ArchiCAD).',
        ),
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
      usefulness: usefulnessSchema
        .optional()
        .describe(
          'Structured "how does each discipline / phase use this product?" payload. ' +
            'Each entry must reference an `id` that is among the product\'s linked ' +
            'disciplines / phases — use list_taxonomy to look up record IDs. ' +
            'Stored on Airtable as JSON in the `usefulness` long-text field.',
        ),
      // ---- Leaf-scoring inputs (mirrors cloud product-orchestrator leaves) -
      // The scoring service (services/scoring.ts) reads these fields off the
      // record and recomputes priority_score / priority_tier / priority_flags
      // synchronously after the patch. The `*_checked_at` timestamps clear the
      // matching `missing_*_check` flags. Pass `null` to clear a field.
      api_docs_checked_at: z
        .string()
        .optional()
        .describe('ISO timestamp of the most recent api-docs check. Set when has_api_docs / api_docs_url were just refreshed.'),
      g2_rating: z.number().nullable().optional(),
      g2_review_count: z.number().int().nullable().optional(),
      g2_url: z.string().nullable().optional(),
      capterra_rating: z.number().nullable().optional(),
      capterra_review_count: z.number().int().nullable().optional(),
      capterra_url: z.string().nullable().optional(),
      reviews_checked_at: z
        .string()
        .optional()
        .describe('ISO timestamp of the most recent G2 / Capterra check. Set when any of the four rating/count fields were just written.'),
      marketplace_count: z
        .number()
        .int()
        .min(0)
        .max(MARKETPLACE_NAMES.length)
        .optional()
        .describe('Number of AEC marketplaces this product is published to (0–4).'),
      source_marketplaces: z
        .array(z.enum(MARKETPLACE_NAMES))
        .optional()
        .describe(
          `AEC marketplaces with a verified vendor-published listing. Allowed values: ${MARKETPLACE_NAMES.join(', ')}. (Note: Autodesk's marketplace is "ACC".)`,
        ),
      marketplace_checked_at: z
        .string()
        .optional()
        .describe('ISO timestamp of the most recent marketplace sweep.'),
      ipaas_count: z
        .number()
        .int()
        .min(0)
        .max(IPAAS_PLATFORM_NAMES.length)
        .optional()
        .describe('Number of iPaaS platforms with a published connector for this product (0–3).'),
      ipaas_platforms: z
        .array(z.enum(IPAAS_PLATFORM_NAMES))
        .optional()
        .describe(
          `iPaaS platforms with a verified published connector. Allowed values: ${IPAAS_PLATFORM_NAMES.join(', ')}.`,
        ),
      ipaas_checked_at: z
        .string()
        .optional()
        .describe('ISO timestamp of the most recent iPaaS sweep.'),
    },
    async (input) => {
      const env = getEnv();
      const fields: Record<string, unknown> = {};
      for (const [key, airtableKey] of Object.entries(PRODUCT_PATCH_FIELD_MAP)) {
        const value = (input as Record<string, unknown>)[key];
        if (value === undefined) continue;
        // usefulness is the only field that needs to be serialized — it's a
        // structured object on the wire but a long-text cell in Airtable.
        fields[airtableKey] = key === 'usefulness' ? JSON.stringify(value) : value;
      }
      if (Object.keys(fields).length === 0) {
        return err('No editable fields provided.');
      }
      try {
        const existing = await fetchProducts(env);
        const existingRecord = existing.find((r) => r.id === input.record_id);
        if (!existingRecord) return err(`Product not found: ${input.record_id}`);
        const existingPromotion = existingRecord.get('promotion_status');
        if (typeof existingPromotion === 'string' && existingPromotion === 'rejected') {
          return err(`Product ${input.record_id} is rejected and cannot be updated via MCP.`);
        }
        await updateRecord(env, 'products', input.record_id, fields);

        // Synchronously recompute the priority score (Integration / Demand
        // pillars + tier + emerging-flag) so the response reflects the new
        // score in one round-trip. Pure math — no LLM, no external APIs.
        // Loop-safe: scoreProduct writes via the raw Airtable service, never
        // re-entering this MCP tool.
        let scoreSummary: string | undefined;
        try {
          const result = await scoreProduct(env, input.record_id);
          scoreSummary = result.summary;
        } catch (e) {
          console.error(
            '[update_product] scoreProduct failed',
            input.record_id,
            String(e),
          );
        }

        await cacheInvalidate(env.KV_CACHE, `table:${tableId(env, 'products')}`);

        // Re-fetch the single record so the response reflects scoreProduct's
        // writes (the cached fetchProducts snapshot is stale until next pull).
        const fresh = await getRecord(env, 'products', input.record_id);
        const [integrations, maps, products] = await Promise.all([
          fetchIntegrations(env),
          buildLookupMaps(env),
          fetchProducts(env),
        ]);
        const detail = hydrateProductDetail(fresh, maps, integrations, products);
        const rejectedProductIds = buildRejectedProductIds(products);
        const isOk = (otherId: string | undefined): boolean =>
          !!otherId && !rejectedProductIds.has(otherId);
        return ok({
          ...detail,
          score_summary: scoreSummary,
          integrationsAsSource: detail.integrationsAsSource.filter((i) =>
            isOk(i.targetProduct?.id),
          ),
          integrationsAsTarget: detail.integrationsAsTarget.filter((i) =>
            isOk(i.sourceProduct?.id),
          ),
          integratedProducts: detail.integratedProducts.filter(
            (p) => !rejectedProductIds.has(p.id),
          ),
          poweredIntegrations: detail.poweredIntegrations.filter(
            (i) => isOk(i.sourceProduct?.id) && isOk(i.targetProduct?.id),
          ),
        });
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );
}

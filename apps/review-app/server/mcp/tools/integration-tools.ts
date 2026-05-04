// ---------------------------------------------------------------------------
// MCP integration tools: list, get, create, update.
//
// Integrations link two products (Source Tool, Target Tool). Most integration
// records get created automatically by the integrations-discovery workflow,
// but these tools let an LLM materialize / edit one directly when it has
// high-confidence evidence.
// ---------------------------------------------------------------------------
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import {
  createRecord,
  fetchIntegrations,
  fetchProducts,
  fetchVendors,
  tableId,
  updateRecord,
} from '../../services/airtable';
import { cacheInvalidate } from '../../services/cache';
import { buildLookupMaps, hydrateIntegration } from '../../hydrate';
import { err, ok, toMessage } from '../helpers';

const MECHANISM_KINDS = [
  'native',
  'iPaaS',
  'marketplace-app',
  'api',
  'webhook',
  'partner',
] as const;

export function registerIntegrationTools(
  server: McpServer,
  getEnv: () => Env,
): void {
  // -------------------------------------------------------------------------
  // list_integrations
  // -------------------------------------------------------------------------
  server.tool(
    'list_integrations',
    'List integration records. Filter by source/target/powered-by product ID, mechanism kind, maturity, pricing model, or built-by vendor ID. Default sort is by name.',
    {
      search: z
        .string()
        .optional()
        .describe('Substring matched against name, description, mechanism_name, notes, source/target product names.'),
      source_product_id: z.string().optional(),
      target_product_id: z.string().optional(),
      powered_by_product_id: z.string().optional(),
      mechanism_kind: z.enum(MECHANISM_KINDS).optional(),
      maturity: z.string().optional(),
      pricing_model: z.string().optional(),
      built_by_vendor_id: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (input) => {
      const env = getEnv();
      try {
        const [raw, maps] = await Promise.all([
          fetchIntegrations(env),
          buildLookupMaps(env),
        ]);
        let hydrated = raw.map((r) => hydrateIntegration(r, maps));
        const search = input.search?.trim().toLowerCase();
        if (search) {
          hydrated = hydrated.filter((i) => {
            const haystack = [
              i.name,
              i.description ?? '',
              i.mechanismName ?? '',
              i.notes ?? '',
              i.sourceProduct?.name ?? '',
              i.targetProduct?.name ?? '',
            ]
              .join(' ')
              .toLowerCase();
            return haystack.includes(search);
          });
        }
        if (input.source_product_id) {
          hydrated = hydrated.filter((i) => i.sourceProduct?.id === input.source_product_id);
        }
        if (input.target_product_id) {
          hydrated = hydrated.filter((i) => i.targetProduct?.id === input.target_product_id);
        }
        if (input.powered_by_product_id) {
          hydrated = hydrated.filter((i) => i.poweredByProduct?.id === input.powered_by_product_id);
        }
        if (input.mechanism_kind) {
          hydrated = hydrated.filter((i) => i.mechanismKind === input.mechanism_kind);
        }
        if (input.maturity) {
          hydrated = hydrated.filter((i) => i.maturity === input.maturity);
        }
        if (input.pricing_model) {
          hydrated = hydrated.filter((i) => i.pricingModel === input.pricing_model);
        }
        if (input.built_by_vendor_id) {
          hydrated = hydrated.filter((i) => i.builtBy?.id === input.built_by_vendor_id);
        }
        hydrated.sort((a, b) => a.name.localeCompare(b.name));

        const offset = Math.max(0, input.offset ?? 0);
        const limit = Math.min(200, input.limit ?? 50);
        const total = hydrated.length;
        const data = hydrated.slice(offset, offset + limit);
        return ok({ data, total, offset, limit });
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_integration
  // -------------------------------------------------------------------------
  server.tool(
    'get_integration',
    'Fetch a single integration record by Airtable record ID. Returns the full IntegrationSummary (source/target product LinkRefs, mechanism, listing/docs URLs, notes).',
    {
      record_id: z
        .string()
        .min(1)
        .describe('Airtable record ID, e.g. "rec0123456789ABCD".'),
    },
    async (input) => {
      const env = getEnv();
      try {
        const [raw, maps] = await Promise.all([
          fetchIntegrations(env),
          buildLookupMaps(env),
        ]);
        const record = raw.find((r) => r.id === input.record_id);
        if (!record) return err(`Integration not found: ${input.record_id}`);
        return ok(hydrateIntegration(record, maps));
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // create_integration
  // -------------------------------------------------------------------------
  server.tool(
    'create_integration',
    'Manually create an integration record linking two existing products. Both source_product_id and target_product_id must be valid Airtable record IDs (use list_products to find them; create products first if they do not exist). Most integrations are created automatically by the discovery workflow — only call this when you have direct evidence and want to bypass discovery.',
    {
      source_product_id: z
        .string()
        .min(1)
        .describe('Airtable record ID of the source product (the one being integrated FROM).'),
      target_product_id: z
        .string()
        .min(1)
        .describe('Airtable record ID of the target product (the one being integrated TO).'),
      name: z
        .string()
        .optional()
        .describe('Display name. If omitted, defaults to "{target_name} (manual)".'),
      listing_url: z
        .string()
        .url()
        .describe('Required. URL where evidence of this integration was found (marketplace listing, docs page, partner page).'),
      mechanism_kind: z.enum(MECHANISM_KINDS).optional(),
      mechanism_name: z
        .string()
        .optional()
        .describe('Free-text mechanism label (e.g. "Zapier connector", "Procore App").'),
      direction: z.enum(['one-way', 'bidirectional']).optional(),
      description: z.string().optional(),
      docs_url: z.string().url().optional(),
      website: z.string().url().optional(),
      mechanism_url: z.string().url().optional(),
      pricing_model: z.string().optional(),
      maturity: z.string().optional(),
      built_by_vendor_id: z
        .string()
        .optional()
        .describe('Airtable record ID of the vendor who built this integration.'),
      powered_by_product_id: z
        .string()
        .optional()
        .describe('Airtable record ID of an iPaaS / connector product that powers this integration.'),
      notes: z.string().optional(),
    },
    async (input) => {
      const env = getEnv();
      try {
        const [products, vendors] = await Promise.all([
          fetchProducts(env),
          input.built_by_vendor_id ? fetchVendors(env) : Promise.resolve([]),
        ]);
        const sourceRecord = products.find((p) => p.id === input.source_product_id);
        const targetRecord = products.find((p) => p.id === input.target_product_id);
        if (!sourceRecord) return err(`source_product_id not found: ${input.source_product_id}`);
        if (!targetRecord) return err(`target_product_id not found: ${input.target_product_id}`);
        if (input.source_product_id === input.target_product_id) {
          return err('source_product_id and target_product_id must differ');
        }
        if (input.powered_by_product_id) {
          if (!products.find((p) => p.id === input.powered_by_product_id)) {
            return err(`powered_by_product_id not found: ${input.powered_by_product_id}`);
          }
        }
        if (input.built_by_vendor_id) {
          if (!vendors.find((v) => v.id === input.built_by_vendor_id)) {
            return err(`built_by_vendor_id not found: ${input.built_by_vendor_id}`);
          }
        }

        const targetName = (targetRecord.get('Name') as string | undefined) ?? 'integration';
        const fields: Record<string, unknown> = {
          Name: input.name ?? `${targetName} (manual)`,
          'Source Tool': [input.source_product_id],
          'Target Tool': [input.target_product_id],
          listing_url: input.listing_url,
        };
        if (input.mechanism_kind) fields['mechanism_kind'] = input.mechanism_kind;
        if (input.mechanism_name) fields['mechanism_name'] = input.mechanism_name;
        if (input.direction) fields['direction'] = input.direction;
        if (input.description) fields['Description'] = input.description;
        if (input.docs_url) fields['docs_url'] = input.docs_url;
        if (input.website) fields['website'] = input.website;
        if (input.mechanism_url) fields['mechanism_url'] = input.mechanism_url;
        if (input.pricing_model) fields['pricing_model'] = input.pricing_model;
        if (input.maturity) fields['maturity'] = input.maturity;
        if (input.built_by_vendor_id) fields['built_by'] = [input.built_by_vendor_id];
        if (input.powered_by_product_id)
          fields['powered_by_product'] = [input.powered_by_product_id];
        if (input.notes) fields['notes'] = input.notes;

        const created = await createRecord(env, 'integrations', fields);
        await cacheInvalidate(env.KV_CACHE, `table:${tableId(env, 'integrations')}`);
        const maps = await buildLookupMaps(env);
        return ok(hydrateIntegration(created, maps));
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // update_integration
  // -------------------------------------------------------------------------
  server.tool(
    'update_integration',
    'Patch fields on an existing integration record. Only provided fields are written. source_product_id / target_product_id rewrite the linked-record arrays. Returns the updated IntegrationSummary.',
    {
      record_id: z.string().min(1),
      name: z.string().optional(),
      source_product_id: z.string().optional(),
      target_product_id: z.string().optional(),
      mechanism_kind: z.enum(MECHANISM_KINDS).optional(),
      mechanism_name: z.string().optional(),
      direction: z.enum(['one-way', 'bidirectional']).optional(),
      description: z.string().optional(),
      docs_url: z.string().optional(),
      website: z.string().optional(),
      mechanism_url: z.string().optional(),
      listing_url: z.string().optional(),
      pricing_model: z.string().optional(),
      maturity: z.string().optional(),
      built_by_vendor_id: z.string().optional(),
      powered_by_product_id: z.string().optional(),
      notes: z.string().optional(),
    },
    async (input) => {
      const env = getEnv();
      const fields: Record<string, unknown> = {};
      if (input.name !== undefined) fields['Name'] = input.name;
      if (input.source_product_id !== undefined)
        fields['Source Tool'] = [input.source_product_id];
      if (input.target_product_id !== undefined)
        fields['Target Tool'] = [input.target_product_id];
      if (input.mechanism_kind !== undefined) fields['mechanism_kind'] = input.mechanism_kind;
      if (input.mechanism_name !== undefined) fields['mechanism_name'] = input.mechanism_name;
      if (input.direction !== undefined) fields['direction'] = input.direction;
      if (input.description !== undefined) fields['Description'] = input.description;
      if (input.docs_url !== undefined) fields['docs_url'] = input.docs_url;
      if (input.website !== undefined) fields['website'] = input.website;
      if (input.mechanism_url !== undefined) fields['mechanism_url'] = input.mechanism_url;
      if (input.listing_url !== undefined) fields['listing_url'] = input.listing_url;
      if (input.pricing_model !== undefined) fields['pricing_model'] = input.pricing_model;
      if (input.maturity !== undefined) fields['maturity'] = input.maturity;
      if (input.built_by_vendor_id !== undefined)
        fields['built_by'] = [input.built_by_vendor_id];
      if (input.powered_by_product_id !== undefined)
        fields['powered_by_product'] = [input.powered_by_product_id];
      if (input.notes !== undefined) fields['notes'] = input.notes;

      if (Object.keys(fields).length === 0) {
        return err('No editable fields provided.');
      }
      try {
        const updated = await updateRecord(
          env,
          'integrations',
          input.record_id,
          fields,
        );
        await cacheInvalidate(env.KV_CACHE, `table:${tableId(env, 'integrations')}`);
        const maps = await buildLookupMaps(env);
        return ok(hydrateIntegration(updated, maps));
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );
}

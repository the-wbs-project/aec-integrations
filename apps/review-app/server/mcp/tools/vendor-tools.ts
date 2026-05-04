// ---------------------------------------------------------------------------
// MCP vendor tools: list, get, create+research (existing), update.
// ---------------------------------------------------------------------------
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { fetchVendors, tableId, updateRecord } from '../../services/airtable';
import { cacheInvalidate } from '../../services/cache';
import {
  buildLookupMaps,
  hydrateVendor,
  hydrateVendorDetail,
} from '../../hydrate';
import {
  CreateVendorValidationError,
  createVendorAndStartOrchestrator,
} from '../../services/createVendor';
import { err, ok, toMessage } from '../helpers';

const VENDOR_PATCH_FIELD_MAP: Record<string, string> = {
  company_name: 'company_name',
  description: 'description',
  website: 'website',
  headquarters: 'headquarters',
  founded_year: 'founded_year',
  public_private: 'public_private',
  parent_company: 'parent_company',
  linkedin_url: 'linkedin_url',
  crunchbase_url: 'crunchbase_url',
  wiki_url: 'wiki_url',
  source_url: 'source_url',
  github_org: 'github_org',
  phone_number: 'phone_number',
  contact_email: 'contact_email',
  admin_notes: 'admin_notes',
};

export function registerVendorTools(
  server: McpServer,
  getEnv: () => Env,
): void {
  // -------------------------------------------------------------------------
  // list_vendors
  // -------------------------------------------------------------------------
  server.tool(
    'list_vendors',
    'List vendors. Supports case-insensitive search by company name and pagination. Use this to confirm whether a vendor already exists before calling create_vendor_and_research.',
    {
      search: z
        .string()
        .optional()
        .describe('Substring matched (case-insensitive) against company_name.'),
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
          fetchVendors(env),
          buildLookupMaps(env),
        ]);
        let hydrated = raw.map((r) => hydrateVendor(r, maps));
        const search = input.search?.trim().toLowerCase();
        if (search) {
          hydrated = hydrated.filter((v) =>
            v.companyName.toLowerCase().includes(search),
          );
        }
        hydrated.sort((a, b) => a.companyName.localeCompare(b.companyName));
        const offset = Math.max(0, input.offset ?? 0);
        const limit = Math.min(200, input.limit ?? 50);
        const total = hydrated.length;
        const data = hydrated.slice(offset, offset + limit).map((v) => ({
          id: v.id,
          companyName: v.companyName,
          website: v.website,
          headquarters: v.headquarters,
          foundedYear: v.foundedYear,
          toolCount: v.toolCount,
          vqsScore: v.vqsScore,
          vqsTier: v.vqsTier,
          vendorEnrichmentStatus: v.vendorEnrichmentStatus,
        }));
        return ok({ data, total, offset, limit });
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_vendor
  // -------------------------------------------------------------------------
  server.tool(
    'get_vendor',
    'Fetch a single vendor by Airtable record ID. Returns the full enriched VendorDetail (description, headquarters, funding signals, GitHub, VQS pillars, linked tools).',
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
          fetchVendors(env),
          buildLookupMaps(env),
        ]);
        const record = raw.find((r) => r.id === input.record_id);
        if (!record) return err(`Vendor not found: ${input.record_id}`);
        return ok(hydrateVendorDetail(record, maps));
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // create_vendor_and_research
  // -------------------------------------------------------------------------
  server.tool(
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
        const result = await createVendorAndStartOrchestrator(getEnv(), {
          companyName: input.company_name,
          website: input.website,
          description: input.description,
          forceRefresh: input.force_refresh,
          model: input.model,
          skipOrchestrator: input.skip_orchestrator,
          triggeredBy: 'mcp',
        });
        return ok(result);
      } catch (e) {
        if (e instanceof CreateVendorValidationError) return err(e.message);
        return err(toMessage(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // update_vendor
  // -------------------------------------------------------------------------
  server.tool(
    'update_vendor',
    'Patch fields on an existing vendor record. Only provided fields are written. Use snake_case Airtable field names (company_name, website, founded_year, etc.). Returns the updated VendorDetail.',
    {
      record_id: z
        .string()
        .min(1)
        .describe('Airtable record ID of the vendor to update.'),
      company_name: z.string().optional(),
      description: z.string().optional(),
      website: z.string().optional(),
      headquarters: z.string().optional(),
      founded_year: z.number().int().nullable().optional(),
      public_private: z.string().nullable().optional(),
      parent_company: z.string().optional(),
      linkedin_url: z.string().optional(),
      crunchbase_url: z.string().optional(),
      wiki_url: z.string().optional(),
      source_url: z.string().optional(),
      github_org: z.string().optional(),
      phone_number: z.string().optional(),
      contact_email: z.string().optional(),
      admin_notes: z.string().optional(),
    },
    async (input) => {
      const env = getEnv();
      const fields: Record<string, unknown> = {};
      for (const [key, airtableKey] of Object.entries(VENDOR_PATCH_FIELD_MAP)) {
        const value = (input as Record<string, unknown>)[key];
        if (value !== undefined) fields[airtableKey] = value;
      }
      if (Object.keys(fields).length === 0) {
        return err('No editable fields provided.');
      }
      try {
        const updated = await updateRecord(
          env,
          'vendors',
          input.record_id,
          fields,
        );
        await cacheInvalidate(env.KV_CACHE, `table:${tableId(env, 'vendors')}`);
        const maps = await buildLookupMaps(env);
        return ok(hydrateVendorDetail(updated, maps));
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );
}

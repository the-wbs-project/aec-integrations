// ---------------------------------------------------------------------------
// MCP vendor tools: list, get, create+research (existing), update,
// get_vendor_crunchbase_data.
// ---------------------------------------------------------------------------
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import {
  fetchProducts,
  fetchVendors,
  tableId,
  updateRecord,
} from '../../services/airtable';
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
import { scrapeCrunchbaseOrg } from '../../services/scrapfly';
import {
  parseCrunchbaseHtml,
  isSnapshotUseful,
} from '../../services/crunchbase-parse';
import { notifyRunStarted } from '../../lib/notify-run-started';
import { buildRejectedProductIds, err, ok, toMessage } from '../helpers';

// Curator-editable + LLM-derivable VQS-input fields. Most map 1:1 to Airtable
// column names, so the value here is just the Airtable field name.
const VENDOR_PATCH_FIELD_MAP: Record<string, string> = {
  // Curator-editable basics.
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
  company_size: 'company_size',
  // VQS-input fields (LLM patches; vendor-score workflow consumes).
  funding_stage: 'funding_stage',
  funding_checked_at: 'funding_checked_at',
  crunchbase_rank: 'crunchbase_rank',
  crunchbase_growth_score: 'crunchbase_growth_score',
  crunchbase_heat_score: 'crunchbase_heat_score',
  crunchbase_categories: 'crunchbase_categories',
  crunchbase_lists: 'crunchbase_lists',
  crunchbase_checked_at: 'crunchbase_checked_at',
  monthly_web_visits: 'monthly_web_visits',
  github_org_verified: 'github_org_verified',
  github_repo_count: 'github_repo_count',
  github_stars_total: 'github_stars_total',
  github_last_commit_days_ago: 'github_last_commit_days_ago',
  has_sdk_repo: 'has_sdk_repo',
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
        const [raw, maps, products] = await Promise.all([
          fetchVendors(env),
          buildLookupMaps(env),
          fetchProducts(env),
        ]);
        const record = raw.find((r) => r.id === input.record_id);
        if (!record) return err(`Vendor not found: ${input.record_id}`);
        const rejectedProductIds = buildRejectedProductIds(products);
        const detail = hydrateVendorDetail(record, maps);
        return ok({
          ...detail,
          tools: detail.tools.filter((t) => !rejectedProductIds.has(t.id)),
        });
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
    'Patch fields on an existing vendor record. Only provided fields are written. Use snake_case Airtable field names (company_name, website, founded_year, funding_stage, crunchbase_*, github_*, monthly_web_visits, has_sdk_repo, etc.). After the patch lands, the aeci-vendor-score workflow is spawned in the background to recompute VQS — never set vqs_score / vqs_tier yourself. Returns the updated VendorDetail.',
    {
      record_id: z
        .string()
        .min(1)
        .describe('Airtable record ID of the vendor to update.'),
      // Curator-editable basics.
      company_name: z.string().optional(),
      description: z.string().optional(),
      website: z.string().optional(),
      headquarters: z.string().optional(),
      founded_year: z.number().int().nullable().optional(),
      public_private: z
        .enum(['Public', 'Private', 'Subsidiary', 'Nonprofit', 'Unknown'])
        .nullable()
        .optional(),
      parent_company: z.string().optional(),
      linkedin_url: z.string().optional(),
      crunchbase_url: z.string().optional(),
      wiki_url: z.string().optional(),
      source_url: z.string().optional(),
      github_org: z.string().optional(),
      phone_number: z.string().optional(),
      contact_email: z.string().optional(),
      admin_notes: z.string().optional(),
      company_size: z
        .string()
        .optional()
        .describe('Headcount range singleSelect (e.g. "51-100"). Crunchbase-derived.'),
      // VQS-input fields (consumed by the vendor-score workflow).
      funding_stage: z
        .enum([
          'Bootstrapped',
          'Pre-seed',
          'Seed',
          'Series A',
          'Series B',
          'Series C',
          'Series D+',
          'Public',
          'Acquired',
          'Unknown',
        ])
        .optional()
        .describe('Closed vocabulary; "Unknown" leaves the field unscored.'),
      funding_checked_at: z
        .string()
        .optional()
        .describe('ISO timestamp of when funding was last verified. Set this whenever you patch funding_stage.'),
      crunchbase_rank: z.number().int().nullable().optional(),
      crunchbase_growth_score: z.number().int().min(0).max(100).nullable().optional(),
      crunchbase_heat_score: z.number().int().min(0).max(100).nullable().optional(),
      crunchbase_categories: z
        .array(z.string())
        .optional()
        .describe('Industry tags from Crunchbase. VQS Fit pillar matches these against an AEC keyword set.'),
      crunchbase_lists: z
        .string()
        .optional()
        .describe('JSON-stringified array of Crunchbase list memberships (multilineText column).'),
      crunchbase_checked_at: z
        .string()
        .optional()
        .describe('ISO timestamp of the last Crunchbase fetch. Always set this when you patch any crunchbase_* field.'),
      monthly_web_visits: z.number().int().nullable().optional(),
      github_org_verified: z
        .boolean()
        .optional()
        .describe('True when github_org actually exists and resolves to the vendor.'),
      github_repo_count: z.number().int().min(0).nullable().optional(),
      github_stars_total: z.number().int().min(0).nullable().optional(),
      github_last_commit_days_ago: z
        .number()
        .int()
        .min(0)
        .nullable()
        .optional(),
      has_sdk_repo: z
        .boolean()
        .optional()
        .describe('True when the org has at least one repo whose name/description signals an SDK / API client / integration toolkit.'),
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

        // Fire-and-forget: recompute VQS pillars / tier / confidence so the
        // LLM never has to touch the score itself. WF.create() returns once
        // the instance is registered, the score workflow then runs async.
        const scoreRunId = crypto.randomUUID();
        try {
          await env.WF_VENDOR_SCORE.create({
            id: scoreRunId,
            params: {
              recordId: input.record_id,
              model: env.DEFAULT_MODEL,
              searchTool: 'web',
            },
          });
          notifyRunStarted(env, {
            runId: scoreRunId,
            workflow: 'vendor-score',
            recordId: input.record_id,
            recordLabel:
              ((updated.fields['company_name'] as string | undefined) ?? input.record_id),
            triggeredBy: 'mcp',
            forceRefresh: false,
            model: env.DEFAULT_MODEL,
          }).catch((e) =>
            console.error('[update_vendor] notify score failed', scoreRunId, String(e)),
          );
        } catch (e) {
          console.error(
            '[update_vendor] failed to spawn vendor-score',
            input.record_id,
            String(e),
          );
        }

        const [maps, products] = await Promise.all([
          buildLookupMaps(env),
          fetchProducts(env),
        ]);
        const rejectedProductIds = buildRejectedProductIds(products);
        const detail = hydrateVendorDetail(updated, maps);
        return ok({
          ...detail,
          tools: detail.tools.filter((t) => !rejectedProductIds.has(t.id)),
          score_run_id: scoreRunId,
        });
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_vendor_crunchbase_data
  //
  // Crunchbase blocks worker IPs and isn't reachable via the LLM's WebFetch.
  // This tool routes the request through Scrapfly (anti-bot + JS render) and
  // returns the parsed snapshot the LLM should write back via update_vendor.
  // Result is KV-cached for 30d (per scrapfly.ts), so calling repeatedly for
  // the same URL costs nothing after the first hit.
  // -------------------------------------------------------------------------
  server.tool(
    'get_vendor_crunchbase_data',
    'Scrape a Crunchbase organization page (via the server-side proxy) and return the parsed snapshot: description, headquarters, parent_company, public_private, headcount range, cb_rank, growth_score, heat_score, monthly_web_visits, industry categories, list memberships. Use this in the add-vendor playbook to populate VQS-input fields — Crunchbase is not reachable via WebFetch. Pass the canonical /organization/<slug> URL (find it with WebSearch first).',
    {
      crunchbase_url: z
        .string()
        .url()
        .describe(
          'Canonical Crunchbase org URL, e.g. https://www.crunchbase.com/organization/autodesk. Use WebSearch with `"<vendor>" site:crunchbase.com` to find it before calling this tool.',
        ),
    },
    async (input) => {
      const env = getEnv();
      try {
        const res = await scrapeCrunchbaseOrg(env, input.crunchbase_url);
        if (!res.successful || !res.html) {
          return err(
            `Crunchbase scrape failed for ${input.crunchbase_url}: ${res.error ?? 'unknown error'}`,
          );
        }
        const snapshot = parseCrunchbaseHtml(res.html);
        const useful = isSnapshotUseful(snapshot);
        return ok({
          crunchbase_url: input.crunchbase_url,
          useful,
          snapshot,
          // Convenience block — exact field names the LLM should patch onto
          // the vendor via update_vendor. Null fields mean "not found, leave
          // the existing value alone" — do NOT send null to update_vendor.
          suggested_vendor_patch: {
            description: snapshot.description,
            headquarters: snapshot.headquarters,
            parent_company: snapshot.parentCompany,
            public_private: snapshot.publicPrivate,
            company_size: snapshot.headcountRange,
            website: snapshot.website,
            phone_number: snapshot.phoneNumber,
            contact_email: snapshot.contactEmail,
            crunchbase_rank: snapshot.cbRank,
            crunchbase_growth_score: snapshot.growthScore,
            crunchbase_heat_score: snapshot.heatScore,
            crunchbase_categories:
              snapshot.industries.length > 0 ? snapshot.industries : null,
            crunchbase_lists:
              snapshot.lists.length > 0 ? JSON.stringify(snapshot.lists) : null,
            monthly_web_visits: snapshot.monthlyWebVisits,
            crunchbase_checked_at: new Date().toISOString(),
          },
        });
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );
}

// ---------------------------------------------------------------------------
// MCP research tools — synchronous SearchAPI-backed metrics that built-in
// Claude tools can't reproduce. Used by the research-products playbook so
// playbook runs (which only have WebSearch + WebFetch) can still populate
// search-demand and Reddit-mention signals without spawning the cloud
// workflows.
//
// Both tools mirror the data the cloud workflows produce
// (workflows/product/searchDemand.ts, workflows/product/reddit.ts) but call
// SearchAPI inline and write back to Airtable themselves. The cloud
// workflows remain the cron path; these MCP tools are the on-demand path.
// ---------------------------------------------------------------------------
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { getRecord, updateRecord, asString } from '../../services/airtable';
import { runSerpSearch } from '../../services/search';
import { err, ok, toMessage } from '../helpers';

const AEC_SUBREDDITS = [
  'Construction',
  'AEC',
  'Revit',
  'civilengineering',
  'ConstructionManagement',
] as const;

interface TrendsTimelinePoint {
  values?: Array<{ extracted_value?: number }>;
}

function extractTrendsIndex(body: Record<string, unknown>): number | null {
  const interest = body['interest_over_time'] as Record<string, unknown> | undefined;
  const timelines = interest?.['timeline_data'] as TrendsTimelinePoint[] | undefined;
  if (!Array.isArray(timelines) || timelines.length === 0) return null;
  const values = timelines.map((t) => {
    const v = t.values?.[0]?.extracted_value;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  });
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function extractSearchVolume(body: Record<string, unknown>): number | null {
  const info = body['search_information'] as Record<string, unknown> | undefined;
  const totalResults = info?.['total_results'];
  if (typeof totalResults !== 'number' || totalResults <= 0) return null;
  return Math.round(Math.log10(totalResults + 1) * 100);
}

const REDDIT_POST_URL = new RegExp(
  `^https?://(?:www\\.|old\\.)?reddit\\.com/r/(?:${AEC_SUBREDDITS.join('|')})/comments/`,
  'i',
);

function extractRedditPosts(
  body: Record<string, unknown>,
): { urls: string[] } {
  const organic = body['organic_results'];
  if (!Array.isArray(organic)) return { urls: [] };
  const seen = new Set<string>();
  for (const r of organic) {
    const item = r as Record<string, unknown>;
    const link = typeof item['link'] === 'string' ? (item['link'] as string) : undefined;
    if (!link) continue;
    if (!REDDIT_POST_URL.test(link)) continue;
    // Canonicalize: trim trailing slash + querystring so two pointers to the
    // same post collapse to one count.
    const canonical = link.split('?')[0].replace(/\/$/, '');
    seen.add(canonical);
  }
  return { urls: Array.from(seen) };
}

export function registerResearchTools(
  server: McpServer,
  getEnv: () => Env,
): void {
  // -------------------------------------------------------------------------
  // compute_product_search_demand
  // -------------------------------------------------------------------------
  server.tool(
    'compute_product_search_demand',
    'Compute google_trends_index (0-100, 12-month average) and search_volume_monthly (log10 of Google total_results) for a product, write them to Airtable, and return the values. Mirrors the cloud product-search-demand workflow but runs synchronously. Use from the research-products playbook because Claude\'s built-in WebSearch / WebFetch cannot reach Google Trends or expose total_results.',
    {
      record_id: z
        .string()
        .min(1)
        .describe('Airtable record ID of the product, e.g. "rec0123…".'),
    },
    async (input) => {
      try {
        const env = getEnv();
        const record = await getRecord(env, 'products', input.record_id);
        const toolName =
          asString(record.fields['Name']) ?? asString(record.fields['name']);
        if (!toolName) {
          return err(
            `Product ${input.record_id} has no name field; cannot run search-demand query.`,
          );
        }
        const q = `${toolName} software`;
        const attribution = { runId: 'mcp-tool', workflow: 'compute_product_search_demand' };

        let trendsIndex: number | null = null;
        try {
          const trends = await runSerpSearch(
            env,
            { engine: 'google_trends', q, date: 'today 12-m' },
            attribution,
          );
          if (trends.status === 200) trendsIndex = extractTrendsIndex(trends.body);
        } catch (e) {
          console.error('[compute_product_search_demand] trends call failed:', e);
        }

        let searchVolume: number | null = null;
        try {
          const google = await runSerpSearch(env, { engine: 'google', q }, attribution);
          if (google.status === 200) searchVolume = extractSearchVolume(google.body);
        } catch (e) {
          console.error('[compute_product_search_demand] google call failed:', e);
        }

        const checkedAt = new Date().toISOString();
        const fields: Record<string, unknown> = { search_checked_at: checkedAt };
        if (searchVolume !== null) fields['search_volume_monthly'] = searchVolume;
        if (trendsIndex !== null) fields['google_trends_index'] = trendsIndex;

        await updateRecord(env, 'products', input.record_id, fields);

        return ok({
          record_id: input.record_id,
          name: toolName,
          query: q,
          google_trends_index: trendsIndex,
          search_volume_monthly: searchVolume,
          search_checked_at: checkedAt,
        });
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // compute_product_reddit_mentions
  // -------------------------------------------------------------------------
  server.tool(
    'compute_product_reddit_mentions',
    'Count distinct Reddit post URLs in the AEC subreddits (r/Construction, r/AEC, r/Revit, r/civilengineering, r/ConstructionManagement) that mention a product, write the count + checked_at to Airtable, and return up to 5 sample URLs. One SearchAPI google query, deterministic count from organic_results — no LLM. Use from the research-products playbook because Claude\'s built-in WebSearch and old.reddit.com fetch are both blocked for this corpus.',
    {
      record_id: z
        .string()
        .min(1)
        .describe('Airtable record ID of the product.'),
    },
    async (input) => {
      try {
        const env = getEnv();
        const record = await getRecord(env, 'products', input.record_id);
        const toolName =
          asString(record.fields['Name']) ?? asString(record.fields['name']);
        if (!toolName) {
          return err(
            `Product ${input.record_id} has no name field; cannot run reddit query.`,
          );
        }
        const subredditClause = AEC_SUBREDDITS.map((s) => `r/${s}`).join(' OR ');
        const q = `"${toolName}" site:reddit.com (${subredditClause})`;
        const attribution = { runId: 'mcp-tool', workflow: 'compute_product_reddit_mentions' };

        let urls: string[] = [];
        try {
          const search = await runSerpSearch(env, { engine: 'google', q }, attribution);
          if (search.status === 200) {
            urls = extractRedditPosts(search.body).urls;
          }
        } catch (e) {
          console.error('[compute_product_reddit_mentions] search failed:', e);
        }

        const checkedAt = new Date().toISOString();
        const fields = {
          reddit_mentions_24mo: urls.length,
          reddit_checked_at: checkedAt,
        };
        await updateRecord(env, 'products', input.record_id, fields);

        return ok({
          record_id: input.record_id,
          name: toolName,
          query: q,
          reddit_mentions_24mo: urls.length,
          sample_urls: urls.slice(0, 5),
          reddit_checked_at: checkedAt,
        });
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );
}

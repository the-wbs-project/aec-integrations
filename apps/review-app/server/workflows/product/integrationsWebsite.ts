// ---------------------------------------------------------------------------
// Integration discovery leaf — vendor's own website.
//
// Fetches /integrations, /partners, /apps, /marketplace on the product's
// website via Scrapfly, then asks the LLM to pull integration partners from
// whichever pages came back.
// ---------------------------------------------------------------------------
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { ErrorCapturingWorkflow } from '../../lib/error-capturing-workflow';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import { asString, type AirtableRecord } from '../../services/airtable';
import { scrapeUrl } from '../../services/scrapfly';
import { runLeaf } from './integrationsLeaf';

export const meta: WorkflowMeta = {
  slug: 'product-integrations-website',
  description:
    "Discover integrations from the product's own /integrations, /partners, /apps page.",
  table: 'products',
};

const PATHS = ['/integrations', '/partners', '/apps', '/marketplace'] as const;
const MAX_HTML_PER_PAGE = 80_000;

/**
 * Pages to scrape for integration partners. When the curator (or
 * product-research) has populated `tool_integrations_url`, use ONLY that
 * URL — it has been vetted as the canonical integrations page (often a
 * dedicated subdomain like `apps.autodesk.com/RVT/...` or
 * `integrations.bluebeam.com` that the path-guessing fallback wouldn't find).
 * Otherwise fall back to guessing /integrations, /partners, /apps,
 * /marketplace off the product website.
 */
function siteUrls(record: AirtableRecord): string[] {
  const integrationsUrl = asString(record.fields['tool_integrations_url']);
  if (integrationsUrl) {
    try {
      const u = new URL(
        integrationsUrl.startsWith('http') ? integrationsUrl : `https://${integrationsUrl}`,
      );
      return [u.toString()];
    } catch {
      // Fall through to website-derived guesses if the curated value is junk.
    }
  }

  const website = asString(record.fields['website']);
  if (!website) return [];
  let base: URL;
  try {
    base = new URL(website.startsWith('http') ? website : `https://${website}`);
  } catch {
    return [];
  }
  return PATHS.map((p) => `${base.origin}${p}`);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_HTML_PER_PAGE);
}

export class ProductIntegrationsWebsiteWorkflow extends ErrorCapturingWorkflow {
  override async runImpl(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId, model, searchTool } = event.payload;
    const ctx = { runId: event.instanceId, workflow: meta.slug };

    return runLeaf(this.env, step, ctx, recordId, model, searchTool, {
      source: 'website',
      preFetch: async (env, _step, record) => {
        const urls = siteUrls(record);
        if (urls.length === 0) {
          return { extraUserContext: 'NOTE: product has no website on file.', skipLlm: true };
        }
        const fetched: { url: string; text: string }[] = [];
        for (const url of urls) {
          const cacheKey = `int-website:${url}`;
          const result = await checkpoint(step, `scrape:${url}`, () =>
            scrapeUrl(env, url, { cacheKey, cacheTtlS: 7 * 24 * 60 * 60 }),
          );
          if (result.successful && result.html) {
            fetched.push({ url, text: stripHtml(result.html) });
          }
        }
        if (fetched.length === 0) {
          return {
            extraUserContext:
              'NOTE: none of /integrations, /partners, /apps, /marketplace returned content.',
            skipLlm: true,
          };
        }
        const corpus = fetched
          .map((f) => `--- PAGE: ${f.url} ---\n${f.text}`)
          .join('\n\n');
        return {
          extraUserContext: `Pages fetched from the product's site (use these as the sole source of integration partner names — do NOT invent):\n\n${corpus}`,
        };
      },
      buildPrompt: (record) => {
        const productName = asString(record.fields['Name']) ?? '';
        return {
          systemPrompt:
            'You extract integration partners from a software product\'s own marketing pages (integrations, partners, apps, marketplace). Only return entries that are clearly listed as integration partners on the supplied pages. Use the literal page URL where each partner was found as evidenceUrl. confidence is "high" when the partner is shown in a dedicated integrations grid, "medium" when only mentioned in body copy, "low" otherwise.',
          userPrompt: `Find integration partners listed on ${productName}'s own integrations/partners pages. For each partner, return: targetName (their product/company name as printed), targetWebsite if linked, mechanismKind ('native' is a safe default for first-party integration pages), and the page URL where you saw them as evidenceUrl. When done call emit_result. Do NOT use web_search — answer purely from the supplied page text.`,
        };
      },
    });
  }
}

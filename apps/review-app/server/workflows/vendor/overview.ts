// ---------------------------------------------------------------------------
// V0R — Vendor overview (Crunchbase-first enrichment).
//
// Replaces the old LLM-only `vendor-research`. New flow:
//
//   1. Discover the vendor's Crunchbase URL (one SERP if not already saved).
//   2. Scrape the Crunchbase org page via Scrapfly (cached 30d in KV).
//   3. Wikipedia summary + infobox for `founded_year` (Crunchbase obfuscates
//      it on the free tier) and as a description backstop.
//   4. LLM fallback (small budget) — only when Crunchbase + Wikipedia leave
//      critical fields empty. Reuses the same tool-loop machinery the old
//      research workflow used.
//   5. Validate, then write whatever was filled. On a successful Crunchbase
//      scrape we *also* mark `employee_checked_at` fresh so the
//      vendor-company-size leaf gets skipped by the orchestrator.
//
// Curator-edited values are never overwritten for `website`, `headquarters`,
// `founded_year`, `parent_company`, `phone_number`, `contact_email`,
// `crunchbase_url`, `wiki_url`. `description`, `public_private`, and the
// Crunchbase signal fields are always overwritten on every run.
// ---------------------------------------------------------------------------
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { ErrorCapturingWorkflow } from '../../lib/error-capturing-workflow';
import { NonRetryableError } from 'cloudflare:workflows';
import type { Env, SearchTool } from '../../env';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import { getRecord, updateRecord, asString, asNumber } from '../../services/airtable';
import {
  runTurn,
  interpretMessage,
  logTurnSummary,
  executeSearchTool,
  resolveSearchTool,
  supportsTemperature,
  runForceEmitTurn,
  type MessageParam,
  type OutputSchema,
} from '../../lib/llm';
import {
  searchApiToolSchema,
  emitResultTool,
  type Tool,
  type WebSearchTool,
} from '../../services/llm-tools';
import type { MessageRequestBody } from '../../services/anthropic';
import { runSerpSearch, pickOrganicResults } from '../../services/search';
import { findWikipediaSummary, fetchInfobox } from '../../services/wikipedia';
import { scrapeCrunchbaseOrg } from '../../services/scrapfly';
import {
  parseCrunchbaseHtml,
  isSnapshotUseful,
  type CrunchbaseSnapshot,
} from '../../services/crunchbase-parse';

export const meta: WorkflowMeta = {
  slug: 'vendor-overview',
  description:
    'Scrape Crunchbase + Wikipedia for vendor basics; falls back to LLM search only when both miss.',
  table: 'vendors',
};

// LLM fallback budget — much smaller than the old research workflow because
// Crunchbase + Wikipedia handle the common case.
const FALLBACK_MAX_SEARCHES = 2;
const FALLBACK_MAX_TURNS = FALLBACK_MAX_SEARCHES + 2;
const MAX_PAUSE_RESUMES = 1;

const PUBLIC_PRIVATE_VALUES = [
  'Public',
  'Private',
  'Subsidiary',
  'Nonprofit',
  'Unknown',
] as const;
type PublicPrivate = (typeof PUBLIC_PRIVATE_VALUES)[number];

const CRUNCHBASE_ORG_URL = /^https?:\/\/(www\.)?crunchbase\.com\/organization\/[a-z0-9-]+\/?(?:[?#].*)?$/i;

interface OverviewResult {
  description: string | null;
  url: string | null;
  crunchbase_url: string | null;
  wiki_url: string | null;
  headquarters: string | null;
  founded_year: number | null;
  public_private: PublicPrivate;
  parent_company: string | null;
  phone_number: string | null;
  contact_email: string | null;
  /** Headcount range, e.g. "51-100". Maps to Airtable singleSelect `company_size`. */
  company_size: string | null;
  // Crunchbase-derived signals (always null when scrape failed).
  crunchbase_rank: number | null;
  crunchbase_growth_score: number | null;
  crunchbase_heat_score: number | null;
  crunchbase_categories: string[];
  monthly_web_visits: number | null;
  /** JSON-stringified for Airtable multilineText. */
  crunchbase_lists_json: string | null;
  /** Did the Crunchbase scrape succeed and yield a useful snapshot? */
  crunchbase_ok: boolean;
  notes: string;
  citations: string[];
}

export class VendorOverviewWorkflow extends ErrorCapturingWorkflow {
  override async runImpl(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId, model, searchTool } = event.payload;
    const ctx = { runId: event.instanceId, workflow: meta.slug };

    // ---- 1. Fetch record + read existing curator values ----------------
    const record = await checkpoint(step, 'fetch-record', () =>
      getRecord(this.env, 'vendors', recordId),
    );
    const name = asString(record.fields['company_name']) ?? '';
    if (!name) {
      throw new NonRetryableError(`Vendor ${recordId} has no company_name`);
    }
    const existingWebsite = asString(record.fields['website']);
    const existingHeadquarters = asString(record.fields['headquarters']);
    const existingFoundedYear = asNumber(record.fields['founded_year']);
    const existingParentCompany = asString(record.fields['parent_company']);
    const existingPublicPrivate = asString(record.fields['public_private']);
    const existingPhone = asString(record.fields['phone_number']);
    const existingEmail = asString(record.fields['contact_email']);
    const existingCrunchbaseUrl = asString(record.fields['crunchbase_url']);
    const existingWikiUrl = asString(record.fields['wiki_url']);
    const existingCompanySize = asString(record.fields['company_size']);

    // ---- 2. Discover Crunchbase URL if missing -------------------------
    const crunchbaseUrl = existingCrunchbaseUrl
      ? existingCrunchbaseUrl
      : await checkpoint(step, 'discover-crunchbase-url', () =>
          discoverCrunchbaseUrl(this.env, ctx, name),
        );

    // ---- 3. Scrape Crunchbase ------------------------------------------
    // Retry up to 3 times with a 30s pause between attempts. Each attempt is
    // its own checkpoint, and the sleep uses step.sleep so we don't burn
    // worker CPU. After 3 failed tries we move on with the empty snapshot.
    let crunchbase: { snapshot: CrunchbaseSnapshot | null; ok: boolean; error: string | null } =
      { snapshot: null, ok: false, error: 'no crunchbase_url' };
    if (crunchbaseUrl) {
      const MAX_ATTEMPTS = 3;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const result = await checkpoint(step, `scrape-crunchbase-${attempt}`, async () => {
          const res = await scrapeCrunchbaseOrg(this.env, crunchbaseUrl);
          if (!res.successful || !res.html) {
            console.log(
              `[vendor-overview] crunchbase scrape attempt ${attempt + 1}/${MAX_ATTEMPTS} failed for ${recordId}: ${res.error}`,
            );
            return { snapshot: null, ok: false, error: res.error };
          }
          const snap = parseCrunchbaseHtml(res.html);
          const useful = isSnapshotUseful(snap);
          return {
            snapshot: snap,
            ok: useful,
            error: useful ? null : 'parsed snapshot did not meet usefulness bar',
          };
        });
        crunchbase = result;
        if (result.ok) break;
        if (attempt < MAX_ATTEMPTS - 1) {
          await step.sleep(`scrape-crunchbase-backoff-${attempt}`, '30 seconds');
        }
      }
    }

    // ---- 4. Wikipedia (founded year + description backstop) ------------
    const wiki = await checkpoint(step, 'fetch-wikipedia', () =>
      fetchWikipediaEvidence(name),
    );

    // ---- 5. Merge what we have so far ----------------------------------
    let merged: OverviewResult = mergeEvidence({
      name,
      crunchbase: crunchbase.snapshot,
      crunchbaseOk: crunchbase.ok,
      crunchbaseUrl: crunchbaseUrl ?? null,
      wiki,
    });

    // ---- 6. LLM fallback — only if critical fields are still missing --
    const needsLlm = !merged.description || !merged.headquarters;
    if (needsLlm) {
      const llmFilled = await checkpoint(step, 'llm-fallback', () =>
        runLlmFallback(this.env, ctx, {
          model,
          searchTool: resolveSearchTool(this.env, searchTool),
          name,
          website: existingWebsite,
          missingFields: missingFieldList(merged),
        }),
      );
      if (llmFilled) {
        merged = applyLlmFill(merged, llmFilled);
      }
    }

    // ---- 7. Build the Airtable patch -----------------------------------
    const fieldsToWrite: Record<string, unknown> = {};

    // Always-overwrite fields (when populated).
    if (merged.description) fieldsToWrite['description'] = merged.description;
    if (merged.public_private && merged.public_private !== 'Unknown') {
      fieldsToWrite['public_private'] = merged.public_private;
    } else if (!existingPublicPrivate && merged.public_private === 'Unknown') {
      // Don't store 'Unknown' — leave the field blank so curators can spot it.
    }

    // Curator-preserve fields.
    if (!existingWebsite && merged.url) fieldsToWrite['website'] = merged.url;
    if (!existingHeadquarters && merged.headquarters) {
      fieldsToWrite['headquarters'] = merged.headquarters;
    }
    if (existingFoundedYear === undefined && merged.founded_year !== null) {
      fieldsToWrite['founded_year'] = merged.founded_year;
    }
    if (!existingParentCompany && merged.parent_company) {
      fieldsToWrite['parent_company'] = merged.parent_company;
    }
    if (!existingPhone && merged.phone_number) {
      fieldsToWrite['phone_number'] = merged.phone_number;
    }
    if (!existingEmail && merged.contact_email) {
      fieldsToWrite['contact_email'] = merged.contact_email;
    }
    if (!existingCrunchbaseUrl && merged.crunchbase_url) {
      fieldsToWrite['crunchbase_url'] = merged.crunchbase_url;
    }
    if (!existingWikiUrl && merged.wiki_url) {
      fieldsToWrite['wiki_url'] = merged.wiki_url;
    }

    // Crunchbase-only fields — overwrite when scrape succeeded; leave alone
    // otherwise so we don't blow away yesterday's good data on today's flake.
    if (crunchbase.ok && crunchbase.snapshot) {
      const snap = crunchbase.snapshot;
      if (!existingCompanySize && snap.headcountRange) {
        fieldsToWrite['company_size'] = snap.headcountRange;
      }
      fieldsToWrite['crunchbase_rank'] = snap.cbRank;
      fieldsToWrite['crunchbase_growth_score'] = snap.growthScore;
      fieldsToWrite['crunchbase_heat_score'] = snap.heatScore;
      fieldsToWrite['monthly_web_visits'] = snap.monthlyWebVisits;
      if (snap.industries.length > 0) {
        fieldsToWrite['crunchbase_categories'] = snap.industries;
      }
      fieldsToWrite['crunchbase_lists'] =
        snap.lists.length > 0 ? JSON.stringify(snap.lists) : null;
      fieldsToWrite['crunchbase_checked_at'] = new Date().toISOString();

      // Mark the per-leaf timestamp Crunchbase satisfies, so the orchestrator
      // skips the company-size leaf for the next 60 days. Only when we
      // actually filled `company_size` (either now or already curator-set).
      if (snap.headcountRange || existingCompanySize) {
        fieldsToWrite['employee_checked_at'] = new Date().toISOString();
      }
    }

    if (Object.keys(fieldsToWrite).length === 0) {
      return {
        fields: {},
        fieldsUpdated: [],
        status: 'success' as const,
        note: 'Nothing new to write',
        crunchbaseOk: crunchbase.ok,
      };
    }

    await checkpoint(step, 'write-fields', () =>
      updateRecord(this.env, 'vendors', recordId, fieldsToWrite),
    );

    const fieldsUpdated = Object.keys(fieldsToWrite);
    return {
      fields: fieldsToWrite,
      fieldsUpdated,
      status: 'success' as const,
      crunchbaseOk: crunchbase.ok,
      crunchbaseError: crunchbase.error,
      note: `${fieldsUpdated.length} fields written (${crunchbase.ok ? 'crunchbase' : 'no crunchbase'}${needsLlm ? ' + llm' : ''})`,
      overview: merged,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a single SERP for `"<name>" site:crunchbase.com` and pick the first
 * organic result whose URL matches a canonical /organization/<slug> path.
 * Returns null if nothing plausible turned up — that's the signal the vendor
 * isn't on Crunchbase at all.
 */
async function discoverCrunchbaseUrl(
  env: Env,
  attribution: { runId: string; workflow: string },
  name: string,
): Promise<string | null> {
  const res = await runSerpSearch(env, { q: `"${name}" site:crunchbase.com` }, attribution);
  if (res.status !== 200) return null;
  for (const r of pickOrganicResults(res.body, 5)) {
    if (typeof r.link === 'string' && CRUNCHBASE_ORG_URL.test(r.link)) {
      // Strip query/fragment to get the canonical org URL.
      return r.link.split(/[?#]/)[0];
    }
  }
  return null;
}

interface WikipediaEvidence {
  url: string | null;
  description: string | null;
  foundedYear: number | null;
  headquarters: string | null;
  parent: string | null;
  website: string | null;
}

async function fetchWikipediaEvidence(name: string): Promise<WikipediaEvidence> {
  const summary = await findWikipediaSummary(name);
  if (!summary) {
    return {
      url: null,
      description: null,
      foundedYear: null,
      headquarters: null,
      parent: null,
      website: null,
    };
  }
  const infobox = await fetchInfobox(summary.title);
  return {
    url: summary.canonicalUrl,
    description: summary.extract,
    foundedYear: infobox?.foundedYear ?? null,
    headquarters: infobox?.headquarters ?? null,
    parent: infobox?.parent ?? null,
    website: infobox?.website ?? null,
  };
}

interface MergeInput {
  name: string;
  crunchbase: CrunchbaseSnapshot | null;
  crunchbaseOk: boolean;
  crunchbaseUrl: string | null;
  wiki: WikipediaEvidence;
}

function mergeEvidence(input: MergeInput): OverviewResult {
  const cb = input.crunchbase;
  const wiki = input.wiki;

  // Description: Crunchbase first, Wikipedia as backstop.
  const description = cb?.description ?? wiki.description ?? null;

  // Headquarters: Crunchbase FAQ-derived value first, Wikipedia second.
  const headquarters = cb?.headquarters ?? wiki.headquarters ?? null;

  // Founded year only ever comes from Wikipedia (Crunchbase obfuscates it).
  const foundedYear = wiki.foundedYear ?? null;

  // Public/private: trust Crunchbase pill when available; otherwise Unknown.
  const publicPrivate = normalizePublicPrivate(cb?.publicPrivate);

  // Parent: Crunchbase "Sub-Organization Of" first, Wikipedia infobox second.
  const parent = cb?.parentCompany ?? wiki.parent ?? null;

  // Website: Crunchbase chip first, Wikipedia infobox second. Caller will
  // only write it if not already set.
  const website = cb?.website ?? wiki.website ?? null;

  return {
    description,
    url: website,
    crunchbase_url: input.crunchbaseUrl,
    wiki_url: wiki.url,
    headquarters,
    founded_year: foundedYear,
    public_private: publicPrivate,
    parent_company: parent,
    phone_number: cb?.phoneNumber ?? null,
    contact_email: cb?.contactEmail ?? null,
    company_size: cb?.headcountRange ?? null,
    crunchbase_rank: cb?.cbRank ?? null,
    crunchbase_growth_score: cb?.growthScore ?? null,
    crunchbase_heat_score: cb?.heatScore ?? null,
    crunchbase_categories: cb?.industries ?? [],
    monthly_web_visits: cb?.monthlyWebVisits ?? null,
    crunchbase_lists_json:
      cb?.lists && cb.lists.length > 0 ? JSON.stringify(cb.lists) : null,
    crunchbase_ok: input.crunchbaseOk,
    notes: input.crunchbaseOk
      ? 'crunchbase scrape ok'
      : 'crunchbase scrape failed/missing — leaves run as fallback',
    citations: [
      input.crunchbaseUrl,
      wiki.url,
    ].filter((x): x is string => typeof x === 'string'),
  };
}

function normalizePublicPrivate(raw: string | null | undefined): PublicPrivate {
  if (!raw) return 'Unknown';
  const v = raw.trim();
  if (/^public$/i.test(v)) return 'Public';
  if (/^private$/i.test(v)) return 'Private';
  if (/^subsidiary$/i.test(v)) return 'Subsidiary';
  if (/^non[- ]?profit$/i.test(v)) return 'Nonprofit';
  return 'Unknown';
}

function missingFieldList(merged: OverviewResult): string[] {
  const missing: string[] = [];
  if (!merged.description) missing.push('description');
  if (!merged.headquarters) missing.push('headquarters');
  if (!merged.founded_year) missing.push('founded_year');
  if (!merged.parent_company) missing.push('parent_company');
  if (merged.public_private === 'Unknown') missing.push('public_private');
  return missing;
}

function applyLlmFill(merged: OverviewResult, fill: Partial<OverviewResult>): OverviewResult {
  return {
    ...merged,
    description: merged.description ?? fill.description ?? null,
    headquarters: merged.headquarters ?? fill.headquarters ?? null,
    founded_year: merged.founded_year ?? fill.founded_year ?? null,
    parent_company: merged.parent_company ?? fill.parent_company ?? null,
    public_private:
      merged.public_private !== 'Unknown' ? merged.public_private : fill.public_private ?? 'Unknown',
    citations: [...merged.citations, ...(fill.citations ?? [])],
  };
}

// ---------------------------------------------------------------------------
// LLM fallback. Only fires when Crunchbase + Wikipedia leave critical fields
// empty (vendor not on Crunchbase, no Wikipedia article, etc.).
// ---------------------------------------------------------------------------

interface LlmFallbackInput {
  model: string;
  searchTool: SearchTool;
  name: string;
  website?: string;
  missingFields: string[];
}

async function runLlmFallback(
  env: Env,
  ctx: { runId: string; workflow: string },
  input: LlmFallbackInput,
): Promise<Partial<OverviewResult> | null> {
  const systemPrompt =
    'You are a research agent that fills in missing facts about a company. Use web search sparingly. Return null for anything you cannot verify with at least one authoritative source.';

  const knownLines = [`Vendor: "${input.name}"`];
  if (input.website) knownLines.push(`Website hint: ${input.website}`);

  const userPrompt = `The vendor's Crunchbase profile and Wikipedia article (if any) have already been consulted. Fill in only the following missing fields with high confidence — leave others null.

${knownLines.join('\n')}

Missing fields: ${input.missingFields.join(', ')}

You have a budget of at most ${FALLBACK_MAX_SEARCHES} web searches. Prefer the company's own About / Press page first.

Call emit_result with these fields (all optional, all null when unsure):
- description: 1–3 sentences, AEC market focus
- headquarters: "City, Country"
- founded_year: integer
- parent_company: parent organization
- public_private: 'Public' | 'Private' | 'Subsidiary' | 'Nonprofit' | 'Unknown'
- citations: array of source URLs`;

  const outputSchema: OutputSchema = {
    type: 'object',
    properties: {
      description: { type: ['string', 'null'] },
      headquarters: { type: ['string', 'null'] },
      founded_year: { type: ['integer', 'null'] },
      parent_company: { type: ['string', 'null'] },
      public_private: { type: 'string', enum: [...PUBLIC_PRIVATE_VALUES] },
      citations: { type: 'array', items: { type: 'string' } },
    },
    required: ['public_private'],
  };

  const buildRequest = (
    messages: MessageParam[],
    forceTool: boolean,
  ): MessageRequestBody => {
    const webSearch: WebSearchTool = {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: FALLBACK_MAX_SEARCHES,
    };
    const tools: Tool[] = [
      input.searchTool === 'web' ? webSearch : searchApiToolSchema(),
      emitResultTool(outputSchema),
    ];
    return {
      model: input.model,
      max_tokens: 2048,
      ...(supportsTemperature(input.model) ? { temperature: 0 } : {}),
      system: systemPrompt,
      messages,
      tools,
      tool_choice: { type: forceTool ? 'any' : 'auto' },
    };
  };

  let messages: MessageParam[] = [{ role: 'user', content: userPrompt }];
  let response = await runTurn(env, ctx, buildRequest(messages, false));

  let emitted: Record<string, unknown> | undefined;
  let pauseResumes = 0;
  let searchesUsed = 0;
  for (let turn = 0; turn < FALLBACK_MAX_TURNS && !emitted; turn++) {
    const interpreted = interpretMessage(response);
    logTurnSummary(ctx, turn, interpreted);
    messages = [...messages, interpreted.assistantMessage];

    if (interpreted.emitted) {
      emitted = interpreted.emitted;
      break;
    }
    searchesUsed += interpreted.searches.length;

    if (
      interpreted.stopReason === 'pause_turn' &&
      interpreted.pendingSearches.length === 0 &&
      pauseResumes < MAX_PAUSE_RESUMES
    ) {
      pauseResumes++;
      response = await runTurn(env, ctx, buildRequest(messages, false));
      continue;
    }

    if (interpreted.pendingSearches.length > 0 && input.searchTool === 'searchapi') {
      searchesUsed += interpreted.pendingSearches.length;
      const remainingSearches = Math.max(0, FALLBACK_MAX_SEARCHES - searchesUsed);
      const toolResult = await executeSearchTool(env, ctx, interpreted.pendingSearches, {
        remainingSearches,
      });
      messages = [...messages, toolResult];
      response = await runTurn(env, ctx, buildRequest(messages, true));
      continue;
    }

    // Force-emit safety net.
    emitted = await runForceEmitTurn(env, ctx, {
      model: input.model,
      systemPrompt,
      outputSchema,
      priorMessages: messages,
    });
    break;
  }

  if (!emitted) return null;

  const description = typeof emitted['description'] === 'string' ? (emitted['description'] as string) : null;
  const headquarters = typeof emitted['headquarters'] === 'string' ? (emitted['headquarters'] as string) : null;
  const foundedYear =
    typeof emitted['founded_year'] === 'number' && Number.isInteger(emitted['founded_year'])
      ? (emitted['founded_year'] as number)
      : null;
  const parent = typeof emitted['parent_company'] === 'string' ? (emitted['parent_company'] as string) : null;
  const pp = emitted['public_private'];
  const publicPrivate: PublicPrivate =
    typeof pp === 'string' && (PUBLIC_PRIVATE_VALUES as readonly string[]).includes(pp)
      ? (pp as PublicPrivate)
      : 'Unknown';
  const citations = Array.isArray(emitted['citations'])
    ? (emitted['citations'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];

  return {
    description: description ?? undefined,
    headquarters: headquarters ?? undefined,
    founded_year: foundedYear ?? undefined,
    parent_company: parent ?? undefined,
    public_private: publicPrivate,
    citations,
  };
}

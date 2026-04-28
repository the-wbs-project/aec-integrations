// ---------------------------------------------------------------------------
// Record hydration — converts raw Airtable records into typed API shapes.
// ---------------------------------------------------------------------------
import type {
  CrunchbaseList,
  IntegrationSummary,
  LinkRef,
  Tool,
  ToolDetail,
  Vendor,
  VendorDetail,
} from './types';
import type { Env } from './env';
import {
  type AirtableRecord,
  fetchCategories,
  fetchDisciplines,
  fetchIntegrations,
  fetchProjectPhases,
  fetchTools,
  fetchVendors,
} from './services/airtable';

// ---------------------------------------------------------------------------
// Lookup-map builders
// ---------------------------------------------------------------------------
export type NameMap = Map<string, string>;

/** Build a Map<recordId, primaryFieldValue> from an array of Airtable records. */
export function buildNameMap(
  records: AirtableRecord[],
  field: string,
): NameMap {
  const map = new Map<string, string>();
  for (const r of records) {
    const val = r.get(field);
    if (typeof val === 'string') {
      map.set(r.id, val);
    }
  }
  return map;
}

/** Convert an array of linked-record IDs into LinkRef[] using a lookup map. */
export function toRefs(ids: unknown, nameMap: NameMap): LinkRef[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((id): id is string => typeof id === 'string' && nameMap.has(id))
    .map((id) => ({ id, name: nameMap.get(id)! }));
}

/** Single LinkRef or undefined. */
export function toRef(ids: unknown, nameMap: NameMap): LinkRef | undefined {
  const refs = toRefs(ids, nameMap);
  return refs.length > 0 ? refs[0] : undefined;
}

// ---------------------------------------------------------------------------
// Field-value coercion helpers
// ---------------------------------------------------------------------------
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length > 0 ? out : undefined;
}

/**
 * Parse a JSON-stringified array of Crunchbase list summaries from an
 * Airtable multilineText cell. Returns undefined on missing input or any
 * parse / shape error — defensive because curators might edit the cell by
 * hand.
 */
function asJsonStringArray(v: unknown): string[] | undefined {
  if (typeof v !== 'string' || v.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(v) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const arr = parsed.filter((x): x is string => typeof x === 'string');
    return arr.length > 0 ? arr : undefined;
  } catch {
    return undefined;
  }
}

function asCrunchbaseLists(v: unknown): CrunchbaseList[] | undefined {
  if (typeof v !== 'string' || v.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(v) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const lists = parsed
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((x) => ({
        name: typeof x['name'] === 'string' ? (x['name'] as string) : '',
        countOrgs: typeof x['countOrgs'] === 'number' ? (x['countOrgs'] as number) : undefined,
        totalFunding: typeof x['totalFunding'] === 'string' ? (x['totalFunding'] as string) : undefined,
        countInvestors: typeof x['countInvestors'] === 'number' ? (x['countInvestors'] as number) : undefined,
      }))
      .filter((l) => l.name.length > 0);
    return lists.length > 0 ? lists : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Lookup maps bundle — fetched once and reused across hydrations
// ---------------------------------------------------------------------------
export interface LookupMaps {
  vendors: NameMap;
  categories: NameMap;
  disciplines: NameMap;
  phases: NameMap;
  tools: NameMap;
}

export async function buildLookupMaps(env: Env): Promise<LookupMaps> {
  const [vendorRecs, catRecs, discRecs, phaseRecs, toolRecs] = await Promise.all([
    fetchVendors(env),
    fetchCategories(env),
    fetchDisciplines(env),
    fetchProjectPhases(env),
    fetchTools(env),
  ]);

  return {
    vendors: buildNameMap(vendorRecs, 'company_name'),
    categories: buildNameMap(catRecs, 'Name'),
    disciplines: buildNameMap(discRecs, 'Name'),
    phases: buildNameMap(phaseRecs, 'Name'),
    tools: buildNameMap(toolRecs, 'Name'),
  };
}

// ---------------------------------------------------------------------------
// Tool hydration
// ---------------------------------------------------------------------------
export function hydrateTool(
  record: AirtableRecord,
  maps: LookupMaps,
): Tool {
  const sourceIds = record.get('tool_integrations_source');
  const targetIds = record.get('tool_integrations_target');
  const sourceCount = Array.isArray(sourceIds) ? sourceIds.length : 0;
  const targetCount = Array.isArray(targetIds) ? targetIds.length : 0;
  const storedIntegrationCount = asNumber(record.get('integration_count'));

  return {
    id: record.id,
    name: asString(record.get('Name')) ?? '',
    website: asString(record.get('website')),
    description: asString(record.get('description')),
    categories: toRefs(record.get('category'), maps.categories),
    vendors: toRefs(record.get('vendors'), maps.vendors),
    disciplines: toRefs(record.get('supported_disciplines'), maps.disciplines),
    phases: toRefs(record.get('supported_project_phases'), maps.phases),
    researchStatus: asString(record.get('research_status')),
    integrationCount: storedIntegrationCount ?? sourceCount + targetCount,

    hasApiDocs: asBoolean(record.get('has_api_docs')),
    apiDocsUrl: asString(record.get('api_docs_url')),
    toolIntegrationsUrl: asString(record.get('tool_integrations_url')),
    sourceMarketplaces: asStringArray(record.get('source_marketplaces')),
    marketplaceCount: asNumber(record.get('marketplace_count')),
    ipaasPlatforms: asStringArray(record.get('ipaas_platforms')),
    ipaasCount: asNumber(record.get('ipaas_count')),
    zapierTriggerCount: asNumber(record.get('zapier_trigger_count')),

    g2ReviewCount: asNumber(record.get('g2_review_count')),
    g2Rating: asNumber(record.get('g2_rating')),
    g2Url: asString(record.get('g2_url')),
    capterraReviewCount: asNumber(record.get('capterra_review_count')),
    capterraRating: asNumber(record.get('capterra_rating')),
    capterraUrl: asString(record.get('capterra_url')),
    searchVolumeMonthly: asNumber(record.get('search_volume_monthly')),
    googleTrendsIndex: asNumber(record.get('google_trends_index')),
    redditMentions24mo: asNumber(record.get('reddit_mentions_24mo')),

    integrationScore: asNumber(record.get('integration_score')),
    demandScore: asNumber(record.get('demand_score')),
    outreachScore: asNumber(record.get('outreach_score')),
    priorityScore: asNumber(record.get('priority_score')),
    priorityTier: asString(record.get('priority_tier')),
    emergingFlag: asBoolean(record.get('emerging_flag')),
    toolDataCompleteness: asNumber(record.get('tool_data_completeness')),
    toolEnrichmentStatus: asString(record.get('tool_enrichment_status')),
    lastToolEnrichedAt: asString(record.get('last_tool_enriched_at')),
    lastScoredAt: asString(record.get('last_scored_at')),
  };
}

export function hydrateToolDetail(
  record: AirtableRecord,
  maps: LookupMaps,
  integrationRecords: AirtableRecord[],
): ToolDetail {
  const base = hydrateTool(record, maps);
  const toolId = record.id;

  const integrationsAsSource: IntegrationSummary[] = [];
  const integrationsAsTarget: IntegrationSummary[] = [];

  for (const ir of integrationRecords) {
    const sourceIds = ir.get('Source Tool') as string[] | undefined;
    const targetIds = ir.get('Target Tool') as string[] | undefined;
    const isSource = Array.isArray(sourceIds) && sourceIds.includes(toolId);
    const isTarget = Array.isArray(targetIds) && targetIds.includes(toolId);

    if (!isSource && !isTarget) continue;

    const summary: IntegrationSummary = {
      id: ir.id,
      name: asString(ir.get('Name')) ?? '',
      sourceTool: toRef(sourceIds, maps.tools),
      targetTool: toRef(targetIds, maps.tools),
      integrationType: asString(ir.get('Integration Type')),
      description: asString(ir.get('Description')),
    };

    if (isSource) integrationsAsSource.push(summary);
    if (isTarget) integrationsAsTarget.push(summary);
  }

  return {
    ...base,
    researchNotes: asString(record.get('research_notes')),
    toolIntegrationCheckNotes: asString(record.get('tool_integration_check_notes')),
    toolIntegrationCheckedAt: asString(record.get('tool_integration_checked_at')),
    integrationsAsSource,
    integrationsAsTarget,
  };
}

// ---------------------------------------------------------------------------
// Vendor hydration
// ---------------------------------------------------------------------------
export function hydrateVendor(
  record: AirtableRecord,
  _maps: LookupMaps,
): Vendor {
  const toolIds = record.get('tools');
  return {
    id: record.id,
    companyName: asString(record.get('company_name')) ?? '',
    website: asString(record.get('website')),
    headquarters: asString(record.get('headquarters')),
    foundedYear: asNumber(record.get('founded_year')),
    companySize: asString(record.get('company_size')),
    publicPrivate: asString(record.get('public_private')),
    parentCompany: asString(record.get('parent_company')),
    logoUrl: asString(record.get('logo_url')),
    toolCount: Array.isArray(toolIds) ? toolIds.length : 0,

    fundingStage: asString(record.get('funding_stage')),
    githubStarsTotal: asNumber(record.get('github_stars_total')),
    vendorEnrichmentStatus: asString(record.get('vendor_enrichment_status')),
    vendorDataCompleteness: asNumber(record.get('vendor_data_completeness')),

    vqsScore: asNumber(record.get('vqs_score')),
    vqsTier: asString(record.get('vqs_tier')),
    vqsConfidence: asString(record.get('vqs_confidence')),
  };
}

export function hydrateVendorDetail(
  record: AirtableRecord,
  maps: LookupMaps,
): VendorDetail {
  const base = hydrateVendor(record, maps);
  return {
    ...base,
    description: asString(record.get('description')),
    linkedinUrl: asString(record.get('linkedin_url')),
    crunchbaseUrl: asString(record.get('crunchbase_url')),
    wikiUrl: asString(record.get('wiki_url')),
    sourceUrl: asString(record.get('source_url')),
    phoneNumber: asString(record.get('phone_number')),
    contactEmail: asString(record.get('contact_email')),
    tools: toRefs(record.get('tools'), maps.tools),

    githubOrg: asString(record.get('github_org')),
    githubOrgVerified: asBoolean(record.get('github_org_verified')),
    githubRepoCount: asNumber(record.get('github_repo_count')),
    hasSdkRepo: asBoolean(record.get('has_sdk_repo')),
    githubLastCommitDaysAgo: asNumber(record.get('github_last_commit_days_ago')),
    githubCheckedAt: asString(record.get('github_checked_at')),

    fundingCheckedAt: asString(record.get('funding_checked_at')),

    crunchbaseRank: asNumber(record.get('crunchbase_rank')),
    crunchbaseGrowthScore: asNumber(record.get('crunchbase_growth_score')),
    crunchbaseHeatScore: asNumber(record.get('crunchbase_heat_score')),
    crunchbaseCategories: asStringArray(record.get('crunchbase_categories')),
    monthlyWebVisits: asNumber(record.get('monthly_web_visits')),
    crunchbaseLists: asCrunchbaseLists(record.get('crunchbase_lists')),
    crunchbaseCheckedAt: asString(record.get('crunchbase_checked_at')),

    vqsCredibility: asNumber(record.get('vqs_credibility')),
    vqsMomentum: asNumber(record.get('vqs_momentum')),
    vqsFit: asNumber(record.get('vqs_fit')),
    vqsFlags: asJsonStringArray(record.get('vqs_flags')),

    lastEnrichedAt: asString(record.get('last_enriched_at')),
  };
}

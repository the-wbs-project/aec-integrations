// ---------------------------------------------------------------------------
// Record hydration — converts raw Airtable records into typed API shapes.
// ---------------------------------------------------------------------------
import type {
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

    employeeCountExact: asNumber(record.get('employee_count_exact')),
    fundingStage: asString(record.get('funding_stage')),
    githubStarsTotal: asNumber(record.get('github_stars_total')),
    vendorEnrichmentStatus: asString(record.get('vendor_enrichment_status')),
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
    sourceUrl: asString(record.get('source_url')),
    tools: toRefs(record.get('tools'), maps.tools),

    githubOrg: asString(record.get('github_org')),
    githubOrgVerified: asBoolean(record.get('github_org_verified')),
    githubRepoCount: asNumber(record.get('github_repo_count')),
    hasSdkRepo: asBoolean(record.get('has_sdk_repo')),
    githubLastCommitDaysAgo: asNumber(record.get('github_last_commit_days_ago')),
    githubCheckedAt: asString(record.get('github_checked_at')),

    totalFundingUsd: asNumber(record.get('total_funding_usd')),
    lastFundingDate: asString(record.get('last_funding_date')),
    fundingSourceUrl: asString(record.get('funding_source_url')),
    fundingCheckedAt: asString(record.get('funding_checked_at')),

    pressCount12mo: asNumber(record.get('press_count_12mo')),
    pressLatestDate: asString(record.get('press_latest_date')),
    pressCheckedAt: asString(record.get('press_checked_at')),
    blogUrl: asString(record.get('blog_url')),
    blogLastPostDate: asString(record.get('blog_last_post_date')),
    blogLastPostDaysAgo: asNumber(record.get('blog_last_post_days_ago')),
    blogCheckedAt: asString(record.get('blog_checked_at')),
    linkedinFollowers: asNumber(record.get('linkedin_followers')),
    linkedinCheckedAt: asString(record.get('linkedin_checked_at')),

    employeeSource: asString(record.get('employee_source')),
    employeeCheckedAt: asString(record.get('employee_checked_at')),

    vendorDataCompleteness: asNumber(record.get('vendor_data_completeness')),
    lastEnrichedAt: asString(record.get('last_enriched_at')),
  };
}

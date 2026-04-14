// ---------------------------------------------------------------------------
// Record hydration — converts raw Airtable records into typed API shapes.
// ---------------------------------------------------------------------------
import type { FieldSet, Record as AirtableRecord } from 'airtable';
import type {
  Env,
  IntegrationSummary,
  LinkRef,
  Tool,
  ToolDetail,
  Vendor,
  VendorDetail,
} from './types';
import {
  fetchCategories,
  fetchDisciplines,
  fetchIntegrations,
  fetchProjectPhases,
  fetchTools,
  fetchVendors,
} from './airtable';

// ---------------------------------------------------------------------------
// Lookup-map builders
// ---------------------------------------------------------------------------
export type NameMap = Map<string, string>;

/** Build a Map<recordId, primaryFieldValue> from an array of Airtable records. */
export function buildNameMap(
  records: AirtableRecord<FieldSet>[],
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
    vendors: buildNameMap(vendorRecs, 'Company Name'),
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
  record: AirtableRecord<FieldSet>,
  maps: LookupMaps,
): Tool {
  const sourceIds = record.get('Tool Integrations (Source Tool)');
  const targetIds = record.get('Tool Integrations (Target Tool)');
  const sourceCount = Array.isArray(sourceIds) ? sourceIds.length : 0;
  const targetCount = Array.isArray(targetIds) ? targetIds.length : 0;

  return {
    id: record.id,
    name: (record.get('Name') as string) ?? '',
    website: record.get('Website') as string | undefined,
    description: record.get('Description') as string | undefined,
    categories: toRefs(record.get('Category'), maps.categories),
    vendors: toRefs(record.get('Vendors'), maps.vendors),
    disciplines: toRefs(record.get('Supported Disciplines'), maps.disciplines),
    phases: toRefs(record.get('Supported Project Phases'), maps.phases),
    researchStatus: record.get('Research Status') as string | undefined,
    integrationCount: sourceCount + targetCount,
  };
}

export function hydrateToolDetail(
  record: AirtableRecord<FieldSet>,
  maps: LookupMaps,
  integrationRecords: AirtableRecord<FieldSet>[],
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
      name: (ir.get('Name') as string) ?? '',
      sourceTool: toRef(sourceIds, maps.tools),
      targetTool: toRef(targetIds, maps.tools),
      integrationType: ir.get('Integration Type') as string | undefined,
      description: ir.get('Description') as string | undefined,
    };

    if (isSource) integrationsAsSource.push(summary);
    if (isTarget) integrationsAsTarget.push(summary);
  }

  return {
    ...base,
    researchNotes: record.get('Research Notes') as string | undefined,
    integrationsAsSource,
    integrationsAsTarget,
  };
}

// ---------------------------------------------------------------------------
// Vendor hydration
// ---------------------------------------------------------------------------
export function hydrateVendor(
  record: AirtableRecord<FieldSet>,
  maps: LookupMaps,
): Vendor {
  const toolIds = record.get('Tools');
  return {
    id: record.id,
    companyName: (record.get('Company Name') as string) ?? '',
    website: record.get('Website') as string | undefined,
    headquarters: record.get('Headquarters') as string | undefined,
    foundedYear: record.get('Founded Year') as number | undefined,
    companySize: record.get('Company Size') as string | undefined,
    publicPrivate: record.get('Public/Private') as string | undefined,
    parentCompany: record.get('Parent Company') as string | undefined,
    logoUrl: record.get('Logo URL') as string | undefined,
    toolCount: Array.isArray(toolIds) ? toolIds.length : 0,
  };
}

export function hydrateVendorDetail(
  record: AirtableRecord<FieldSet>,
  maps: LookupMaps,
): VendorDetail {
  const base = hydrateVendor(record, maps);
  return {
    ...base,
    description: record.get('Description') as string | undefined,
    linkedinUrl: record.get('LinkedIn URL') as string | undefined,
    crunchbaseUrl: record.get('Crunchbase URL') as string | undefined,
    sourceUrl: record.get('Source URL') as string | undefined,
    tools: toRefs(record.get('Tools'), maps.tools),
  };
}

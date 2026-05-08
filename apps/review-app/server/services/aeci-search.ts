import type { Env } from '../env';
import type { IntegrationSummary, Product, Vendor } from '../types';
import {
  fetchIntegrations,
  fetchProducts,
  fetchVendors,
  type AirtableRecord,
} from './airtable';
import {
  buildLookupMaps,
  hydrateIntegration,
  hydrateProduct,
  hydrateVendor,
  type LookupMaps,
} from '../hydrate';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SAFE_BYTES = 3_800_000;
const AECI_SEARCH_INSTANCE = 'aeci-search';

const CUSTOM_METADATA = [
  { field_name: 'entity_type', data_type: 'text' },
  { field_name: 'category', data_type: 'text' },
  { field_name: 'discipline', data_type: 'text' },
  { field_name: 'project_phase', data_type: 'text' },
  { field_name: 'visibility', data_type: 'text' },
] satisfies Array<{ field_name: string; data_type: 'text' }>;

export type AeciSearchEntityType = 'product' | 'vendor' | 'integration' | 'evidence';
export type AeciSearchFilterKey =
  | 'entity_type'
  | 'category'
  | 'discipline'
  | 'project_phase'
  | 'visibility';

export interface AeciSearchFilters {
  entity_type?: AeciSearchEntityType | AeciSearchEntityType[];
  category?: string | string[];
  discipline?: string | string[];
  project_phase?: string | string[];
  visibility?: string | string[];
}

export interface AeciSearchRequest {
  query: string;
  filters?: AeciSearchFilters;
  limit?: number;
  matchThreshold?: number;
  retrievalType?: 'vector' | 'keyword' | 'hybrid';
}

export interface AeciSearchResult {
  id: string;
  key: string;
  title: string;
  snippet: string;
  sourceUrl?: string;
  entityType?: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface AeciSearchResponse {
  query: string;
  searchQuery: string;
  results: AeciSearchResult[];
}

export interface AeciSearchSyncRequest {
  products?: number;
  vendors?: number;
  integrations?: number;
  evidence?: number | boolean;
  poll?: boolean;
}

export interface AeciSearchSyncResult {
  configured: boolean;
  uploaded: Array<{ key: string; status: string; id?: string }>;
  errors: Array<{ key: string; error: string }>;
  counts: {
    products: number;
    vendors: number;
    integrations: number;
    evidence: number;
  };
}

interface SearchDocument {
  key: string;
  body: string;
  metadata: Record<AeciSearchFilterKey, string>;
}

export async function configureAeciSearch(env: Env): Promise<AiSearchInstanceInfo> {
  const instance = await getOrCreateAeciSearchInstance(env);
  return instance.update({
    index_method: { vector: true, keyword: true },
    fusion_method: 'rrf',
    custom_metadata: CUSTOM_METADATA,
    score_threshold: 0.4,
    max_num_results: 10,
  });
}

export async function searchAeciCorpus(
  env: Env,
  request: AeciSearchRequest,
): Promise<AeciSearchResponse> {
  const query = request.query.trim();
  if (query.length === 0) {
    throw new Error('query is required');
  }

  const limit = clampInteger(request.limit ?? 10, 1, 50);
  const threshold = clampNumber(request.matchThreshold ?? 0.4, 0, 1);
  const filters = toAiSearchFilters(request.filters);
  const instance = env.AECI_SEARCH.get(AECI_SEARCH_INSTANCE);

  const response = await instance.search({
    query,
    ai_search_options: {
      retrieval: {
        retrieval_type: request.retrievalType ?? 'hybrid',
        fusion_method: 'rrf',
        max_num_results: limit,
        match_threshold: threshold,
        ...(filters ? { filters } : {}),
      },
    },
  });

  return {
    query,
    searchQuery: response.search_query,
    results: response.chunks.map(normalizeChunk),
  };
}

export async function syncAeciSearchCorpus(
  env: Env,
  request: AeciSearchSyncRequest = {},
): Promise<AeciSearchSyncResult> {
  await configureAeciSearch(env);

  const docs = await buildSearchDocuments(env, request);
  const result: AeciSearchSyncResult = {
    configured: true,
    uploaded: [],
    errors: [],
    counts: { products: 0, vendors: 0, integrations: 0, evidence: 0 },
  };

  for (const doc of docs) {
    const kind = doc.metadata.entity_type as AeciSearchEntityType;
    result.counts[pluralCountKey(kind)] += 1;

    try {
      const instance = env.AECI_SEARCH.get(AECI_SEARCH_INSTANCE);
      const item = request.poll
        ? await instance.items.uploadAndPoll(doc.key, doc.body, {
            metadata: doc.metadata,
            pollIntervalMs: 1000,
            timeoutMs: 30_000,
          })
        : await instance.items.upload(doc.key, doc.body, {
            metadata: doc.metadata,
          });
      result.uploaded.push({ key: doc.key, status: item.status, id: item.id });
    } catch (err) {
      result.errors.push({
        key: doc.key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

async function getOrCreateAeciSearchInstance(env: Env): Promise<AiSearchInstance> {
  const existing = env.AECI_SEARCH.get(AECI_SEARCH_INSTANCE);
  try {
    await existing.info();
    return existing;
  } catch {
    return env.AECI_SEARCH.create({
      id: AECI_SEARCH_INSTANCE,
      index_method: { vector: true, keyword: true },
      fusion_method: 'rrf',
      custom_metadata: CUSTOM_METADATA,
      score_threshold: 0.4,
      max_num_results: 10,
    });
  }
}

async function buildSearchDocuments(
  env: Env,
  request: AeciSearchSyncRequest,
): Promise<SearchDocument[]> {
  const [maps, productRecords, vendorRecords, integrationRecords] = await Promise.all([
    buildLookupMaps(env),
    fetchProducts(env),
    fetchVendors(env),
    fetchIntegrations(env),
  ]);

  const productLimit = normalizeLimit(request.products, 25);
  const vendorLimit = normalizeLimit(request.vendors, 10);
  const integrationLimit = normalizeLimit(request.integrations, 25);
  const evidenceLimit = normalizeEvidenceLimit(request.evidence, productLimit);

  const products = productRecords.slice(0, productLimit).map((r) => hydrateProduct(r, maps));
  const vendors = vendorRecords.slice(0, vendorLimit).map((r) => hydrateVendor(r, maps));
  const integrations = integrationRecords
    .slice(0, integrationLimit)
    .map((r) => hydrateIntegration(r, maps));

  return [
    ...products.map(productDocument),
    ...vendors.map(vendorDocument),
    ...integrations.map(integrationDocument),
    ...productRecords
      .slice(0, evidenceLimit)
      .map((record) => evidenceDocument(record, maps))
      .filter((doc): doc is SearchDocument => doc !== null),
  ];
}

function productDocument(product: Product): SearchDocument {
  const metadata = productMetadata(product, 'product');
  const lines = [
    `# ${product.name}`,
    '',
    `Entity type: product`,
    `Record ID: ${product.id}`,
    `Review URL: /products/${product.id}/details`,
    product.website ? `Website: ${product.website}` : undefined,
    product.description ? `Summary: ${product.description}` : undefined,
    formatList('Vendors', product.vendors.map((v) => v.name)),
    formatList('Categories', product.categories.map((c) => c.name)),
    formatList('Disciplines', product.disciplines.map((d) => d.name)),
    formatList('Project phases', product.phases.map((p) => p.name)),
    product.hasApiDocs !== undefined
      ? `API documentation: ${product.hasApiDocs ? 'yes' : 'no'}`
      : undefined,
    product.apiDocsUrl ? `API docs URL: ${product.apiDocsUrl}` : undefined,
    product.toolIntegrationsUrl
      ? `Integrations page: ${product.toolIntegrationsUrl}`
      : undefined,
    formatList('AEC marketplaces', product.sourceMarketplaces ?? []),
    formatList('iPaaS platforms', product.ipaasPlatforms ?? []),
    product.integrationCount ? `Known integration count: ${product.integrationCount}` : undefined,
    product.priorityScore !== undefined
      ? `Priority score: ${product.priorityScore}`
      : undefined,
    product.priorityTier ? `Priority tier: ${product.priorityTier}` : undefined,
    product.vendorVqsScore !== undefined
      ? `Vendor quality score: ${product.vendorVqsScore}`
      : undefined,
  ];

  return {
    key: `products/${product.id}.md`,
    body: boundedMarkdown(lines),
    metadata,
  };
}

function vendorDocument(vendor: Vendor): SearchDocument {
  const lines = [
    `# ${vendor.companyName}`,
    '',
    `Entity type: vendor`,
    `Record ID: ${vendor.id}`,
    `Review URL: /vendors/${vendor.id}/details`,
    vendor.website ? `Website: ${vendor.website}` : undefined,
    vendor.companySize ? `Company size: ${vendor.companySize}` : undefined,
    vendor.fundingStage ? `Funding stage: ${vendor.fundingStage}` : undefined,
    vendor.publicPrivate ? `Ownership: ${vendor.publicPrivate}` : undefined,
    vendor.headquarters ? `Headquarters: ${vendor.headquarters}` : undefined,
    vendor.githubStarsTotal !== undefined
      ? `GitHub stars total: ${vendor.githubStarsTotal}`
      : undefined,
    vendor.vqsScore !== undefined ? `Vendor quality score: ${vendor.vqsScore}` : undefined,
    vendor.vqsTier ? `Vendor quality tier: ${vendor.vqsTier}` : undefined,
    vendor.toolCount ? `Known product count: ${vendor.toolCount}` : undefined,
  ];

  return {
    key: `vendors/${vendor.id}.md`,
    body: boundedMarkdown(lines),
    metadata: {
      entity_type: 'vendor',
      category: '',
      discipline: '',
      project_phase: '',
      visibility: 'internal',
    },
  };
}

function integrationDocument(integration: IntegrationSummary): SearchDocument {
  const reviewPath = integration.sourceProduct
    ? `/products/${integration.sourceProduct.id}/integrations`
    : integration.targetProduct
    ? `/products/${integration.targetProduct.id}/integrations`
    : undefined;
  const lines = [
    `# ${integration.name}`,
    '',
    `Entity type: integration`,
    `Record ID: ${integration.id}`,
    reviewPath ? `Review URL: ${reviewPath}` : undefined,
    integration.sourceProduct ? `Source product: ${integration.sourceProduct.name}` : undefined,
    integration.targetProduct ? `Target product: ${integration.targetProduct.name}` : undefined,
    integration.description ? `Description: ${integration.description}` : undefined,
    integration.mechanismKind ? `Mechanism kind: ${integration.mechanismKind}` : undefined,
    integration.mechanismName ? `Mechanism name: ${integration.mechanismName}` : undefined,
    integration.poweredByProduct
      ? `Powered by product: ${integration.poweredByProduct.name}`
      : undefined,
    integration.direction ? `Direction: ${integration.direction}` : undefined,
    integration.maturity ? `Maturity: ${integration.maturity}` : undefined,
    integration.listingUrl ? `Listing URL: ${integration.listingUrl}` : undefined,
    integration.docsUrl ? `Docs URL: ${integration.docsUrl}` : undefined,
    integration.notes ? `Notes: ${integration.notes}` : undefined,
  ];

  return {
    key: `integrations/${integration.id}.md`,
    body: boundedMarkdown(lines),
    metadata: {
      entity_type: 'integration',
      category: integration.mechanismKind ?? '',
      discipline: '',
      project_phase: '',
      visibility: 'internal',
    },
  };
}

function evidenceDocument(record: AirtableRecord, maps: LookupMaps): SearchDocument | null {
  const product = hydrateProduct(record, maps);
  const sourceLines = [
    product.website ? `Product website: ${product.website}` : undefined,
    product.apiDocsUrl ? `API docs: ${product.apiDocsUrl}` : undefined,
    product.toolIntegrationsUrl
      ? `Product integrations page: ${product.toolIntegrationsUrl}`
      : undefined,
    product.g2Url ? `G2: ${product.g2Url}` : undefined,
    product.capterraUrl ? `Capterra: ${product.capterraUrl}` : undefined,
    product.zapierUrl ? `Zapier: ${product.zapierUrl}` : undefined,
    product.makeUrl ? `Make: ${product.makeUrl}` : undefined,
    product.workatoUrl ? `Workato: ${product.workatoUrl}` : undefined,
  ].filter((x): x is string => Boolean(x));

  const notes = [
    record.fields['research_notes'],
    record.fields['tool_integration_check_notes'],
    record.fields['integrations_discovery_summary'],
  ].filter((x): x is string => typeof x === 'string' && x.trim().length > 0);

  if (sourceLines.length === 0 && notes.length === 0) return null;

  return {
    key: `evidence/${product.id}.md`,
    body: boundedMarkdown([
      `# Evidence for ${product.name}`,
      '',
      `Entity type: evidence`,
      `Record ID: ${product.id}`,
      `Review URL: /products/${product.id}/details`,
      sourceLines.length > 0 ? '## Source links' : undefined,
      ...sourceLines.map((line) => `- ${line}`),
      notes.length > 0 ? '## Notes' : undefined,
      ...notes.map((note) => note.trim()),
    ]),
    metadata: productMetadata(product, 'evidence'),
  };
}

function productMetadata(
  product: Product,
  entityType: 'product' | 'evidence',
): Record<AeciSearchFilterKey, string> {
  return {
    entity_type: entityType,
    category: product.categories[0]?.name ?? '',
    discipline: product.disciplines[0]?.name ?? '',
    project_phase: product.phases[0]?.name ?? '',
    visibility: product.promotionStatus ?? 'internal',
  };
}

function normalizeChunk(chunk: AiSearchSearchResponse['chunks'][number]): AeciSearchResult {
  const metadata = chunk.item.metadata ?? {};
  const title = extractHeading(chunk.text) ?? chunk.item.key.replace(/\.md$/, '');
  const sourceUrl = extractField(chunk.text, 'Review URL') ?? extractField(chunk.text, 'Website');
  return {
    id: chunk.id,
    key: chunk.item.key,
    title,
    snippet: makeSnippet(chunk.text),
    sourceUrl,
    entityType:
      typeof metadata['entity_type'] === 'string'
        ? metadata['entity_type']
        : inferEntityType(chunk.item.key),
    score: chunk.score,
    metadata,
  };
}

function toAiSearchFilters(
  filters: AeciSearchFilters | undefined,
): VectorizeVectorMetadataFilter | undefined {
  if (!filters) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of ['entity_type', 'category', 'discipline', 'project_phase', 'visibility'] as const) {
    const value = filters[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const values = value.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      if (values.length > 0) out[key] = { $in: values };
    } else if (typeof value === 'string' && value.trim().length > 0) {
      out[key] = value.trim();
    }
  }
  return Object.keys(out).length > 0 ? (out as VectorizeVectorMetadataFilter) : undefined;
}

function boundedMarkdown(lines: Array<string | undefined>): string {
  const body = lines.filter((line): line is string => line !== undefined && line.length > 0).join('\n');
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes <= MAX_SAFE_BYTES) return body;
  if (bytes > MAX_FILE_BYTES) {
    return `${body.slice(0, MAX_SAFE_BYTES)}\n\n[Truncated before indexing to stay below AI Search's 4 MB file limit.]`;
  }
  return body;
}

function formatList(label: string, values: string[]): string | undefined {
  const clean = values.map((v) => v.trim()).filter(Boolean);
  return clean.length > 0 ? `${label}: ${clean.join(', ')}` : undefined;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return clampInteger(value, 0, 5000);
}

function normalizeEvidenceLimit(
  value: AeciSearchSyncRequest['evidence'],
  fallback: number,
): number {
  if (value === false) return 0;
  if (value === true || value === undefined) return fallback;
  return clampInteger(value, 0, 5000);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function makeSnippet(text: string): string {
  return text
    .replace(/^# .+$/m, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 480);
}

function extractHeading(text: string): string | undefined {
  const match = text.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

function extractField(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^${escaped}:\\s+(.+)$`, 'm'));
  return match?.[1]?.trim();
}

function inferEntityType(key: string): AeciSearchEntityType | undefined {
  if (key.startsWith('products/')) return 'product';
  if (key.startsWith('vendors/')) return 'vendor';
  if (key.startsWith('integrations/')) return 'integration';
  if (key.startsWith('evidence/')) return 'evidence';
  return undefined;
}

function pluralCountKey(kind: AeciSearchEntityType): keyof AeciSearchSyncResult['counts'] {
  if (kind === 'evidence') return 'evidence';
  return `${kind}s` as keyof AeciSearchSyncResult['counts'];
}

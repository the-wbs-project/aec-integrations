// ---------------------------------------------------------------------------
// Cloudflare Worker environment bindings
// ---------------------------------------------------------------------------
export interface AirtableTables {
  tools: string;
  vendors: string;
  categories: string;
  projectPhases: string;
  disciplines: string;
  toolIntegrations: string;
}

export interface Env {
  AIRTABLE_TOKEN: string;
  AIRTABLE_BASE_ID: string;
  AIRTABLE_TABLES: AirtableTables;
  ASSETS: Fetcher;
  CACHE: KVNamespace;
}

// ---------------------------------------------------------------------------
// Shared response primitives
// ---------------------------------------------------------------------------
export interface LinkRef {
  id: string;
  name: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  offset: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
export interface Tool {
  id: string;
  name: string;
  website?: string;
  description?: string;
  categories: LinkRef[];
  vendors: LinkRef[];
  disciplines: LinkRef[];
  phases: LinkRef[];
  researchStatus?: string;
  integrationCount: number;
}

export interface ToolDetail extends Tool {
  researchNotes?: string;
  integrationsAsSource: IntegrationSummary[];
  integrationsAsTarget: IntegrationSummary[];
}

export interface IntegrationSummary {
  id: string;
  name: string;
  sourceTool?: LinkRef;
  targetTool?: LinkRef;
  integrationType?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------
export interface Vendor {
  id: string;
  companyName: string;
  website?: string;
  headquarters?: string;
  foundedYear?: number;
  companySize?: string;
  publicPrivate?: string;
  parentCompany?: string;
  logoUrl?: string;
  toolCount: number;
}

export interface VendorDetail extends Vendor {
  description?: string;
  linkedinUrl?: string;
  crunchbaseUrl?: string;
  sourceUrl?: string;
  tools: LinkRef[];
}

// ---------------------------------------------------------------------------
// Meta (filter dropdown data)
// ---------------------------------------------------------------------------
export interface MetaResponse {
  categories: LinkRef[];
  disciplines: LinkRef[];
  phases: LinkRef[];
  researchStatuses: string[];
}

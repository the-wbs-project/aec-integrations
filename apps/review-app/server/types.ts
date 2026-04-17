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

  // Enrichment signals
  hasApiDocs?: boolean;
  apiDocsUrl?: string;
  toolIntegrationsUrl?: string;
  sourceMarketplaces?: string[];
  marketplaceCount?: number;
  ipaasPlatforms?: string[];
  ipaasCount?: number;
  zapierTriggerCount?: number;

  // Market signals
  g2ReviewCount?: number;
  g2Rating?: number;
  g2Url?: string;
  capterraReviewCount?: number;
  capterraRating?: number;
  capterraUrl?: string;
  searchVolumeMonthly?: number;
  googleTrendsIndex?: number;
  redditMentions24mo?: number;

  // Scoring
  integrationScore?: number;
  demandScore?: number;
  outreachScore?: number;
  priorityScore?: number;
  priorityTier?: string;
  emergingFlag?: boolean;
  toolDataCompleteness?: number;
  toolEnrichmentStatus?: string;
  lastToolEnrichedAt?: string;
  lastScoredAt?: string;
}

export interface ToolDetail extends Tool {
  researchNotes?: string;
  toolIntegrationCheckNotes?: string;
  toolIntegrationCheckedAt?: string;
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

  // Enrichment-derived summary fields for list views
  employeeCountExact?: number;
  fundingStage?: string;
  githubStarsTotal?: number;
  vendorEnrichmentStatus?: string;
}

export interface VendorDetail extends Vendor {
  description?: string;
  linkedinUrl?: string;
  crunchbaseUrl?: string;
  sourceUrl?: string;
  tools: LinkRef[];

  // GitHub
  githubOrg?: string;
  githubOrgVerified?: boolean;
  githubRepoCount?: number;
  hasSdkRepo?: boolean;
  githubLastCommitDaysAgo?: number;
  githubCheckedAt?: string;

  // Funding
  totalFundingUsd?: number;
  lastFundingDate?: string;
  fundingSourceUrl?: string;
  fundingCheckedAt?: string;

  // Press & activity
  pressCount12mo?: number;
  pressLatestDate?: string;
  pressCheckedAt?: string;
  blogUrl?: string;
  blogLastPostDate?: string;
  blogLastPostDaysAgo?: number;
  blogCheckedAt?: string;
  linkedinFollowers?: number;
  linkedinCheckedAt?: string;

  // Employees
  employeeSource?: string;
  employeeCheckedAt?: string;

  // Orchestrator
  vendorDataCompleteness?: number;
  lastEnrichedAt?: string;
}

// ---------------------------------------------------------------------------
// Meta (filter dropdown data)
// ---------------------------------------------------------------------------
export interface MetaResponse {
  categories: LinkRef[];
  disciplines: LinkRef[];
  phases: LinkRef[];
  researchStatuses: string[];
  priorityTiers: string[];
  toolEnrichmentStatuses: string[];
}

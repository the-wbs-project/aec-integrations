// ---------------------------------------------------------------------------
// API response/request shapes for the data layer (vendors, tools, meta).
//
// Env / AirtableTables now live in `./env.ts` so the workflow runners share
// a single source of truth. Re-exported here for backward compatibility with
// existing route imports.
// ---------------------------------------------------------------------------
export type { Env, AirtableTables } from './env';

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
  vendors: LinkRef[];
  researchStatuses: string[];
  priorityTiers: string[];
  toolEnrichmentStatuses: string[];
}

// ---------------------------------------------------------------------------
// Write payloads
// ---------------------------------------------------------------------------
export interface CreateToolRequest {
  name: string;
  description?: string;
  website?: string;
}

/**
 * Partial update payload. Linked-record fields accept arrays of Airtable
 * record IDs (the form sends IDs, not LinkRefs).
 */
export interface UpdateToolRequest {
  name?: string;
  description?: string;
  website?: string;
  toolIntegrationsUrl?: string;
  apiDocsUrl?: string;
  hasApiDocs?: boolean;
  researchStatus?: string;
  researchNotes?: string;
  toolIntegrationCheckNotes?: string;
  categories?: string[];
  disciplines?: string[];
  phases?: string[];
  vendors?: string[];
}

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
  /**
   * Legacy — was the per-tool outreach pillar (vendor-derived). Removed when
   * priority moved to a 2-pillar model; vendor outreach quality lives in VQS.
   * Field is no longer written by T08; kept on the type so historical Airtable
   * values still hydrate without errors.
   */
  outreachScore?: number;
  priorityScore?: number;
  priorityTier?: string;
  priorityConfidence?: string;
  priorityFlags?: string[];
  emergingFlag?: boolean;
  toolDataCompleteness?: number;
  toolEnrichmentStatus?: string;
  lastToolEnrichedAt?: string;
  lastScoredAt?: string;

  // Linked vendor's VQS — surfaced in tool list/detail so users can see vendor
  // outreach quality next to tool-intrinsic priority without it being
  // multiplied into the score.
  vendorVqsScore?: number;
  vendorVqsTier?: string;
}

export interface ToolDetail extends Tool {
  researchNotes?: string;
  toolIntegrationCheckNotes?: string;
  toolIntegrationCheckedAt?: string;
  adminNotes?: string;
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
  fundingStage?: string;
  githubStarsTotal?: number;
  vendorEnrichmentStatus?: string;
  vendorDataCompleteness?: number;

  // Vendor Quality Score (see docs/vendor-quality-score.md)
  vqsScore?: number;
  vqsTier?: string;
  vqsConfidence?: string;
}

export interface VendorDetail extends Vendor {
  description?: string;
  linkedinUrl?: string;
  crunchbaseUrl?: string;
  wikiUrl?: string;
  sourceUrl?: string;
  phoneNumber?: string;
  contactEmail?: string;
  tools: LinkRef[];

  // GitHub
  githubOrg?: string;
  githubOrgVerified?: boolean;
  githubRepoCount?: number;
  hasSdkRepo?: boolean;
  githubLastCommitDaysAgo?: number;
  githubCheckedAt?: string;

  // Funding
  fundingCheckedAt?: string;

  // Crunchbase signals — written by vendor-overview when the Scrapfly fetch
  // succeeds and the parsed snapshot is useful (>=3 of 5 critical fields).
  crunchbaseRank?: number;
  crunchbaseGrowthScore?: number;
  crunchbaseHeatScore?: number;
  crunchbaseCategories?: string[];
  monthlyWebVisits?: number;
  /** "Lists Featuring This Company" block, parsed from JSON-stringified Airtable text. */
  crunchbaseLists?: CrunchbaseList[];
  crunchbaseCheckedAt?: string;

  // Vendor Quality Score breakdown (see docs/vendor-quality-score.md)
  vqsCredibility?: number;
  vqsMomentum?: number;
  vqsFit?: number;
  vqsFlags?: string[];

  // Orchestrator
  lastEnrichedAt?: string;

  adminNotes?: string;
}

export interface CrunchbaseList {
  name: string;
  countOrgs?: number;
  totalFunding?: string;
  countInvestors?: number;
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
  adminNotes?: string;
  categories?: string[];
  disciplines?: string[];
  phases?: string[];
  vendors?: string[];
}

/**
 * Partial update payload for vendors. All fields optional — only the keys
 * present in the body are written to Airtable.
 */
export interface UpdateVendorRequest {
  companyName?: string;
  description?: string;
  website?: string;
  headquarters?: string;
  foundedYear?: number | null;
  publicPrivate?: string | null;
  parentCompany?: string;
  linkedinUrl?: string;
  crunchbaseUrl?: string;
  wikiUrl?: string;
  sourceUrl?: string;
  githubOrg?: string;
  phoneNumber?: string;
  contactEmail?: string;
  adminNotes?: string;
}

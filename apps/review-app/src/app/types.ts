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

  fundingStage?: string;
  githubStarsTotal?: number;
  vendorEnrichmentStatus?: string;
  vendorDataCompleteness?: number;

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

  githubOrg?: string;
  githubOrgVerified?: boolean;
  githubRepoCount?: number;
  hasSdkRepo?: boolean;
  githubLastCommitDaysAgo?: number;
  githubCheckedAt?: string;

  fundingCheckedAt?: string;

  crunchbaseRank?: number;
  crunchbaseGrowthScore?: number;
  crunchbaseHeatScore?: number;
  crunchbaseCategories?: string[];
  monthlyWebVisits?: number;
  crunchbaseLists?: CrunchbaseList[];
  crunchbaseCheckedAt?: string;

  vqsCredibility?: number;
  vqsMomentum?: number;
  vqsFit?: number;
  vqsFlags?: string[];

  lastEnrichedAt?: string;

  adminNotes?: string;
}

export interface CrunchbaseList {
  name: string;
  countOrgs?: number;
  totalFunding?: string;
  countInvestors?: number;
}

export interface MetaResponse {
  categories: LinkRef[];
  disciplines: LinkRef[];
  phases: LinkRef[];
  vendors: LinkRef[];
  researchStatuses: string[];
  priorityTiers: string[];
  toolEnrichmentStatuses: string[];
}

export interface StatsResponse {
  integrations: { total: number };
  vendors: {
    total: number;
    byStatus: Record<string, number>;
    byTier: Record<string, number>;
    tierBuckets: { key: string; label: string }[];
  };
  tools: {
    total: number;
    byResearchStatus: Record<string, number>;
    byPriority: Record<string, number>;
  };
}

// ---------------------------------------------------------------------------
// Write payloads (mirror server/types.ts)
// ---------------------------------------------------------------------------
export interface CreateToolRequest {
  name: string;
  description?: string;
  website?: string;
}

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

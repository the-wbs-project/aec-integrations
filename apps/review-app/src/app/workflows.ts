// ---------------------------------------------------------------------------
// Single source of truth for the UI's workflow catalog. Mirrors the keys in
// server/workflows/registry.ts.
// ---------------------------------------------------------------------------
export interface WorkflowMeta {
  slug: string;
  family: 'vendor' | 'tool';
  title: string;
  blurb: string;
}

export const WORKFLOWS: WorkflowMeta[] = [
  // Vendor family
  { slug: 'vendor-orchestrator', family: 'vendor', title: 'V00 · Orchestrator', blurb: 'Run the full vendor enrichment pipeline.' },
  { slug: 'vendor-overview', family: 'vendor', title: 'V0R · Overview', blurb: 'Crunchbase + Wikipedia: description, HQ, founded year, public/private, parent, phone, email.' },
  { slug: 'vendor-github', family: 'vendor', title: 'V02 · GitHub', blurb: 'GitHub org, repos, stars, last commit.' },
  { slug: 'vendor-funding', family: 'vendor', title: 'V04 · Funding', blurb: 'Funding stage.' },
  { slug: 'vendor-score', family: 'vendor', title: 'V07 · Vendor Quality Score', blurb: 'Compute Credibility / Momentum / Fit and tier.' },

  // Tool family
  { slug: 'product-orchestrator', family: 'tool', title: 'T00 · Orchestrator', blurb: 'Run the full tool enrichment pipeline.' },
  { slug: 'product-overview', family: 'tool', title: 'T0R · Overview', blurb: 'Scrape G2 + Capterra for review counts and ratings.' },
  { slug: 'product-research', family: 'tool', title: 'TR · Research', blurb: 'Research a Pending tool: description, categories, disciplines, phases.' },
  { slug: 'product-api-check', family: 'tool', title: 'T01 · API check', blurb: 'Detect official API documentation.' },
  { slug: 'product-marketplace', family: 'tool', title: 'T02 · Marketplace', blurb: 'Procore, Autodesk, Trimble, Bluebeam presence.' },
  { slug: 'product-ipaas', family: 'tool', title: 'T03 · iPaaS', blurb: 'Zapier, Make, Workato presence.' },
  { slug: 'product-reviews', family: 'tool', title: 'T04 · Reviews', blurb: 'G2 + Capterra ratings and counts (LLM fallback).' },
  { slug: 'product-search-demand', family: 'tool', title: 'T05 · Search demand', blurb: 'Google Trends + search volume.' },
  { slug: 'product-reddit', family: 'tool', title: 'T06 · Reddit', blurb: 'Reddit mentions in AEC subreddits.' },
  { slug: 'product-integration-count', family: 'tool', title: 'T07 · Integration count', blurb: 'Sum linked tool integrations.' },
  { slug: 'product-score', family: 'tool', title: 'T08 · Priority score', blurb: 'Integration / demand / priority.' },
];

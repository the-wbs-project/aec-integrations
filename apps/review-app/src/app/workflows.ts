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
  { slug: 'vendor-research', family: 'vendor', title: 'V0R · Research', blurb: 'Description, HQ, founded year, public/private, parent company.' },
  { slug: 'vendor-linkedin', family: 'vendor', title: 'V01 · LinkedIn', blurb: 'LinkedIn URL + follower count.' },
  { slug: 'vendor-github', family: 'vendor', title: 'V02 · GitHub', blurb: 'GitHub org, repos, stars, last commit.' },
  { slug: 'vendor-company-size', family: 'vendor', title: 'V03 · Company size', blurb: 'Employee bucket + exact count.' },
  { slug: 'vendor-funding', family: 'vendor', title: 'V04 · Funding', blurb: 'Funding stage, total raised, source.' },
  { slug: 'vendor-press', family: 'vendor', title: 'V05 · Press', blurb: '12-month press mention count.' },
  { slug: 'vendor-blog-recency', family: 'vendor', title: 'V06 · Blog recency', blurb: 'Blog URL + last post date.' },
  { slug: 'vendor-score', family: 'vendor', title: 'V07 · Score (completeness)', blurb: 'Recompute completeness ratio + status.' },

  // Tool family
  { slug: 'tool-orchestrator', family: 'tool', title: 'T00 · Orchestrator', blurb: 'Run the full tool enrichment pipeline.' },
  { slug: 'tool-research', family: 'tool', title: 'T0R · Research', blurb: 'Research a Pending tool: description, categories, disciplines, phases.' },
  { slug: 'tool-api-check', family: 'tool', title: 'T01 · API check', blurb: 'Detect official API documentation.' },
  { slug: 'tool-marketplace', family: 'tool', title: 'T02 · Marketplace', blurb: 'Procore, Autodesk, Trimble, Bluebeam presence.' },
  { slug: 'tool-ipaas', family: 'tool', title: 'T03 · iPaaS', blurb: 'Zapier, Make, Workato presence.' },
  { slug: 'tool-reviews', family: 'tool', title: 'T04 · Reviews', blurb: 'G2 + Capterra ratings and counts.' },
  { slug: 'tool-search-demand', family: 'tool', title: 'T05 · Search demand', blurb: 'Google Trends + search volume.' },
  { slug: 'tool-reddit', family: 'tool', title: 'T06 · Reddit', blurb: 'Reddit mentions in AEC subreddits.' },
  { slug: 'tool-integration-count', family: 'tool', title: 'T07 · Integration count', blurb: 'Sum linked tool integrations.' },
  { slug: 'tool-score', family: 'tool', title: 'T08 · Priority score', blurb: 'Integration / demand / outreach / priority.' },
];

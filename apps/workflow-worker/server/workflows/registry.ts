// ---------------------------------------------------------------------------
// Workflow registry — maps slug → meta + the env binding name to dispatch on.
//
// Each workflow exports a WorkflowEntrypoint class as its own Cloudflare
// Workflow binding. Routes dispatch via `env[bindingName]` so the registry
// stays tiny and fully typed.
// ---------------------------------------------------------------------------
import type { Env } from '../env';
import type { WorkflowMeta } from '../lib/workflow-meta';

import { meta as vendorLinkedinMeta } from './vendor/linkedin';
import { meta as vendorGithubMeta } from './vendor/github';
import { meta as vendorCompanySizeMeta } from './vendor/companySize';
import { meta as vendorFundingMeta } from './vendor/funding';
import { meta as vendorPressMeta } from './vendor/press';
import { meta as vendorBlogRecencyMeta } from './vendor/blogRecency';
import { meta as vendorScoreMeta } from './vendor/score';
import { meta as vendorOrchestratorMeta } from './vendor/orchestrator';

import { meta as toolApiCheckMeta } from './tool/apiCheck';
import { meta as toolMarketplaceMeta } from './tool/marketplace';
import { meta as toolIpaasMeta } from './tool/ipaas';
import { meta as toolReviewsMeta } from './tool/reviews';
import { meta as toolSearchDemandMeta } from './tool/searchDemand';
import { meta as toolRedditMeta } from './tool/reddit';
import { meta as toolIntegrationCountMeta } from './tool/integrationCount';
import { meta as toolScoreMeta } from './tool/score';
import { meta as toolOrchestratorMeta } from './tool/orchestrator';

/** Names of every Workflow binding on Env. */
export type WorkflowBindingName =
  | 'WF_VENDOR_LINKEDIN'
  | 'WF_VENDOR_GITHUB'
  | 'WF_VENDOR_COMPANY_SIZE'
  | 'WF_VENDOR_FUNDING'
  | 'WF_VENDOR_PRESS'
  | 'WF_VENDOR_BLOG_RECENCY'
  | 'WF_VENDOR_SCORE'
  | 'WF_VENDOR_ORCHESTRATOR'
  | 'WF_TOOL_API_CHECK'
  | 'WF_TOOL_MARKETPLACE'
  | 'WF_TOOL_IPAAS'
  | 'WF_TOOL_REVIEWS'
  | 'WF_TOOL_SEARCH_DEMAND'
  | 'WF_TOOL_REDDIT'
  | 'WF_TOOL_INTEGRATION_COUNT'
  | 'WF_TOOL_SCORE'
  | 'WF_TOOL_ORCHESTRATOR';

export interface WorkflowEntry {
  meta: WorkflowMeta;
  binding: WorkflowBindingName;
}

export const WORKFLOWS: Record<string, WorkflowEntry> = {
  [vendorLinkedinMeta.slug]: { meta: vendorLinkedinMeta, binding: 'WF_VENDOR_LINKEDIN' },
  [vendorGithubMeta.slug]: { meta: vendorGithubMeta, binding: 'WF_VENDOR_GITHUB' },
  [vendorCompanySizeMeta.slug]: { meta: vendorCompanySizeMeta, binding: 'WF_VENDOR_COMPANY_SIZE' },
  [vendorFundingMeta.slug]: { meta: vendorFundingMeta, binding: 'WF_VENDOR_FUNDING' },
  [vendorPressMeta.slug]: { meta: vendorPressMeta, binding: 'WF_VENDOR_PRESS' },
  [vendorBlogRecencyMeta.slug]: { meta: vendorBlogRecencyMeta, binding: 'WF_VENDOR_BLOG_RECENCY' },
  [vendorScoreMeta.slug]: { meta: vendorScoreMeta, binding: 'WF_VENDOR_SCORE' },
  [vendorOrchestratorMeta.slug]: {
    meta: vendorOrchestratorMeta,
    binding: 'WF_VENDOR_ORCHESTRATOR',
  },
  [toolApiCheckMeta.slug]: { meta: toolApiCheckMeta, binding: 'WF_TOOL_API_CHECK' },
  [toolMarketplaceMeta.slug]: { meta: toolMarketplaceMeta, binding: 'WF_TOOL_MARKETPLACE' },
  [toolIpaasMeta.slug]: { meta: toolIpaasMeta, binding: 'WF_TOOL_IPAAS' },
  [toolReviewsMeta.slug]: { meta: toolReviewsMeta, binding: 'WF_TOOL_REVIEWS' },
  [toolSearchDemandMeta.slug]: { meta: toolSearchDemandMeta, binding: 'WF_TOOL_SEARCH_DEMAND' },
  [toolRedditMeta.slug]: { meta: toolRedditMeta, binding: 'WF_TOOL_REDDIT' },
  [toolIntegrationCountMeta.slug]: {
    meta: toolIntegrationCountMeta,
    binding: 'WF_TOOL_INTEGRATION_COUNT',
  },
  [toolScoreMeta.slug]: { meta: toolScoreMeta, binding: 'WF_TOOL_SCORE' },
  [toolOrchestratorMeta.slug]: { meta: toolOrchestratorMeta, binding: 'WF_TOOL_ORCHESTRATOR' },
};

export type WorkflowName = keyof typeof WORKFLOWS;

/** Resolve the Workflow binding for a given slug. */
export function workflowBinding(env: Env, slug: string): Workflow | undefined {
  const entry = WORKFLOWS[slug];
  if (!entry) return undefined;
  return env[entry.binding];
}

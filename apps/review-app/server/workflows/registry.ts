// ---------------------------------------------------------------------------
// Workflow registry — maps slug → meta + the env binding name to dispatch on.
//
// Each workflow exports a WorkflowEntrypoint class as its own Cloudflare
// Workflow binding. Routes dispatch via `env[bindingName]` so the registry
// stays tiny and fully typed.
// ---------------------------------------------------------------------------
import type { Env } from '../env';
import type { WorkflowMeta } from '../lib/workflow-meta';

import { meta as vendorGithubMeta } from './vendor/github';
import { meta as vendorFundingMeta } from './vendor/funding';
import { meta as vendorScoreMeta } from './vendor/score';
import { meta as vendorOrchestratorMeta } from './vendor/orchestrator';
import { meta as vendorOverviewMeta } from './vendor/overview';

import { meta as toolOverviewMeta } from './tool/overview';
import { meta as toolApiCheckMeta } from './tool/apiCheck';
import { meta as toolMarketplaceMeta } from './tool/marketplace';
import { meta as toolIpaasMeta } from './tool/ipaas';
import { meta as toolReviewsMeta } from './tool/reviews';
import { meta as toolSearchDemandMeta } from './tool/searchDemand';
import { meta as toolRedditMeta } from './tool/reddit';
import { meta as toolIntegrationCountMeta } from './tool/integrationCount';
import { meta as toolScoreMeta } from './tool/score';
import { meta as toolOrchestratorMeta } from './tool/orchestrator';
import { meta as toolResearchMeta } from './tool/research';

/** Names of every Workflow binding on Env. */
export type WorkflowBindingName =
  | 'WF_VENDOR_GITHUB'
  | 'WF_VENDOR_FUNDING'
  | 'WF_VENDOR_SCORE'
  | 'WF_VENDOR_ORCHESTRATOR'
  | 'WF_VENDOR_OVERVIEW'
  | 'WF_TOOL_OVERVIEW'
  | 'WF_TOOL_API_CHECK'
  | 'WF_TOOL_MARKETPLACE'
  | 'WF_TOOL_IPAAS'
  | 'WF_TOOL_REVIEWS'
  | 'WF_TOOL_SEARCH_DEMAND'
  | 'WF_TOOL_REDDIT'
  | 'WF_TOOL_INTEGRATION_COUNT'
  | 'WF_TOOL_SCORE'
  | 'WF_TOOL_ORCHESTRATOR'
  | 'WF_TOOL_RESEARCH';

export interface WorkflowEntry {
  meta: WorkflowMeta;
  binding: WorkflowBindingName;
}

export const WORKFLOWS: Record<string, WorkflowEntry> = {
  [vendorGithubMeta.slug]: { meta: vendorGithubMeta, binding: 'WF_VENDOR_GITHUB' },
  [vendorFundingMeta.slug]: { meta: vendorFundingMeta, binding: 'WF_VENDOR_FUNDING' },
  [vendorScoreMeta.slug]: { meta: vendorScoreMeta, binding: 'WF_VENDOR_SCORE' },
  [vendorOrchestratorMeta.slug]: {
    meta: vendorOrchestratorMeta,
    binding: 'WF_VENDOR_ORCHESTRATOR',
  },
  [vendorOverviewMeta.slug]: { meta: vendorOverviewMeta, binding: 'WF_VENDOR_OVERVIEW' },
  [toolOverviewMeta.slug]: { meta: toolOverviewMeta, binding: 'WF_TOOL_OVERVIEW' },
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
  [toolResearchMeta.slug]: { meta: toolResearchMeta, binding: 'WF_TOOL_RESEARCH' },
};

export type WorkflowName = keyof typeof WORKFLOWS;

/** Resolve the Workflow binding for a given slug. */
export function workflowBinding(env: Env, slug: string): Workflow | undefined {
  const entry = WORKFLOWS[slug];
  if (!entry) return undefined;
  return env[entry.binding];
}

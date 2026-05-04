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

import { meta as productOverviewMeta } from './product/overview';
import { meta as productApiCheckMeta } from './product/apiCheck';
import { meta as productMarketplaceMeta } from './product/marketplace';
import { meta as productIpaasMeta } from './product/ipaas';
import { meta as productReviewsMeta } from './product/reviews';
import { meta as productSearchDemandMeta } from './product/searchDemand';
import { meta as productRedditMeta } from './product/reddit';
import { meta as productScoreMeta } from './product/score';
import { meta as productOrchestratorMeta } from './product/orchestrator';
import { meta as productResearchMeta } from './product/research';
import { meta as productIntegrationsWebsiteMeta } from './product/integrationsWebsite';
import { meta as productIntegrationsIpaasMeta } from './product/integrationsIpaas';
import { meta as productIntegrationsMarketplacesMeta } from './product/integrationsMarketplaces';
import { meta as productIntegrationsG2Meta } from './product/integrationsG2';
import { meta as productIntegrationsGithubMeta } from './product/integrationsGithub';
import { meta as productIntegrationsWebMeta } from './product/integrationsWeb';
import { meta as productIntegrationsDiscoveryMeta } from './product/integrationsDiscovery';

/** Names of every Workflow binding on Env. */
export type WorkflowBindingName =
  | 'WF_VENDOR_GITHUB'
  | 'WF_VENDOR_FUNDING'
  | 'WF_VENDOR_SCORE'
  | 'WF_VENDOR_ORCHESTRATOR'
  | 'WF_VENDOR_OVERVIEW'
  | 'WF_PRODUCT_OVERVIEW'
  | 'WF_PRODUCT_API_CHECK'
  | 'WF_PRODUCT_MARKETPLACE'
  | 'WF_PRODUCT_IPAAS'
  | 'WF_PRODUCT_REVIEWS'
  | 'WF_PRODUCT_SEARCH_DEMAND'
  | 'WF_PRODUCT_REDDIT'
  | 'WF_PRODUCT_SCORE'
  | 'WF_PRODUCT_ORCHESTRATOR'
  | 'WF_PRODUCT_RESEARCH'
  | 'WF_INTEGRATIONS_WEBSITE'
  | 'WF_INTEGRATIONS_IPAAS'
  | 'WF_INTEGRATIONS_MARKETPLACES'
  | 'WF_INTEGRATIONS_G2'
  | 'WF_INTEGRATIONS_GITHUB'
  | 'WF_INTEGRATIONS_WEB'
  | 'WF_INTEGRATIONS_DISCOVERY';

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
  [productOverviewMeta.slug]: { meta: productOverviewMeta, binding: 'WF_PRODUCT_OVERVIEW' },
  [productApiCheckMeta.slug]: { meta: productApiCheckMeta, binding: 'WF_PRODUCT_API_CHECK' },
  [productMarketplaceMeta.slug]: { meta: productMarketplaceMeta, binding: 'WF_PRODUCT_MARKETPLACE' },
  [productIpaasMeta.slug]: { meta: productIpaasMeta, binding: 'WF_PRODUCT_IPAAS' },
  [productReviewsMeta.slug]: { meta: productReviewsMeta, binding: 'WF_PRODUCT_REVIEWS' },
  [productSearchDemandMeta.slug]: { meta: productSearchDemandMeta, binding: 'WF_PRODUCT_SEARCH_DEMAND' },
  [productRedditMeta.slug]: { meta: productRedditMeta, binding: 'WF_PRODUCT_REDDIT' },
  [productScoreMeta.slug]: { meta: productScoreMeta, binding: 'WF_PRODUCT_SCORE' },
  [productOrchestratorMeta.slug]: { meta: productOrchestratorMeta, binding: 'WF_PRODUCT_ORCHESTRATOR' },
  [productResearchMeta.slug]: { meta: productResearchMeta, binding: 'WF_PRODUCT_RESEARCH' },
  [productIntegrationsWebsiteMeta.slug]: {
    meta: productIntegrationsWebsiteMeta,
    binding: 'WF_INTEGRATIONS_WEBSITE',
  },
  [productIntegrationsIpaasMeta.slug]: {
    meta: productIntegrationsIpaasMeta,
    binding: 'WF_INTEGRATIONS_IPAAS',
  },
  [productIntegrationsMarketplacesMeta.slug]: {
    meta: productIntegrationsMarketplacesMeta,
    binding: 'WF_INTEGRATIONS_MARKETPLACES',
  },
  [productIntegrationsG2Meta.slug]: {
    meta: productIntegrationsG2Meta,
    binding: 'WF_INTEGRATIONS_G2',
  },
  [productIntegrationsGithubMeta.slug]: {
    meta: productIntegrationsGithubMeta,
    binding: 'WF_INTEGRATIONS_GITHUB',
  },
  [productIntegrationsWebMeta.slug]: {
    meta: productIntegrationsWebMeta,
    binding: 'WF_INTEGRATIONS_WEB',
  },
  [productIntegrationsDiscoveryMeta.slug]: {
    meta: productIntegrationsDiscoveryMeta,
    binding: 'WF_INTEGRATIONS_DISCOVERY',
  },
};

export type WorkflowName = keyof typeof WORKFLOWS;

/** Resolve the Workflow binding for a given slug. */
export function workflowBinding(env: Env, slug: string): Workflow | undefined {
  const entry = WORKFLOWS[slug];
  if (!entry) return undefined;
  return env[entry.binding];
}

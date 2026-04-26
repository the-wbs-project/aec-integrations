// ---------------------------------------------------------------------------
// Workflow registry — maps URL slug → workflow module. Imported by routes
// and the WorkflowRun DO.
// ---------------------------------------------------------------------------
import type { Workflow } from './types';

import * as vendorLinkedin from './vendor/linkedin';
import * as vendorGithub from './vendor/github';
import * as vendorCompanySize from './vendor/companySize';
import * as vendorFunding from './vendor/funding';
import * as vendorPress from './vendor/press';
import * as vendorBlogRecency from './vendor/blogRecency';
import * as vendorScore from './vendor/score';
import * as vendorOrchestrator from './vendor/orchestrator';

import * as toolApiCheck from './tool/apiCheck';
import * as toolMarketplace from './tool/marketplace';
import * as toolIpaas from './tool/ipaas';
import * as toolReviews from './tool/reviews';
import * as toolSearchDemand from './tool/searchDemand';
import * as toolReddit from './tool/reddit';
import * as toolIntegrationCount from './tool/integrationCount';
import * as toolScore from './tool/score';
import * as toolOrchestrator from './tool/orchestrator';

export const WORKFLOWS = {
  'vendor-linkedin': vendorLinkedin.workflow,
  'vendor-github': vendorGithub.workflow,
  'vendor-company-size': vendorCompanySize.workflow,
  'vendor-funding': vendorFunding.workflow,
  'vendor-press': vendorPress.workflow,
  'vendor-blog-recency': vendorBlogRecency.workflow,
  'vendor-score': vendorScore.workflow,
  'vendor-orchestrator': vendorOrchestrator.workflow,
  'tool-api-check': toolApiCheck.workflow,
  'tool-marketplace': toolMarketplace.workflow,
  'tool-ipaas': toolIpaas.workflow,
  'tool-reviews': toolReviews.workflow,
  'tool-search-demand': toolSearchDemand.workflow,
  'tool-reddit': toolReddit.workflow,
  'tool-integration-count': toolIntegrationCount.workflow,
  'tool-score': toolScore.workflow,
  'tool-orchestrator': toolOrchestrator.workflow,
} satisfies Record<string, Workflow>;

export type WorkflowName = keyof typeof WORKFLOWS;

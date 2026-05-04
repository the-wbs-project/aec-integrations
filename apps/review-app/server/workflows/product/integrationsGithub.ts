// ---------------------------------------------------------------------------
// Integration discovery leaf — vendor's GitHub org.
//
// Reads the vendor's github_org slug (already populated by vendor-github),
// lists public repos via the GitHub REST API, and treats repos whose name or
// description matches connector/sdk/integration/api/webhook patterns as
// integration evidence. Repo names like "<vendor>-procore-connector" or
// "<vendor>-zapier-app" let us extract the partner name deterministically;
// we hand the lot to the LLM for naming + cleanup.
// ---------------------------------------------------------------------------
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { ErrorCapturingWorkflow } from '../../lib/error-capturing-workflow';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import {
  asString,
  asStringArray,
  getRecord,
  type AirtableRecord,
} from '../../services/airtable';
import { listOrgRepos, type GithubRepo } from '../../services/github';
import { runLeaf } from './integrationsLeaf';

export const meta: WorkflowMeta = {
  slug: 'product-integrations-github',
  description:
    "Discover integrations from the vendor's GitHub org repos (connectors, SDKs, integrations).",
  table: 'products',
};

const SIGNAL_RE = /(connector|connectors|integration|integrations|sdk|api|webhook|plugin)/i;

interface RepoSignal {
  repo: GithubRepo;
  description: string;
}

function filterRepos(repos: GithubRepo[]): RepoSignal[] {
  return repos
    .filter((r) => !r.archived && !r.fork)
    .filter((r) => SIGNAL_RE.test(r.name) || (r.description && SIGNAL_RE.test(r.description)))
    .map((r) => ({ repo: r, description: r.description ?? '' }));
}

export class ProductIntegrationsGithubWorkflow extends ErrorCapturingWorkflow {
  override async runImpl(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId, model, searchTool } = event.payload;
    const ctx = { runId: event.instanceId, workflow: meta.slug };

    return runLeaf(this.env, step, ctx, recordId, model, searchTool, {
      source: 'github',
      preFetch: async (env, _step, record: AirtableRecord) => {
        const vendorIds = asStringArray(record.fields['vendors']);
        if (vendorIds.length === 0) {
          return { extraUserContext: 'NOTE: no linked vendor on this product.', skipLlm: true };
        }
        // First linked vendor wins — products are usually owned by one vendor.
        const vendor = await checkpoint(step, 'fetch-vendor', () =>
          getRecord(env, 'vendors', vendorIds[0]),
        );
        const githubOrg = asString(vendor.fields['github_org']);
        if (!githubOrg) {
          return {
            extraUserContext: 'NOTE: linked vendor has no github_org on file.',
            skipLlm: true,
          };
        }
        let repos: GithubRepo[];
        try {
          repos = await checkpoint(step, 'list-repos', () => listOrgRepos(env, githubOrg, 3));
        } catch (err) {
          return {
            extraUserContext: `NOTE: GitHub listOrgRepos failed: ${err instanceof Error ? err.message : String(err)}`,
            skipLlm: true,
          };
        }
        const signals = filterRepos(repos);
        if (signals.length === 0) {
          return {
            extraUserContext: `NOTE: no repos in ${githubOrg} matched connector/sdk/integration patterns.`,
            skipLlm: true,
          };
        }
        const corpus = signals
          .map(
            (s) =>
              `- ${s.repo.name}  →  ${s.repo.html_url}\n  desc: ${s.description || '(none)'}`,
          )
          .join('\n');
        return {
          extraUserContext: `GitHub org "${githubOrg}" has these connector/SDK-flavored public repos:\n${corpus}\n\nThe partner name is usually the second segment (e.g. "<vendor>-procore-connector" → Procore). Use the html_url as evidenceUrl.`,
        };
      },
      buildPrompt: (record) => {
        const productName = asString(record.fields['Name']) ?? '';
        return {
          systemPrompt:
            'You convert GitHub repository names + descriptions for a vendor\'s connector/SDK repos into IntegrationCandidates. The repo name typically encodes the partner: "<vendor>-<partner>-(connector|sdk|integration)". mechanismKind is "api" or "webhook" depending on what the description says, "native" otherwise. Skip repos that are general-purpose SDKs ("python-sdk", "node-client") with no named partner.',
          userPrompt: `For product "${productName}", review the supplied GitHub repos and emit one IntegrationCandidate per repo that clearly names a partner integration. Set:
  - targetName = the partner name extracted from the repo
  - mechanismKind = "api" / "webhook" / "native" based on the description
  - mechanismName = repo name
  - evidenceUrl = the repo html_url
  - confidence = "high" when the partner name is unambiguous in the repo name, "medium" otherwise

Do NOT call web_search — answer purely from the supplied repo list. When done call emit_result.`,
        };
      },
    });
  }
}

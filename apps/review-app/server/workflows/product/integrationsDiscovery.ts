// ---------------------------------------------------------------------------
// Integration discovery — sub-orchestrator.
//
// Fans out the six per-source leaf workflows (website, ipaas, marketplaces,
// g2, github, web), waits for them, then reads the per-leaf candidate blobs
// off the product record and hands them to resolveAndMaterialize. Materialized
// integrations are written to Airtable; unresolved candidates are parked back
// on the product as JSON.
// ---------------------------------------------------------------------------
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { ErrorCapturingWorkflow } from '../../lib/error-capturing-workflow';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import { asString, getRecord, updateRecord } from '../../services/airtable';
import { notifyRunStarted } from '../../lib/notify-run-started';
import {
  resolveAndMaterialize,
  type IntegrationCandidate,
  type EvidenceSource,
} from '../../services/integrationCandidates';
import { candidatesField } from './integrationsLeaf';
import type { WorkflowBindingName } from '../registry';

export const meta: WorkflowMeta = {
  slug: 'product-integrations-discovery',
  description:
    'Run six per-source integration leaves, dedupe, and materialize Integration records.',
  table: 'products',
};

const POLL_INTERVAL = '10 seconds' as const;
const MAX_POLLS = 90;
const TERMINAL_STATUSES = new Set(['complete', 'errored', 'terminated', 'unknown']);

interface Leaf {
  source: EvidenceSource;
  slug: string;
  binding: WorkflowBindingName;
  /**
   * Short tag used as the runId suffix when spawning this leaf. Cloudflare
   * Workflows caps instance IDs at 64 chars; the parent's runId is itself
   * `<36-char UUID>-intd` (~41 chars), so concatenating the full slug here
   * would overflow. Keep these short and unique within the array.
   */
  idTag: string;
}

const LEAVES: readonly Leaf[] = [
  { source: 'website', slug: 'product-integrations-website', binding: 'WF_INTEGRATIONS_WEBSITE', idTag: 'web1' },
  { source: 'ipaas', slug: 'product-integrations-ipaas', binding: 'WF_INTEGRATIONS_IPAAS', idTag: 'ipaas' },
  { source: 'marketplaces', slug: 'product-integrations-marketplaces', binding: 'WF_INTEGRATIONS_MARKETPLACES', idTag: 'mkt' },
  { source: 'g2', slug: 'product-integrations-g2', binding: 'WF_INTEGRATIONS_G2', idTag: 'g2' },
  { source: 'github', slug: 'product-integrations-github', binding: 'WF_INTEGRATIONS_GITHUB', idTag: 'gh' },
  { source: 'web', slug: 'product-integrations-web', binding: 'WF_INTEGRATIONS_WEB', idTag: 'web2' },
] as const;

interface PendingChild {
  slug: string;
  binding: WorkflowBindingName;
  runId: string;
}

interface ChildOutcome {
  slug: string;
  runId: string;
  status: string;
  error?: string;
}

function parseCandidatesBlob(raw: unknown): IntegrationCandidate[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is IntegrationCandidate => {
      if (!c || typeof c !== 'object') return false;
      const o = c as Record<string, unknown>;
      return (
        typeof o['targetName'] === 'string' &&
        typeof o['evidenceUrl'] === 'string' &&
        typeof o['confidence'] === 'string' &&
        typeof o['evidenceSource'] === 'string'
      );
    });
  } catch {
    return [];
  }
}

export class ProductIntegrationsDiscoveryWorkflow extends ErrorCapturingWorkflow {
  override async runImpl(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId, model, searchTool, forceRefresh = false } = event.payload;
    const orchestratorRunId = event.instanceId;

    const record = await checkpoint(step, 'fetch-record', () =>
      getRecord(this.env, 'products', recordId),
    );
    const recordLabel =
      asString(record.fields['Name']) ?? asString(record.fields['name']);

    // ----- Spawn leaves in parallel ----------------------------------------
    const pending: PendingChild[] = LEAVES.map((leaf) => ({
      slug: leaf.slug,
      binding: leaf.binding,
      runId: `${orchestratorRunId}-${leaf.idTag}`,
    }));

    await checkpoint(step, 'spawn-leaves', async () => {
      await Promise.all(
        pending.map((c) => {
          const binding = this.env[c.binding] as Workflow<RunParams>;
          return binding.create({
            id: c.runId,
            params: { recordId, model, searchTool, forceRefresh },
          });
        }),
      );
      await Promise.all(
        pending.map((c) =>
          notifyRunStarted(this.env, {
            runId: c.runId,
            workflow: c.slug,
            recordId,
            recordLabel,
            parentRunId: orchestratorRunId,
            triggeredBy: 'parent-orchestrator',
            forceRefresh,
            model,
          }).catch((err) =>
            console.error(
              '[integrations-discovery] notify child failed',
              c.runId,
              String(err),
            ),
          ),
        ),
      );
      return { spawned: pending.map((p) => p.slug) };
    });

    // ----- Poll until every child is terminal ------------------------------
    const outcomes = await this.waitForChildren(step, pending);

    // ----- Re-fetch product to read the per-leaf candidate blobs -----------
    const refetched = await checkpoint(step, 'refetch-record', () =>
      getRecord(this.env, 'products', recordId),
    );

    const aggregated: IntegrationCandidate[] = [];
    const perSourceCounts: Record<string, number> = {};
    for (const leaf of LEAVES) {
      const candidates = parseCandidatesBlob(refetched.fields[candidatesField(leaf.source)]);
      perSourceCounts[leaf.source] = candidates.length;
      aggregated.push(...candidates);
    }

    // ----- Materialize -----------------------------------------------------
    const materialized = await checkpoint(step, 'materialize', () =>
      resolveAndMaterialize(this.env, recordId, aggregated),
    );

    // ----- Write summary back to the product -------------------------------
    const summary = LEAVES.map(
      (leaf) => `${leaf.source}: ${perSourceCounts[leaf.source] ?? 0} found`,
    ).join('\n');
    const checkedAt = new Date().toISOString();
    await checkpoint(step, 'write-summary', () =>
      updateRecord(this.env, 'products', recordId, {
        integrations_discovery_checked_at: checkedAt,
        integrations_discovery_candidates: JSON.stringify(materialized.unresolved),
        integrations_discovery_summary: `${summary}\n→ created ${materialized.createdIntegrations.length} integrations, ${materialized.createdVendors.length} vendor stubs, ${materialized.unresolved.length} unresolved, ${materialized.skippedExistingIntegrations} skipped (existed)`,
      }),
    );

    return {
      status: 'success' as const,
      forceRefresh,
      childOutcomes: outcomes,
      perSourceCounts,
      aggregatedCandidateCount: aggregated.length,
      createdIntegrations: materialized.createdIntegrations,
      createdVendors: materialized.createdVendors,
      unresolvedCount: materialized.unresolved.length,
      skippedExistingIntegrations: materialized.skippedExistingIntegrations,
      note: `Aggregated ${aggregated.length} candidates → ${materialized.createdIntegrations.length} integrations created, ${materialized.unresolved.length} parked`,
    };
  }

  private async waitForChildren(
    step: WorkflowStep,
    children: PendingChild[],
  ): Promise<ChildOutcome[]> {
    if (children.length === 0) return [];
    const finished = new Map<string, ChildOutcome>();
    let attempt = 0;
    while (finished.size < children.length && attempt < MAX_POLLS) {
      const remaining = children.filter((c) => !finished.has(c.runId));
      const tick = await checkpoint(step, `poll-${attempt}`, async () =>
        Promise.all(
          remaining.map(async (c): Promise<ChildOutcome> => {
            try {
              const binding = this.env[c.binding] as Workflow<RunParams>;
              const inst = await binding.get(c.runId);
              const s = await inst.status();
              return {
                slug: c.slug,
                runId: c.runId,
                status: s.status,
                error: s.error?.message,
              };
            } catch (err) {
              return {
                slug: c.slug,
                runId: c.runId,
                status: 'unknown',
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }),
        ),
      );
      for (const o of tick) {
        if (TERMINAL_STATUSES.has(o.status)) finished.set(o.runId, o);
      }
      if (finished.size >= children.length) break;
      await step.sleep(`wait-${attempt}`, POLL_INTERVAL);
      attempt++;
    }
    return children.map(
      (c) =>
        finished.get(c.runId) ?? {
          slug: c.slug,
          runId: c.runId,
          status: 'timeout',
          error: `No terminal status after ${MAX_POLLS} polls`,
        },
    );
  }
}

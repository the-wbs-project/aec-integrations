// ---------------------------------------------------------------------------
// V00 — Vendor orchestrator.
// Source: artifacts/n8n-workflows/AECi-V00-Orchestrator.json
//
// For one vendor record:
//   1. Fetch the record.
//   2. For each leaf enrichment, decide if it is stale (last-checked field
//      missing or older than STALE_AFTER_DAYS) — skip leaves that are fresh.
//      If params.forceRefresh is true, treat every leaf as stale and re-run
//      it regardless of its last-checked timestamp.
//   3. Fan out the stale leaves as child workflow instances in parallel.
//   4. Poll until every child reaches a terminal state (complete / errored /
//      terminated). Errored children do not abort the orchestrator — the
//      score recompute below will reflect whatever signals are populated.
//   5. Spawn vendor-score as a final child workflow and wait for it to
//      finish, so vendor_data_completeness, vendor_enrichment_status, and
//      last_enriched_at are written off the freshly-enriched record.
// ---------------------------------------------------------------------------
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { ErrorCapturingWorkflow } from '../../lib/error-capturing-workflow';
import type { Env } from '../../env';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import { getRecord, asString } from '../../services/airtable';
import type { WorkflowBindingName } from '../registry';

export const meta: WorkflowMeta = {
  slug: 'vendor-orchestrator',
  description:
    'Run stale vendor enrichments in parallel, then recompute the completeness score.',
  table: 'vendors',
};

const STALE_AFTER_DAYS = 60;
const STALE_AFTER_MS = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
const POLL_INTERVAL = '10 seconds' as const;
const MAX_POLLS = 90; // ~15 min ceiling at 10s intervals.

interface Leaf {
  slug: string;
  binding: WorkflowBindingName;
  stalenessField: string;
}

const LEAVES: readonly Leaf[] = [
  { slug: 'vendor-linkedin', binding: 'WF_VENDOR_LINKEDIN', stalenessField: 'linkedin_checked_at' },
  { slug: 'vendor-github', binding: 'WF_VENDOR_GITHUB', stalenessField: 'github_checked_at' },
  {
    slug: 'vendor-company-size',
    binding: 'WF_VENDOR_COMPANY_SIZE',
    stalenessField: 'employee_checked_at',
  },
  { slug: 'vendor-funding', binding: 'WF_VENDOR_FUNDING', stalenessField: 'funding_checked_at' },
  { slug: 'vendor-press', binding: 'WF_VENDOR_PRESS', stalenessField: 'press_checked_at' },
  {
    slug: 'vendor-blog-recency',
    binding: 'WF_VENDOR_BLOG_RECENCY',
    stalenessField: 'blog_checked_at',
  },
] as const;

const TERMINAL_STATUSES = new Set(['complete', 'errored', 'terminated', 'unknown']);

function isStale(checkedAtRaw: string | undefined, now: number): boolean {
  if (!checkedAtRaw) return true;
  const ts = Date.parse(checkedAtRaw);
  if (!Number.isFinite(ts)) return true;
  return now - ts >= STALE_AFTER_MS;
}

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

export class VendorOrchestratorWorkflow extends ErrorCapturingWorkflow {
  override async runImpl(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId, model, searchTool, forceRefresh = false } = event.payload;
    const orchestratorRunId = event.instanceId;

    const record = await checkpoint(step, 'fetch-record', () =>
      getRecord(this.env, 'vendors', recordId),
    );

    const now = Date.now();
    const stale = forceRefresh
      ? [...LEAVES]
      : LEAVES.filter((leaf) => isStale(asString(record.fields[leaf.stalenessField]), now));
    const skipped = LEAVES.filter((leaf) => !stale.includes(leaf)).map((l) => l.slug);

    // ----- Spawn stale leaves in parallel ------------------------------------
    const pending: PendingChild[] = stale.map((leaf) => ({
      slug: leaf.slug,
      binding: leaf.binding,
      runId: `${orchestratorRunId}-${leaf.slug}`,
    }));

    if (pending.length > 0) {
      await checkpoint(step, 'spawn-leaves', async () => {
        await Promise.all(
          pending.map((c) => {
            const binding = this.env[c.binding] as Workflow<RunParams>;
            return binding.create({
              id: c.runId,
              params: { recordId, model, searchTool },
            });
          }),
        );
        return { spawned: pending.map((p) => p.slug) };
      });
    }

    // ----- Poll until every child is terminal --------------------------------
    const outcomes: ChildOutcome[] = await this.waitForChildren(step, pending);

    // ----- Spawn vendor-score and wait for it --------------------------------
    const scoreRunId = `${orchestratorRunId}-vendor-score`;
    await checkpoint(step, 'spawn-score', async () => {
      await this.env.WF_VENDOR_SCORE.create({
        id: scoreRunId,
        params: { recordId, model, searchTool },
      });
      return { spawned: 'vendor-score' };
    });

    const scoreOutcome = (
      await this.waitForChildren(step, [
        { slug: 'vendor-score', binding: 'WF_VENDOR_SCORE', runId: scoreRunId },
      ])
    )[0];

    const noteSuffix = forceRefresh ? ' (force-refresh)' : '';
    return {
      status: 'success' as const,
      forceRefresh,
      ranLeaves: pending.map((p) => p.slug),
      skippedLeaves: skipped,
      childOutcomes: outcomes,
      score: scoreOutcome,
      note:
        pending.length === 0
          ? `All leaves fresh; recomputed score only${noteSuffix}`
          : `Ran ${pending.length}/${LEAVES.length} ${forceRefresh ? 'leaves' : 'stale leaves'} and recomputed score`,
    };
  }

  /**
   * Poll the given children until each reaches a terminal state. Errored
   * children are reported but do not throw — the orchestrator's job is to
   * make a best-effort enrichment pass and let the score reflect whatever
   * landed.
   */
  private async waitForChildren(
    step: WorkflowStep,
    children: PendingChild[],
  ): Promise<ChildOutcome[]> {
    if (children.length === 0) return [];

    const finished = new Map<string, ChildOutcome>();
    let attempt = 0;

    while (finished.size < children.length && attempt < MAX_POLLS) {
      const remaining = children.filter((c) => !finished.has(c.runId));

      const tick = await checkpoint(step, `poll-${attempt}`, async () => {
        return Promise.all(
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
        );
      });

      for (const o of tick) {
        if (TERMINAL_STATUSES.has(o.status)) finished.set(o.runId, o);
      }

      if (finished.size >= children.length) break;
      await step.sleep(`wait-${attempt}`, POLL_INTERVAL);
      attempt++;
    }

    // Timed-out children are recorded as 'timeout' so the orchestrator return
    // value tells you which leaf was still running when we gave up.
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

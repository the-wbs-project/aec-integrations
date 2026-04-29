// ---------------------------------------------------------------------------
// V00 — Vendor orchestrator.
//
// For one vendor record:
//   1. Fetch the record.
//   2. Run vendor-overview FIRST and wait. This scrapes Crunchbase + reads
//      Wikipedia, populating description / HQ / phone / email / company_size
//      / Crunchbase signal fields.
//   3. Re-fetch the record so the staleness check sees the freshly-written
//      timestamps.
//   4. For each leaf enrichment (github, funding), decide if it is stale
//      (last-checked field missing or older than STALE_AFTER_DAYS) — skip
//      leaves that are fresh. If params.forceRefresh is true, treat every
//      leaf as stale and re-run it regardless.
//   5. Fan out the stale leaves as child workflow instances in parallel.
//   6. Poll until every child reaches a terminal state.
//   7. Spawn vendor-score as a final child and wait so the VQS pillars,
//      tier, confidence, flags, and completeness fields all reflect the
//      freshly-enriched record.
// ---------------------------------------------------------------------------
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { ErrorCapturingWorkflow } from '../../lib/error-capturing-workflow';
import type { Env } from '../../env';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import { getRecord, asString } from '../../services/airtable';
import { notifyRunStarted } from '../../lib/notify-run-started';
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
  { slug: 'vendor-github', binding: 'WF_VENDOR_GITHUB', stalenessField: 'github_checked_at' },
  { slug: 'vendor-funding', binding: 'WF_VENDOR_FUNDING', stalenessField: 'funding_checked_at' },
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
    console.log(
      `[vendor-orchestrator] BOOT runId=${orchestratorRunId} recordId=${recordId} forceRefresh=${forceRefresh}`,
    );

    // Mark when this run started. After vendor-overview finishes, any leaf
    // whose `*_checked_at` is newer than this timestamp was satisfied by the
    // overview run — we skip those even under forceRefresh, because re-running
    // them would just throw away data overview just wrote.
    //
    // Persist the timestamp via a step.do checkpoint so resumed instances
    // (Workflows replay each step) compute the same value across replays
    // instead of reading the wall clock at retry time.
    const orchestratorStartedAt = await checkpoint(step, 'mark-start', async () =>
      Date.now(),
    );

    const initialRecord = await checkpoint(step, 'fetch-record', () =>
      getRecord(this.env, 'vendors', recordId),
    );
    const recordLabel = asString(initialRecord.fields['company_name']);

    // ----- Run vendor-overview first ----------------------------------------
    // This populates description / HQ / phone / email / company_size / the
    // Crunchbase signal fields, and writes `employee_checked_at` when the
    // Crunchbase scrape filled `company_size` — letting us skip the
    // company-size leaf below.
    const overviewRunId = `${orchestratorRunId}-vendor-overview`;
    await checkpoint(step, 'spawn-overview', async () => {
      await this.env.WF_VENDOR_OVERVIEW.create({
        id: overviewRunId,
        params: { recordId, model, searchTool, forceRefresh },
      });
      await notifyRunStarted(this.env, {
        runId: overviewRunId,
        workflow: 'vendor-overview',
        recordId,
        recordLabel,
        parentRunId: orchestratorRunId,
        triggeredBy: 'parent-orchestrator',
        forceRefresh,
        model,
      }).catch((err) =>
        console.error('[vendor-orchestrator] notify overview failed', overviewRunId, String(err)),
      );
      return { spawned: 'vendor-overview' };
    });

    const overviewOutcome = (
      await this.waitForChildren(step, [
        { slug: 'vendor-overview', binding: 'WF_VENDOR_OVERVIEW', runId: overviewRunId },
      ])
    )[0];

    // ----- Re-fetch record so staleness check sees overview's writes -------
    const record = await checkpoint(step, 'refetch-record', () =>
      getRecord(this.env, 'vendors', recordId),
    );

    const now = Date.now();
    // A leaf was "just satisfied" if its checkpoint timestamp is newer than
    // when this orchestrator run started — i.e. vendor-overview wrote it.
    const justSatisfied = (leaf: Leaf): boolean => {
      const raw = asString(record.fields[leaf.stalenessField]);
      if (!raw) return false;
      const ts = Date.parse(raw);
      return Number.isFinite(ts) && ts >= orchestratorStartedAt;
    };

    const stale = forceRefresh
      ? LEAVES.filter((leaf) => !justSatisfied(leaf))
      : LEAVES.filter(
          (leaf) =>
            !justSatisfied(leaf) &&
            isStale(asString(record.fields[leaf.stalenessField]), now),
        );
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
        // Best-effort RunsHub notification so the bell sees the children
        // immediately. Failures are logged but never fail the step.
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
              console.error('[vendor-orchestrator] notify child failed', c.runId, String(err)),
            ),
          ),
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
      await notifyRunStarted(this.env, {
        runId: scoreRunId,
        workflow: 'vendor-score',
        recordId,
        recordLabel,
        parentRunId: orchestratorRunId,
        triggeredBy: 'parent-orchestrator',
        forceRefresh,
        model,
      }).catch((err) =>
        console.error('[vendor-orchestrator] notify score failed', scoreRunId, String(err)),
      );
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
      overview: overviewOutcome,
      ranLeaves: pending.map((p) => p.slug),
      skippedLeaves: skipped,
      childOutcomes: outcomes,
      score: scoreOutcome,
      note:
        pending.length === 0
          ? `Overview + score only${noteSuffix}`
          : `Overview + ${pending.length}/${LEAVES.length} ${forceRefresh ? 'leaves' : 'stale leaves'} + score`,
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

// ---------------------------------------------------------------------------
// T00 — Tool orchestrator.
//
// For one tool record:
//   1. Fetch the record.
//   2. Run tool-research FIRST and wait. This fills foundational fields
//      (description, category, disciplines, phases) that downstream
//      enrichments may depend on.
//   3. Run tool-overview and wait. This scrapes G2 + Capterra and writes
//      review counts/ratings + reviews_checked_at when at least one site
//      succeeds.
//   4. Re-fetch the record so the staleness check sees the freshly-written
//      timestamps.
//   5. For each leaf enrichment (api-check, marketplace, ipaas, reviews,
//      search-demand, reddit), decide if it is stale
//      (last-checked field missing or older than STALE_AFTER_DAYS) — skip
//      leaves that are fresh. If params.forceRefresh is true, treat every
//      leaf as stale and re-run it regardless, EXCEPT leaves that overview
//      just satisfied during this run (re-running them would just throw
//      away data overview just wrote).
//   6. Fan out the stale leaves as child workflow instances in parallel.
//   7. Poll until every child reaches a terminal state.
//   8. Spawn tool-score as a final child and wait so completeness, confidence,
//      flags, and tier all reflect the freshly-enriched record.
//
// Mirrors vendor/orchestrator.ts.
// ---------------------------------------------------------------------------
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { ErrorCapturingWorkflow } from '../../lib/error-capturing-workflow';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import { getRecord, asString } from '../../services/airtable';
import { notifyRunStarted } from '../../lib/notify-run-started';
import type { WorkflowBindingName } from '../registry';

export const meta: WorkflowMeta = {
  slug: 'product-orchestrator',
  description:
    'Run stale tool enrichments in parallel, then recompute the priority score.',
  table: 'products',
};

const STALE_AFTER_DAYS = 60;
const STALE_AFTER_MS = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
const POLL_INTERVAL = '10 seconds' as const;
const MAX_POLLS = 90; // ~15 min ceiling at 10s intervals.

interface Leaf {
  slug: string;
  binding: WorkflowBindingName;
  stalenessField: string;
  /**
   * Short tag used as the runId suffix when spawning this leaf. Cloudflare
   * Workflows caps instance IDs at 64 chars (`^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`),
   * and the parent's runId is already a 36-char UUID, so concatenating the
   * full slug overflows. Keep these short and unique within the array.
   */
  idTag: string;
}

const LEAVES: readonly Leaf[] = [
  { slug: 'product-api-check', binding: 'WF_PRODUCT_API_CHECK', stalenessField: 'api_docs_checked_at', idTag: 'api' },
  { slug: 'product-marketplace', binding: 'WF_PRODUCT_MARKETPLACE', stalenessField: 'marketplace_checked_at', idTag: 'mkt' },
  { slug: 'product-ipaas', binding: 'WF_PRODUCT_IPAAS', stalenessField: 'ipaas_checked_at', idTag: 'ipaas' },
  { slug: 'product-reviews', binding: 'WF_PRODUCT_REVIEWS', stalenessField: 'reviews_checked_at', idTag: 'rev' },
  { slug: 'product-search-demand', binding: 'WF_PRODUCT_SEARCH_DEMAND', stalenessField: 'search_checked_at', idTag: 'srch' },
  { slug: 'product-reddit', binding: 'WF_PRODUCT_REDDIT', stalenessField: 'reddit_checked_at', idTag: 'reddit' },
  { slug: 'product-integrations-discovery', binding: 'WF_INTEGRATIONS_DISCOVERY', stalenessField: 'integrations_discovery_checked_at', idTag: 'intd' },
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

export class ProductOrchestratorWorkflow extends ErrorCapturingWorkflow {
  override async runImpl(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId, model, searchTool, forceRefresh = false } = event.payload;
    const orchestratorRunId = event.instanceId;
    console.log(
      `[tool-orchestrator] BOOT runId=${orchestratorRunId} recordId=${recordId} forceRefresh=${forceRefresh}`,
    );

    // Mark when this run started. After tool-overview finishes, any leaf
    // whose `*_checked_at` is newer than this timestamp was satisfied by the
    // overview run — we skip those even under forceRefresh.
    const orchestratorStartedAt = await checkpoint(step, 'mark-start', async () =>
      Date.now(),
    );

    const initialRecord = await checkpoint(step, 'fetch-record', () =>
      getRecord(this.env, 'products', recordId),
    );
    const recordLabel =
      asString(initialRecord.fields['Name']) ?? asString(initialRecord.fields['name']);

    // ----- Run tool-research first -----------------------------------------
    // Fills foundational fields (description, category, disciplines, phases)
    // that downstream enrichments may depend on.
    const researchRunId = `${orchestratorRunId}-tool-research`;
    await checkpoint(step, 'spawn-research', async () => {
      await this.env.WF_PRODUCT_RESEARCH.create({
        id: researchRunId,
        params: { recordId, model, searchTool, forceRefresh },
      });
      await notifyRunStarted(this.env, {
        runId: researchRunId,
        workflow: 'product-research',
        recordId,
        recordLabel,
        parentRunId: orchestratorRunId,
        triggeredBy: 'parent-orchestrator',
        forceRefresh,
        model,
      }).catch((err) =>
        console.error('[tool-orchestrator] notify research failed', researchRunId, String(err)),
      );
      return { spawned: 'tool-research' };
    });

    const researchOutcome = (
      await this.waitForChildren(step, [
        { slug: 'product-research', binding: 'WF_PRODUCT_RESEARCH', runId: researchRunId },
      ])
    )[0];

    // ----- Run tool-overview --------------------------------------------------
    // Scrapes G2 + Capterra; on success writes reviews_checked_at so the
    // T04-Reviews leaf below skips.
    const overviewRunId = `${orchestratorRunId}-tool-overview`;
    await checkpoint(step, 'spawn-overview', async () => {
      await this.env.WF_PRODUCT_OVERVIEW.create({
        id: overviewRunId,
        params: { recordId, model, searchTool, forceRefresh },
      });
      await notifyRunStarted(this.env, {
        runId: overviewRunId,
        workflow: 'product-overview',
        recordId,
        recordLabel,
        parentRunId: orchestratorRunId,
        triggeredBy: 'parent-orchestrator',
        forceRefresh,
        model,
      }).catch((err) =>
        console.error('[tool-orchestrator] notify overview failed', overviewRunId, String(err)),
      );
      return { spawned: 'tool-overview' };
    });

    const overviewOutcome = (
      await this.waitForChildren(step, [
        { slug: 'product-overview', binding: 'WF_PRODUCT_OVERVIEW', runId: overviewRunId },
      ])
    )[0];

    // ----- Re-fetch record so staleness check sees overview's writes -------
    const record = await checkpoint(step, 'refetch-record', () =>
      getRecord(this.env, 'products', recordId),
    );

    const now = Date.now();
    // A leaf was "just satisfied" if its checkpoint timestamp is newer than
    // when this orchestrator run started — i.e. tool-overview wrote it.
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

    // ----- Spawn stale leaves in parallel -----------------------------------
    const pending: PendingChild[] = stale.map((leaf) => ({
      slug: leaf.slug,
      binding: leaf.binding,
      runId: `${orchestratorRunId}-${leaf.idTag}`,
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
              console.error('[tool-orchestrator] notify child failed', c.runId, String(err)),
            ),
          ),
        );
        return { spawned: pending.map((p) => p.slug) };
      });
    }

    // ----- Poll until every child is terminal -------------------------------
    const outcomes: ChildOutcome[] = await this.waitForChildren(step, pending);

    // ----- Spawn tool-score and wait for it ---------------------------------
    const scoreRunId = `${orchestratorRunId}-tool-score`;
    await checkpoint(step, 'spawn-score', async () => {
      await this.env.WF_PRODUCT_SCORE.create({
        id: scoreRunId,
        params: { recordId, model, searchTool },
      });
      await notifyRunStarted(this.env, {
        runId: scoreRunId,
        workflow: 'product-score',
        recordId,
        recordLabel,
        parentRunId: orchestratorRunId,
        triggeredBy: 'parent-orchestrator',
        forceRefresh,
        model,
      }).catch((err) =>
        console.error('[tool-orchestrator] notify score failed', scoreRunId, String(err)),
      );
      return { spawned: 'tool-score' };
    });

    const scoreOutcome = (
      await this.waitForChildren(step, [
        { slug: 'product-score', binding: 'WF_PRODUCT_SCORE', runId: scoreRunId },
      ])
    )[0];

    const noteSuffix = forceRefresh ? ' (force-refresh)' : '';
    return {
      status: 'success' as const,
      forceRefresh,
      research: researchOutcome,
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

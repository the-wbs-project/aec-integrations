/**
 * The promote ingest as a Cloudflare Workflow (AECI-563 / ADR 0021).
 *
 * Why this exists: the ingest used to run inline on `POST /api/promote`, so its
 * durability was only as good as the caller's HTTP connection. The review app aborts
 * at 30s; AECi committed anyway. The atomic `db.batch` landed, the product went live,
 * and the response carrying the assigned IDs — the *only* link between an Airtable row
 * and its public row, since D1 stores no curation-tool key — was lost. Re-promoting a
 * stranded product then minted duplicates (AECI-561).
 *
 * Moving the commit into a Workflow decouples it from the caller entirely: kick off,
 * walk away, poll later. Two properties do the work:
 *
 *   1. **The job id IS the Workflow instance id.** The review app supplies it (and
 *      stamps it on the Airtable row *before* pushing — AECI-567), so a replayed
 *      kick-off hits `create({ id })`'s duplicate guard and attaches to the existing
 *      instance. A retry storm can never produce a second commit.
 *   2. **The commit step is never auto-retried.** It throws `NonRetryableError`, so a
 *      failure surfaces as `errored` with its structured code for the review app to
 *      act on, rather than the engine silently replaying a half-planned create.
 *
 * Residual risk, documented rather than engineered around (per the AECI-563 decision):
 * Workflows guarantee a step runs *at least* once, so an engine crash in the window
 * between `db.batch` committing and the step result being persisted could replay the
 * commit and duplicate a *created* row. Client death — the failure this issue exists
 * to fix — is fully covered; the engine-crash window is not. Hardening it needs either
 * deterministic ids derived from the job id or a D1 job ledger — tracked as AECI-571.
 */

import {
  ApiErrorCode,
  PromotePayloadSchema,
  type PromotePayload,
  type PromoteResponse,
} from '@aeci/shared';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { logToDatadog, submitCount, submitDistribution } from '../datadog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import {
  PROMOTE_RESULT_TTL_SECONDS,
  promotePayloadKey,
  promoteResultKey,
  type PromoteWorkflowParams,
} from '../lib/promote-jobs';
import {
  dispatchPromoteHooks,
  runPromoteIngest,
  type PromoteIngestDeps,
  type PromoteIngestResult,
  type PromoteRunCtx,
} from '../routes/promote';

export type { PromoteWorkflowParams };

/**
 * Commit-step configuration. `limit: 1` expresses intent, but the guarantee comes from
 * throwing `NonRetryableError` — the documented mechanism for "do not retry this step"
 * — because the `retries.limit` semantics ("total number of attempts") leave no room
 * for a mistake we'd only discover as a duplicate product in production.
 *
 * The timeout is generous on purpose: a heavy bundle's plan phase issues many sequential
 * D1 reads, and this used to be a request that could legitimately run for minutes. There
 * is no client waiting on it any more, so a slow ingest is not a failure.
 */
const COMMIT_STEP_CONFIG = {
  retries: { limit: 1, delay: 0 },
  timeout: '10 minutes',
} as const;

/** Fallback origin when `sourceUrl` is unusable — the Datadog `hostname` must never be empty. */
const FALLBACK_SOURCE_URL = 'https://aeci-api.internal/api/promote';

/**
 * `PromoteRunCtx` for a workflow run. `bookmark` is a mutable holder rather than a value
 * because the post-commit re-reads (Algolia, home-stats, the trade publication floor) must
 * resume the write's D1 session, and the bookmark doesn't exist until the commit step has
 * returned — see the `PromoteRunCtx` docs.
 */
export function createWorkflowRunCtx(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  sourceUrl: string,
): PromoteRunCtx & { setBookmark(bookmark: string | null): void } {
  let bookmark: string | null = null;
  let request: Request;
  try {
    request = new Request(sourceUrl);
  } catch {
    request = new Request(FALLBACK_SOURCE_URL);
  }
  return {
    env,
    request,
    waitUntil: (promise) => ctx.waitUntil(promise),
    bookmark: () => bookmark,
    setBookmark: (next) => {
      bookmark = next;
    },
  };
}

/** Seams for the workflow spec: the ingest and the hook dispatch are injectable so the
 *  run can be driven over the in-memory D1 harness without real transports. */
export type PromoteWorkflowDeps = PromoteIngestDeps & {
  ingest?: typeof runPromoteIngest;
  dispatchHooks?: typeof dispatchPromoteHooks;
};

/** The subset of `WorkflowStep` this run uses — declared structurally so the spec can
 *  pass a fake step (one that just invokes the callback) with no platform shim. */
export type PromoteStepRunner = {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: unknown, callback: () => Promise<T>): Promise<T>;
};

/**
 * The whole run, as a plain function. `PromoteWorkflow.run` is a one-line delegate to
 * this so the spec can exercise every branch — including the failure mapping — in the
 * plain-Node test lane, which has no Workflows runtime.
 *
 * Returns the `PromoteResponse` as the instance output, which is what
 * `GET /api/promote/jobs/:id` serves once the status is `complete`.
 */
export async function runPromoteWorkflow(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  event: { payload: PromoteWorkflowParams; instanceId: string },
  step: PromoteStepRunner,
  deps: PromoteWorkflowDeps = {},
): Promise<PromoteResponse> {
  const params = event.payload;
  // Prefer the params copy so a hand-restarted instance keeps its original job id;
  // `instanceId` is the same value in every path the kick-off produces.
  const jobId = params.jobId || event.instanceId;
  const rc = createWorkflowRunCtx(env, ctx, params.sourceUrl);
  const startedAt = Date.now();

  // Wrapped in the same emit-then-rethrow as `commit-promote` below: a permanent
  // staging-read failure (KV read exhausting its retries, or a `NonRetryableError` for
  // an unbound/corrupt value) must still emit the `errored` job telemetry, or the
  // `REVIEW_APP_PROMOTE_API.md` §6.3 "every rejected promote is in Datadog" invariant
  // silently stops holding on the KV-staged path.
  let payload: PromotePayload | undefined;
  try {
    payload =
      params.payloadRef === 'kv'
        ? await step.do('load-staged-payload', () => loadStagedPayload(env, jobId))
        : params.payload;
  } catch (error) {
    emitJobOutcome(rc, jobId, 'errored', Date.now() - startedAt, error);
    throw error;
  }

  if (!payload) {
    const error = new NonRetryableError(
      `Promote job ${jobId} carries no payload`,
      ApiErrorCode.INTERNAL_ERROR,
    );
    emitJobOutcome(rc, jobId, 'errored', Date.now() - startedAt, error);
    throw error;
  }

  let result: PromoteIngestResult;
  try {
    result = await step.do('commit-promote', COMMIT_STEP_CONFIG, () =>
      commitPromote(rc, jobId, payload, deps),
    );
  } catch (error) {
    emitJobOutcome(rc, jobId, 'errored', Date.now() - startedAt, error);
    throw error;
  }

  // The bookmark only becomes available here, and the hooks' re-reads need it.
  rc.setBookmark(result.bookmark);

  // Dispatched AFTER the step resolves, never from inside it: a replayed step would
  // otherwise re-fire every purge/upsert/ping. All of them are fire-and-forget through
  // `rc.waitUntil`, so the instance completes the moment the batch has committed and the
  // poller gets its IDs without waiting on Algolia or Cloudflare.
  (deps.dispatchHooks ?? dispatchPromoteHooks)(rc, result, deps);

  emitJobOutcome(rc, jobId, 'complete', Date.now() - startedAt);
  return result.response;
}

/**
 * The commit itself. Runs inside the single non-retried step, and mirrors the resulting
 * ID map to KV before returning so the IDs outlive the instance's retention window.
 *
 * Every failure is converted to `NonRetryableError(message, code)`: the second argument
 * becomes the error's `name`, which is the only field `instance.status().error` carries
 * besides the message — so the structured code the synchronous endpoint used to return
 * (`SLUG_CONFLICT` for a racing slug, `VALIDATION_FAILED` for an unslugifiable name)
 * survives to the poll response instead of degrading to a bare string.
 */
async function commitPromote(
  rc: PromoteRunCtx,
  jobId: string,
  payload: PromotePayload,
  deps: PromoteWorkflowDeps,
): Promise<PromoteIngestResult> {
  let result: PromoteIngestResult;
  try {
    result = await (deps.ingest ?? runPromoteIngest)(rc, payload, deps);
  } catch (error) {
    throw toNonRetryable(error);
  }
  // Post-commit and deliberately swallowed: the batch has already committed, so a KV
  // outage must not turn a successful promote into a failed job. Losing the mirror only
  // shortens how long the IDs stay fetchable (to the instance retention window).
  await mirrorResult(rc.env, jobId, result.response);
  return result;
}

function toNonRetryable(error: unknown): NonRetryableError {
  if (error instanceof ApiError) return new NonRetryableError(error.message, error.code);
  const message = error instanceof Error ? error.message : String(error);
  return new NonRetryableError(message, ApiErrorCode.INTERNAL_ERROR);
}

/**
 * Read back a bundle the kick-off staged in KV.
 *
 * A missing key throws a *plain* Error on purpose: KV is eventually consistent, so a read
 * issued moments after the write can legitimately miss, and the step's default retry
 * schedule (5 attempts, exponential) is exactly the right response. A malformed value, by
 * contrast, will never fix itself — that is non-retryable.
 */
async function loadStagedPayload(env: Env, jobId: string): Promise<PromotePayload> {
  const kv = env.PROMOTE_KV;
  if (!kv) {
    throw new NonRetryableError(
      'PROMOTE_KV is not bound, so the staged promote payload cannot be read',
      ApiErrorCode.INTERNAL_ERROR,
    );
  }
  const raw = await kv.get(promotePayloadKey(jobId));
  if (raw === null) throw new Error(`Staged payload for promote job ${jobId} is not readable yet`);
  try {
    return PromotePayloadSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new NonRetryableError(
      `Staged payload for promote job ${jobId} is unusable: ${
        error instanceof Error ? error.message : String(error)
      }`,
      ApiErrorCode.INTERNAL_ERROR,
    );
  }
}

async function mirrorResult(env: Env, jobId: string, response: PromoteResponse): Promise<void> {
  const kv = env.PROMOTE_KV;
  if (!kv) return;
  try {
    await kv.put(promoteResultKey(jobId), JSON.stringify(response), {
      expirationTtl: PROMOTE_RESULT_TTL_SECONDS,
    });
  } catch (error) {
    console.warn(`promote job ${jobId}: result mirror to KV failed`, error);
  }
}

/**
 * Job-level observability (AECI-563). Two reasons this is not optional:
 *
 *   - `aeci.api.query.duration_ms{endpoint:/api/promote}` now times only the kick-off, so
 *     without these metrics a slow or failing ingest is invisible.
 *   - A workflow failure does not pass through the router's `errorHandler`, so the
 *     `REVIEW_APP_PROMOTE_API.md` §6.3 promise — "every rejected promote is in Datadog
 *     under `source:review-app-promote`" — would silently stop holding for the
 *     `SLUG_CONFLICT` / `INTERNAL_ERROR` cases that used to be 4xx/5xx responses.
 */
function emitJobOutcome(
  rc: PromoteRunCtx,
  jobId: string,
  outcome: 'complete' | 'errored',
  durationMs: number,
  error?: unknown,
): void {
  const code = error ? errorCodeOf(error) : undefined;
  try {
    submitCount(rc, rc.env, rc.request, 'aeci.api.promote.job', 1, [
      `outcome:${outcome}`,
      ...(code ? [`code:${code}`] : []),
    ]);
    submitDistribution(rc, rc.env, rc.request, 'aeci.api.promote.job.duration_ms', durationMs, [
      `outcome:${outcome}`,
    ]);
    if (error) {
      logToDatadog(rc, rc.env, rc.request, {
        level: 'error',
        message: 'aeci.api.promote.job_failed',
        source: 'review-app-promote',
        job_id: jobId,
        code,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  } catch (emitError) {
    // Observability MUST NOT break the promote path — including a missing waitUntil in a
    // non-Worker test harness (mirrors `metricsMiddleware`).
    console.warn('promote job: telemetry emit failed', emitError);
  }
}

/** `NonRetryableError`'s `name` carries the `ApiErrorCode`; anything else is a fault. */
function errorCodeOf(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  const known = Object.values(ApiErrorCode) as string[];
  return name && known.includes(name) ? name : ApiErrorCode.INTERNAL_ERROR;
}

/**
 * The bound Workflow class. Registered in `wrangler.jsonc` as `class_name` and re-exported
 * from `src/index.ts` (wrangler resolves Workflow classes off the Worker's main module).
 * Intentionally a one-line delegate — all the logic, and all the tests, live in
 * {@link runPromoteWorkflow}.
 */
export class PromoteWorkflow extends WorkflowEntrypoint<Env, PromoteWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<PromoteWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<PromoteResponse> {
    return runPromoteWorkflow(
      this.env,
      this.ctx,
      { payload: event.payload, instanceId: event.instanceId },
      step as PromoteStepRunner,
    );
  }
}

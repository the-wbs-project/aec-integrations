/**
 * `GET /api/promote/jobs/:id` — the poll half of the async promote protocol
 * (AECI-563 / ADR 0021).
 *
 * This endpoint is what makes a lost response recoverable. Before it existed, the ID map
 * a promote produced lived only in the HTTP response body: a client that timed out (the
 * review app aborts at 30s) lost the only link between an Airtable row and the public rows
 * the commit had just created, with no way to ask for it again (AECI-561). Now the IDs are
 * durable — held by the Workflow instance for its retention window, and by the KV result
 * mirror for 90 days after that.
 *
 * Same bearer auth and the same sub-router as the kick-off, so a rejected poll is logged to
 * Datadog under `source:review-app-promote` exactly like a rejected push.
 */

import { ApiErrorCode, type PromoteJobResponse, type PromoteResponse } from '@aeci/shared';

import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import { promoteJobErrorCode, promoteResultKey, toPromoteJobStatus } from '../lib/promote-jobs';
import type { Context } from 'hono';

export function createPromoteJobHandler(): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const jobId = c.req.param('id');
    if (!jobId) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing promote job id', {
        field: 'id',
      });
    }
    const workflow = c.env.PROMOTE_WORKFLOW;

    // No binding at all: fall through to the KV mirror rather than 503-ing, so a poll can
    // still resolve a job that a properly-configured deploy committed earlier.
    if (workflow) {
      let instance;
      try {
        instance = await workflow.get(jobId);
      } catch {
        // `get` throws for an unknown id — which covers both "never existed" and "aged out
        // of the retention window". The mirror below distinguishes them.
        return respondFromMirror(c, jobId);
      }

      const state = await instance.status();
      const status = toPromoteJobStatus(state.status);
      const body: PromoteJobResponse = { jobId, status };

      if (status === 'complete') {
        // `output` is the Workflow's return value — the same `PromoteResponse` the
        // synchronous endpoint used to send. Present only once the instance is complete,
        // which is exactly when we read it.
        body.result = (state.output as PromoteResponse | undefined) ?? undefined;
      } else if (status === 'errored') {
        body.error = {
          code: promoteJobErrorCode(state.error?.name),
          message: state.error?.message ?? 'Promote job failed',
        };
      }

      return json(body);
    }

    return respondFromMirror(c, jobId);
  };
}

/**
 * Serve a completed job from the KV result mirror. A hit means the ingest committed and
 * mirrored its IDs, so `complete` is the truthful status even though the instance is gone.
 * A miss means we genuinely know nothing about this id — `404`, not an empty `complete`,
 * because "the promote didn't happen" and "the promote happened and produced nothing" must
 * not look the same to a caller deciding whether to re-push.
 */
async function respondFromMirror(c: Context<{ Bindings: Env }>, jobId: string): Promise<Response> {
  const mirrored = await readMirroredResult(c.env, jobId);
  if (!mirrored) {
    throw new ApiError(404, ApiErrorCode.NOT_FOUND, `No promote job found for id "${jobId}"`, {
      details: { resource: 'promote_job', id: jobId },
    });
  }
  const body: PromoteJobResponse = { jobId, status: 'complete', result: mirrored };
  return json(body);
}

async function readMirroredResult(env: Env, jobId: string): Promise<PromoteResponse | null> {
  const kv = env.PROMOTE_KV;
  if (!kv) return null;
  try {
    // Written by this Worker's own commit step, so it is trusted rather than re-validated.
    return await kv.get<PromoteResponse>(promoteResultKey(jobId), 'json');
  } catch (error) {
    // A KV fault must not masquerade as "no such job" — that would tell the review app to
    // re-push a product that is already live.
    throw new ApiError(
      503,
      ApiErrorCode.DEPENDENCY_FAILURE,
      `Could not read the stored result for promote job "${jobId}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * `POST /api/promote` — the async kick-off (AECI-563 / ADR 0021).
 *
 * Validates synchronously, starts the promote Workflow, and returns `202 { jobId }`.
 * The commit itself happens in `workflows/promote-workflow.ts`; the ID map is collected
 * from `GET /api/promote/jobs/:id`.
 *
 * This endpoint used to run the whole plan-then-batch ingest inline, which made the
 * commit's recoverability depend on the caller's HTTP connection surviving — the
 * stranding bug of AECI-561. Fast 4xx behaviour is deliberately unchanged: a malformed
 * body, a schema violation, or a bad token still fails immediately with the same code, so
 * the caller's error handling doesn't have to move to the poll for anything it can fix.
 *
 * Two things make a replayed kick-off safe:
 *   - **The caller's `jobId` is the Workflow instance id.** `create({ id })` throws on a
 *     duplicate, so the second call attaches to the existing instance and returns the same
 *     `jobId`. There is no path that starts two instances for one job id, and therefore no
 *     path that commits twice.
 *   - **Nothing here touches D1.** The handler can be retried freely; it validates, maybe
 *     writes a KV staging entry (keyed by the same job id, so a retry overwrites its own),
 *     and creates the instance.
 */

import {
  ApiErrorCode,
  PromotePayloadSchema,
  type PromoteKickoffResponse,
  type PromotePayload,
} from '@aeci/shared';

import { submitCount } from '../posthog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import {
  PROMOTE_PARAMS_INLINE_MAX_BYTES,
  PROMOTE_PAYLOAD_MAX_BYTES,
  PROMOTE_PAYLOAD_TTL_SECONDS,
  promotePayloadKey,
  type PromoteWorkflowParams,
} from '../lib/promote-jobs';
import type { Context } from 'hono';

/**
 * `env.PROMOTE_WORKFLOW` is optional (a Worker booted without the binding — bare
 * `wrangler dev`, a partial test Env — must still start), so its absence is a
 * configuration fault, not a caller error: 503, not 500, matching how the rest of the API
 * reports a missing upstream (`API_CONTRACTS.md` §4).
 */
function requireWorkflow(env: Env) {
  const workflow = env.PROMOTE_WORKFLOW;
  if (!workflow) {
    throw new ApiError(
      503,
      ApiErrorCode.DEPENDENCY_FAILURE,
      'Promote is unavailable: the PROMOTE_WORKFLOW binding is not configured',
    );
  }
  return workflow;
}

export function createPromoteKickoffHandler(): (
  c: Context<{ Bindings: Env }>,
) => Promise<Response> {
  return async (c) => {
    // Read as text first: it gives an exact byte count for the size guard and for the
    // inline-vs-KV decision, and it lets a malformed body be rejected without the parse
    // cost. `c.req.json()` would hide both.
    const body = await c.req.text();
    if (byteLength(body) > PROMOTE_PAYLOAD_MAX_BYTES) {
      throw new ApiError(
        413,
        ApiErrorCode.PAYLOAD_TOO_LARGE,
        `Promote payload exceeds the ${PROMOTE_PAYLOAD_MAX_BYTES}-byte limit`,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
    }

    const payload = PromotePayloadSchema.parse(raw);
    const workflow = requireWorkflow(c.env);

    // A caller-supplied id is what buys replay idempotency; the fallback keeps a caller
    // that omits it working (it just gets no protection — see `PromoteJobIdSchema`).
    const jobId = payload.jobId ?? crypto.randomUUID();

    const params = await buildParams(c.env, jobId, c.req.url, payload);

    let outcome: 'created' | 'existing';
    try {
      await workflow.create({ id: jobId, params });
      outcome = 'created';
    } catch (error) {
      // `create` throws when the id is already in use by an instance still inside its
      // retention window — which is precisely the replayed-kick-off case, and the whole
      // point of caller-supplied ids. Confirm by fetching the instance rather than
      // string-matching the platform's error message: if it really exists this is a
      // replay, and if it doesn't the original failure was something else and must
      // surface.
      try {
        await workflow.get(jobId);
      } catch {
        throw error;
      }
      outcome = 'existing';
    }

    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.api.promote.kickoff', 1, [
      `outcome:${outcome}`,
      `payload:${params.payloadRef === 'kv' ? 'staged' : 'inline'}`,
    ]);

    const response: PromoteKickoffResponse = { jobId, status: 'queued' };
    return json(response, { status: 202, headers: { Location: `/api/promote/jobs/${jobId}` } });
  };
}

/**
 * Decide how the bundle reaches the Workflow. Inline for everything under the threshold —
 * which in practice is every real bundle — and staged in KV above it, because Workflow
 * event params are capped at 1 MiB and a curator with a very heavily-integrated product
 * must not hit a wall the protocol can avoid.
 *
 * `sourceUrl` rides along so the Workflow's logs keep the same `host` facet as
 * the request-originated ones.
 */
async function buildParams(
  env: Env,
  jobId: string,
  sourceUrl: string,
  payload: PromotePayload,
): Promise<PromoteWorkflowParams> {
  // Measure what we would actually send (the validated payload), not the caller's body:
  // Zod strips unknown keys and applies defaults, so the two can differ in both directions.
  const serialized = JSON.stringify(payload);
  if (byteLength(serialized) <= PROMOTE_PARAMS_INLINE_MAX_BYTES) {
    return { jobId, sourceUrl, payload };
  }

  const kv = env.PROMOTE_KV;
  if (!kv) {
    // The only environment without the binding is one that hasn't provisioned the
    // namespace. Refusing loudly beats inlining an oversize payload and having the
    // platform reject the instance creation with an opaque error.
    throw new ApiError(
      413,
      ApiErrorCode.PAYLOAD_TOO_LARGE,
      'Promote payload is too large to inline and PROMOTE_KV is not configured for staging',
    );
  }
  await kv.put(promotePayloadKey(jobId), serialized, {
    expirationTtl: PROMOTE_PAYLOAD_TTL_SECONDS,
  });
  return { jobId, sourceUrl, payloadRef: 'kv' };
}

/** Byte length, not character count — the platform limits are bytes and a single emoji in
 *  a description would make `String.length` lie. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Shared vocabulary of the async promote-job protocol (AECI-563 / ADR 0021).
 *
 * Three modules have to agree byte-for-byte about the KV key layout, the size
 * thresholds, and the platform→contract status mapping: the kick-off
 * (`routes/promote-kickoff.ts`), the Workflow (`workflows/promote-workflow.ts`),
 * and the poll (`routes/promote-jobs.ts`). They live here so a change is one edit
 * rather than three that can silently drift — a mismatched key prefix would look
 * exactly like "the job vanished".
 */

import { ApiErrorCode, type PromoteJobStatus, type PromotePayload } from '@aeci/shared';

/**
 * What the kick-off puts on the Workflow event. Declared here — a leaf module with no
 * platform imports — rather than beside the Workflow class, so `env.ts` can type the
 * `PROMOTE_WORKFLOW` binding without importing `cloudflare:workers`.
 *
 * `payload` is inlined for the overwhelming majority of bundles; oversize ones are staged
 * in KV and flagged with `payloadRef: 'kv'` (event params cap at 1 MiB).
 */
export type PromoteWorkflowParams = {
  jobId: string;
  /**
   * The kick-off request's URL, replayed into a synthetic `Request` purely so the Datadog
   * `hostname` dimension of workflow-originated promote logs matches the request-originated
   * ones operators already query. Nothing reads a body or headers off it.
   */
  sourceUrl: string;
  payload?: PromotePayload;
  payloadRef?: 'kv';
};

/**
 * Where the kick-off stages a bundle too large to ride the Workflow event params,
 * and where the Workflow reads it back. Keyed by job id, so a replayed kick-off
 * overwrites its own staging entry rather than orphaning one.
 */
export const promotePayloadKey = (jobId: string): string => `promote:payload:${jobId}`;

/**
 * Where the committed ingest mirrors its ID map. This is what keeps the acceptance
 * criterion ("the IDs remain fetchable by job ID") true past the Workflow instance's
 * retention window — after that the instance is gone and this mirror is the only
 * surviving copy.
 */
export const promoteResultKey = (jobId: string): string => `promote:result:${jobId}`;

/**
 * Staged payloads live 24h. Long enough to cover every retry the Workflow will make
 * (and an operator `restart()` the same day); short enough that the namespace never
 * accumulates curator bundles. The payload is only ever read at the start of the run.
 */
export const PROMOTE_PAYLOAD_TTL_SECONDS = 86_400;

/**
 * Mirrored results live 90 days — deliberately longer than the 30-day Workflow
 * instance retention, so "I lost the response" stays recoverable for a full quarter.
 */
export const PROMOTE_RESULT_TTL_SECONDS = 7_776_000;

/**
 * Above this, the validated bundle is staged in KV instead of being inlined into the
 * Workflow event params. The platform caps event payloads at 1 MiB (2^20); 512 KiB
 * leaves room for the params envelope and for JSON re-serialization overhead rather
 * than betting on the caller's body length matching ours.
 */
export const PROMOTE_PARAMS_INLINE_MAX_BYTES = 512 * 1024;

/**
 * Hard ceiling on the request body, checked before anything is parsed. Real bundles
 * are KB-scale (a product with ~200 integrations is well under 100 KB), so this is a
 * runaway/abuse guard, not a functional limit — it exists so a malformed multi-megabyte
 * body is rejected in O(1) instead of being parsed, validated, and written to KV.
 */
export const PROMOTE_PAYLOAD_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Collapse the platform's nine instance states onto the four the contract exposes
 * (`@aeci/shared` `PromoteJobStatus`).
 *
 * `paused` / `waiting` / `waitingForPause` / `unknown` all mean "not finished, not
 * failed" to a poller, so they read as `running` — a caller has nothing different to
 * do for any of them. `terminated` (an operator killed the instance) reads as
 * `errored` for the same reason: the promote did not complete and will not.
 */
export function toPromoteJobStatus(status: string): PromoteJobStatus {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'complete':
      return 'complete';
    case 'errored':
    case 'terminated':
      return 'errored';
    default:
      return 'running';
  }
}

/**
 * Recover the structured error code from a failed instance.
 *
 * The Workflow throws `NonRetryableError(message, code)` — the second argument is the
 * error's `name`, which is what `instance.status().error.name` surfaces — so the code
 * the synchronous endpoint used to return in its envelope survives the round trip.
 * Anything unrecognized (a platform-level failure, a step timeout) is an
 * `INTERNAL_ERROR` from the caller's point of view.
 */
export function promoteJobErrorCode(name: string | undefined): ApiErrorCode {
  const known = Object.values(ApiErrorCode) as string[];
  return name && known.includes(name) ? (name as ApiErrorCode) : ApiErrorCode.INTERNAL_ERROR;
}

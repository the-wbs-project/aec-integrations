/**
 * Linear issue creation for vendor requests (AECI-211 / Phase 6.4).
 *
 * The form→Linear bridge: after a claim/correction commits, this runs in the
 * request handler's `ctx.waitUntil()` (so it never blocks the `201`) and creates
 * a Linear issue in the **"Vendor Requests" project** — kind label, body from the
 * form fields, the `Source URL` as a clickable attachment, a round-robin assignee
 * — then stores the returned issue id back on `vendor_requests.linear_issue_id`
 * AND the request's `workflow_instance.linear_issue_id`. Linear's own email
 * notifications then alert the assignee (`STAGE_1_PHASE_6_SPEC.md` §6.1, §10).
 *
 * The contract `createLinearIssueForRequest()` upholds (mirrors `lib/perspective.ts`):
 *
 *   - **Never throws.** Every failure mode (absent key, timeout, non-2xx, a
 *     200-with-`errors[]` body, `success:false`, a DB write error) is caught,
 *     logged to Datadog, and metered — the row simply stays `open` with
 *     `linear_issue_id=null` for the §6.7 reconciliation sweep to retry (§6.2).
 *   - **Absent key → silent no-op, no metric.** No `LINEAR_API_KEY` is the
 *     expected state in local `dev:bound` / PR previews (staging/prod only), so it
 *     must not pollute the `aeci.linear.issue` error-rate denominator.
 *   - **Idempotent.** A read-guard skips creation once `linear_issue_id` is set, so
 *     a stray re-fire (or the §6.7 retrier running this same function) never
 *     double-creates. The persist is a compare-and-set by primary key. Full
 *     concurrent mutual-exclusion (a lease / search-before-create on the embedded
 *     `Request: <id>` marker) is the §6.7 retrier's job — single-fire here has one
 *     writer, so the read-guard suffices.
 *
 * Linear returns **HTTP 200 with `{ errors:[...] }`** (or `success:false`) on
 * logical failures — bad label/assignee id, auth scope — so a `res.ok` check alone
 * is not enough; `linearGraphql()` surfaces both as failures.
 *
 * The id constants + `linearGraphql()` transport are exported for the §6.5 webhook
 * and §6.7 reconciliation sweep to reuse without re-deriving the board structure.
 */

import type { RequestKind, RequestTargetType } from '@aeci/shared';
import {
  forwardWorkflowTransition,
  type WorkflowTransitionEntry,
  type WorkflowTransitionForwarder,
} from '@aeci/shared/workflow-transition';
import { and, eq, isNull } from 'drizzle-orm';

import type { Db } from '../db/client';
import { vendorRequests, workflowInstances } from '../db/schema';
import { logToDatadog, submitCount, submitDistribution } from '../datadog';
import type { Env } from '../env';
import { workflowTransitionInsert } from './audit';

// ─── Verified Linear board constants ─────────────────────────────────────────
// Queried live (2026-06-13). Hardcoded rather than env-configured because they
// mirror the fixed Linear board structure (Phase 6 spec §6.1) and are not secret.

export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

/** "Vendor Requests" project in the AECi team — each request becomes an issue. */
export const VENDOR_REQUESTS_PROJECT_ID = '9f67f235-8610-4eb5-b58d-35d4ae0f2596';
export const AECI_TEAM_ID = 'd7706bcb-c776-4064-b4da-0c350dfb8f16';

/** Request-type + workflow-stage label ids. `domain-check-pending` is applied on
 *  a domain mismatch (`domain_match:'no_match'`) computed at submit time (6.8 §7.1). */
export const LABEL_IDS = {
  claim: '3fcb69bc-9759-4e6e-848d-84f28692289e',
  correction: '6842dec1-aaec-4fee-a3e1-9efd4ca620f2',
  domainCheckPending: 'a0a784c1-6cb0-49ca-b865-fbd2e8761611',
} as const;

/**
 * Round-robin assignee pool (§6.1). Today only Chris is a member of the Linear
 * workspace, so this is single-element and `pickAssignee` always returns him;
 * "round-robin Chris/Bill" activates the moment Bill's user id is appended here —
 * no other change needed.
 */
export const ASSIGNEE_IDS: readonly string[] = ['4580c38b-84de-4eca-b043-7d26b5b65416'];

/**
 * AECi-team workflow-state ids for the outbound site→Linear sync (§6.5, AECI-213).
 * Queried live 2026-06-13. This is the **inverse** of the §6.3 webhook's
 * `state.type`→status map: a site `resolve`→ the `completed`-type "Done" state, a
 * `reject`→ the `canceled`-type "Canceled" state — so the two directions agree on
 * the same terminal Linear states. Hardcoded for the same reason as the board
 * constants above (fixed board structure, not secret).
 */
export const WORKFLOW_STATE_IDS = {
  resolved: 'd1ccafd9-f13a-4210-b735-4def79b9aa00', // "Done"     (type: completed)
  rejected: 'd3d59ae8-63b6-41b4-9b87-8d62bfcc753a', // "Canceled" (type: canceled)
} as const;

/** Cap on each Linear call so a slow API never holds the `waitUntil` open. */
const TIMEOUT_MS = 5000;

// ─── GraphQL operations ──────────────────────────────────────────────────────

const ISSUE_CREATE_MUTATION = `
mutation CreateRequestIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url }
  }
}`;

const ATTACHMENT_CREATE_MUTATION = `
mutation AttachSource($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) {
    success
    attachment { id }
  }
}`;

const ISSUE_UPDATE_MUTATION = `
mutation TransitionRequestIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id identifier state { id name type } }
  }
}`;

const COMMENT_CREATE_MUTATION = `
mutation CommentOnRequestIssue($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id }
  }
}`;

type IssueCreatePayload = {
  issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null };
};
type AttachmentCreatePayload = {
  attachmentCreate: { success: boolean; attachment: { id: string } | null };
};
type IssueState = { id: string; name: string; type: string };
type IssueUpdatePayload = {
  issueUpdate: {
    success: boolean;
    issue: { id: string; identifier: string; state: IssueState | null } | null;
  };
};
type CommentCreatePayload = {
  commentCreate: { success: boolean; comment: { id: string } | null };
};

// ─── Transport ───────────────────────────────────────────────────────────────

export type LinearFailureReason =
  | 'timeout'
  | 'network'
  | 'http_error'
  | 'graphql_error'
  | 'empty_response';

export type LinearGraphqlResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; reason: LinearFailureReason; message: string };

/**
 * POST a GraphQL operation to Linear. **Never throws** — network/timeout/non-2xx
 * and a 200-with-`errors[]` body all resolve to a structured `{ ok:false }`.
 * `fetchImpl` is injected (defaults to the global `fetch`) so tests need no global
 * stub. Auth is the raw key in `Authorization` (Linear's convention — no `Bearer`).
 */
export async function linearGraphql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearGraphqlResult<T>> {
  let res: Response;
  try {
    res = await fetchImpl(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      reason: isTimeoutError(error) ? 'timeout' : 'network',
      message: error instanceof Error ? error.message : 'network_error',
    };
  }

  let body: { data?: T; errors?: Array<{ message?: string }> } | null = null;
  try {
    body = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
  } catch {
    // Non-JSON body (e.g. an HTML 5xx page); statusText is the best signal left.
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      reason: 'http_error',
      message: extractErrors(body) ?? res.statusText ?? `http_${res.status}`,
    };
  }
  const errs = extractErrors(body);
  if (errs) return { ok: false, status: res.status, reason: 'graphql_error', message: errs };
  if (!body?.data) {
    return { ok: false, status: res.status, reason: 'empty_response', message: 'empty_response' };
  }
  return { ok: true, data: body.data };
}

function extractErrors(body: { errors?: Array<{ message?: string }> } | null): string | null {
  if (!body?.errors?.length) return null;
  return (
    body.errors
      .map((e) => e.message)
      .filter(Boolean)
      .join('; ') || 'graphql_error'
  );
}

// ─── Pure helpers (exported for testing) ─────────────────────────────────────

/**
 * Deterministic, stateless balanced assignee pick keyed on the request id. A
 * retry (§6.7) re-assigns the *same* person — true round-robin needs a shared
 * counter we don't have in a stateless Worker, and a balanced hash of the UUID is
 * the standard substitute. A single-element pool always returns its only member.
 */
export function pickAssignee(
  requestId: string,
  pool: readonly string[] = ASSIGNEE_IDS,
): string | undefined {
  if (pool.length === 0) return undefined;
  const n = Number.parseInt(requestId.replace(/-/g, '').slice(0, 8), 16);
  return pool[(Number.isNaN(n) ? 0 : n) % pool.length];
}

/** Labels for a request issue: the kind label, plus `domain-check-pending` when
 *  6.8 has flagged a domain mismatch (`domain_match:'no_match'`). */
export function labelIdsFor(kind: RequestKind, domainMatch?: string | null): string[] {
  const ids: string[] = [LABEL_IDS[kind]];
  if (domainMatch === 'no_match') ids.push(LABEL_IDS.domainCheckPending);
  return ids;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

/**
 * ORM-neutral persistence seam for the issue link-back + idempotency guard. The
 * post-commit task runs OUTSIDE any transaction, so these are top-level reads/
 * writes. `createLinearIssueForRequest` depends only on this seam:
 * `routes/requests.ts` passes a Drizzle-backed store (`drizzleLinearStore`);
 * `lib/reconciliation-sweep.ts` passes a Prisma-backed one (`prismaLinearStore`)
 * until it migrates (ADR 0016 / AECI-253).
 */
export interface LinearRequestStore {
  /** Current `linear_issue_id` of the request — null if unlinked OR the row is
   *  gone (both mean "proceed to create", matching the old `findUnique` guard). */
  getLinkedIssueId(requestId: string): Promise<string | null>;
  /** Compare-and-set the issue id onto the request row AND its workflow instance,
   *  by PK with a `linear_issue_id IS NULL` guard (idempotent under a retry race). */
  linkIssue(requestId: string, workflowId: string, issueId: string): Promise<void>;
}

/** Drizzle/D1 `LinearRequestStore` (`routes/requests.ts`; the §6.7 sweep once it
 *  migrates). */
export function drizzleLinearStore(db: Db): LinearRequestStore {
  return {
    async getLinkedIssueId(requestId) {
      const row = await db.query.vendorRequests.findFirst({
        columns: { linearIssueId: true },
        where: eq(vendorRequests.id, requestId),
      });
      return row?.linearIssueId ?? null;
    },
    async linkIssue(requestId, workflowId, issueId) {
      await db
        .update(vendorRequests)
        .set({ linearIssueId: issueId })
        .where(and(eq(vendorRequests.id, requestId), isNull(vendorRequests.linearIssueId)));
      await db
        .update(workflowInstances)
        .set({ linearIssueId: issueId })
        .where(and(eq(workflowInstances.id, workflowId), isNull(workflowInstances.linearIssueId)));
    },
  };
}

type UpdateManyArgs = { where: Record<string, unknown>; data: Record<string, unknown> };

/**
 * @deprecated Transitional Prisma surface for {@link prismaLinearStore}. Removed
 * when `lib/reconciliation-sweep.ts` (its only remaining caller) moves to Drizzle
 * (AECI-253). A real accelerated client and the sweep's test fake both satisfy it.
 */
export type LinearPersistClient = {
  vendorRequest: {
    findUnique(args: {
      where: { id: string };
      select: { linearIssueId: true };
    }): Promise<{ linearIssueId: string | null } | null>;
    updateMany(args: UpdateManyArgs): Promise<{ count: number }>;
  };
  workflowInstance: { updateMany(args: UpdateManyArgs): Promise<{ count: number }> };
};

/** @deprecated Transitional Prisma-backed `LinearRequestStore` (the §6.7 sweep
 *  until it migrates to Drizzle). */
export function prismaLinearStore(client: LinearPersistClient): LinearRequestStore {
  return {
    async getLinkedIssueId(requestId) {
      const row = await client.vendorRequest.findUnique({
        where: { id: requestId },
        select: { linearIssueId: true },
      });
      return row?.linearIssueId ?? null;
    },
    async linkIssue(requestId, workflowId, issueId) {
      await client.vendorRequest.updateMany({
        where: { id: requestId, linearIssueId: null },
        data: { linearIssueId: issueId },
      });
      await client.workflowInstance.updateMany({
        where: { id: workflowId, linearIssueId: null },
        data: { linearIssueId: issueId },
      });
    },
  };
}

/** The slice of Hono's `Context` this needs, typed structurally (like
 *  `perspective.ts`'s `ScoreContext`) so a handler's richer `AuthContext` fits. */
type LinearContext = { env: Env; executionCtx: ExecutionContext; req: { raw: Request } };

export interface LinearIssueInput {
  requestId: string;
  /** The request's `workflow_instance.id` — the PK the persist compare-and-sets. */
  workflowId: string;
  kind: RequestKind;
  targetType: RequestTargetType;
  /** Display name for the issue title; not stored on the row. */
  targetName: string;
  slug: string;
  submitterEmail: string;
  submitterName?: string | null;
  submitterRole?: string | null;
  body: string;
  sourceUrl?: string | null;
  /** From 6.8 (§7.1); `'no_match'` adds the domain-check-pending label. */
  domainMatch?: string | null;
  /** From 6.8 (§7.2): the earliest matching `open` request id when this submit looks
   *  like a duplicate. Set → post an informational note on the issue (never rejects). */
  duplicateOfRequestId?: string | null;
  /** That duplicate request's Linear issue id, if any — referenced in the note. */
  duplicateLinearIssueId?: string | null;
}

export interface LinearResolutionInput {
  requestId: string;
  /** The request's `workflow_instance.id` — the transition's parent. */
  workflowId: string;
  /** The linked Linear issue node id, or null if one was never created (§6.2). */
  linearIssueId: string | null;
  kind: RequestKind;
  /** The resolution the admin chose: `resolved`→"Done", `rejected`→"Canceled". */
  toStatus: keyof typeof WORKFLOW_STATE_IDS;
  /** Prior status, for the transition's `from_state` (defaults to `'open'`). */
  fromStatus?: string | null;
  /** Resolution note / rejection reason → the Linear comment + `transition.reason`. */
  reason?: string | null;
  /** Admin profile id → `transition.actor_id`. */
  actorId?: string | null;
  /** Admin email/name for the comment body (display only; never required). */
  actorLabel?: string | null;
}

/**
 * Create the Linear issue for a just-submitted request and link it back. Runs in
 * `ctx.waitUntil()`; never throws (see file header). On any failure the row is
 * left `open`/`linear_issue_id=null` for §6.7 to retry.
 */
export async function createLinearIssueForRequest(
  c: LinearContext,
  store: LinearRequestStore,
  input: LinearIssueInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const apiKey = c.env.LINEAR_API_KEY;
  // Absent key is the expected non-prod state — silent no-op, no metric (it must
  // not pollute the error-rate denominator; mirrors `perspective.ts`).
  if (!apiKey) return;

  // Idempotency guard: skip if already linked. Covers a stray re-fire and the
  // §6.7 retrier reusing this function.
  try {
    const existingId = await store.getLinkedIssueId(input.requestId);
    if (existingId) {
      emit(c, 'skipped_exists', input.kind);
      return;
    }
  } catch (error) {
    // A guard read failure must not risk a duplicate — bail, leave the row open.
    warn(c, `linear idempotency read failed: ${errMsg(error)}`);
    emit(c, 'failed', input.kind, 'db_error');
    return;
  }

  const started = Date.now();
  const assigneeId = pickAssignee(input.requestId);
  const createRes = await linearGraphql<IssueCreatePayload>(
    apiKey,
    ISSUE_CREATE_MUTATION,
    {
      input: {
        teamId: AECI_TEAM_ID,
        projectId: VENDOR_REQUESTS_PROJECT_ID,
        title: buildTitle(input),
        description: buildDescription(input),
        labelIds: labelIdsFor(input.kind, input.domainMatch),
        ...(assigneeId ? { assigneeId } : {}),
      },
    },
    fetchImpl,
  );

  // Gate on transport ok AND Linear's own `success`/`issue` — a 200 can still carry
  // `errors[]` or `success:false` (handled in `linearGraphql`/here).
  const issue = createRes.ok ? createRes.data.issueCreate.issue : null;
  if (!createRes.ok || !createRes.data.issueCreate.success || !issue) {
    const reason = createRes.ok ? 'graphql_error' : createRes.reason;
    const message = createRes.ok ? 'issueCreate success=false' : createRes.message;
    error(c, `linear issueCreate failed (${reason}): ${message}`);
    emit(c, 'failed', input.kind, reason, Date.now() - started);
    return;
  }

  // Source URL → attachment (renders as a clickable card). Best-effort: a failed
  // attachment must not undo the issue or block linking.
  if (input.sourceUrl) {
    const attachRes = await linearGraphql<AttachmentCreatePayload>(
      apiKey,
      ATTACHMENT_CREATE_MUTATION,
      { input: { issueId: issue.id, title: 'Source URL', url: input.sourceUrl } },
      fetchImpl,
    );
    if (!attachRes.ok || !attachRes.data.attachmentCreate.success) {
      warn(
        c,
        `linear attachmentCreate failed: ${attachRes.ok ? 'success=false' : attachRes.message}`,
      );
    }
  }

  // Duplicate note (§7.2). Best-effort like the attachment — informational only, a
  // failure must not undo the issue or block linking.
  if (input.duplicateOfRequestId) {
    const noteRes = await linearGraphql<CommentCreatePayload>(
      apiKey,
      COMMENT_CREATE_MUTATION,
      { input: { issueId: issue.id, body: buildDuplicateNote(input) } },
      fetchImpl,
    );
    if (!noteRes.ok || !noteRes.data.commentCreate.success) {
      warn(
        c,
        `linear duplicate commentCreate failed: ${noteRes.ok ? 'success=false' : noteRes.message}`,
      );
    }
  }

  // Persist the id on both the request row and its workflow instance, compare-and-
  // set by PK so only the first writer wins (idempotent under a retry race).
  try {
    await store.linkIssue(input.requestId, input.workflowId, issue.id);
  } catch (err) {
    // The issue exists but we couldn't link it — row stays open; §6.7 reconciles
    // via the embedded `Request: <id>` marker. Reported as a pipeline failure.
    error(c, `linear id persist failed (issue ${issue.id}): ${errMsg(err)}`);
    emit(c, 'failed', input.kind, 'db_error', Date.now() - started);
    return;
  }

  emit(c, 'ok', input.kind, undefined, Date.now() - started);
}

/**
 * Site → Linear sync on an admin resolve/reject (`STAGE_1_PHASE_6_SPEC.md` §6.5;
 * `STAGE_1_SPEC.md` §26.4 — the outbound half of the bidirectional sync). After
 * an admin resolves/rejects a vendor request on the site, this transitions the
 * linked Linear issue to the matching terminal state ("Done"/"Canceled"), posts a
 * comment, and records the site-originated `workflow_transition`.
 *
 * Designed to be called from the §8.1 resolve/reject handler's `ctx.waitUntil()`
 * (AECI-217, not yet built) — the handler owns the local `status`/`resolved_*`
 * write + `audit_log`; this owns the Linear push + the sync transition. It upholds
 * the same contract as `createLinearIssueForRequest`:
 *
 *   - **Never throws.** Every failure (absent key, timeout, non-2xx, `errors[]`,
 *     `success:false`, a transition-write error) is caught, logged, and metered.
 *   - **Absent key → silent no-op, no metric** (non-prod state; must not pollute
 *     the `aeci.linear.sync` error-rate denominator).
 *   - **Tolerant of a missing issue.** `linear_issue_id === null` (issue never
 *     created — §6.2 — or the §6.7 sweep hasn't reconciled it yet) is **skip +
 *     log**, not an error: there is simply nothing to push.
 */
export async function pushRequestResolutionToLinear(
  c: LinearContext,
  db: Db,
  input: LinearResolutionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const apiKey = c.env.LINEAR_API_KEY;
  // Absent key is the expected non-prod state — silent no-op, no metric (parity
  // with `createLinearIssueForRequest`).
  if (!apiKey) return;

  // Tolerant of a request whose Linear issue was never created: nothing to sync.
  // Skip + log (not an error) and don't record a transition — there is no issue
  // the admin's resolution could have been pushed to.
  if (!input.linearIssueId) {
    info(c, `linear sync skipped: request ${input.requestId} has no linear_issue_id`);
    emitSync(c, 'skipped_no_issue', input.kind, input.toStatus);
    return;
  }

  const started = Date.now();
  const stateId = WORKFLOW_STATE_IDS[input.toStatus];
  const updateRes = await linearGraphql<IssueUpdatePayload>(
    apiKey,
    ISSUE_UPDATE_MUTATION,
    { id: input.linearIssueId, input: { stateId } },
    fetchImpl,
  );

  // Gate on transport ok AND Linear's own `success`/`issue` — a 200 can carry
  // `errors[]` or `success:false` (same rationale as the create path).
  const issue = updateRes.ok ? updateRes.data.issueUpdate.issue : null;
  if (!updateRes.ok || !updateRes.data.issueUpdate.success || !issue) {
    const reason = updateRes.ok ? 'graphql_error' : updateRes.reason;
    const message = updateRes.ok ? 'issueUpdate success=false' : updateRes.message;
    error(c, `linear issueUpdate failed (${reason}): ${message}`);
    emitSync(c, 'failed', input.kind, input.toStatus, reason, Date.now() - started);
    return;
  }

  // Comment — best-effort (a failed comment must not undo the state change or
  // block the transition record), mirroring the create path's attachment step.
  const commentRes = await linearGraphql<CommentCreatePayload>(
    apiKey,
    COMMENT_CREATE_MUTATION,
    { input: { issueId: input.linearIssueId, body: buildResolutionComment(input) } },
    fetchImpl,
  );
  if (!commentRes.ok || !commentRes.data.commentCreate.success) {
    warn(c, `linear commentCreate failed: ${commentRes.ok ? 'success=false' : commentRes.message}`);
  }

  // Record the site-originated transition (§6.5, AECI-213 AC2). Append-only,
  // non-transactional (we're post-commit in `waitUntil`); a write failure is
  // logged + metered, never thrown. `actor_type` lives in metadata (no column).
  const transitionEntry: WorkflowTransitionEntry = {
    workflowId: input.workflowId,
    fromState: input.fromStatus ?? 'open',
    toState: input.toStatus,
    actorId: input.actorId ?? null,
    reason: input.reason ?? null,
    metadata: {
      source: 'site-linear-sync',
      actor_type: 'admin',
      linear_issue_id: input.linearIssueId,
      linear_state_id: stateId,
      linear_state_name: issue.state?.name ?? null,
      linear_state_type: issue.state?.type ?? null,
    },
  };
  try {
    await workflowTransitionInsert(db, transitionEntry);
  } catch (err) {
    error(c, `linear sync transition persist failed: ${errMsg(err)}`);
    emitSync(c, 'failed', input.kind, input.toStatus, 'db_error', Date.now() - started);
    return;
  }
  // Best-effort §26.5 forward AFTER the row commits (forwarder swallows its own
  // errors, so this can't throw out of the `waitUntil`).
  await forwardWorkflowTransition(transitionEntry, makeSyncForwarder(c));

  emitSync(c, 'ok', input.kind, input.toStatus, undefined, Date.now() - started);
}

// ─── Issue content ───────────────────────────────────────────────────────────

function buildTitle(input: LinearIssueInput): string {
  const verb = input.kind === 'claim' ? 'Claim' : 'Correction';
  return `${verb}: ${input.targetName} (${input.targetType})`;
}

function buildDescription(input: LinearIssueInput): string {
  const lines = [
    `**Type:** ${input.kind}`,
    `**Target:** ${input.targetName} (${input.targetType}, \`${input.slug}\`)`,
    `**Submitter:** ${input.submitterEmail}`,
  ];
  if (input.submitterName) lines.push(`**Name:** ${input.submitterName}`);
  if (input.submitterRole) lines.push(`**Role:** ${input.submitterRole}`);
  lines.push('', input.body, '', '---', `Request: ${input.requestId}`);
  return lines.join('\n');
}

/** Linear comment for an admin resolve/reject pushed from the site (§6.5). */
function buildResolutionComment(input: LinearResolutionInput): string {
  const verb = input.toStatus === 'resolved' ? 'resolved' : 'rejected';
  const who = input.actorLabel ? ` by ${input.actorLabel}` : '';
  const lines = [`This request was **${verb}**${who} on AECi.`];
  if (input.reason) lines.push('', `> ${input.reason}`);
  return lines.join('\n');
}

/** Informational duplicate note (§7.2). Vendor-request duplicates are sometimes
 *  legitimate (two people from the same vendor claim independently), so this only
 *  flags for the admin — it never rejects. */
function buildDuplicateNote(input: LinearIssueInput): string {
  const lines = [
    "⚠️ **Possible duplicate.** An existing `open` request for this target shares this submit's kind or submitter.",
    '',
    `**Original request:** \`${input.duplicateOfRequestId}\``,
  ];
  if (input.duplicateLinearIssueId) {
    lines.push(`**Original Linear issue:** ${input.duplicateLinearIssueId}`);
  }
  lines.push(
    '',
    'Informational only — review before resolving. Vendor-request duplicates are sometimes legitimate (e.g. two people from the same vendor claiming independently).',
  );
  return lines.join('\n');
}

// ─── Telemetry ───────────────────────────────────────────────────────────────

/** Emit the `aeci.linear.issue` outcome count (+ duration distribution on a
 *  terminal create attempt). Wrapped so a missing `DD_API_KEY` / ExecutionContext
 *  can never turn a graceful path into a throw (mirrors `perspective.ts`). */
function emit(
  c: LinearContext,
  outcome: 'ok' | 'failed' | 'skipped_exists',
  kind: RequestKind,
  reason?: string,
  durationMs?: number,
): void {
  try {
    const tags = [`outcome:${outcome}`, `kind:${kind}`];
    if (reason) tags.push(`reason:${reason}`);
    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.linear.issue', 1, tags);
    if (durationMs !== undefined) {
      submitDistribution(
        c.executionCtx,
        c.env,
        c.req.raw,
        'aeci.linear.issue.duration_ms',
        durationMs,
        [`outcome:${outcome}`],
      );
    }
  } catch {
    // Telemetry must never break the pipeline.
  }
}

/** Emit the `aeci.linear.sync` outcome count (+ duration on a terminal attempt)
 *  for the site→Linear resolve/reject push (§6.5, AECI-213). Same swallow-on-error
 *  wrapper as `emit`. */
function emitSync(
  c: LinearContext,
  outcome: 'ok' | 'failed' | 'skipped_no_issue',
  kind: RequestKind,
  toStatus: keyof typeof WORKFLOW_STATE_IDS,
  reason?: string,
  durationMs?: number,
): void {
  try {
    const tags = [`outcome:${outcome}`, `kind:${kind}`, `to_status:${toStatus}`];
    if (reason) tags.push(`reason:${reason}`);
    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.linear.sync', 1, tags);
    if (durationMs !== undefined) {
      submitDistribution(
        c.executionCtx,
        c.env,
        c.req.raw,
        'aeci.linear.sync.duration_ms',
        durationMs,
        [`outcome:${outcome}`],
      );
    }
  } catch {
    // Telemetry must never break the pipeline.
  }
}

/** Datadog forwarder for the sync transition write; no-op without `DD_API_KEY`.
 *  Mirrors `routes/webhooks.ts`'s `makeWorkflowForwarder`, tagged
 *  `source: site-linear-sync`. */
function makeSyncForwarder(c: LinearContext): WorkflowTransitionForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `workflow ${entry.fromState ?? '∅'}→${entry.toState} ${entry.workflowId}`.trim(),
      from_state: entry.fromState ?? undefined,
      to_state: entry.toState,
      workflow_id: entry.workflowId,
      source: 'site-linear-sync',
    });
  };
}

function info(c: LinearContext, message: string): void {
  log(c, 'info', message);
}
function warn(c: LinearContext, message: string): void {
  log(c, 'warn', message);
}
function error(c: LinearContext, message: string): void {
  log(c, 'error', message);
}
function log(c: LinearContext, level: 'info' | 'warn' | 'error', message: string): void {
  try {
    logToDatadog(c.executionCtx, c.env, c.req.raw, { level, message, source: 'linear' });
  } catch {
    const sink = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    console[sink](`linear: ${message}`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True for an `AbortSignal.timeout` abort (`DOMException` named `AbortError` or
 *  `TimeoutError`). Duck-typed on `.name` — `DOMException` isn't always `Error`. */
function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

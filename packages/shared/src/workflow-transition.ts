/**
 * Append-only workflow-transition writer (Stage 1 Spec §26.2, §26.5;
 * Phase 6 Spec §5).
 *
 * Mirrors `appendAuditLog()`. Each row in `workflow_transitions` records one
 * state change of a `workflow_instance` (`from_state` → `to_state`, who, why).
 * Per §26.1's transactional contract, pass a Prisma transaction client as `db`
 * so the transition commits or rolls back with the entity write that triggered
 * it. Failure to write the row throws — the caller's transaction unwinds.
 *
 * Per §26.5 the helper ALSO forwards the event to Datadog, but Supabase is the
 * source of truth: a forwarding failure is logged and swallowed, never failing
 * the DB write. Forwarding is injected (`forward`) rather than hard-wired so
 * this module stays transport-agnostic and edge-safe — identical rationale to
 * `appendAuditLog`.
 *
 * **Stage-1 lean relaxation (§26.3, Phase 6 Spec §5):** there is **no guarded
 * state machine**. Transitions are *recorded*, not *enforced* — this helper
 * never validates that `from_state`/`to_state` form a legal edge. Moderation is
 * driven off the entity `status` columns; `workflow_transitions` is purely an
 * append-only history. The guarded/throwing FSM described in §26.3 is deferred
 * past Stage 1 given low request volume.
 *
 * Note: `workflow_transitions` has no `actor_type` column. The §26.4 inbound
 * Linear webhook records its `actor_type: 'workflow'` provenance in `metadata`,
 * not as a first-class field here.
 */

/**
 * A single workflow transition. `workflowId` is the parent `workflow_instance`.
 * `fromState` is null for the genesis transition (instance creation). `actorId`
 * is null for anonymous/system/workflow actors. `metadata` carries context
 * (e.g. `{ source, kind, linear_issue_id }`).
 */
export interface WorkflowTransitionEntry {
  workflowId: string;
  fromState?: string | null;
  toState: string;
  actorId?: string | null;
  reason?: string | null;
  metadata?: unknown;
}

/**
 * Minimal Prisma surface this helper needs. Accepts the full `PrismaClient`,
 * a `$transaction` client, the accelerated client, or a test fake — all expose
 * `workflowTransition.create`.
 */
export interface WorkflowTransitionClient {
  workflowTransition: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

/**
 * Forwards a transition event to an external sink (Datadog). Implementations
 * must not throw to the caller — but `appendWorkflowTransition` defends against
 * it anyway. May be sync (fire-and-forget via `ctx.waitUntil`) or async.
 */
export type WorkflowTransitionForwarder = (entry: WorkflowTransitionEntry) => void | Promise<void>;

/**
 * Write a `workflow_transitions` row and (best-effort) forward it.
 *
 * The DB write is awaited and propagates errors — callers pass their
 * transaction client so a failed write rolls the operation back. The forward
 * step is wrapped: any rejection is logged via `console.warn` and swallowed so
 * Datadog availability never blocks a state change.
 */
export async function appendWorkflowTransition(
  db: WorkflowTransitionClient,
  entry: WorkflowTransitionEntry,
  forward?: WorkflowTransitionForwarder,
): Promise<void> {
  await db.workflowTransition.create({
    data: {
      workflowId: entry.workflowId,
      fromState: entry.fromState ?? null,
      toState: entry.toState,
      actorId: entry.actorId ?? null,
      reason: entry.reason ?? null,
      // Json? column: omit when absent (Prisma stores DB NULL). A literal
      // `null` would be rejected — that path needs Prisma.JsonNull.
      metadata: entry.metadata ?? undefined,
    },
  });

  if (!forward) return;
  try {
    await forward(entry);
  } catch (error) {
    console.warn('appendWorkflowTransition: Datadog forward failed', error);
  }
}

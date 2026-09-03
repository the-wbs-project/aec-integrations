/**
 * Append-only workflow-transition forwarder (Stage 1 Spec §26.2, §26.5;
 * Phase 6 Spec §5).
 *
 * Mirrors {@link forwardAuditLog}. Each row in `workflow_transitions` records one
 * state change of a `workflow_instance` (`from_state` → `to_state`, who, why).
 * Under D1 (ADR 0016 / AECI-249) the transition row is inserted as a statement
 * inside the caller's atomic `db.batch([...])` via the `workflowTransitionInsert`
 * builder (`apps/api/src/lib/audit.ts`), so it commits or rolls back with the
 * entity write that triggered it (the §26.1 invariant, preserved by the batch).
 *
 * Per §26.5 the event is ALSO forwarded to the observability plane, but the
 * database is the source of truth: a forwarding failure is logged and swallowed,
 * never failing the DB write. Forwarding is injected (`forward`) rather than
 * hard-wired so this module stays transport-agnostic and edge-safe — identical
 * rationale to the audit-log forwarder, and identically the reason the
 * Datadog → PostHog swap (AECI-642 / POSTHOG_MIGRATION_SPEC.md §3.7) changed no
 * line in this file. The API Worker wires `forward` to `logToPosthog()`.
 *
 * **Stage-1 lean relaxation (§26.3, Phase 6 Spec §5):** there is **no guarded
 * state machine**. Transitions are *recorded*, not *enforced* — nothing here
 * validates that `from_state`/`to_state` form a legal edge. Moderation is driven
 * off the entity `status` columns; `workflow_transitions` is purely an
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
 * Forwards a transition event to an external sink (PostHog). Implementations
 * must not throw to the caller — but {@link forwardWorkflowTransition} defends
 * against it anyway. May be sync (fire-and-forget via `ctx.waitUntil`) or async.
 */
export type WorkflowTransitionForwarder = (entry: WorkflowTransitionEntry) => void | Promise<void>;

/**
 * Best-effort forward of a transition event to PostHog (§26.5), decoupled from
 * the DB write. Under D1 (ADR 0016 / AECI-249) the transition row is inserted as
 * a statement inside the caller's atomic `db.batch([...])` (see
 * `apps/api/src/lib/audit.ts` `workflowTransitionInsert`), so the §26.1 invariant
 * is unaffected by where the forward goes. Call AFTER the batch commits. A
 * forward failure is logged and swallowed.
 */
export async function forwardWorkflowTransition(
  entry: WorkflowTransitionEntry,
  forward?: WorkflowTransitionForwarder,
): Promise<void> {
  if (!forward) return;
  try {
    await forward(entry);
  } catch (error) {
    console.warn('forwardWorkflowTransition: observability forward failed', error);
  }
}

/**
 * Canonical audit-log forwarder (Stage 1 Spec §26.1, §26.5).
 *
 * Every state-changing write across the platform records an `audit_log` row.
 * Under D1 (ADR 0016 / AECI-249) that row is inserted as a statement inside the
 * caller's atomic `db.batch([...])` via the `auditInsert` builder
 * (`apps/api/src/lib/audit.ts`), so the §26.1 "no state change without a
 * corresponding audit row" invariant is preserved by the batch — the row commits
 * or rolls back with the entity write.
 *
 * Per §26.5 the event is ALSO forwarded to the observability plane, but the
 * database is the source of truth: a forwarding failure is logged and swallowed,
 * never failing the write. Forwarding is injected (`forward`) rather than
 * hard-wired so this module stays transport-agnostic and edge-safe — no
 * `fetch`/`Request` coupling. That seam is exactly what let the vendor change
 * without touching this file: the API Worker wires `forward` to its
 * `logToPosthog()` (which uses `ctx.waitUntil`, and during the dual-run window
 * fans out to Datadog as well — AECI-642 / POSTHOG_MIGRATION_SPEC.md §3.7).
 * Call {@link forwardAuditLog} AFTER the batch commits.
 *
 * Naming convention (§26.1): dot-separated `entity.action`
 * (e.g. `product.created`, `vendor.updated`, `review.approved`).
 */

/** Allowed `actor_type` values — mirrors the `audit_log.actor_type` CHECK. */
export type AuditLogActorType = 'user' | 'admin' | 'system' | 'workflow';

/**
 * A single audit event. `actorId` is null for system/anonymous actors.
 * `beforeState`/`afterState` capture only the changed fields (updates); leave
 * unset for creates. `metadata` carries workflow context
 * (e.g. `{ linear_issue_id, ip_address, cf_country }`).
 */
export interface AuditLogEntry {
  actorId?: string | null;
  actorType: AuditLogActorType;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  metadata?: unknown;
}

/**
 * Forwards an audit event to an external sink (PostHog). Implementations must
 * not throw to the caller — but {@link forwardAuditLog} defends against it anyway.
 * May be sync (fire-and-forget via `ctx.waitUntil`) or async (awaited).
 */
export type AuditLogForwarder = (entry: AuditLogEntry) => void | Promise<void>;

/**
 * Best-effort forward of an audit event to PostHog (§26.5), decoupled from the
 * DB write. The audit row itself is inserted inside the caller's atomic
 * `db.batch([...])` (see `apps/api/src/lib/audit.ts` `auditInsert`), so the §26.1
 * "no state change without an audit row" invariant is preserved by the batch, not
 * by this helper — and is untouched by the vendor swap, because forwarding is
 * post-commit only. Call AFTER the batch commits (typically via `ctx.waitUntil`).
 * A forward failure is logged and swallowed — observability availability never
 * blocks a write.
 */
export async function forwardAuditLog(
  entry: AuditLogEntry,
  forward?: AuditLogForwarder,
): Promise<void> {
  if (!forward) return;
  try {
    await forward(entry);
  } catch (error) {
    console.warn('forwardAuditLog: observability forward failed', error);
  }
}

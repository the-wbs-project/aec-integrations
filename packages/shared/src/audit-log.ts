/**
 * Canonical audit-log writer (Stage 1 Spec §26.1, §26.5).
 *
 * Every state-changing write across the platform records an `audit_log` row.
 * Per §26.1 the write is part of the originating transaction: pass a Prisma
 * transaction client as `db` so the audit row commits or rolls back with the
 * entity. Failure to write the row throws — the caller's transaction unwinds,
 * guaranteeing "no state change happens without a corresponding audit entry".
 *
 * Per §26.5 the helper ALSO forwards the event to Datadog, but Supabase is the
 * source of truth: a forwarding failure is logged and swallowed, never failing
 * the audit write. Forwarding is injected (`forward`) rather than hard-wired so
 * this module stays transport-agnostic and edge-safe — no `fetch`/`Request`
 * coupling. The API Worker wires `forward` to its `logToDatadog()` (which uses
 * `ctx.waitUntil`); CLI scripts wire a plain awaited `fetch`. Both reuse the
 * same DB-write contract here.
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
 * Minimal Prisma surface this helper needs. Accepts the full `PrismaClient`,
 * a `$transaction` client, the accelerated client, or a test fake — all expose
 * `auditLog.create`.
 */
export interface AuditLogClient {
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

/**
 * Forwards an audit event to an external sink (Datadog). Implementations must
 * not throw to the caller — but `appendAuditLog` defends against it anyway.
 * May be sync (fire-and-forget via `ctx.waitUntil`) or async (awaited).
 */
export type AuditLogForwarder = (entry: AuditLogEntry) => void | Promise<void>;

/**
 * Write an audit-log row and (best-effort) forward it.
 *
 * The DB write is awaited and propagates errors — callers pass their
 * transaction client so a failed audit write rolls the operation back. The
 * forward step is wrapped: any rejection is logged via `console.warn` and
 * swallowed so Datadog availability never blocks a state change.
 */
export async function appendAuditLog(
  db: AuditLogClient,
  entry: AuditLogEntry,
  forward?: AuditLogForwarder,
): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: entry.actorId ?? null,
      actorType: entry.actorType,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      // Json? columns: omit when absent (Prisma stores DB NULL). A literal
      // `null` would be rejected — that path needs Prisma.JsonNull.
      beforeState: entry.beforeState ?? undefined,
      afterState: entry.afterState ?? undefined,
      metadata: entry.metadata ?? undefined,
    },
  });

  if (!forward) return;
  try {
    await forward(entry);
  } catch (error) {
    console.warn('appendAuditLog: Datadog forward failed', error);
  }
}

/**
 * ONE batched PostHog forward for a write's audit rows and workflow transitions
 * (§26.5, AECI-666's connection-limit rule). Every API Worker handler that forwards
 * more than one entry per request goes through here (AECI-1112).
 *
 * Handlers used to forward each row with its own `logToPosthog` inside a
 * `Promise.all`: one `fetch` per audit row and per transition. A last-seat revoke, a
 * seat grant that returns contests, or an account erasure that hands a vendor's
 * contests back carries one row per contest, so the count grows with the vendor's
 * data, and a Worker invocation holds only about six open connections. Past that the
 * runtime cancels the stalled responses into `fetch` promises that never settle, and
 * the forwards vanish with no error (CLAUDE.md, "Release every `fetch` body you
 * don't read, and batch fan-out").
 *
 * The events are the same the per-row forwarders sent (`audit {action} {id}` and
 * `workflow {from}→{to} {id}`, tagged with `source`), so dashboards keyed on those
 * fields are unchanged. Callers pass their own `source` (`admin-moderation`,
 * `account`, `request-form`, …). `logBatchToPosthog` self-gates on the project key
 * and warns and swallows a failed request. A throw while building the batch is
 * caught here too, so the forward can never fail a write that already committed.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';

import type { Env } from '../env';
import { logBatchToPosthog, type PosthogLogEvent } from '../posthog';

/** What the forward needs from a Hono context. Structural, so any handler can pass `c`. */
export interface ForwardContext {
  executionCtx: Parameters<typeof logBatchToPosthog>[0];
  env: Env;
  req: { raw: Request };
}

export function forwardAuditBatch(
  c: ForwardContext,
  audits: readonly (AuditLogEntry | null | undefined)[],
  transitions: readonly (WorkflowTransitionEntry | null | undefined)[],
  source = 'admin-moderation',
): void {
  try {
    const events: PosthogLogEvent[] = [
      ...audits
        .filter((entry): entry is AuditLogEntry => entry != null)
        .map((entry) => ({
          level: 'info' as const,
          message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
          source,
          action: entry.action,
          entity_type: entry.entityType ?? undefined,
          entity_id: entry.entityId ?? undefined,
        })),
      ...transitions
        .filter((entry): entry is WorkflowTransitionEntry => entry != null)
        .map((entry) => ({
          level: 'info' as const,
          message: `workflow ${entry.fromState ?? '∅'}→${entry.toState} ${entry.workflowId}`,
          source,
          from_state: entry.fromState ?? undefined,
          to_state: entry.toState,
          workflow_id: entry.workflowId,
        })),
    ];
    if (events.length === 0) return;
    logBatchToPosthog(c.executionCtx, c.env, c.req.raw, events);
  } catch (error) {
    // §26.5: the D1 row is the record, and it has already committed. The forward is
    // a copy, so a failure warns and is swallowed. It never fails the response.
    console.warn('forwardAuditBatch: observability forward failed', error);
  }
}

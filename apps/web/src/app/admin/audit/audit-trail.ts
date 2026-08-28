import { Component, computed, input, output, signal } from '@angular/core';

import type { AdminAuditRow } from '@aeci/shared';

import { RelativeTime } from '../../shared/relative-time/relative-time';
import { AdminPaginator } from '../admin-paginator';
import { describeAuditAction } from './audit-action-labels';

/** One row of a `before_state` to `after_state` diff. */
export interface DiffRow {
  readonly key: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly change: 'added' | 'removed' | 'changed' | 'same';
}

/** A row plus everything the table needs to draw it, derived once per fetch. */
interface AuditRowView {
  readonly row: AdminAuditRow;
  readonly description: string;
  readonly actor: string;
  readonly diff: readonly DiffRow[];
}

/**
 * The `audit_log` viewer, as a table (AECI-694).
 *
 * Extracted from `/admin/vendors/:id`, which is still its only caller and still
 * the platform's only read surface over `audit_log`. It is a component rather
 * than markup in that page because "audit trail" is a shape the console will
 * want again (a user, a product, a request all have trails worth reading), and
 * the next one should be a drop-in rather than a second divergent renderer.
 *
 * ── PRESENTATION ONLY ────────────────────────────────────────────────────────
 * It owns the table, the collapsed diffs and the paginator; it owns no fetching
 * and no scope filter. Scope is vendor-specific (`?scope=all|entity|actor`, four
 * OR'd disjuncts server-side) and stays with the page that knows what a scope
 * means there, so a future user-scoped trail is not forced to inherit a control
 * that would be wrong for it.
 *
 * ── WHY A TABLE AND NOT CARDS ────────────────────────────────────────────────
 * Every field is short and every row has the same fields, which is the case a
 * table is for: an operator scans the When column down the page to find the
 * change they are chasing. The card list made each row a paragraph and put the
 * timestamp third in a run-on line of dot-separated values.
 *
 * ── NO LIVE UPDATES ──────────────────────────────────────────────────────────
 * By design (`ADMIN_PANEL_SPEC.md` §5.7). The trail refreshes when the page
 * acts or reloads, so the relative stamps are as fresh as the fetch that
 * produced them.
 */
@Component({
  selector: 'aec-audit-trail',
  imports: [AdminPaginator, RelativeTime],
  templateUrl: './audit-trail.html',
})
export class AuditTrail {
  readonly rows = input.required<readonly AdminAuditRow[]>();
  readonly page = input.required<number>();
  readonly perPage = input.required<number>();
  readonly total = input.required<number>();
  readonly loading = input.required<boolean>();
  readonly failed = input.required<boolean>();

  /**
   * Whether the GoTrue email lookup ran at all. `false` means every `actor.email`
   * is `null` because the seam was unreachable, NOT because those accounts have
   * no address, so an actor with neither name nor email is "details unavailable"
   * rather than "unnamed". The flag was already on the wire and already stored by
   * the caller; it had simply never been rendered.
   */
  readonly emailsAvailable = input.required<boolean>();

  readonly pageChange = output<number>();
  readonly retry = output<void>();

  /**
   * Ids of the rows whose diff is expanded. Collapsed by default: most rows are
   * scanned, not read, and an always-open diff would bury the chronology the
   * operator came for.
   */
  private readonly openDiffIds = signal<ReadonlySet<string>>(new Set());

  /** Derived once per input change rather than per render. The diff walk is a
   *  key union over two free-form JSON blobs, and the template needs its length,
   *  its rows, and a colspan decision from it. */
  protected readonly views = computed<readonly AuditRowView[]>(() =>
    this.rows().map((row) => ({
      row,
      description: describeAuditAction(row.action),
      actor: this.actorLabel(row),
      diff: diffRows(row),
    })),
  );

  protected readonly isEmpty = computed(() => !this.loading() && this.rows().length === 0);

  protected toggleDiff(id: string): void {
    this.openDiffIds.update((open) => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected isDiffOpen(id: string): boolean {
    return this.openDiffIds().has(id);
  }

  /**
   * Who did it.
   *
   * A `null` actor is not "unknown": it is a `system` or `workflow` row (a cron,
   * the promote Workflow) with no person behind it. Saying "System" is the honest
   * rendering; "Unknown" would suggest a lookup failed. Note that a row CAN
   * legitimately carry `actor_type: 'user'` with a null actor, because GDPR
   * erasure nulls `audit_log.actor_id` for the erased account.
   */
  private actorLabel(row: AdminAuditRow): string {
    if (!row.actor) {
      return row.actor_type === 'workflow'
        ? $localize`:@@admin.audit.actor.workflow:Automated workflow`
        : $localize`:@@admin.audit.actor.system:System`;
    }
    if (row.actor.display_name) return row.actor.display_name;
    if (row.actor.email) return row.actor.email;
    return this.emailsAvailable()
      ? $localize`:@@admin.audit.actor.unnamed:Unnamed account`
      : $localize`:@@admin.audit.actor.unavailable:Account details unavailable`;
  }

  protected changeLabel(change: DiffRow['change']): string {
    switch (change) {
      case 'added':
        return $localize`:@@admin.audit.diff.added:added`;
      case 'removed':
        return $localize`:@@admin.audit.diff.removed:removed`;
      case 'changed':
        return $localize`:@@admin.audit.diff.changed:changed`;
      case 'same':
        return $localize`:@@admin.audit.diff.same:unchanged`;
    }
  }
}

/**
 * The before to after diff for one row.
 *
 * Walks the UNION of both objects' keys so an added or removed field is visible
 * rather than silently dropped. Handles the non-object case deliberately: these
 * snapshots are free-form JSON written by ~34 call sites over the life of the
 * schema, with no shared contract and no retention prune, so today's reader is
 * parsing rows written by code that no longer exists. A scalar or an array
 * renders as a single `value` row instead of throwing.
 */
export function diffRows(row: AdminAuditRow): readonly DiffRow[] {
  const before = row.before_state;
  const after = row.after_state;
  if (before == null && after == null) return [];

  const beforeObj = asRecord(before);
  const afterObj = asRecord(after);
  if (!beforeObj && !afterObj) {
    return [
      {
        key: 'value',
        before: before == null ? null : format(before),
        after: after == null ? null : format(after),
        change: changeOf(before, after),
      },
    ];
  }

  const keys = [...new Set([...Object.keys(beforeObj ?? {}), ...Object.keys(afterObj ?? {})])];
  keys.sort();
  return keys.map((key): DiffRow => {
    const b = beforeObj?.[key];
    const a = afterObj?.[key];
    return {
      key,
      before: b === undefined ? null : format(b),
      after: a === undefined ? null : format(a),
      change: changeOf(b, a),
    };
  });
}

/** `true` only for a plain JSON object: an array is data, not a field bag, and
 *  diffing it key-by-index would produce nonsense rows. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function format(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? String(value);
}

function changeOf(before: unknown, after: unknown): DiffRow['change'] {
  if (before === undefined && after !== undefined) return 'added';
  if (before !== undefined && after === undefined) return 'removed';
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null) ? 'same' : 'changed';
}

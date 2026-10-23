import { formatDate } from '@angular/common';
import {
  Component,
  ElementRef,
  LOCALE_ID,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { AUDIT_PAGE_SIZES, type AdminAuditRow } from '@aeci/shared';

import { RelativeTime } from '../../shared/relative-time/relative-time';
import { SortHeader } from '../../shared/sort-header/sort-header';
import { AdminCursorPaginator } from '../admin-cursor-paginator';
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
  /** `yyyy-MM-dd HH:mm UTC`, or `null` when `absoluteTime` is off. */
  readonly absolute: string | null;
  readonly diff: readonly DiffRow[];
}

/** The id of the result line, the focus target after a page move. */
export const AUDIT_TRAIL_RESULT_ID = 'audit-trail-result';

/**
 * The `audit_log` viewer, as a table (AECI-694).
 *
 * Extracted from `/admin/vendors/:id`. Since then `/admin/connectors/:id`
 * (AECI-722) and `/admin/claims/:id` (AECI-1276) render it too. It is a
 * component rather than markup in one page because "audit trail" is a shape the
 * console keeps wanting, and each new one should be a drop-in rather than a
 * second divergent renderer.
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
 * ── TWO OPTIONAL INPUTS FOR THE GLOBAL LOG (AECI-653) ────────────────────────
 * `/admin/audit` (`ADMIN_PANEL_SPEC.md` §5.18) is the one unscoped consumer, and
 * it needs two things the scoped trails do not. `emptyText` replaces the empty
 * line, because "nothing for this scope" is wrong when the operator chose the
 * filters. `linkEntities` turns the entity cell into a link to that entity's
 * full history in the global log. Both default to the scoped behaviour, so the
 * three detail pages render exactly as before.
 *
 * ── CURSOR PAGING AND THE GLOBAL LOG'S EXTRAS ────────────────────────────────
 * The follow-up to AECI-653 gave the global log keyset paging (ADR 0046) and a
 * few table affordances. Each is an input that defaults off, so the scoped
 * trails keep offset paging through `AdminPaginator` and render as before:
 * `paging="cursor"` swaps in `AdminCursorPaginator` (above and below the table)
 * and the result line; `linkActors` links the Who cell to that actor's entries;
 * `absoluteTime` adds the UTC instant under the relative stamp; `sortable` makes
 * When a sort header that emits `sortOrderChange`.
 *
 * ── THE TABLE STAYS MOUNTED WHILE IT REFETCHES ───────────────────────────────
 * The `email-activity.ts` rule. Replacing the table with a loading line would
 * destroy the control the operator just pressed and drop focus to the body. So
 * the loading line shows only when there are no rows to keep: the first load,
 * or a refetch after an error or an empty page. Otherwise the wrapper is
 * `aria-busy`, dims, and the paging controls disable. This applies to every
 * consumer, the scoped trails included.
 *
 * ── NO LIVE UPDATES ──────────────────────────────────────────────────────────
 * By design (`ADMIN_PANEL_SPEC.md` §5.7). The trail refreshes when the page
 * acts or reloads, so the relative stamps are as fresh as the fetch that
 * produced them.
 */
@Component({
  selector: 'aec-audit-trail',
  imports: [AdminCursorPaginator, AdminPaginator, RelativeTime, RouterLink, SortHeader],
  templateUrl: './audit-trail.html',
})
export class AuditTrail {
  private readonly locale = inject(LOCALE_ID);

  readonly rows = input.required<readonly AdminAuditRow[]>();
  /** 1-based. Read by offset paging only: a cursor page has no number, so the
   *  global log binds 1. Required rather than defaulted, because an optional
   *  `page` beside `pageChange` reads to the linter as a two-way pair. */
  readonly page = input.required<number>();
  readonly perPage = input.required<number>();
  /** Rows matching the filters. `null` only on a cursor page whose caller does
   *  not know the total (it sent `count=0` with nothing remembered). */
  readonly total = input.required<number | null>();
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

  /** The empty-state line. `null` keeps the scoped trails' own sentence
   *  (`@@admin.audit.empty`). The global log passes its filter-aware copy. */
  readonly emptyText = input<string | null>(null);

  /**
   * When true, the entity cell links to `/admin/audit?entity_type=…&entity_id=…`.
   * Off by default: on a scoped trail every row's entity is usually the page
   * the operator is already on, so a link there would be noise. The href is an
   * absolute path, because a relative one resolves against `<base href>`.
   */
  readonly linkEntities = input(false);

  /** `offset` (the scoped trails) or `cursor` (the global log, ADR 0046). */
  readonly paging = input<'offset' | 'cursor'>('offset');
  /** The order the rows arrive in, for the caption, the result line and the
   *  sort header. The scoped trails are always newest first. */
  readonly order = input<'asc' | 'desc'>('desc');
  /** Cursor paging only: whether the caller can move either way. */
  readonly hasPrev = input(false);
  readonly hasNext = input(false);
  /** Cursor paging only: show "First page". */
  readonly canFirst = input(false);
  /** Cursor paging only: the sizes the rows-per-page select offers. */
  readonly pageSizes = input<readonly number[]>(AUDIT_PAGE_SIZES);

  /** When true, the Who cell links to `/admin/audit?actor_id=…`. A null actor
   *  (system, workflow, or erased) stays plain text: there is nothing to filter. */
  readonly linkActors = input(false);
  /** When true, the exact UTC minute renders under the relative stamp. */
  readonly absoluteTime = input(false);
  /** When true, the When header is a sort control that emits `sortOrderChange`. */
  readonly sortable = input(false);

  readonly pageChange = output<number>();
  readonly retry = output<void>();
  readonly prev = output<void>();
  readonly next = output<void>();
  readonly first = output<void>();
  readonly pageSizeChange = output<number>();
  readonly sortOrderChange = output<'asc' | 'desc'>();

  protected readonly resultId = AUDIT_TRAIL_RESULT_ID;
  private readonly resultLine = viewChild<ElementRef<HTMLElement>>('resultLine');

  protected readonly topPagerLabel = $localize`:@@admin.audit.pager.top:Pagination, above the table`;
  protected readonly bottomPagerLabel = $localize`:@@admin.audit.pager.bottom:Pagination, below the table`;
  protected readonly whenLabel = $localize`:@@admin.audit.col.when:When`;

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
      absolute: this.absoluteTime() ? this.absoluteLabel(row.created_at) : null,
      diff: diffRows(row),
    })),
  );

  /** The loading line replaces the table only when there are no rows to keep
   *  mounted (see the class doc). */
  protected readonly showLoadingLine = computed(() => this.loading() && this.rows().length === 0);
  protected readonly isEmpty = computed(() => !this.loading() && this.rows().length === 0);
  protected readonly isCursor = computed(() => this.paging() === 'cursor');
  protected readonly sortDirection = computed<'ascending' | 'descending'>(() =>
    this.order() === 'asc' ? 'ascending' : 'descending',
  );

  /** Move focus to the result line. The page calls this after a page move, so
   *  a keyboard user lands at the top of the new rows rather than on a button
   *  that may have just disabled. A no-op when the line is not rendered. */
  focusResultLine(): void {
    this.resultLine()?.nativeElement.focus();
  }

  protected onSort(change: { order: 'asc' | 'desc' }): void {
    if (change.order !== this.order()) this.sortOrderChange.emit(change.order);
  }

  private absoluteLabel(createdAt: string): string {
    const stamp = formatDate(createdAt, 'yyyy-MM-dd HH:mm', this.locale, 'UTC');
    return $localize`:@@admin.audit.absoluteTime:${stamp}:STAMP: UTC`;
  }

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

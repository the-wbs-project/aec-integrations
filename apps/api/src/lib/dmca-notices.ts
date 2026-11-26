/**
 * The copyright notice log's pure rules (AECI-1665, counsel Q38). Source of truth:
 * `docs/ADMIN_PANEL_SPEC.md` §5.23, `docs/DATABASE_SCHEMA.md` §8.14.
 *
 *   - {@link restoreClock}: where a counter-notice's restore window stands. 17 U.S.C.
 *     512(g)(2)(C) lets us restore the material no sooner than 10 and no later than 14
 *     business days after we receive the counter-notice, unless the complainant tells us
 *     a court action was filed. The Terms "Copyright complaints" promise the same window.
 *   - {@link readRestoresDue}: the open counter-notices that need the operator now
 *     (AECI-1944). The `dmca_restore_due` data-quality check and the Overview status
 *     strip both read it, so the two signals cannot disagree.
 *   - {@link takedownCountWhere} and {@link counterNoticeCountWhere}: the per-account counts.
 *     `GET /api/admin/dmca-notices?account_id=` and `GET /api/admin/users/:id` both read
 *     these two predicates, so the two surfaces cannot disagree.
 */

import {
  DMCA_RESTORE_EARLIEST_BUSINESS_DAYS,
  DMCA_RESTORE_LATEST_BUSINESS_DAYS,
  DMCA_TAKEDOWN_ACTIONS,
  type DmcaNotice,
  type DmcaRestoreClock,
  type DmcaRestoreClockState,
} from '@aeci/shared';
import { and, asc, count, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { dmcaNotices } from '../db/schema';
import { addBusinessDays, businessWindowEnd } from './business-days';

export type DmcaNoticeRow = typeof dmcaNotices.$inferSelect;

/** `audit_log.entity_type` of every log write. */
export const DMCA_NOTICE_ENTITY_TYPE = 'dmca_notice';
/** `audit_log.action` of a new row. */
export const DMCA_NOTICE_CREATED_ACTION = 'dmca_notice.created';
/** `audit_log.action` of an edit. */
export const DMCA_NOTICE_UPDATED_ACTION = 'dmca_notice.updated';

const HOUR_MS = 3_600_000;

/**
 * A counter-notice's restore clock, or null for a notice.
 *
 * `earliest` is the start of business day 10 after `received_at`, as 05:00 UTC of that New
 * York date. That is midnight EST and 1 am EDT, so it is never early. `latest` is
 * `businessWindowEnd(received_at, 14)`, the first moment safely past business day 14.
 * Business days skip weekends and observed US federal holidays (`business-days.ts`).
 */
export function restoreClock(
  row: Pick<
    DmcaNoticeRow,
    'kind' | 'receivedAt' | 'forwardedAt' | 'courtActionAt' | 'restoreOutcome'
  >,
  now: Date,
): DmcaRestoreClock | null {
  if (row.kind !== 'counter_notice') return null;
  const received = new Date(row.receivedAt);
  if (Number.isNaN(received.getTime())) return null;
  const opensOn = addBusinessDays(received, DMCA_RESTORE_EARLIEST_BUSINESS_DAYS);
  const dueOn = addBusinessDays(received, DMCA_RESTORE_LATEST_BUSINESS_DAYS);
  const earliest = new Date(opensOn.getTime() + 5 * HOUR_MS).toISOString();
  const latest = businessWindowEnd(row.receivedAt, DMCA_RESTORE_LATEST_BUSINESS_DAYS);
  return {
    earliest,
    latest,
    opens_on: opensOn.toISOString().slice(0, 10),
    due_on: dueOn.toISOString().slice(0, 10),
    state: clockState(row, now, earliest, latest),
  };
}

function clockState(
  row: Pick<DmcaNoticeRow, 'forwardedAt' | 'courtActionAt' | 'restoreOutcome'>,
  now: Date,
  earliest: string,
  latest: string,
): DmcaRestoreClockState {
  if (row.restoreOutcome === 'restored') return 'restored';
  if (row.restoreOutcome === 'not_restored') return 'not_restored';
  if (row.courtActionAt) return 'court_action';
  if (!row.forwardedAt) return 'awaiting_forward';
  const t = now.getTime();
  if (t < Date.parse(earliest)) return 'waiting';
  if (t < Date.parse(latest)) return 'restore_window_open';
  return 'overdue';
}

/** Lower is more urgent. A notice, and a counter-notice with an outcome, rank last. */
const URGENCY: Record<DmcaRestoreClockState, number> = {
  overdue: 0,
  restore_window_open: 1,
  awaiting_forward: 2,
  waiting: 3,
  court_action: 4,
  restored: 4,
  not_restored: 4,
};

/**
 * The list order: most urgent restore clock first, then `received_at` newest first, then
 * `id`. Timestamps and ids compare as plain strings (BINARY), never by locale.
 */
export function compareDmcaNotices(a: DmcaNotice, b: DmcaNotice): number {
  const ua = a.restore_clock ? URGENCY[a.restore_clock.state] : 4;
  const ub = b.restore_clock ? URGENCY[b.restore_clock.state] : 4;
  if (ua !== ub) return ua - ub;
  if (a.received_at !== b.received_at) return a.received_at < b.received_at ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * The clock states that need the operator now (AECI-1944). `overdue`: business day 14 has
 * ended with no outcome. `restore_window_open`: the restore is due by day 14. And
 * `awaiting_forward`: the counter-notice was never sent on to the complainant. That state
 * wins over the dates in {@link restoreClock}, so an unforwarded counter-notice never turns
 * `overdue` by itself. It is listed at any age because the Terms promise to forward it
 * promptly. `waiting`, `court_action` and the outcomes need nothing.
 */
export const DMCA_RESTORE_DUE_STATES = [
  'overdue',
  'restore_window_open',
  'awaiting_forward',
] as const satisfies readonly DmcaRestoreClockState[];
export type DmcaRestoreDueState = (typeof DMCA_RESTORE_DUE_STATES)[number];

/** One open counter-notice that needs the operator, with its clock. */
export interface DmcaRestoreDue {
  id: string;
  noticeId: string | null;
  receivedAt: string;
  /** Set when someone closed the row with no outcome. A mistake: step 9 of the runbook
   *  closes a counter-notice only once its outcome is recorded. Kept on the list, never
   *  filtered out, so a stray "Closed on" date cannot silence a running deadline. */
  closedAt: string | null;
  /** True once business day 14 has ended (`now >= clock.latest`), whatever the state. An
   *  unforwarded counter-notice keeps the `awaiting_forward` state past its deadline, so
   *  the state alone cannot say a restore is late. */
  pastDeadline: boolean;
  clock: DmcaRestoreClock & { state: DmcaRestoreDueState };
}

function isDueState(state: DmcaRestoreClockState): state is DmcaRestoreDueState {
  return (DMCA_RESTORE_DUE_STATES as readonly string[]).includes(state);
}

/**
 * The open counter-notices in a {@link DMCA_RESTORE_DUE_STATES} state, most urgent first,
 * then oldest `received_at`, then `id`. SQL narrows to counter-notices with no outcome and
 * no court action. `closed_at` is deliberately not a filter: a closed row with no outcome is
 * a mistake, and the deadline still runs. {@link restoreClock} decides the rest, so the holiday math stays in one
 * place. The log holds a handful of rows, so reading them all is cheap.
 */
export async function readRestoresDue(db: Db, now: Date): Promise<DmcaRestoreDue[]> {
  const rows = await db
    .select({
      id: dmcaNotices.id,
      noticeId: dmcaNotices.noticeId,
      kind: dmcaNotices.kind,
      receivedAt: dmcaNotices.receivedAt,
      forwardedAt: dmcaNotices.forwardedAt,
      courtActionAt: dmcaNotices.courtActionAt,
      restoreOutcome: dmcaNotices.restoreOutcome,
      closedAt: dmcaNotices.closedAt,
    })
    .from(dmcaNotices)
    .where(
      and(
        eq(dmcaNotices.kind, 'counter_notice'),
        isNull(dmcaNotices.restoreOutcome),
        isNull(dmcaNotices.courtActionAt),
      ),
    )
    .orderBy(asc(dmcaNotices.receivedAt), asc(dmcaNotices.id));
  const due: DmcaRestoreDue[] = [];
  for (const row of rows) {
    const clock = restoreClock(row, now);
    if (!clock || !isDueState(clock.state)) continue;
    due.push({
      id: row.id,
      noticeId: row.noticeId,
      receivedAt: row.receivedAt,
      closedAt: row.closedAt,
      pastDeadline: now.getTime() >= Date.parse(clock.latest),
      clock: { ...clock, state: clock.state },
    });
  }
  // Past the deadline ranks first in any state, so an unforwarded counter-notice past day
  // 14 sits with the overdue rows. A stable sort keeps the oldest-first SQL order within.
  const rank = (d: DmcaRestoreDue) => (d.pastDeadline ? 0 : URGENCY[d.clock.state]);
  return due.sort((a, b) => rank(a) - rank(b));
}

/**
 * The three counts the Overview status strip shows. Each row counts once. `overdue` is
 * every row past business day 14, forwarded or not, so an unforwarded counter-notice past
 * its deadline reads as overdue rather than only "not yet forwarded".
 */
export function countRestoresDue(due: readonly DmcaRestoreDue[]): {
  overdue: number;
  window_open: number;
  awaiting_forward: number;
} {
  return {
    overdue: due.filter((d) => d.pastDeadline).length,
    window_open: due.filter((d) => !d.pastDeadline && d.clock.state === 'restore_window_open')
      .length,
    awaiting_forward: due.filter((d) => !d.pastDeadline && d.clock.state === 'awaiting_forward')
      .length,
  };
}

/**
 * The takedown count's WHERE (ruling 2A of 2026-11-17). A row counts when it is a notice
 * against the account whose material we removed or disabled, and no counter-notice to it
 * ended `restored`. An incomplete notice (`no_action`), an open one (`pending`) and a
 * takedown we later restored do not count. A takedown whose counter-notice ended
 * `not_restored` does.
 *
 * The subquery aliases its table as `c`, so the bare `dmca_notices` name inside it binds to
 * the outer row.
 */
export function takedownCountWhere(accountId: string): SQL {
  return and(
    eq(dmcaNotices.accountId, accountId),
    eq(dmcaNotices.kind, 'notice'),
    inArray(dmcaNotices.action, [...DMCA_TAKEDOWN_ACTIONS]),
    sql`NOT EXISTS (SELECT 1 FROM ${sql.raw('"dmca_notices"')} AS c
      WHERE c.notice_id = ${dmcaNotices.id}
        AND c.kind = 'counter_notice'
        AND c.restore_outcome = 'restored')`,
  )!;
}

/** The counter-notice count's WHERE: counter-notices the account filed. */
export function counterNoticeCountWhere(accountId: string): SQL {
  return and(eq(dmcaNotices.accountId, accountId), eq(dmcaNotices.kind, 'counter_notice'))!;
}

/**
 * The two per-account counts as batch statements, `[takedowns, counter-notices]`, each a
 * one-row `{ value }`. The list endpoint and the user detail both put these in their batch.
 */
export function accountCountStatements(db: Db, accountId: string) {
  return [
    db.select({ value: count() }).from(dmcaNotices).where(takedownCountWhere(accountId)),
    db.select({ value: count() }).from(dmcaNotices).where(counterNoticeCountWhere(accountId)),
  ] as const;
}

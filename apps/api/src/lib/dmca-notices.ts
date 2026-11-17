/**
 * The copyright notice log's pure rules (AECI-1665, counsel Q38). Source of truth:
 * `docs/ADMIN_PANEL_SPEC.md` §5.23, `docs/DATABASE_SCHEMA.md` §8.14.
 *
 *   - {@link restoreClock}: where a counter-notice's restore window stands. 17 U.S.C.
 *     512(g)(2)(C) lets us restore the material no sooner than 10 and no later than 14
 *     business days after we receive the counter-notice, unless the complainant tells us
 *     a court action was filed. The Terms "Copyright complaints" promise the same window.
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
import { and, count, eq, inArray, sql, type SQL } from 'drizzle-orm';

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

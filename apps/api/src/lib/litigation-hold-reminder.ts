/**
 * The reminder for a litigation hold left open too long (AECI-1638, ADR 0058,
 * `ADMIN_PANEL_SPEC.md` §5.22b).
 *
 * A hold stops the legal retention prune, so a hold nobody remembers keeps personal data
 * past the period the Privacy Policy promises. Nothing else prompts anyone to release one.
 * The daily legal retention job (`scheduled.ts`) calls {@link runLitigationHoldReminders}
 * before it prunes. It finds every open hold placed more than
 * {@link LITIGATION_HOLD_REMINDER_AFTER_DAYS} days ago and sends the operator the
 * `litigation-hold-reminder` email for it.
 *
 * **At most one reminder per hold every {@link LITIGATION_HOLD_REMINDER_EVERY_DAYS} days.**
 * The send ledger (`notification_sends`, AECI-1202) is the memory: a hold whose last
 * `sent` or `unknown` send of this template is younger than that is skipped. An `unknown`
 * send may have gone out, so it counts. A `failed`, `skipped` or `suppressed` one did not,
 * so the next run tries again. The dedupe key holds one day, so a queue retry of the same
 * run is a `duplicate`, never a second mail.
 *
 * Never throws: a failed read or send is counted and the prune still runs.
 */

import {
  LITIGATION_HOLD_REMINDER_AFTER_DAYS,
  LITIGATION_HOLD_REMINDER_EVERY_DAYS,
  type LitigationHoldScope,
} from '@aeci/shared';
import { and, asc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';

import type { Db } from '../db/client';
import { litigationHolds, notificationSends, vendors } from '../db/schema';
import { sendLitigationHoldReminder, type EmailContext, type EmailOutcome } from './email';

export const LITIGATION_HOLD_REMINDER_TEMPLATE = 'litigation-hold-reminder';

const DAY_MS = 86_400_000;

/** One open hold that is due a reminder. */
export interface DueHoldReminder {
  id: string;
  scope: LitigationHoldScope;
  vendorId: string | null;
  vendorName: string | null;
  reason: string;
  matterReference: string | null;
  placedAt: string;
  /** Whole days since `placed_at`. */
  ageDays: number;
}

/** The send-ledger key: one per hold per UTC day. */
export function litigationHoldReminderKey(holdId: string, now: Date): string {
  return `${LITIGATION_HOLD_REMINDER_TEMPLATE}:${holdId}:${now.toISOString().slice(0, 10)}`;
}

/**
 * Every open hold placed more than {@link LITIGATION_HOLD_REMINDER_AFTER_DAYS} days before
 * `now` with no `sent` or `unknown` reminder in the last
 * {@link LITIGATION_HOLD_REMINDER_EVERY_DAYS} days, oldest first.
 */
export async function findDueHoldReminders(db: Db, now: Date): Promise<DueHoldReminder[]> {
  const placedBefore = new Date(
    now.getTime() - LITIGATION_HOLD_REMINDER_AFTER_DAYS * DAY_MS,
  ).toISOString();
  const open = await db
    .select({
      id: litigationHolds.id,
      scope: litigationHolds.scope,
      vendorId: litigationHolds.vendorId,
      vendorName: vendors.companyName,
      reason: litigationHolds.reason,
      matterReference: litigationHolds.matterReference,
      placedAt: litigationHolds.placedAt,
    })
    .from(litigationHolds)
    .leftJoin(vendors, eq(vendors.id, litigationHolds.vendorId))
    .where(and(isNull(litigationHolds.releasedAt), lt(litigationHolds.placedAt, placedBefore)))
    .orderBy(asc(litigationHolds.placedAt), asc(litigationHolds.id));
  if (open.length === 0) return [];

  // Open holds number a handful at most, well under D1's bound-parameter cap.
  const sentSince = new Date(
    now.getTime() - LITIGATION_HOLD_REMINDER_EVERY_DAYS * DAY_MS,
  ).toISOString();
  const recent = await db
    .select({ entityId: notificationSends.entityId })
    .from(notificationSends)
    .where(
      and(
        eq(notificationSends.notificationId, LITIGATION_HOLD_REMINDER_TEMPLATE),
        eq(notificationSends.entityType, 'litigation_hold'),
        inArray(
          notificationSends.entityId,
          open.map((h) => h.id),
        ),
        inArray(notificationSends.outcome, ['sent', 'unknown']),
        gt(notificationSends.createdAt, sentSince),
      ),
    );
  const remindedRecently = new Set(recent.map((r) => r.entityId));

  return open
    .filter((h) => !remindedRecently.has(h.id))
    .map((h) => ({
      ...h,
      scope: h.scope as LitigationHoldScope,
      ageDays: Math.floor((now.getTime() - Date.parse(h.placedAt)) / DAY_MS),
    }));
}

export type SendHoldReminder = typeof sendLitigationHoldReminder;

export interface HoldReminderReport {
  /** Holds due a reminder this run. */
  due: number;
  /** How each send went. */
  outcomes: Partial<Record<EmailOutcome, number>>;
  /** Set when the read failed, so nothing was sent. */
  error?: string;
}

/** Find the due holds and send one reminder each. Never throws. */
export async function runLitigationHoldReminders(
  c: EmailContext,
  db: Db,
  now: Date,
  deps: { send?: SendHoldReminder } = {},
): Promise<HoldReminderReport> {
  const send = deps.send ?? sendLitigationHoldReminder;
  let due: DueHoldReminder[];
  try {
    due = await findDueHoldReminders(db, now);
  } catch (error) {
    return {
      due: 0,
      outcomes: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const outcomes: Partial<Record<EmailOutcome, number>> = {};
  for (const hold of due) {
    let outcome: EmailOutcome;
    try {
      outcome = await send(c, {
        to: c.env.SUPPORT_EMAIL,
        holdId: hold.id,
        scope: hold.scope,
        vendorId: hold.vendorId,
        vendorName: hold.vendorName,
        reason: hold.reason,
        matterReference: hold.matterReference,
        placedAt: hold.placedAt,
        ageDays: hold.ageDays,
        dedupeKey: litigationHoldReminderKey(hold.id, now),
      });
    } catch {
      outcome = 'failed';
    }
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  return { due: due.length, outcomes };
}

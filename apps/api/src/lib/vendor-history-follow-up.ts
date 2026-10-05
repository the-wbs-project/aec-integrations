/**
 * The search follow-up of a page of vendor history rows (AECI-1160,
 * `API_CONTRACTS.md` §6.14 "Change history: search follow-up",
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.19).
 *
 * For each of the page's audit ids, where each URL that change queued now stands
 * on each channel: queued, submitted, failed or requested. Two sources, both
 * keyed by the causing audit id AECI-1184 records:
 *
 * - `recrawl_submission_causes` joined to `recrawl_submissions`: every attempt
 *   the IndexNow drain made and every Google request an operator recorded. These
 *   rows are permanent, so the state stays truthful after the queues drain.
 * - `recrawl_queue_causes`: the URLs still waiting, on either queue. Transient:
 *   the drain and the worklist clear delete them once the URL leaves its queue.
 *
 * ── SCOPING ─────────────────────────────────────────────────────────────────
 * Both reads filter on the cause's `vendor_id = <session vendor>`, the same
 * predicate `GET /api/vendor/recrawl-submissions` uses (AECI-1187). An audit id
 * that is not the caller's own edit matches nothing, so the ids in the query
 * need no separate check. Promote and AECi admin causes carry no vendor and never
 * reach a vendor.
 *
 * ── COST ────────────────────────────────────────────────────────────────────
 * One `db.batch`, two statements per chunk of {@link FOLLOW_UP_IDS_PER_STATEMENT}
 * ids. A history page is 25 rows, so one chunk. The submission read rides the
 * `(vendor_id, submission_id)` index and filters this vendor's cause rows on
 * `audit_log_id`. The queue read scans `recrawl_queue_causes`, which holds at most
 * the URLs waiting for the next drain or worklist clear. Neither table has an
 * `audit_log_id` index. Add one if a vendor's cause rows ever grow large enough
 * to matter (`DATABASE_SCHEMA.md` §9.6b).
 *
 * ── ONE STATE PER URL AND CHANNEL ───────────────────────────────────────────
 * A URL refused three times and then accepted has four submission rows. The
 * reader sees one line, "submitted", not four claims. See {@link reduceFollowUp}.
 */

import type {
  VendorHistoryFollowUp,
  VendorSearchChannel,
  VendorSearchFollowUpState,
} from '@aeci/shared';
import { and, eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import { recrawlQueueCauses, recrawlSubmissionCauses, recrawlSubmissions } from '../db/schema';

import type { BatchTuple } from './audit';

/**
 * Ids bound per statement. Each statement also binds the vendor id, so 90 ids
 * keep it at 91 parameters, under D1's cap of 100.
 */
export const FOLLOW_UP_IDS_PER_STATEMENT = 90;

/** One submission attempt a cause of this vendor's points at. */
export interface FollowUpSubmissionRow {
  auditLogId: string | null;
  url: string;
  channel: string; // 'indexnow' | 'gsc_manual'
  outcome: string; // 'accepted' | 'refused' | 'failed' | 'requested'
  httpStatus: number | null;
  submittedAt: string;
  submissionId: number;
}

/** One cause still waiting on a queue. */
export interface FollowUpQueuedRow {
  auditLogId: string | null;
  url: string;
  channel: string; // 'indexnow' | 'gsc'
  queuedAt: string;
}

/** The vendor-facing channel for a stored channel name, or `null` for one we do not know. */
function vendorChannel(stored: string): VendorSearchChannel | null {
  if (stored === 'indexnow') return 'indexnow';
  if (stored === 'gsc' || stored === 'gsc_manual') return 'google';
  return null;
}

const CHANNEL_ORDER: Record<VendorSearchChannel, number> = { indexnow: 0, google: 1 };

/** Binary order: audit ids and URLs are identifiers, not names (`API_CONTRACTS.md` §3.2). */
function binary(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Fold the raw rows into one state per (audit id, URL, channel).
 *
 * IndexNow: an accepted attempt wins ("submitted", at its time). Otherwise the
 * latest refused or failed attempt is "failed", with `retrying` when a cause is
 * still queued. With no attempt yet, a queued cause is "queued".
 *
 * Google: a recorded operator request is "requested". Otherwise a queued cause
 * is "queued". A worklist row cleared as "not requested" leaves neither, so it
 * shows nothing rather than a request nobody made.
 */
export function reduceFollowUp(
  submissions: readonly FollowUpSubmissionRow[],
  queued: readonly FollowUpQueuedRow[],
): VendorHistoryFollowUp[] {
  interface Acc {
    auditLogId: string;
    url: string;
    channel: VendorSearchChannel;
    accepted: FollowUpSubmissionRow | null;
    lastFailed: FollowUpSubmissionRow | null;
    requested: FollowUpSubmissionRow | null;
    queuedAt: string | null;
  }
  const byKey = new Map<string, Acc>();
  const accFor = (auditLogId: string, url: string, channel: VendorSearchChannel): Acc => {
    const key = `${auditLogId}\u0000${url}\u0000${channel}`;
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        auditLogId,
        url,
        channel,
        accepted: null,
        lastFailed: null,
        requested: null,
        queuedAt: null,
      };
      byKey.set(key, acc);
    }
    return acc;
  };
  // Later attempt first: by time, then by submission id within one run.
  const later = (a: FollowUpSubmissionRow, b: FollowUpSubmissionRow | null): boolean =>
    !b ||
    a.submittedAt > b.submittedAt ||
    (a.submittedAt === b.submittedAt && a.submissionId > b.submissionId);

  for (const row of submissions) {
    const channel = vendorChannel(row.channel);
    if (!row.auditLogId || !channel) continue;
    const acc = accFor(row.auditLogId, row.url, channel);
    if (row.outcome === 'accepted') {
      if (later(row, acc.accepted)) acc.accepted = row;
    } else if (row.outcome === 'refused' || row.outcome === 'failed') {
      if (later(row, acc.lastFailed)) acc.lastFailed = row;
    } else if (row.outcome === 'requested') {
      if (later(row, acc.requested)) acc.requested = row;
    }
  }
  for (const row of queued) {
    const channel = vendorChannel(row.channel);
    if (!row.auditLogId || !channel) continue;
    const acc = accFor(row.auditLogId, row.url, channel);
    if (!acc.queuedAt || row.queuedAt < acc.queuedAt) acc.queuedAt = row.queuedAt;
  }

  const out: VendorHistoryFollowUp[] = [];
  for (const acc of byKey.values()) {
    const base = { audit_log_id: acc.auditLogId, url: acc.url, channel: acc.channel };
    const emit = (
      state: VendorSearchFollowUpState,
      at: string,
      httpStatus: number | null,
      retrying = false,
    ) => out.push({ ...base, state, at, http_status: httpStatus, retrying });

    if (acc.channel === 'google') {
      if (acc.requested) emit('requested', acc.requested.submittedAt, null);
      else if (acc.queuedAt) emit('queued', acc.queuedAt, null);
      continue;
    }
    if (acc.accepted) emit('submitted', acc.accepted.submittedAt, acc.accepted.httpStatus);
    else if (acc.lastFailed) {
      emit('failed', acc.lastFailed.submittedAt, acc.lastFailed.httpStatus, acc.queuedAt !== null);
    } else if (acc.queuedAt) emit('queued', acc.queuedAt, null);
  }

  return out.sort(
    (a, b) =>
      binary(a.audit_log_id, b.audit_log_id) ||
      binary(a.url, b.url) ||
      CHANNEL_ORDER[a.channel] - CHANNEL_ORDER[b.channel],
  );
}

/** Split ids into statement-sized chunks. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Read and fold the follow-up for `auditIds`, scoped to `vendorId`'s own causes.
 * An empty id list reads nothing.
 */
export async function loadVendorHistoryFollowUp(
  db: Db,
  vendorId: string,
  auditIds: readonly string[],
): Promise<VendorHistoryFollowUp[]> {
  if (auditIds.length === 0) return [];
  const statements = chunks(auditIds, FOLLOW_UP_IDS_PER_STATEMENT).flatMap((ids) => [
    db
      .select({
        auditLogId: recrawlSubmissionCauses.auditLogId,
        url: recrawlSubmissions.url,
        channel: recrawlSubmissions.channel,
        outcome: recrawlSubmissions.outcome,
        httpStatus: recrawlSubmissions.httpStatus,
        submittedAt: recrawlSubmissions.submittedAt,
        submissionId: recrawlSubmissions.id,
      })
      .from(recrawlSubmissionCauses)
      .innerJoin(
        recrawlSubmissions,
        eq(recrawlSubmissions.id, recrawlSubmissionCauses.submissionId),
      )
      .where(
        and(
          eq(recrawlSubmissionCauses.vendorId, vendorId),
          inArray(recrawlSubmissionCauses.auditLogId, ids),
        ),
      ),
    db
      .select({
        auditLogId: recrawlQueueCauses.auditLogId,
        url: recrawlQueueCauses.url,
        channel: recrawlQueueCauses.channel,
        queuedAt: recrawlQueueCauses.queuedAt,
      })
      .from(recrawlQueueCauses)
      .where(
        and(eq(recrawlQueueCauses.vendorId, vendorId), inArray(recrawlQueueCauses.auditLogId, ids)),
      ),
  ]);
  // Every statement is a SELECT, so each result is its row array.
  const results = (await db.batch(statements as unknown as BatchTuple)) as unknown[];
  const submissions: FollowUpSubmissionRow[] = [];
  const queued: FollowUpQueuedRow[] = [];
  results.forEach((rows, i) => {
    if (i % 2 === 0) submissions.push(...(rows as FollowUpSubmissionRow[]));
    else queued.push(...(rows as FollowUpQueuedRow[]));
  });
  return reduceFollowUp(submissions, queued);
}

/**
 * The notice on the day the first in-force versions of the legal documents take effect
 * (AECI-1870, `legal-first-effective`, counsel Q60, rulings 28 and 68, `STAGE_1_SPEC.md`
 * §27.4). Before it, the publish flow emailed 30 days ahead and nothing went at the moment.
 *
 * ── WHEN ───────────────────────────────────────────────────────────────────────
 * The daily `legal_first_effective_notice` job runs from the 12:00 UTC tick, the moment a
 * version takes effect (`PROTEST_REMINDER_CRON`, no trigger of its own). It reads every
 * `legal_versions` row and asks `legalFirstInForceMoments` (`@aeci/shared`) which moments
 * in the last 7 days saw a document's FIRST in-force version take effect. A later version
 * never counts, a draft never counts, and a moment that has not come is not listed. A
 * moment more than 7 days old is never sent, so a late deploy cannot send a stale notice:
 * the run counts it as `stale` and logs it.
 *
 * ── ONE EMAIL PER ACCOUNT PER MOMENT ───────────────────────────────────────────
 * Every document whose first version took effect at one moment goes in one email. The
 * audience is every unbanned `profiles` row of the tier, vendor seats included
 * (`legalNoticeAccountIds`), so a person is one entry however many roles they hold. A
 * billing email that belongs to no account is not sent it (ruling 68). The job queues one
 * {@link LegalFirstEffectiveMessage} per {@link READER_NOTICE_CHUNK} accounts on
 * `aeci-legal-notice-{env}` with `sendBatch()`, then stamps
 * `legal_versions.first_effective_notice_enqueued_at` on every row of the moment, each with
 * its `legal_version.first_effective_notice_enqueued` audit row in the same `db.batch`. A
 * second run sees the marker and queues nothing. A fan-out that did not finish stamps
 * nothing, so the next day's run queues it again, and the ledger key stops a second email.
 *
 * ── THE CONSUMER ───────────────────────────────────────────────────────────────
 * `queue()` in `scheduled.ts` routes a `first-effective` message here before the change
 * notice path. It refuses a message before the moment (retried, nothing sent), and a
 * message with no site URL (retried). It re-reads each account, skips one banned or
 * deleted since the fan-out, and looks the addresses up through the same Auth seam as the
 * account change notice. An unavailable lookup retries the whole message. Each account is
 * keyed {@link legalFirstEffectiveDedupeKey}: `legal-first-effective:{YYYY-MM-DD}:{profileId}`.
 * A failed send releases its key and retries the message, and the accounts already sent
 * read `duplicate`. An owner seat (`profiles.seat_owner` on a vendor) gets the Vendor Terms
 * acceptance line when the Vendor Terms are in the list.
 *
 * No delivery table: the send ledger (`notification_sends`) and the run's `job_runs` detail
 * are the record (`docs/runbooks/legal.md`).
 */

import {
  LEGAL_IN_FORCE_MAPS,
  legalFirstInForceMoments,
  type LegalInForceMaps,
  type LegalPublishableDocument,
} from '@aeci/shared';
import { LegalPublishableDocumentSchema } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, type Db } from '../db/client';
import { legalVersions, profiles } from '../db/schema';
import type { Env } from '../env';
import { logToPosthog, submitCount } from '../posthog';
import { auditInsertWhere, landedAuditEntries, type BatchStmt, type BatchTuple } from './audit';
import {
  sendLegalFirstEffectiveEmail,
  type EmailContext,
  type EmailOutcome,
  type LegalFirstEffectiveSubject,
} from './email';
import type { DbFactory } from './handler-utils';
import {
  LEGAL_NOTICE_ENTITY_TYPE,
  LEGAL_NOTICE_MAX_RETRIES,
  LEGAL_NOTICE_SEND_BATCH,
  READER_NOTICE_CHUNK,
  legalNoticeAccountIds,
  legalNoticeRetryDelaySeconds,
  type FetchSeatEmailsResult,
} from './legal-notice';
import { forwardAuditBatch } from './moderation-forward';
import { fetchAuthUserEmailsResult } from './supabase-admin';

const DAY_MS = 86_400_000;

/** The registry id, and `notification_sends.notification_id`, of the day-of notice. */
export const LEGAL_FIRST_EFFECTIVE_NOTIFICATION_ID = 'legal-first-effective';

/** How long after a moment the job may still send its notice. Older is `stale`. */
export const LEGAL_FIRST_EFFECTIVE_WINDOW_MS = 7 * DAY_MS;

/** `audit_log.action` of the marker write (system actor). */
export const LEGAL_FIRST_EFFECTIVE_ENQUEUED_ACTION =
  'legal_version.first_effective_notice_enqueued';

/** The audit `source` and the log `source` of the job. */
const SOURCE = 'legal-first-effective-notice';

/** One moment's notice for up to 25 accounts. */
export const LegalFirstEffectiveMessageSchema = z.object({
  kind: z.literal('first-effective'),
  /** Epoch ms of the moment: 12:00 UTC of the effective day. */
  effectiveAt: z.number().int(),
  /** Every `legal_versions` row of the moment, one per document. */
  legalVersionIds: z
    .array(z.string().min(1))
    .min(1)
    .max(LegalPublishableDocumentSchema.options.length),
  profileIds: z.array(z.string().min(1)).min(1).max(READER_NOTICE_CHUNK),
  enqueuedAt: z.string(),
});
export type LegalFirstEffectiveMessage = z.infer<typeof LegalFirstEffectiveMessageSchema>;

/** Whether a legal-notice queue message is a day-of one. `queue()` routes on it. */
export function isLegalFirstEffectiveMessage(body: unknown): boolean {
  return (body as { kind?: unknown } | null)?.kind === 'first-effective';
}

/** `YYYY-MM-DD` of a moment. */
export function legalEffectiveDayOf(effectiveAtMs: number): string {
  return new Date(effectiveAtMs).toISOString().slice(0, 10);
}

/** The dedupe key of one account's day-of notice for one moment. */
export function legalFirstEffectiveDedupeKey(effectiveDay: string, profileId: string): string {
  return `${LEGAL_FIRST_EFFECTIVE_NOTIFICATION_ID}:${effectiveDay}:${profileId}`;
}

// ─── Producer ──────────────────────────────────────────────────────────────────

/** What the producer needs to log and count. */
export interface FirstEffectiveTarget {
  env: Env;
  ctx: { waitUntil(promise: Promise<unknown>): void };
  request: Request;
}

/** The outcome of one moment's fan-out. */
export interface FirstEffectiveFanOut {
  /** Accounts in the audience. */
  total: number;
  /** Accounts whose message was queued. */
  queued: number;
  complete: boolean;
  failure: 'audience_read' | 'unbound' | 'send_batch' | null;
}

/**
 * Queue one moment's notice to every unbanned account, 25 per message, 100 messages per
 * `sendBatch()`. Never throws. A failure returns `complete: false`, and the caller then
 * leaves the marker unset.
 */
export async function fanOutFirstEffectiveNotice(
  target: FirstEffectiveTarget,
  db: Db,
  moment: { effectiveAtMs: number; legalVersionIds: readonly string[] },
  now: Date = new Date(),
): Promise<FirstEffectiveFanOut> {
  const { env, ctx, request } = target;
  const countMetric = (outcome: 'ok' | 'failed' | 'unbound', n: number) =>
    submitCount(ctx, env, request, 'aeci.legal_notice.enqueue', n, [
      `outcome:${outcome}`,
      'audience:first-effective',
    ]);
  const fail = (
    failure: NonNullable<FirstEffectiveFanOut['failure']>,
    total: number,
    queued: number,
    error: unknown,
  ): FirstEffectiveFanOut => {
    logToPosthog(ctx, env, request, {
      level: 'error',
      message: `aeci.legal_notice: the first-effective fan-out did not complete (${failure}); the next 12:00 run queues it again`,
      source: SOURCE,
      effective_on: legalEffectiveDayOf(moment.effectiveAtMs),
      queued,
      total,
      error: error instanceof Error ? error.message : String(error ?? ''),
    });
    return { total, queued, complete: false, failure };
  };

  let profileIds: string[];
  try {
    profileIds = await legalNoticeAccountIds(db);
  } catch (error) {
    countMetric('failed', 1);
    return fail('audience_read', 0, 0, error);
  }
  if (profileIds.length === 0) return { total: 0, queued: 0, complete: true, failure: null };

  const queue = env.LEGAL_NOTICE_QUEUE;
  if (!queue) {
    countMetric('unbound', profileIds.length);
    return fail('unbound', profileIds.length, 0, 'LEGAL_NOTICE_QUEUE is not bound');
  }
  const enqueuedAt = now.toISOString();
  const perSend = LEGAL_NOTICE_SEND_BATCH * READER_NOTICE_CHUNK;
  let queued = 0;
  try {
    for (let i = 0; i < profileIds.length; i += perSend) {
      const ids = profileIds.slice(i, i + perSend);
      const messages: { body: LegalFirstEffectiveMessage }[] = [];
      for (let j = 0; j < ids.length; j += READER_NOTICE_CHUNK) {
        messages.push({
          body: {
            kind: 'first-effective',
            effectiveAt: moment.effectiveAtMs,
            legalVersionIds: [...moment.legalVersionIds],
            profileIds: ids.slice(j, j + READER_NOTICE_CHUNK),
            enqueuedAt,
          },
        });
      }
      await queue.sendBatch(messages);
      queued += ids.length;
    }
  } catch (error) {
    if (queued > 0) countMetric('ok', queued);
    countMetric('failed', profileIds.length - queued);
    return fail('send_batch', profileIds.length, queued, error);
  }
  countMetric('ok', queued);
  return { total: profileIds.length, queued, complete: true, failure: null };
}

/** One moment the job handled, for the run's `job_runs` detail. */
export interface FirstEffectiveMomentReport {
  effectiveOn: string;
  documents: string[];
  accounts: number;
  queued: number;
  outcome: 'enqueued' | 'failed';
  failure?: NonNullable<FirstEffectiveFanOut['failure']>;
  /** Rows this run stamped (a concurrent run may have stamped some first). */
  marked: number;
}

/** What one run of the job did. */
export interface FirstEffectiveRunResult {
  moments: FirstEffectiveMomentReport[];
  /** First in-force rows with no marker whose moment is more than 7 days old. Never sent. */
  stale: number;
}

/**
 * The daily job (module header). Throws only on a D1 error reading or stamping the rows,
 * which the cron records as a failed run. A fan-out failure is a reported moment, not a
 * throw: its marker stays unset, so the next run retries it.
 */
export async function runLegalFirstEffectiveNotice(
  target: FirstEffectiveTarget,
  db: Db,
  now: Date = new Date(),
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): Promise<FirstEffectiveRunResult> {
  const rows = await db
    .select({
      id: legalVersions.id,
      document: legalVersions.document,
      version: legalVersions.version,
      effectiveAt: legalVersions.effectiveAt,
      marker: legalVersions.firstEffectiveNoticeEnqueuedAt,
    })
    .from(legalVersions);
  const nowMs = now.getTime();
  const sinceMs = nowMs - LEGAL_FIRST_EFFECTIVE_WINDOW_MS;

  const stale = legalFirstInForceMoments(rows, { sinceMs: Number.NEGATIVE_INFINITY, nowMs }, maps)
    .filter((m) => m.effectiveAtMs <= sinceMs)
    .reduce((n, m) => n + m.rows.filter((r) => r.marker === null).length, 0);
  if (stale > 0) {
    logToPosthog(target.ctx, target.env, target.request, {
      level: 'warn',
      message: `aeci.legal_notice: ${stale} first in-force versions took effect more than 7 days ago with no day-of notice; none is sent now`,
      source: SOURCE,
    });
  }

  const reports: FirstEffectiveMomentReport[] = [];
  for (const moment of legalFirstInForceMoments(rows, { sinceMs, nowMs }, maps)) {
    const unmarked = moment.rows.filter((r) => r.marker === null);
    if (unmarked.length === 0) continue;
    const effectiveOn = legalEffectiveDayOf(moment.effectiveAtMs);
    const documents = moment.rows.map((r) => r.document);
    const fan = await fanOutFirstEffectiveNotice(
      target,
      db,
      { effectiveAtMs: moment.effectiveAtMs, legalVersionIds: moment.rows.map((r) => r.id) },
      now,
    );
    if (!fan.complete) {
      reports.push({
        effectiveOn,
        documents,
        accounts: fan.total,
        queued: fan.queued,
        outcome: 'failed',
        ...(fan.failure ? { failure: fan.failure } : {}),
        marked: 0,
      });
      continue;
    }
    const marked = await markFirstEffectiveEnqueued(target, db, unmarked, fan.total, now);
    reports.push({
      effectiveOn,
      documents,
      accounts: fan.total,
      queued: fan.queued,
      outcome: 'enqueued',
      marked,
    });
  }
  return { moments: reports, stale };
}

/**
 * Stamp the marker on each row, each with its audit row, in ONE `db.batch`. The UPDATE is
 * guarded on the marker still being NULL, and each audit row lands only when its row now
 * carries this run's stamp (`auditInsertWhere`), so a concurrent run that stamped first
 * leaves no second audit row. Forwards the rows that landed. Returns how many landed.
 */
async function markFirstEffectiveEnqueued(
  target: FirstEffectiveTarget,
  db: Db,
  rows: readonly { id: string; document: string; version: string; effectiveAt: number }[],
  accounts: number,
  now: Date,
): Promise<number> {
  const at = now.toISOString();
  const ids = rows.map((r) => r.id);
  const entries: AuditLogEntry[] = rows.map((r) => ({
    actorId: null,
    actorType: 'system',
    action: LEGAL_FIRST_EFFECTIVE_ENQUEUED_ACTION,
    entityType: LEGAL_NOTICE_ENTITY_TYPE,
    entityId: r.id,
    beforeState: { first_effective_notice_enqueued_at: null },
    afterState: { first_effective_notice_enqueued_at: at },
    metadata: {
      source: SOURCE,
      document: r.document,
      version: r.version,
      effective_on: legalEffectiveDayOf(r.effectiveAt),
      accounts,
    },
  }));
  const stmts: BatchStmt[] = [
    db
      .update(legalVersions)
      .set({ firstEffectiveNoticeEnqueuedAt: at })
      .where(
        and(inArray(legalVersions.id, ids), isNull(legalVersions.firstEffectiveNoticeEnqueuedAt)),
      ),
    ...entries.map((entry) =>
      auditInsertWhere(db, entry, {
        from: legalVersions,
        where: and(
          eq(legalVersions.id, entry.entityId!),
          eq(legalVersions.firstEffectiveNoticeEnqueuedAt, at),
        ),
      }),
    ),
  ];
  await db.batch(stmts as BatchTuple);
  const landed = await landedAuditEntries(db, entries);
  forwardAuditBatch(
    { executionCtx: target.ctx as ExecutionContext, env: target.env, req: { raw: target.request } },
    landed,
    [],
    SOURCE,
  );
  return landed.length;
}

// ─── Consumer ──────────────────────────────────────────────────────────────────

export type SendLegalFirstEffective = (
  c: EmailContext,
  opts: LegalFirstEffectiveSubject,
) => Promise<EmailOutcome>;

export interface LegalFirstEffectiveDeps {
  dbFor?: DbFactory;
  fetchSeatEmails?: FetchSeatEmailsResult;
  send?: SendLegalFirstEffective;
  now?: () => Date;
}

/** `aeci.legal_notice.delivery{outcome}` for the day-of notice. */
type FirstEffectiveDeliveryOutcome =
  | 'sent'
  | 'too_early'
  | 'invalid'
  | 'unknown_version'
  | 'no_site_url'
  | 'seats_unavailable'
  | 'partial_retry'
  | 'no_recipients'
  | 'read_failed';

/**
 * Deliver one day-of message (module header). Acks or retries it itself and never throws.
 * Sends one account at a time, so a message never holds more than one Resend connection
 * (plus the bounded Auth lookup).
 */
export async function deliverLegalFirstEffectiveNotice(
  env: Env,
  ctx: ExecutionContext,
  message: Message<unknown>,
  deps: LegalFirstEffectiveDeps = {},
): Promise<void> {
  const dbFor = deps.dbFor ?? getDb;
  const clock = deps.now ?? (() => new Date());
  const fetchEmails = deps.fetchSeatEmails ?? fetchAuthUserEmailsResult;
  const send = deps.send ?? sendLegalFirstEffectiveEmail;
  const request = new Request('https://aeci-api/queue/legal-notice');
  const c: EmailContext = { env, executionCtx: ctx, req: { raw: request } };
  const lastAttempt = message.attempts > LEGAL_NOTICE_MAX_RETRIES;
  const metric = (outcome: FirstEffectiveDeliveryOutcome) =>
    submitCount(ctx, env, request, 'aeci.legal_notice.delivery', 1, [
      `outcome:${outcome}`,
      'audience:first-effective',
    ]);
  const log = (level: 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) =>
    logToPosthog(ctx, env, request, { level, message: msg, source: SOURCE, ...extra });
  const retry = (
    outcome: FirstEffectiveDeliveryOutcome,
    msg: string,
    extra: Record<string, unknown>,
  ) => {
    metric(outcome);
    const text = lastAttempt ? `${msg}; last attempt, the message is dropped` : msg;
    log('error', text, extra);
    console.error(text, JSON.stringify(extra));
    message.retry({ delaySeconds: legalNoticeRetryDelaySeconds(message.attempts) });
  };

  const parsed = LegalFirstEffectiveMessageSchema.safeParse(message.body);
  if (!parsed.success) {
    metric('invalid');
    log('warn', 'aeci.legal_notice: dropped a message that is not a LegalFirstEffectiveMessage');
    message.ack();
    return;
  }
  const { effectiveAt, legalVersionIds, profileIds } = parsed.data;
  const effectiveDay = legalEffectiveDayOf(effectiveAt);
  const ids = { effective_on: effectiveDay, accounts: profileIds.length };

  try {
    // The ruling-68 line: never a word before the documents are in force.
    if (effectiveAt > clock().getTime()) {
      retry(
        'too_early',
        'aeci.legal_notice: a first-effective message arrived before the moment; nothing sent, retrying',
        ids,
      );
      return;
    }
    const db = dbFor(env, { constraint: 'first-primary' }).db;
    const rows = await db
      .select({
        id: legalVersions.id,
        document: legalVersions.document,
        version: legalVersions.version,
        effectiveAt: legalVersions.effectiveAt,
      })
      .from(legalVersions)
      .where(inArray(legalVersions.id, legalVersionIds));
    const documents = rows.flatMap((r) => {
      const document = LegalPublishableDocumentSchema.safeParse(r.document);
      return document.success && r.effectiveAt === effectiveAt
        ? [{ document: document.data as LegalPublishableDocument, version: r.version }]
        : [];
    });
    if (documents.length !== legalVersionIds.length) {
      metric('unknown_version');
      log(
        'error',
        'aeci.legal_notice: a first-effective message names a row that is gone or moved; dropped',
        {
          ...ids,
          legal_version_ids: legalVersionIds,
        },
      );
      message.ack();
      return;
    }
    if (!env.PUBLIC_SITE_URL?.trim()) {
      retry(
        'no_site_url',
        'aeci.legal_notice: PUBLIC_SITE_URL unset; the document links cannot be built, nothing sent',
        ids,
      );
      return;
    }

    // Re-read each account: one banned or deleted since the fan-out gets nothing.
    const accounts = await db
      .select({ id: profiles.id, vendorId: profiles.vendorId, seatOwner: profiles.seatOwner })
      .from(profiles)
      .where(and(inArray(profiles.id, profileIds), isNull(profiles.bannedAt)));
    if (accounts.length === 0) {
      metric('no_recipients');
      message.ack();
      return;
    }
    const lookup = await fetchEmails(
      env,
      accounts.map((a) => a.id),
    );
    if (!lookup.available) {
      retry(
        'seats_unavailable',
        'aeci.legal_notice: the account email lookup is unavailable; nothing sent, retrying',
        { ...ids, reason: lookup.reason },
      );
      return;
    }

    let failed = 0;
    let reached = 0;
    for (const account of accounts) {
      const to = lookup.emails.get(account.id);
      if (!to) continue;
      const outcome = await send(c, {
        to,
        effectiveDay,
        documents,
        ownerSeat: account.vendorId !== null && account.seatOwner,
        dedupeKey: legalFirstEffectiveDedupeKey(effectiveDay, account.id),
        entity: { type: 'legal_effective_day', id: effectiveDay },
      });
      if (outcome === 'failed' || outcome === 'skipped') failed += 1;
      else reached += 1;
    }
    if (failed > 0) {
      retry('partial_retry', 'aeci.legal_notice: some first-effective sends did not go; retrying', {
        ...ids,
        failed,
      });
      return;
    }
    metric(reached === 0 ? 'no_recipients' : 'sent');
    message.ack();
  } catch (error) {
    retry('read_failed', 'aeci.legal_notice: a first-effective read failed; retrying', {
      ...ids,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The change notice for a published legal version (AECI-1620, `legal-terms-change`,
 * `VENDOR_SIGNUP_PROCESS.md` §3, ADR 0054). A material version's publish
 * (`routes/admin-legal-versions.ts`) and its re-send route call {@link fanOutLegalNotice}:
 * one {@link LegalNoticeMessage} per affected company on `aeci-legal-notice-{env}`. This
 * Worker consumes the queue (`queue()` in `scheduled.ts` routes it by name) and emails
 * each company's recipients through {@link deliverLegalNotice}.
 *
 * ── WHO GETS IT ────────────────────────────────────────────────────────────────
 *   - `vendor_terms`: every company with at least one unbanned seat. Recipients are every
 *     unbanned seat and the company's billing emails (`vendor-terms.md` "Changes to these
 *     terms": "we email every seat at the company and the billing email").
 *   - `managed_plan`: every company whose billing account holds a live subscription of
 *     any source (Stripe, invoice, complimentary; grants once activated). Recipients are
 *     the owner seats and the billing emails (`managed-plan-agreement.md` "Changes to
 *     this agreement": "we email your owner seats and your billing email"). A grant or
 *     complimentary account gets it as information and is asked for no click (ruled by
 *     Chris, AECI-1620 re-cut).
 * Every list goes through `mergeRecipientAddresses`, so an address appears once per company.
 *
 * ── THE KEY HOLDS THE VENDOR ID ────────────────────────────────────────────────
 * Each address is keyed `legal-terms-change:{document}:{version}:{vendorId}:{recipientHash}`
 * in `notification_sends`. An address that is the billing email of two companies gets
 * one notice per company, each naming that company's own terms. A `failed` send
 * releases its key and the message retries, so the retry reaches only the addresses that
 * failed. A `sent` or `unknown` send keeps its key, so no address gets two.
 *
 * ── NEVER A PARTIAL COMPANY ────────────────────────────────────────────────────
 * Seat addresses come from `fetchAuthUserEmailsResult`. When it reports the seam
 * unavailable (no credentials, or any id failed), the message is retried and nothing is
 * sent for the company: an ack would leave the missing seats un-noticed for good.
 *
 * ── THE PDF IS RE-CHECKED ON EVERY MESSAGE ─────────────────────────────────────
 * The consumer reads the PDF from `UPLOADS` once per message and hashes it. A file that
 * no longer matches the published `pdf_sha256` sends nothing: it logs an error and
 * retries 10, 20 and 30 minutes later, so restoring the published file lets a later
 * attempt send. A notice without the PDF, or without a site URL for the version link,
 * would not carry what both agreements promise (counsel Q3), so neither case sends.
 *
 * ── AFTER THE LAST RETRY ───────────────────────────────────────────────────────
 * The queue drops the message (no dead-letter queue, like every other queue here). The
 * last attempt logs an error naming the version and the company. The `/admin/legal`
 * counts show the shortfall, and "Send the notice again" re-enqueues every company: the
 * keys stop a second email to any address already reached.
 *
 * ── NEVER AFTER THE EFFECTIVE MOMENT ───────────────────────────────────────────
 * The email says "Until then the current version applies", which is false once the
 * version is in effect. A message that arrives at or after `effective_at` sends nothing,
 * logs an error naming the version and the company, is acked, and clears
 * `notice_enqueued_at` (`markNoticeExpired`, with a system audit row) so `/admin/legal`
 * shows the notice as not completed. The re-send route refuses then too.
 */

import { LegalAgreementDocumentSchema, type LegalAgreementDocument } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { LegalExpeditedReason, LegalNoticeSendCounts } from '@aeci/shared';
import { and, count, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, type Db } from '../db/client';
import {
  billingAccounts,
  legalVersions,
  licenses,
  notificationSends,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { logToPosthog, submitCount } from '../posthog';
import { auditInsert, type BatchTuple } from './audit';
import {
  loadVendorBillingEmails,
  mergeRecipientAddresses,
  ownerAndBillingAddresses,
} from './billing-recipients';
import { VENDOR_ADMIN_ROLE } from './claimed-vendors';
import {
  bytesToBase64,
  sendLegalTermsChangeEmail,
  type EmailContext,
  type EmailOutcome,
  type LegalTermsChangeClosing,
  type LegalTermsChangeSubject,
} from './email';
import type { DbFactory } from './handler-utils';
import { recipientHash } from './hash';
import {
  loadLegalVersionById,
  loadVerifiedLegalPdf,
  summaryOf,
  type LegalVersionRow,
} from './legal-versions';
import { fetchAuthUserEmailsResult, type AuthEmailLookup } from './supabase-admin';
import { loadVendorSeatRecipients, type FetchSeatEmails } from './vendor-seat-recipients';

/** Every legal-notice queue name starts with this. */
export const LEGAL_NOTICE_QUEUE_PREFIX = 'aeci-legal-notice-';

/**
 * The consumer's `max_retries` in every `wrangler.jsonc` block, pinned by
 * `wrangler-legal-notice.spec.ts`. The consumer uses it to tell the last attempt.
 */
export const LEGAL_NOTICE_MAX_RETRIES = 3;

/** The registry id, and the `notification_sends.notification_id` of every send. */
export const LEGAL_NOTICE_NOTIFICATION_ID = 'legal-terms-change';

/** `notification_sends.entity_type` of every send; `entity_id` is the `legal_versions.id`. */
export const LEGAL_NOTICE_ENTITY_TYPE = 'legal_version';

/**
 * Seconds before a retried message comes back: 10, 20, then 30 minutes. A refused PDF
 * needs an operator to restore the published file, and an Auth or Resend outage is
 * usually short, so the retries are spread over an hour rather than spent in seconds.
 */
export function legalNoticeRetryDelaySeconds(attempts: number): number {
  return 600 * Math.min(Math.max(attempts, 1), 3);
}

/** Messages per `sendBatch()`, the Queues cap. */
export const LEGAL_NOTICE_SEND_BATCH = 100;

export const LegalNoticeMessageSchema = z.object({
  legalVersionId: z.string().min(1),
  vendorId: z.string().min(1),
  enqueuedAt: z.string(),
});
export type LegalNoticeMessage = z.infer<typeof LegalNoticeMessageSchema>;

export function isLegalNoticeQueue(queueName: string): boolean {
  return queueName.startsWith(LEGAL_NOTICE_QUEUE_PREFIX);
}

/** The dedupe key of one address's notice from one company. */
export function legalNoticeDedupeKey(
  document: LegalAgreementDocument,
  version: string,
  vendorId: string,
  hash: string,
): string {
  return `legal-terms-change:${document}:${version}:${vendorId}:${hash}`;
}

/** Ids, not display text: binary order (`ANGULAR_STYLE_GUIDE.md` §20a). */
function binarySort(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ─── The audience ──────────────────────────────────────────────────────────────

/** The companies a published version of `document` notifies (module header), sorted. */
export async function legalNoticeVendorIds(
  db: Db,
  document: LegalAgreementDocument,
): Promise<string[]> {
  const rows =
    document === 'vendor_terms'
      ? await db
          .selectDistinct({ vendorId: profiles.vendorId })
          .from(profiles)
          .where(
            and(
              eq(profiles.role, VENDOR_ADMIN_ROLE),
              isNull(profiles.bannedAt),
              isNotNull(profiles.vendorId),
            ),
          )
      : await db
          .selectDistinct({ vendorId: billingAccounts.vendorId })
          .from(licenses)
          .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
          .where(isNull(licenses.endedAt));
  return binarySort(rows.flatMap((r) => (r.vendorId ? [r.vendorId] : [])));
}

/** Whether the company holds a live monthly card subscription: `stripe`, no `ends_at`. */
export async function hasLiveMonthlySubscription(db: Db, vendorId: string): Promise<boolean> {
  const row = await db
    .select({ id: licenses.id })
    .from(licenses)
    .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
    .where(
      and(
        eq(billingAccounts.vendorId, vendorId),
        isNull(licenses.endedAt),
        isNull(licenses.endsAt),
        eq(licenses.source, 'stripe'),
      ),
    )
    .limit(1);
  return row.length > 0;
}

/** The seat-email lookup the consumer injects: the `Result` form, so it can see an outage. */
export type FetchSeatEmailsResult = (
  env: Env,
  userIds: readonly string[],
) => Promise<AuthEmailLookup>;

/** Thrown when the seat-email lookup is unavailable. The consumer retries the message. */
export class SeatLookupUnavailableError extends Error {
  constructor(readonly reason: AuthEmailLookup['reason']) {
    super(`seat email lookup unavailable (${reason})`);
    this.name = 'SeatLookupUnavailableError';
  }
}

/** A bare-map seat lookup that throws instead of returning part of the seats. */
export function strictSeatEmails(fetchResult: FetchSeatEmailsResult): FetchSeatEmails {
  return async (env, ids) => {
    const lookup = await fetchResult(env, ids);
    if (!lookup.available) throw new SeatLookupUnavailableError(lookup.reason);
    return lookup.emails;
  };
}

/** The addresses one company's notice goes to (module header). */
export async function legalNoticeRecipients(
  env: Env,
  db: Db,
  document: LegalAgreementDocument,
  vendorId: string,
  fetchSeatEmails: FetchSeatEmails,
): Promise<string[]> {
  if (document === 'managed_plan') {
    return ownerAndBillingAddresses(env, db, vendorId, fetchSeatEmails);
  }
  const [seats, billing] = await Promise.all([
    loadVendorSeatRecipients(db, env, [vendorId], fetchSeatEmails),
    loadVendorBillingEmails(db, vendorId),
  ]);
  return mergeRecipientAddresses(
    [...(seats.get(vendorId) ?? []).map((s) => s.email), ...billing],
    null,
  );
}

/** The closing line for one company (`LegalTermsChangeClosing`). */
export function legalClosingFor(
  document: LegalAgreementDocument,
  requiresAcceptance: boolean,
  monthly: boolean,
): LegalTermsChangeClosing {
  if (document === 'vendor_terms') {
    return requiresAcceptance ? 'vendor-terms-accept' : 'vendor-terms';
  }
  return requiresAcceptance && monthly ? 'managed-monthly-accept' : 'managed-binds';
}

// ─── Producer ──────────────────────────────────────────────────────────────────

type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

/** How a fan-out went. */
export interface LegalNoticeFanOut {
  /** Companies in the audience, or null when the audience read failed. */
  total: number | null;
  /** Companies whose message the queue accepted. */
  queued: number;
  /** Every company was queued. */
  complete: boolean;
  /** Why it did not complete: `audience_read`, `unbound` or `send_batch`. */
  failure: 'audience_read' | 'unbound' | 'send_batch' | null;
}

/**
 * Read the audience and enqueue one message per company, `sendBatch()` in chunks of
 * 100. Never throws. Emits `aeci.legal_notice.enqueue{outcome}` (`ok`, `failed`,
 * `unbound`) and logs an error naming the version when it does not complete.
 */
export async function fanOutLegalNotice(
  target: { env: Env; ctx: WaitUntil; request: Request },
  db: Db,
  row: Pick<LegalVersionRow, 'id' | 'document'>,
  now: Date = new Date(),
): Promise<LegalNoticeFanOut> {
  const { env, ctx, request } = target;
  const countMetric = (outcome: 'ok' | 'failed' | 'unbound', n: number) =>
    submitCount(ctx, env, request, 'aeci.legal_notice.enqueue', n, [`outcome:${outcome}`]);
  const fail = (
    failure: NonNullable<LegalNoticeFanOut['failure']>,
    total: number | null,
    queued: number,
    error: unknown,
  ): LegalNoticeFanOut => {
    logToPosthog(ctx, env, request, {
      level: 'error',
      message: `aeci.legal_notice.enqueue did not complete (${failure}); send the notice again from /admin/legal`,
      legal_version_id: row.id,
      queued,
      total,
      error: error instanceof Error ? error.message : String(error ?? ''),
    });
    return { total, queued, complete: false, failure };
  };

  let vendorIds: string[];
  try {
    vendorIds = await legalNoticeVendorIds(db, LegalAgreementDocumentSchema.parse(row.document));
  } catch (error) {
    countMetric('failed', 1);
    return fail('audience_read', null, 0, error);
  }
  if (vendorIds.length === 0) return { total: 0, queued: 0, complete: true, failure: null };

  const queue = env.LEGAL_NOTICE_QUEUE;
  if (!queue) {
    countMetric('unbound', vendorIds.length);
    return fail('unbound', vendorIds.length, 0, 'LEGAL_NOTICE_QUEUE is not bound');
  }
  const enqueuedAt = now.toISOString();
  let queued = 0;
  try {
    for (let i = 0; i < vendorIds.length; i += LEGAL_NOTICE_SEND_BATCH) {
      const chunk = vendorIds.slice(i, i + LEGAL_NOTICE_SEND_BATCH);
      await queue.sendBatch(
        chunk.map((vendorId) => ({
          body: { legalVersionId: row.id, vendorId, enqueuedAt } satisfies LegalNoticeMessage,
        })),
      );
      queued += chunk.length;
    }
  } catch (error) {
    if (queued > 0) countMetric('ok', queued);
    countMetric('failed', vendorIds.length - queued);
    return fail('send_batch', vendorIds.length, queued, error);
  }
  countMetric('ok', queued);
  return { total: vendorIds.length, queued, complete: true, failure: null };
}

/**
 * The two outcome columns a fan-out leaves on the row (`LegalVersionSchema`): a complete
 * fan-out stamps `notice_enqueued_at`; an incomplete one leaves it NULL and records the
 * companies queued so far, so `/admin/legal` shows that the send did not finish.
 */
export function noticeOutcomeColumns(
  fan: LegalNoticeFanOut,
  now: Date,
): { noticeEnqueuedAt: string | null; noticeVendorCount: number } {
  return {
    noticeEnqueuedAt: fan.complete ? now.toISOString() : null,
    noticeVendorCount: fan.queued,
  };
}

// ─── The admin page's counts ───────────────────────────────────────────────────

const EMPTY_COUNTS: LegalNoticeSendCounts = {
  sent: 0,
  failed: 0,
  unknown: 0,
  suppressed: 0,
  skipped: 0,
};

/** The notice's `notification_sends` rows per version id, by outcome. */
export async function loadNoticeSendCounts(
  db: Db,
  legalVersionIds: readonly string[],
): Promise<Map<string, LegalNoticeSendCounts>> {
  const out = new Map<string, LegalNoticeSendCounts>();
  const ids = [...new Set(legalVersionIds)];
  for (const id of ids) out.set(id, { ...EMPTY_COUNTS });
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: notificationSends.entityId, outcome: notificationSends.outcome, n: count() })
    .from(notificationSends)
    .where(
      and(
        eq(notificationSends.notificationId, LEGAL_NOTICE_NOTIFICATION_ID),
        eq(notificationSends.entityType, LEGAL_NOTICE_ENTITY_TYPE),
        inArray(notificationSends.entityId, ids),
      ),
    )
    .groupBy(notificationSends.entityId, notificationSends.outcome);
  for (const r of rows) {
    const counts = r.id ? out.get(r.id) : undefined;
    if (!counts) continue;
    if (r.outcome in counts) counts[r.outcome as keyof LegalNoticeSendCounts] += r.n;
  }
  return out;
}

// ─── Consumer ──────────────────────────────────────────────────────────────────

export type SendLegalTermsChange = (
  c: EmailContext,
  opts: LegalTermsChangeSubject,
) => Promise<EmailOutcome>;

export interface LegalNoticeDeps {
  dbFor?: DbFactory;
  fetchSeatEmails?: FetchSeatEmailsResult;
  send?: SendLegalTermsChange;
  now?: () => Date;
}

/** `audit_log.action` when a message arrives after the version took effect (system actor). */
export const LEGAL_VERSION_NOTICE_EXPIRED_ACTION = 'legal_version.notice_expired';

/**
 * A message arrived after the effective moment, so its company got no notice. Clear
 * `notice_enqueued_at` (the count stays) so `/admin/legal` shows the notice as not
 * completed, with a system audit row in one batch. Only the first late message for a
 * version writes: the update is guarded on `notice_enqueued_at IS NOT NULL`, and a row
 * already cleared is left alone. Throws only on a D1 error.
 */
export async function markNoticeExpired(
  db: Db,
  row: Pick<
    LegalVersionRow,
    'id' | 'document' | 'version' | 'noticeEnqueuedAt' | 'noticeVendorCount'
  >,
  now: Date,
): Promise<boolean> {
  if (row.noticeEnqueuedAt === null) return false;
  const entry: AuditLogEntry = {
    actorId: null,
    actorType: 'system',
    action: LEGAL_VERSION_NOTICE_EXPIRED_ACTION,
    entityType: LEGAL_NOTICE_ENTITY_TYPE,
    entityId: row.id,
    beforeState: {
      notice_enqueued_at: row.noticeEnqueuedAt,
      notice_vendor_count: row.noticeVendorCount ?? null,
    },
    afterState: { notice_enqueued_at: null, notice_vendor_count: row.noticeVendorCount ?? null },
    metadata: {
      source: 'legal-notice',
      document: row.document,
      version: row.version,
      at: now.toISOString(),
    },
  };
  await db.batch([
    db
      .update(legalVersions)
      .set({ noticeEnqueuedAt: null })
      .where(and(eq(legalVersions.id, row.id), isNotNull(legalVersions.noticeEnqueuedAt))),
    auditInsert(db, entry),
  ] as BatchTuple);
  return true;
}

/** `aeci.legal_notice.delivery{outcome}`. */
type DeliveryOutcome =
  | 'sent'
  | 'too_late'
  | 'partial_retry'
  | 'no_recipients'
  | 'invalid'
  | 'unknown_version'
  | 'not_material'
  | 'pdf_refused'
  | 'no_site_url'
  | 'seats_unavailable'
  | 'read_failed';

/**
 * Deliver one message. Acks or retries it itself and never throws, so the dispatcher in
 * `scheduled.ts` only loops. Sends to the company's recipients one at a time, so a large
 * company never holds more than one Resend connection (plus the bounded seat lookup).
 */
export async function deliverLegalNotice(
  env: Env,
  ctx: ExecutionContext,
  message: Message<unknown>,
  deps: LegalNoticeDeps = {},
): Promise<void> {
  const dbFor = deps.dbFor ?? getDb;
  const clock = deps.now ?? (() => new Date());
  const fetchSeatEmails = strictSeatEmails(deps.fetchSeatEmails ?? fetchAuthUserEmailsResult);
  const send = deps.send ?? sendLegalTermsChangeEmail;
  const request = new Request('https://aeci-api/queue/legal-notice');
  const c: EmailContext = { env, executionCtx: ctx, req: { raw: request } };
  const lastAttempt = message.attempts > LEGAL_NOTICE_MAX_RETRIES;
  const metric = (outcome: DeliveryOutcome) =>
    submitCount(ctx, env, request, 'aeci.legal_notice.delivery', 1, [`outcome:${outcome}`]);
  const log = (level: 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) =>
    logToPosthog(ctx, env, request, { level, message: msg, ...extra });
  /** Log loud and retry. On the last attempt the queue drops the message after this. */
  const failLoud = (outcome: DeliveryOutcome, msg: string, extra: Record<string, unknown>) => {
    metric(outcome);
    const text = lastAttempt
      ? `${msg}; last attempt, the message is dropped. Send the notice again from /admin/legal`
      : msg;
    log('error', text, extra);
    console.error(text, JSON.stringify(extra));
    message.retry({ delaySeconds: legalNoticeRetryDelaySeconds(message.attempts) });
  };

  const parsed = LegalNoticeMessageSchema.safeParse(message.body);
  if (!parsed.success) {
    metric('invalid');
    log('warn', 'aeci.legal_notice: dropped a message that is not a LegalNoticeMessage');
    message.ack();
    return;
  }
  const { legalVersionId, vendorId } = parsed.data;
  const ids = { legal_version_id: legalVersionId, vendor_id: vendorId };

  try {
    const { db } = dbFor(env, { constraint: 'first-primary' });
    const row = await loadLegalVersionById(db, legalVersionId);
    if (!row) {
      metric('unknown_version');
      log('error', 'aeci.legal_notice: no legal_versions row for the message; dropped', ids);
      message.ack();
      return;
    }
    const versionIds = { ...ids, document: row.document, version: row.version };
    if (!row.material) {
      metric('not_material');
      log('warn', 'aeci.legal_notice: the version is not material; dropped', versionIds);
      message.ack();
      return;
    }
    if (row.effectiveAt <= clock().getTime()) {
      // The email says "Until then the current version applies", which is false from the
      // effective moment on. Send nothing, and mark the notice not completed so the page
      // shows it. The re-send route refuses here too (LEGAL_NOTICE_TOO_LATE).
      metric('too_late');
      log(
        'error',
        'aeci.legal_notice: the version is already in effect; nothing sent, the message is dropped',
        versionIds,
      );
      try {
        await markNoticeExpired(db, row, clock());
      } catch (error) {
        log('error', 'aeci.legal_notice: could not mark the notice not completed', {
          ...versionIds,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      message.ack();
      return;
    }
    const document = LegalAgreementDocumentSchema.parse(row.document);
    if (!env.PUBLIC_SITE_URL?.trim()) {
      failLoud(
        'no_site_url',
        'aeci.legal_notice: PUBLIC_SITE_URL unset; the version link cannot be built, nothing sent',
        versionIds,
      );
      return;
    }
    const pdf = await loadVerifiedLegalPdf(env.UPLOADS, row);
    if (!pdf.ok) {
      failLoud(
        'pdf_refused',
        `aeci.legal_notice: the published PDF was refused (${pdf.problem}); nothing sent`,
        { ...versionIds, pdf_key: row.pdfKey, problem: pdf.problem },
      );
      return;
    }

    let addresses: string[];
    try {
      addresses = await legalNoticeRecipients(env, db, document, vendorId, fetchSeatEmails);
    } catch (error) {
      if (error instanceof SeatLookupUnavailableError) {
        failLoud(
          'seats_unavailable',
          'aeci.legal_notice: the seat email lookup is unavailable; nothing sent, retrying',
          { ...versionIds, reason: error.reason },
        );
        return;
      }
      throw error;
    }
    if (addresses.length === 0) {
      metric('no_recipients');
      log('warn', 'aeci.legal_notice: the company has no address to notify', versionIds);
      message.ack();
      return;
    }
    const monthly =
      document === 'managed_plan' && row.requiresAcceptance
        ? await hasLiveMonthlySubscription(db, vendorId)
        : false;
    const vendor = await db.query.vendors.findFirst({
      columns: { slug: true },
      where: eq(vendors.id, vendorId),
    });
    const closing = legalClosingFor(document, row.requiresAcceptance, monthly);
    const effectiveDay = new Date(row.effectiveAt).toISOString().slice(0, 10);
    const summary = summaryOf(row);
    const pdfBase64 = bytesToBase64(pdf.bytes);
    const expeditedReason = (row.expeditedReason as LegalExpeditedReason | null) ?? null;

    let failed = 0;
    for (const to of addresses) {
      const outcome = await send(c, {
        to,
        document,
        version: row.version,
        effectiveDay,
        summary,
        closing,
        expeditedReason,
        vendorSlug: vendor?.slug ?? null,
        pdfBase64,
        dedupeKey: legalNoticeDedupeKey(document, row.version, vendorId, await recipientHash(to)),
        entity: { type: LEGAL_NOTICE_ENTITY_TYPE, id: row.id },
      });
      if (outcome === 'failed') failed++;
    }
    if (failed > 0) {
      failLoud('partial_retry', 'aeci.legal_notice: some sends failed; retrying those', {
        ...versionIds,
        failed,
        recipients: addresses.length,
      });
      return;
    }
    metric('sent');
    message.ack();
  } catch (error) {
    failLoud('read_failed', 'aeci.legal_notice: a read failed; retrying', {
      ...ids,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

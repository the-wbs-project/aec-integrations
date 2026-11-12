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
 * ── ONE DELIVERY ROW PER COMPANY ───────────────────────────────────────────────
 * `legal_notice_deliveries` (`DATABASE_SCHEMA.md` §8.6j) says where each company stands.
 * The fan-out writes `queued` just before it sends that company's message (a failed send
 * turns it to `dropped`, `enqueue_failed`). The consumer writes `delivered` when every
 * recipient was sent or already sent, `no_recipients` when the company has no address, and
 * on each retry the attempt and its reason. On the last attempt the row becomes `dropped`
 * with the reason, and the queue then drops the message (no dead-letter queue, like every
 * other queue here). `/admin/legal` counts the rows and lists every company not reached by
 * name and reason, and "Send the notice again" re-enqueues every company not `delivered`.
 * The keys stop a second email to any address already reached. Only the consumer's own
 * `delivered` write may replace a `delivered` row, so a late failure never undoes it. A
 * `delivered` row carries `outcome_unknown` or `held_by_tier` when an address is worth
 * checking. The page also treats a `queued` row as not reached once the version is in
 * effect, and lists one untouched for two hours before then as stale. Every multi-row
 * upsert is sized from its measured parameter count (`DELIVERY_UPSERT_CHUNK`) to stay
 * under D1's 100 bound parameters, and a fan-out whose rows could not be written reports
 * itself incomplete so the page says to send again.
 *
 * ── NEVER AFTER THE EFFECTIVE MOMENT ───────────────────────────────────────────
 * The email says "Until then the current version applies", which is false once the
 * version is in effect. A message that arrives at or after `effective_at` sends nothing,
 * logs an error naming the version and the company, and is acked. Every row of the
 * version still `queued` becomes `expired`, and `notice_enqueued_at` is cleared
 * (`markNoticeExpired`, with a system audit row), so `/admin/legal` shows the notice as not
 * completed. The re-send route refuses then too, and its own outcome write is guarded on
 * the version not yet being in effect.
 */

import { LegalAgreementDocumentSchema, type LegalAgreementDocument } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import {
  LEGAL_NOTICE_DELIVERY_REASONS,
  LegalNoticeDeliveryReasonSchema,
  type LegalExpeditedReason,
  type LegalNoticeDeliveries,
  type LegalNoticeDeliveryStatus,
  type LegalNoticeSendCounts,
} from '@aeci/shared';
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';

import { getDb, type Db } from '../db/client';
import {
  billingAccounts,
  legalNoticeDeliveries,
  legalVersions,
  licenses,
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
import { textAsc } from './collation';
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

/**
 * The kinds of live subscription a company holds: `monthly` is a live monthly card
 * subscription (`stripe`, no `ends_at`); `other` is any other live one (annual card,
 * invoice, complimentary, an activated grant).
 */
export async function liveSubscriptionKinds(
  db: Db,
  vendorId: string,
): Promise<{ monthly: boolean; other: boolean }> {
  const rows = await db
    .select({ source: licenses.source, endsAt: licenses.endsAt })
    .from(licenses)
    .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
    .where(and(eq(billingAccounts.vendorId, vendorId), isNull(licenses.endedAt)));
  const isMonthly = (r: { source: string; endsAt: string | null }) =>
    r.source === 'stripe' && r.endsAt === null;
  return { monthly: rows.some(isMonthly), other: rows.some((r) => !isMonthly(r)) };
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

// ─── The per-company delivery record ──────────────────────────────────────────

/** D1's cap on bound parameters in one statement. */
export const D1_MAX_BOUND_PARAMS = 100;
/**
 * Bound values Drizzle emits per row of the delivery upsert: legal_version_id, vendor_id,
 * status, attempts, last_reason, created_at, updated_at. Measured with `toSQL()`
 * (`legal-notice.spec.ts`), not counted by hand: the first build assumed 6 and sent 110.
 */
const DELIVERY_PARAMS_PER_ROW = 7;
/** Bound values of the conflict update: status, attempts, last_reason, updated_at, and the
 *  `status <> 'delivered'` guard. */
const DELIVERY_CONFLICT_PARAMS = 5;
/** Rows per upsert: 12 rows is 7 × 12 + 5 = 89 parameters, 11 under the cap. */
export const DELIVERY_UPSERT_CHUNK = Math.floor(
  (D1_MAX_BOUND_PARAMS - DELIVERY_CONFLICT_PARAMS - 10) / DELIVERY_PARAMS_PER_ROW,
);

type DeliveryReason = (typeof LEGAL_NOTICE_DELIVERY_REASONS)[number];

/** The companies already `delivered` for a version. They are skipped on a re-send. */
export async function loadDeliveredVendorIds(db: Db, legalVersionId: string): Promise<Set<string>> {
  const rows = await db
    .select({ vendorId: legalNoticeDeliveries.vendorId })
    .from(legalNoticeDeliveries)
    .where(
      and(
        eq(legalNoticeDeliveries.legalVersionId, legalVersionId),
        eq(legalNoticeDeliveries.status, 'delivered'),
      ),
    );
  return new Set(rows.map((r) => r.vendorId));
}

/**
 * Set the delivery row of each company to `status`, creating it when absent. A `delivered`
 * row is never moved back by a fan-out (`queued` or a fan-out's `dropped`): the `WHERE` on
 * the conflict update keeps it. Log-class (ADR 0022 amendment 2026-11-12): no audit row.
 * Throws only on a D1 error.
 */
export async function writeDeliveryRows(
  db: Db,
  legalVersionId: string,
  vendorIds: readonly string[],
  next: { status: LegalNoticeDeliveryStatus; attempts?: number; lastReason: DeliveryReason | null },
  now: Date,
  opts: { keepDelivered: boolean } = { keepDelivered: true },
): Promise<void> {
  if (vendorIds.length === 0) return;
  const stmts = [];
  for (let i = 0; i < vendorIds.length; i += DELIVERY_UPSERT_CHUNK) {
    stmts.push(
      deliveryUpsertStatement(
        db,
        legalVersionId,
        vendorIds.slice(i, i + DELIVERY_UPSERT_CHUNK),
        next,
        now,
        opts.keepDelivered,
      ),
    );
  }
  await db.batch(stmts as unknown as BatchTuple);
}

/** One multi-row upsert of the delivery record. Exported so a spec can measure its
 *  `toSQL().params` at `DELIVERY_UPSERT_CHUNK` rows. */
export function deliveryUpsertStatement(
  db: Db,
  legalVersionId: string,
  vendorIds: readonly string[],
  next: { status: LegalNoticeDeliveryStatus; attempts?: number; lastReason: DeliveryReason | null },
  now: Date,
  keepDelivered: boolean,
) {
  const at = now.toISOString();
  return db
    .insert(legalNoticeDeliveries)
    .values(
      vendorIds.map((vendorId) => ({
        legalVersionId,
        vendorId,
        status: next.status,
        attempts: next.attempts ?? 0,
        lastReason: next.lastReason,
        createdAt: at,
        updatedAt: at,
      })),
    )
    .onConflictDoUpdate({
      target: [legalNoticeDeliveries.legalVersionId, legalNoticeDeliveries.vendorId],
      set: {
        status: next.status,
        ...(next.attempts === undefined ? {} : { attempts: next.attempts }),
        lastReason: next.lastReason,
        updatedAt: at,
      },
      ...(keepDelivered ? { setWhere: ne(legalNoticeDeliveries.status, 'delivered') } : {}),
    });
}

/** How a fan-out went. */
export interface LegalNoticeFanOut {
  /** Companies to queue (the audience less those already delivered), or null when the
   *  audience read failed. */
  total: number | null;
  /** Companies whose message the queue accepted. */
  queued: number;
  /** Every company was queued. */
  complete: boolean;
  /**
   * Why it did not complete: `audience_read`, `unbound`, `send_batch`, or `delivery_record`
   * (every message went, but some delivery rows could not be written).
   */
  failure: 'audience_read' | 'unbound' | 'send_batch' | 'delivery_record' | null;
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
    const [audience, delivered] = await Promise.all([
      legalNoticeVendorIds(db, LegalAgreementDocumentSchema.parse(row.document)),
      loadDeliveredVendorIds(db, row.id),
    ]);
    // A re-send reaches only the companies not yet delivered.
    vendorIds = audience.filter((id) => !delivered.has(id));
  } catch (error) {
    countMetric('failed', 1);
    return fail('audience_read', null, 0, error);
  }
  if (vendorIds.length === 0) return { total: 0, queued: 0, complete: true, failure: null };

  /**
   * The delivery rows are a record. A failed write logs an error naming the version and the
   * email still goes, but the fan-out then reports itself incomplete (`delivery_record`), so
   * `notice_enqueued_at` stays NULL and the page says to send again, which rewrites the rows.
   */
  let recordFailed = false;
  const record = async (ids: readonly string[], status: 'queued' | 'dropped') => {
    try {
      await writeDeliveryRows(
        db,
        row.id,
        ids,
        { status, attempts: 0, lastReason: status === 'dropped' ? 'enqueue_failed' : null },
        now,
      );
    } catch (error) {
      recordFailed = true;
      logToPosthog(ctx, env, request, {
        level: 'error',
        message: `aeci.legal_notice: could not record ${ids.length} companies as ${status}; send the notice again from /admin/legal`,
        legal_version_id: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const queue = env.LEGAL_NOTICE_QUEUE;
  if (!queue) {
    countMetric('unbound', vendorIds.length);
    await record(vendorIds, 'dropped');
    return fail('unbound', vendorIds.length, 0, 'LEGAL_NOTICE_QUEUE is not bound');
  }
  const enqueuedAt = now.toISOString();
  let queued = 0;
  try {
    for (let i = 0; i < vendorIds.length; i += LEGAL_NOTICE_SEND_BATCH) {
      const chunk = vendorIds.slice(i, i + LEGAL_NOTICE_SEND_BATCH);
      // `queued` BEFORE the send, so the consumer's `delivered` can never be overwritten
      // by a later `queued` for the same company.
      await record(chunk, 'queued');
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
    // The failed chunk and every company after it were never queued.
    await record(vendorIds.slice(queued), 'dropped');
    return fail('send_batch', vendorIds.length, queued, error);
  }
  countMetric('ok', queued);
  if (recordFailed) {
    return fail('delivery_record', vendorIds.length, queued, 'delivery rows were not written');
  }
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

/**
 * The notice's addresses per version id, each counted once by the outcome of its LATEST
 * `notification_sends` row for that version (`duplicate` rows ignored). So an address that
 * failed and then went counts as sent only, and a retry never inflates any count.
 */
export async function loadNoticeSendCounts(
  db: Db,
  legalVersionIds: readonly string[],
): Promise<Map<string, LegalNoticeSendCounts>> {
  const out = new Map<string, LegalNoticeSendCounts>();
  const ids = [...new Set(legalVersionIds)];
  for (const id of ids) out.set(id, { ...EMPTY_COUNTS });
  if (ids.length === 0) return out;
  const rows = await db.all<{ id: string; outcome: string; n: number }>(sql`
    SELECT entity_id AS id, outcome, count(*) AS n FROM (
      SELECT entity_id, outcome,
             row_number() OVER (PARTITION BY entity_id, recipient_hash ORDER BY id DESC) AS rn
      FROM notification_sends
      WHERE notification_id = ${LEGAL_NOTICE_NOTIFICATION_ID}
        AND entity_type = ${LEGAL_NOTICE_ENTITY_TYPE}
        AND entity_id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
        AND outcome <> 'duplicate'
    )
    WHERE rn = 1
    GROUP BY entity_id, outcome`);
  for (const r of rows) {
    const counts = out.get(r.id);
    if (!counts) continue;
    if (r.outcome in counts) counts[r.outcome as keyof LegalNoticeSendCounts] += Number(r.n);
  }
  return out;
}

/** How many companies each list on the GET names, per version. */
export const NOT_REACHED_LIST_MAX = 100;

/**
 * A `queued` row untouched for this long before the effective moment has no live message
 * behind it: the consumer's retries are 10, 20 and 30 minutes apart, about an hour in all,
 * and each attempt rewrites `updated_at`. Two hours leaves room for a slow queue.
 */
export const STALE_QUEUED_MS = 2 * 60 * 60 * 1000;

const NOT_REACHED_STATUSES = ['dropped', 'expired', 'no_recipients'] as const;
const CHECK_REASONS = ['outcome_unknown', 'held_by_tier'] as const;

/**
 * The per-company delivery summary per version (`LegalNoticeDeliveriesSchema`).
 *
 * From the effective moment on, a row still `queued` can never be sent (the consumer and
 * the re-send both refuse), so it counts and lists as not reached, `expired` / `in_effect`.
 * Before it, a `queued` row untouched for {@link STALE_QUEUED_MS} is listed as stale so the
 * operator can send again while that still works. `delivered` rows with a reason to check
 * (an unknown outcome, or an address held by the tier's email rules) are listed too.
 */
export async function loadNoticeDeliveries(
  db: Db,
  versions: readonly Pick<LegalVersionRow, 'id' | 'effectiveAt'>[],
  now: Date,
): Promise<Map<string, LegalNoticeDeliveries>> {
  const out = new Map<string, LegalNoticeDeliveries>();
  const named = <T extends object>(
    r: T & { vendorId: string; name: string | null; slug: string | null },
  ) => ({
    vendor_id: r.vendorId,
    name: r.name ?? null,
    slug: r.slug ?? null,
  });
  const listRows = (where: SQL | undefined) =>
    db
      .select({
        vendorId: legalNoticeDeliveries.vendorId,
        name: vendors.companyName,
        slug: vendors.slug,
        status: legalNoticeDeliveries.status,
        reason: legalNoticeDeliveries.lastReason,
        updatedAt: legalNoticeDeliveries.updatedAt,
      })
      .from(legalNoticeDeliveries)
      .leftJoin(vendors, eq(vendors.id, legalNoticeDeliveries.vendorId))
      .where(where)
      .orderBy(textAsc(vendors.companyName), asc(legalNoticeDeliveries.vendorId))
      .limit(NOT_REACHED_LIST_MAX);

  for (const v of versions) {
    const inEffect = now.getTime() >= v.effectiveAt;
    const ofVersion = eq(legalNoticeDeliveries.legalVersionId, v.id);
    const counts = await db
      .select({
        status: legalNoticeDeliveries.status,
        reason: legalNoticeDeliveries.lastReason,
        n: count(),
      })
      .from(legalNoticeDeliveries)
      .where(ofVersion)
      .groupBy(legalNoticeDeliveries.status, legalNoticeDeliveries.lastReason);
    const by = (s: string) => counts.filter((c) => c.status === s).reduce((a, c) => a + c.n, 0);
    const queuedNow = by('queued');
    const notReachedStatuses: string[] = [...NOT_REACHED_STATUSES, ...(inEffect ? ['queued'] : [])];
    const notReached = notReachedStatuses.reduce((sum, s) => sum + by(s), 0);
    const toCheck = counts
      .filter(
        (c) =>
          c.status === 'delivered' && (CHECK_REASONS as readonly string[]).includes(c.reason ?? ''),
      )
      .reduce((a, c) => a + c.n, 0);
    const staleCutoff = new Date(now.getTime() - STALE_QUEUED_MS).toISOString();

    const notReachedRows =
      notReached === 0
        ? []
        : await listRows(and(ofVersion, inArray(legalNoticeDeliveries.status, notReachedStatuses)));
    const checkRows =
      toCheck === 0
        ? []
        : await listRows(
            and(
              ofVersion,
              eq(legalNoticeDeliveries.status, 'delivered'),
              inArray(legalNoticeDeliveries.lastReason, [...CHECK_REASONS]),
            ),
          );
    const staleRows =
      inEffect || queuedNow === 0
        ? []
        : await listRows(
            and(
              ofVersion,
              eq(legalNoticeDeliveries.status, 'queued'),
              lt(legalNoticeDeliveries.updatedAt, staleCutoff),
            ),
          );

    out.set(v.id, {
      total: counts.reduce((sum, c) => sum + c.n, 0),
      delivered: by('delivered'),
      pending: inEffect ? 0 : queuedNow,
      not_reached: notReached,
      not_reached_companies: notReachedRows.map((r) => {
        // A row still queued at the effective moment was never sent.
        const expired = r.status === 'queued';
        return {
          ...named(r),
          status: (expired ? 'expired' : r.status) as (typeof NOT_REACHED_STATUSES)[number],
          reason: expired
            ? ('in_effect' as const)
            : LegalNoticeDeliveryReasonSchema.safeParse(r.reason).success
              ? (r.reason as DeliveryReason)
              : null,
        };
      }),
      delivered_to_check: toCheck,
      delivered_to_check_companies: checkRows.map((r) => ({
        ...named(r),
        reason: r.reason as (typeof CHECK_REASONS)[number],
      })),
      stale_companies: staleRows.map((r) => ({ ...named(r), queued_since: r.updatedAt })),
    });
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

/**
 * Whether any send of this company's notice ended `unknown`: its ledger row keeps the
 * dedupe key, whose prefix is `legal-terms-change:{document}:{version}:{vendorId}:`.
 * Compared with `substr`, not `LIKE`, so `_` in `vendor_terms` is not a wildcard. Fails
 * open to false: the flag is advice, the delivery is already settled.
 */
async function hasUnknownSend(db: Db, keyPrefix: string): Promise<boolean> {
  try {
    const rows = await db.all<{ n: number }>(sql`
      SELECT count(*) AS n FROM notification_sends
      WHERE notification_id = ${LEGAL_NOTICE_NOTIFICATION_ID}
        AND outcome = 'unknown'
        AND substr(dedupe_key, 1, ${keyPrefix.length}) = ${keyPrefix}`);
    return Number(rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Every company of the version still `queued` when the version took effect was never
 * sent: mark them `expired` (`in_effect`). Log-class, no audit row. Throws on a D1 error.
 */
export async function expireQueuedDeliveries(
  db: Db,
  legalVersionId: string,
  now: Date,
): Promise<void> {
  await db
    .update(legalNoticeDeliveries)
    .set({ status: 'expired', lastReason: 'in_effect', updatedAt: now.toISOString() })
    .where(
      and(
        eq(legalNoticeDeliveries.legalVersionId, legalVersionId),
        eq(legalNoticeDeliveries.status, 'queued'),
      ),
    );
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

  const parsed = LegalNoticeMessageSchema.safeParse(message.body);
  if (!parsed.success) {
    metric('invalid');
    log('warn', 'aeci.legal_notice: dropped a message that is not a LegalNoticeMessage');
    message.ack();
    return;
  }
  const { legalVersionId, vendorId } = parsed.data;
  const ids = { legal_version_id: legalVersionId, vendor_id: vendorId };

  let db: Db | null = null;
  /**
   * Record this company's delivery row. A failed write logs an error naming the version and
   * the company and never blocks the ack. Only the `delivered` write may replace a row that
   * is already `delivered`: a late failure from an older message must not undo it.
   */
  const record = async (
    status: LegalNoticeDeliveryStatus,
    lastReason: DeliveryReason | null,
  ): Promise<void> => {
    if (!db) return;
    try {
      await writeDeliveryRows(
        db,
        legalVersionId,
        [vendorId],
        { status, attempts: message.attempts, lastReason },
        clock(),
        { keepDelivered: status !== 'delivered' },
      );
    } catch (error) {
      log('error', `aeci.legal_notice: could not record the company as ${status}`, {
        ...ids,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  /**
   * Log loud and retry. The company's row keeps `queued` with this attempt's reason; on the
   * last attempt it becomes `dropped`, and the queue drops the message after this.
   */
  const failLoud = async (
    outcome: DeliveryOutcome,
    reason: DeliveryReason,
    msg: string,
    extra: Record<string, unknown>,
  ) => {
    metric(outcome);
    const text = lastAttempt
      ? `${msg}; last attempt, the message is dropped. Send the notice again from /admin/legal`
      : msg;
    log('error', text, { ...extra, reason_code: reason });
    console.error(text, JSON.stringify(extra));
    await record(lastAttempt ? 'dropped' : 'queued', reason);
    message.retry({ delaySeconds: legalNoticeRetryDelaySeconds(message.attempts) });
  };

  try {
    db = dbFor(env, { constraint: 'first-primary' }).db;
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
      // This company too, even if it has no row yet (its queued write may have failed).
      await record('expired', 'in_effect');
      try {
        await expireQueuedDeliveries(db, row.id, clock());
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
      await failLoud(
        'no_site_url',
        'no_site_url',
        'aeci.legal_notice: PUBLIC_SITE_URL unset; the version link cannot be built, nothing sent',
        versionIds,
      );
      return;
    }
    const pdf = await loadVerifiedLegalPdf(env.UPLOADS, row);
    if (!pdf.ok) {
      await failLoud(
        'pdf_refused',
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
        await failLoud(
          'seats_unavailable',
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
      await record('no_recipients', null);
      message.ack();
      return;
    }
    const kinds =
      document === 'managed_plan' && row.requiresAcceptance
        ? await liveSubscriptionKinds(db, vendorId)
        : { monthly: false, other: false };
    const monthly = kinds.monthly;
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
    let skipped = 0;
    let unknown = 0;
    let held = 0;
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
        otherSubscriptions: closing === 'managed-monthly-accept' && kinds.other,
        pdfBase64,
        dedupeKey: legalNoticeDedupeKey(document, row.version, vendorId, await recipientHash(to)),
        entity: { type: LEGAL_NOTICE_ENTITY_TYPE, id: row.id },
      });
      if (outcome === 'failed') failed++;
      // No Resend key or sender on the tier: nothing went, and nothing holds a key.
      if (outcome === 'skipped') skipped++;
      if (outcome === 'unknown') unknown++;
      if (outcome === 'suppressed') held++;
    }
    if (failed > 0 || skipped > 0) {
      await failLoud(
        'partial_retry',
        failed > 0 ? 'send_failed' : 'email_not_configured',
        'aeci.legal_notice: some sends did not go; retrying those',
        { ...versionIds, failed, skipped, recipients: addresses.length },
      );
      return;
    }
    // Every recipient is sent, already sent (`duplicate`), may have gone (`unknown`, which
    // keeps its key) or was held by this tier's delivery policy (`suppressed`). The last two
    // are flagged on the row so the page lists the company under "with an address to check".
    // An `unknown` from an earlier attempt reads as `duplicate` now, so the ledger is asked.
    const anyUnknown =
      unknown > 0 ||
      (await hasUnknownSend(db, legalNoticeDedupeKey(document, row.version, vendorId, '')));
    await record('delivered', anyUnknown ? 'outcome_unknown' : held > 0 ? 'held_by_tier' : null);
    metric('sent');
    message.ack();
  } catch (error) {
    await failLoud('read_failed', 'read_failed', 'aeci.legal_notice: a read failed; retrying', {
      ...ids,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

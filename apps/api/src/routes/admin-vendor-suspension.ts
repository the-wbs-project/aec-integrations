/**
 * Suspend, then terminate (AECI-1623, counsel's Q13 and follow-up, Chris's ruling 1 of
 * 2026-11-05, `VENDOR_SIGNUP_PROCESS.md` §2; `ADMIN_PANEL_SPEC.md` §5.7).
 *
 * Suspend locks every seat out of the portal at once (`lib/authz.ts`). The listing stays
 * live and billing is untouched. A written notice names the rule and the evidence. Its
 * first confirmed send starts a window of 7 business days to cure or rebut. A failed send
 * leaves the suspension in place with no clock, and the operator re-sends.
 *
 * On a false-claim finding stage 1 did not resolve, stage 2 sends its own notice and a
 * further 7 business days run from its first confirmed send, to prove identity and
 * authority. Terminate is refused until the applicable stage has elapsed. No early path:
 * the window is also "show us we are wrong".
 *
 * The cost comes only from the server-stamped log, so it is provably contemporaneous.
 */

import {
  AbuseCostEntryRequestSchema,
  ApiErrorCode,
  LiftVendorSuspensionRequestSchema,
  StartSuspensionStage2RequestSchema,
  SuspendVendorRequestSchema,
  TerminateVendorRequestSchema,
  TerminationStatementSchema,
  VENDOR_SUSPENSION_WINDOW_BUSINESS_DAYS,
  VendorSuspensionStateResponseSchema,
  VendorSuspensionWriteResponseSchema,
  VoidAbuseCostEntryRequestSchema,
  type AbuseCostEntry,
  type TerminationStatement,
  type VendorSuspension,
  type VendorSuspensionKind,
  type VendorSuspensionStateResponse,
  type VendorSuspensionWriteResponse,
  type VendorTerminationPreview,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { licensePlanSnapshot } from '@aeci/shared/entitlements';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb, type Db } from '../db/client';
import {
  vendorAbuseCostEntries,
  vendors,
  vendorSuspensions,
  vendorTerminationRefunds,
} from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { vendorAuditStamp } from '../lib/audit-vendor';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { mergeRecipientAddresses } from '../lib/billing-recipients';
import { businessWindowEnd } from '../lib/business-days';
import {
  sendVendorSuspendedEmail,
  sendVendorSuspensionLiftedEmail,
  sendVendorTerminatedEmail,
  type EmailOutcome,
} from '../lib/email';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { recipientHash } from '../lib/hash';
import { loadVendorLicenses, type LicenseBefore } from '../lib/license';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { isProductionTier } from '../lib/notifications/delivery-policy';
import { loadOpenProposalIds } from '../lib/product-proposals';
import { stripeClientFromEnv } from '../lib/stripe';
import type { StripeClientFor } from '../lib/stripe-licenses';
import { fetchAuthUserEmails } from '../lib/supabase-admin';
import { isSeatsChangedError, seatRaceSentinels, seatsChangedError } from '../lib/vendor-handback';
import { loadVendorOwnerRecipients, type FetchSeatEmails } from '../lib/vendor-seat-recipients';
import {
  emailAfterTermination,
  loadVendorBillingEmails,
  loadVendorStripeCustomerIds,
  planTermination,
  readRefundablePayments,
  readTermEnds,
  runTerminationFollowups,
  settleTerminationRefunds,
  StripePaymentsUnavailable,
  type SendVendorTerminated,
} from '../lib/vendor-termination';
import {
  buildTerminationStatement,
  costLineCents,
  costTotalCents,
  grossRefundCents,
  type CostLogLine,
  type RefundablePayment,
} from '../lib/vendor-termination-refund';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;
type SuspensionRow = typeof vendorSuspensions.$inferSelect;
type CostEntryRow = typeof vendorAbuseCostEntries.$inferSelect;

export type SendVendorSuspended = typeof sendVendorSuspendedEmail;
export type SendVendorSuspensionLifted = typeof sendVendorSuspensionLiftedEmail;

const SOURCE = 'admin-moderation';

const defaultStripeFor: StripeClientFor = (env) => stripeClientFromEnv(env);

async function parseJsonBody<T>(c: AdminContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  return schema.parse(raw);
}

function vendorIdParam(c: AdminContext): string {
  const id = c.req.param('id');
  if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing vendor id', { field: 'id' });
  return id;
}

async function loadVendor(db: Db, vendorId: string) {
  const vendor = await db.query.vendors.findFirst({
    columns: { id: true, slug: true, companyName: true, verified: true, ownedAt: true },
    where: eq(vendors.id, vendorId),
  });
  if (!vendor) throw notFoundError('vendor', { id: vendorId });
  return vendor;
}

function loadOpenSuspension(db: Db, vendorId: string): Promise<SuspensionRow | undefined> {
  return db.query.vendorSuspensions.findFirst({
    where: and(eq(vendorSuspensions.vendorId, vendorId), isNull(vendorSuspensions.resolvedAt)),
  });
}

async function requireOpenSuspension(db: Db, vendorId: string): Promise<SuspensionRow> {
  const open = await loadOpenSuspension(db, vendorId);
  if (!open) {
    throw new ApiError(
      409,
      ApiErrorCode.VENDOR_SUSPENSION_STATE,
      'This vendor has no open suspension. Reload the page.',
    );
  }
  return open;
}

// ─── The window ──────────────────────────────────────────────────────────────

const stage1EndsAt = (row: Pick<SuspensionRow, 'noticeSentAt'>): string | null =>
  row.noticeSentAt
    ? businessWindowEnd(row.noticeSentAt, VENDOR_SUSPENSION_WINDOW_BUSINESS_DAYS)
    : null;

const stage2EndsAt = (row: Pick<SuspensionRow, 'stage2NoticeSentAt'>): string | null =>
  row.stage2NoticeSentAt
    ? businessWindowEnd(row.stage2NoticeSentAt, VENDOR_SUSPENSION_WINDOW_BUSINESS_DAYS)
    : null;

const passed = (end: string | null, nowMs: number): boolean =>
  end !== null && nowMs >= Date.parse(end);

const stage2Started = (row: SuspensionRow): boolean => row.stage2Finding !== null;

/** Why Terminate must wait, or null when the applicable stage has elapsed. */
function terminateRefusal(row: SuspensionRow, nowMs: number): string | null {
  if (!row.noticeSentAt) {
    return 'The notice has not been confirmed sent, so the window has not started. Re-send it.';
  }
  if (!passed(stage1EndsAt(row), nowMs)) {
    return 'The window of 7 business days is still open.';
  }
  if (row.kind === 'false_claim') {
    if (!stage2Started(row)) {
      return 'A false-claim suspension needs stage 2 first: 7 more business days to prove identity and authority.';
    }
    if (!row.stage2NoticeSentAt) {
      return 'The stage 2 notice has not been confirmed sent, so its window has not started. Re-send it.';
    }
    if (!passed(stage2EndsAt(row), nowMs)) {
      return 'The stage 2 window of 7 business days is still open.';
    }
  }
  return null;
}

// ─── The notice ──────────────────────────────────────────────────────────────

/**
 * Resend accepted this attempt (ruling 4). `unknown` (a timeout) and `duplicate` do not
 * count: the mail may never have gone. Outside production the delivery policy suppresses
 * outside recipients, so `suppressed` counts there, or the flow could never be tested on
 * staging. In production `suppressed` is never confirmed.
 */
function confirmedSend(c: AdminContext, outcome: EmailOutcome): boolean {
  if (outcome === 'sent') return true;
  return outcome === 'suppressed' && !isProductionTier(c.env);
}

/** The owner seats and the billing email, each address once. */
async function ownerAndBillingAddresses(
  c: AdminContext,
  db: Db,
  vendorId: string,
  fetchSeatEmails: FetchSeatEmails,
): Promise<string[]> {
  const [owners, billing] = await Promise.all([
    loadVendorOwnerRecipients(db, c.env, vendorId, fetchSeatEmails),
    loadVendorBillingEmails(db, vendorId),
  ]);
  return mergeRecipientAddresses([...owners.map((o) => o.email), ...billing], null);
}

/**
 * Sends one stage's notice and, on the first confirmed send, stamps it with its audit row
 * in one batch. The stamp is guarded, so only the first send starts the clock. Never
 * throws: a failure means no clock, and the operator re-sends.
 *
 * While no clock runs, each attempt after the first carries its own dedupe key. A timed-out
 * send holds the key, and a retry under it would answer `duplicate` forever, so the clock
 * could never start. No address is confirmed yet, so a second mail is the worse-case cost.
 * Once the clock runs the base key stands, so a resend reaches only addresses not reached.
 */
async function sendNotice(
  c: AdminContext,
  db: Db,
  row: SuspensionRow,
  stage: 1 | 2,
  vendorName: string,
  actor: { actorId: string; actorType: AuditLogEntry['actorType'] },
  fetchSeatEmails: FetchSeatEmails,
  send: SendVendorSuspended,
  isResend = false,
): Promise<boolean> {
  const stamped = stage === 1 ? row.noticeSentAt : row.stage2NoticeSentAt;
  const attemptAt = new Date().toISOString();
  const windowEndsAt = businessWindowEnd(
    stamped ?? attemptAt,
    VENDOR_SUSPENSION_WINDOW_BUSINESS_DAYS,
  );
  const attemptKey = isResend && !stamped ? `:retry:${attemptAt}` : '';
  let confirmed = false;
  try {
    const addresses = await ownerAndBillingAddresses(c, db, row.vendorId, fetchSeatEmails);
    for (const to of addresses) {
      try {
        const outcome = await send(c, {
          to,
          vendorName,
          stage,
          rule: row.rule,
          evidence: row.evidence,
          finding: stage === 2 ? row.stage2Finding : null,
          windowEndsAt,
          dedupeKey: `vendor-suspended:${row.id}:${stage}:${await recipientHash(to)}${attemptKey}`,
          entity: { type: 'vendor', id: row.vendorId },
        });
        if (confirmedSend(c, outcome)) confirmed = true;
      } catch (error) {
        console.warn('vendor-suspended send failed', error);
      }
    }
    if (confirmed && !stamped) {
      const entry: AuditLogEntry = {
        ...actor,
        action: 'vendor.suspension_notice_sent',
        vendorId: row.vendorId,
        entityType: 'vendor_suspension',
        entityId: row.id,
        beforeState: null,
        afterState: { stage, sent_at: attemptAt },
        metadata: { source: SOURCE, stage },
      };
      const column =
        stage === 1
          ? { noticeSentAt: attemptAt, updatedAt: attemptAt }
          : { stage2NoticeSentAt: attemptAt, updatedAt: attemptAt };
      const unstamped =
        stage === 1
          ? isNull(vendorSuspensions.noticeSentAt)
          : isNull(vendorSuspensions.stage2NoticeSentAt);
      await db.batch([
        db
          .update(vendorSuspensions)
          .set(column)
          .where(and(eq(vendorSuspensions.id, row.id), unstamped)),
        ...seatRaceSentinels(db, row.vendorId, null),
        auditInsert(db, entry),
      ] as BatchTuple);
      forwardAuditBatch(c, [entry], []);
    }
  } catch (error) {
    // A concurrent resend stamped first: its clock stands, and this send was confirmed.
    if (isSeatsChangedError(error)) return confirmed;
    console.warn('vendor suspension notice failed', error);
    return stamped !== null;
  }
  return confirmed || stamped !== null;
}

/** Awaited so the operator sees the answer, and held by `waitUntil` so a client that
 *  goes away cannot cancel a notice mid-send. */
function holdThrough<T>(c: AdminContext, work: Promise<T>): Promise<T> {
  c.executionCtx.waitUntil(work);
  return work;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

function toCostEntry(row: CostEntryRow): AbuseCostEntry {
  const kind = row.kind as AbuseCostEntry['kind'];
  return {
    id: row.id,
    kind,
    work_date: row.workDate,
    description: row.description,
    minutes: row.minutes,
    amount_cents: row.amountCents,
    cents: costLineCents(toCostLine(row)),
    logged_at: row.loggedAt,
    voided_at: row.voidedAt,
    void_reason: row.voidReason,
  };
}

function toCostLine(row: CostEntryRow): CostLogLine {
  return {
    kind: row.kind as CostLogLine['kind'],
    workDate: row.workDate,
    description: row.description,
    minutes: row.minutes,
    amountCents: row.amountCents,
    loggedAt: row.loggedAt,
  };
}

async function loadSuspensionsWithChildren(
  db: Db,
  rows: readonly SuspensionRow[],
  nowMs: number,
): Promise<VendorSuspension[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [entries, refunds] = await Promise.all([
    db
      .select()
      .from(vendorAbuseCostEntries)
      .where(inArray(vendorAbuseCostEntries.suspensionId, ids))
      .orderBy(asc(vendorAbuseCostEntries.loggedAt), asc(vendorAbuseCostEntries.id)),
    db
      .select()
      .from(vendorTerminationRefunds)
      .where(inArray(vendorTerminationRefunds.suspensionId, ids))
      .orderBy(asc(vendorTerminationRefunds.id)),
  ]);
  return rows.map((row): VendorSuspension => {
    const open = row.resolvedAt === null;
    const stage1End = stage1EndsAt(row);
    return {
      id: row.id,
      kind: row.kind as VendorSuspensionKind,
      rule: row.rule,
      evidence: row.evidence,
      reason: row.reason,
      suspended_at: row.suspendedAt,
      notice_sent_at: row.noticeSentAt,
      window_ends_at: stage1End,
      stage_2_finding: row.stage2Finding,
      stage_2_notice_sent_at: row.stage2NoticeSentAt,
      stage_2_ends_at: stage2EndsAt(row),
      can_start_stage_2: open && passed(stage1End, nowMs) && !stage2Started(row),
      can_terminate: open && terminateRefusal(row, nowMs) === null,
      cost_log: entries.filter((e) => e.suspensionId === row.id).map(toCostEntry),
      resolution: row.resolution as VendorSuspension['resolution'],
      resolved_at: row.resolvedAt,
      resolution_reason: row.resolutionReason,
      statement: row.statement ? TerminationStatementSchema.parse(row.statement) : null,
      refunds: refunds
        .filter((r) => r.suspensionId === row.id)
        .map((r) => ({
          id: r.id,
          status: r.status as VendorSuspension['refunds'][number]['status'],
          refund_cents: r.refundCents,
          currency: r.currency,
          stripe_refund_id: r.stripeRefundId,
        })),
    };
  });
}

/** The invoice-paid subscriptions Terminate needs an amount for. An open-ended one has no
 *  term to prorate, so it is left out. */
function manualLicenses(vendorLicenses: readonly LicenseBefore[]) {
  return vendorLicenses.filter(
    (l): l is LicenseBefore & { endsAt: string } =>
      l.endedAt === null && l.source === 'invoice' && l.endsAt !== null,
  );
}

function manualPayment(
  license: LicenseBefore & { endsAt: string },
  paidCents: number,
): RefundablePayment {
  return {
    key: `license:${license.id}`,
    source: 'invoice',
    paidCents,
    licenseId: license.id,
    stripeSubscriptionId: null,
    lines: [
      {
        amountCents: Math.max(paidCents, 1),
        periodStart: Math.floor(Date.parse(license.startsAt) / 1000),
        periodEnd: Math.floor(Date.parse(license.endsAt) / 1000),
      },
    ],
  };
}

export function createVendorSuspensionStateHandler(
  dbFor: DbFactory = getDb,
  stripeFor: StripeClientFor = defaultStripeFor,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const vendorId = vendorIdParam(c);
    const { db } = dbFor(c.env);
    await loadVendor(db, vendorId);
    const nowMs = Date.now();
    const rows = await db
      .select()
      .from(vendorSuspensions)
      .where(eq(vendorSuspensions.vendorId, vendorId))
      .orderBy(desc(vendorSuspensions.suspendedAt), asc(vendorSuspensions.id));
    const history = await loadSuspensionsWithChildren(db, rows, nowMs);
    const openRow = rows.find((r) => r.resolvedAt === null);
    const open = history.find((s) => s.resolved_at === null) ?? null;

    let preview: VendorTerminationPreview | null = null;
    if (openRow && open) {
      const vendorLicenses = await loadVendorLicenses(db, vendorId);
      const manual = manualLicenses(vendorLicenses).map((l) => ({
        license_id: l.id,
        reference: l.reference ?? null,
        starts_at: l.startsAt,
        ends_at: l.endsAt,
      }));
      const costTotal = costTotalCents(
        (
          await db
            .select()
            .from(vendorAbuseCostEntries)
            .where(
              and(
                eq(vendorAbuseCostEntries.suspensionId, openRow.id),
                isNull(vendorAbuseCostEntries.voidedAt),
              ),
            )
        ).map(toCostLine),
      );
      try {
        const customers = await loadVendorStripeCustomerIds(db, vendorId);
        const { payments, currency } = await readRefundablePayments(
          stripeFor(c.env),
          customers,
          Math.floor(Date.parse(openRow.suspendedAt) / 1000),
        );
        const { statement } = buildTerminationStatement({
          payments,
          costLog: [],
          suspendedAt: openRow.suspendedAt,
          currency,
        });
        preview = {
          available: true,
          currency,
          gross_cents: statement.gross_cents,
          cost_total_cents: costTotal,
          payments: statement.payments,
          manual_payments: manual,
        };
      } catch (error) {
        if (!(error instanceof StripePaymentsUnavailable)) throw error;
        preview = {
          available: false,
          currency: 'usd',
          gross_cents: 0,
          cost_total_cents: costTotal,
          payments: [],
          manual_payments: manual,
        };
      }
    }

    const body: VendorSuspensionStateResponse = { open, history, preview };
    validateResponseInDev(c.env, () => {
      VendorSuspensionStateResponseSchema.parse(body);
    });
    return json(body);
  };
}

async function respondWith(
  c: AdminContext,
  db: Db,
  suspensionId: string,
  noticeSent?: boolean,
): Promise<Response> {
  const row = await db.query.vendorSuspensions.findFirst({
    where: eq(vendorSuspensions.id, suspensionId),
  });
  if (!row) throw notFoundError('vendor_suspension', { id: suspensionId });
  const [suspension] = await loadSuspensionsWithChildren(db, [row], Date.now());
  const body: VendorSuspensionWriteResponse = {
    suspension: suspension!,
    ...(noticeSent === undefined ? {} : { notice_sent: noticeSent }),
  };
  validateResponseInDev(c.env, () => {
    VendorSuspensionWriteResponseSchema.parse(body);
  });
  return json(body);
}

// ─── Suspend, resend, stage 2 ────────────────────────────────────────────────

/** True for the partial unique index: a second open suspension. */
function isOpenSuspensionConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (String((current as Error).message ?? '').includes('vendor_suspensions')) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function createSuspendVendorHandler(
  dbFor: DbFactory = getDb,
  fetchSeatEmails: FetchSeatEmails = fetchAuthUserEmails,
  send: SendVendorSuspended = sendVendorSuspendedEmail,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const vendorId = vendorIdParam(c);
    const payload = await parseJsonBody(c, SuspendVendorRequestSchema);
    const session = c.get('auth');
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const { db } = writeDb(c, dbFor);
    const vendor = await loadVendor(db, vendorId);
    const alreadyOpen = () =>
      new ApiError(
        409,
        ApiErrorCode.VENDOR_SUSPENSION_STATE,
        'This vendor is already suspended. Reload the page.',
      );
    if (await loadOpenSuspension(db, vendorId)) throw alreadyOpen();

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const stamp = await vendorAuditStamp(db, vendorId);
    const entry: AuditLogEntry = {
      ...actor,
      action: 'vendor.suspended',
      ...stamp,
      vendorId,
      entityType: 'vendor_suspension',
      entityId: id,
      beforeState: null,
      afterState: { kind: payload.kind, rule: payload.rule, suspended_at: now },
      metadata: { source: SOURCE, reason: payload.reason },
    };
    try {
      await db.batch([
        db.insert(vendorSuspensions).values({
          id,
          vendorId,
          kind: payload.kind,
          rule: payload.rule,
          evidence: payload.evidence,
          reason: payload.reason,
          suspendedAt: now,
          suspendedBy: actor.actorId,
        }),
        auditInsert(db, entry),
      ]);
    } catch (error) {
      if (isOpenSuspensionConflict(error)) throw alreadyOpen();
      throw error;
    }
    forwardAuditBatch(c, [entry], []);

    const row = await requireOpenSuspension(db, vendorId);
    const sent = await holdThrough(
      c,
      sendNotice(c, db, row, 1, vendor.companyName, actor, fetchSeatEmails, send),
    );
    return respondWith(c, db, id, sent);
  };
}

export function createResendSuspensionNoticeHandler(
  dbFor: DbFactory = getDb,
  fetchSeatEmails: FetchSeatEmails = fetchAuthUserEmails,
  send: SendVendorSuspended = sendVendorSuspendedEmail,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const vendorId = vendorIdParam(c);
    const session = c.get('auth');
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const { db } = writeDb(c, dbFor);
    const vendor = await loadVendor(db, vendorId);
    const row = await requireOpenSuspension(db, vendorId);
    const stage = stage2Started(row) ? 2 : 1;
    const sent = await holdThrough(
      c,
      sendNotice(c, db, row, stage, vendor.companyName, actor, fetchSeatEmails, send, true),
    );
    return respondWith(c, db, row.id, sent);
  };
}

export function createStartSuspensionStage2Handler(
  dbFor: DbFactory = getDb,
  fetchSeatEmails: FetchSeatEmails = fetchAuthUserEmails,
  send: SendVendorSuspended = sendVendorSuspendedEmail,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const vendorId = vendorIdParam(c);
    const payload = await parseJsonBody(c, StartSuspensionStage2RequestSchema);
    const session = c.get('auth');
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const { db } = writeDb(c, dbFor);
    const vendor = await loadVendor(db, vendorId);
    const row = await requireOpenSuspension(db, vendorId);
    if (stage2Started(row)) {
      throw new ApiError(
        409,
        ApiErrorCode.VENDOR_SUSPENSION_STATE,
        'Stage 2 has already started. Reload the page.',
      );
    }
    if (!passed(stage1EndsAt(row), Date.now())) {
      throw new ApiError(
        409,
        ApiErrorCode.VENDOR_SUSPENSION_WINDOW_OPEN,
        'Stage 2 starts only after the stage 1 window of 7 business days has passed.',
      );
    }
    const now = new Date().toISOString();
    const entry: AuditLogEntry = {
      ...actor,
      action: 'vendor.suspension_stage_2_started',
      vendorId,
      entityType: 'vendor_suspension',
      entityId: row.id,
      beforeState: { kind: row.kind },
      afterState: { kind: 'false_claim', finding: payload.finding },
      metadata: { source: SOURCE },
    };
    try {
      await db.batch([
        db
          .update(vendorSuspensions)
          .set({ kind: 'false_claim', stage2Finding: payload.finding, updatedAt: now })
          .where(
            and(
              eq(vendorSuspensions.id, row.id),
              isNull(vendorSuspensions.resolvedAt),
              isNull(vendorSuspensions.stage2Finding),
            ),
          ),
        ...seatRaceSentinels(db, vendorId, null),
        auditInsert(db, entry),
      ] as BatchTuple);
    } catch (error) {
      if (isSeatsChangedError(error)) throw seatsChangedError();
      throw error;
    }
    forwardAuditBatch(c, [entry], []);
    const fresh = await requireOpenSuspension(db, vendorId);
    const sent = await holdThrough(
      c,
      sendNotice(c, db, fresh, 2, vendor.companyName, actor, fetchSeatEmails, send),
    );
    return respondWith(c, db, row.id, sent);
  };
}

// ─── The cost log ────────────────────────────────────────────────────────────

export function createAddAbuseCostEntryHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const vendorId = vendorIdParam(c);
    const payload = await parseJsonBody(c, AbuseCostEntryRequestSchema);
    const session = c.get('auth');
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const { db } = writeDb(c, dbFor);
    const row = await requireOpenSuspension(db, vendorId);
    const now = new Date().toISOString();
    if (payload.work_date > now.slice(0, 10)) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'A cost entry cannot be dated in the future', {
        field: 'work_date',
      });
    }
    const id = crypto.randomUUID();
    const entry: AuditLogEntry = {
      ...actor,
      action: 'vendor.abuse_cost_logged',
      vendorId,
      entityType: 'vendor_suspension',
      entityId: row.id,
      beforeState: null,
      afterState: { entry_id: id, ...payload },
      metadata: { source: SOURCE },
    };
    await db.batch([
      db.insert(vendorAbuseCostEntries).values({
        id,
        suspensionId: row.id,
        kind: payload.kind,
        workDate: payload.work_date,
        description: payload.description,
        minutes: payload.kind === 'staff' ? payload.minutes : null,
        amountCents: payload.kind === 'staff' ? null : payload.amount_cents,
        loggedAt: now,
        loggedBy: actor.actorId,
      }),
      auditInsert(db, entry),
    ]);
    forwardAuditBatch(c, [entry], []);
    return respondWith(c, db, row.id);
  };
}

export function createVoidAbuseCostEntryHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const vendorId = vendorIdParam(c);
    const entryId = c.req.param('entryId');
    const payload = await parseJsonBody(c, VoidAbuseCostEntryRequestSchema);
    const session = c.get('auth');
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const { db } = writeDb(c, dbFor);
    const row = await requireOpenSuspension(db, vendorId);
    const target = entryId
      ? await db.query.vendorAbuseCostEntries.findFirst({
          where: and(
            eq(vendorAbuseCostEntries.id, entryId),
            eq(vendorAbuseCostEntries.suspensionId, row.id),
            isNull(vendorAbuseCostEntries.voidedAt),
          ),
        })
      : undefined;
    if (!target) throw notFoundError('abuse_cost_entry', { id: entryId ?? '' });
    const now = new Date().toISOString();
    const entry: AuditLogEntry = {
      ...actor,
      action: 'vendor.abuse_cost_voided',
      vendorId,
      entityType: 'vendor_suspension',
      entityId: row.id,
      beforeState: { entry_id: target.id, voided_at: null },
      afterState: { entry_id: target.id, voided_at: now },
      metadata: { source: SOURCE, reason: payload.reason },
    };
    await db.batch([
      db
        .update(vendorAbuseCostEntries)
        .set({ voidedAt: now, voidedBy: actor.actorId, voidReason: payload.reason, updatedAt: now })
        .where(eq(vendorAbuseCostEntries.id, target.id)),
      auditInsert(db, entry),
    ]);
    forwardAuditBatch(c, [entry], []);
    return respondWith(c, db, row.id);
  };
}

// ─── Lift ────────────────────────────────────────────────────────────────────

export function createLiftVendorSuspensionHandler(
  dbFor: DbFactory = getDb,
  fetchSeatEmails: FetchSeatEmails = fetchAuthUserEmails,
  send: SendVendorSuspensionLifted = sendVendorSuspensionLiftedEmail,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const vendorId = vendorIdParam(c);
    const payload = await parseJsonBody(c, LiftVendorSuspensionRequestSchema);
    const session = c.get('auth');
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const { db } = writeDb(c, dbFor);
    const vendor = await loadVendor(db, vendorId);
    const row = await requireOpenSuspension(db, vendorId);
    const now = new Date().toISOString();
    const entry: AuditLogEntry = {
      ...actor,
      action: 'vendor.suspension_lifted',
      vendorId,
      entityType: 'vendor_suspension',
      entityId: row.id,
      beforeState: { resolution: null },
      afterState: { resolution: 'lifted', resolved_at: now },
      metadata: { source: SOURCE, reason: payload.reason },
    };
    try {
      await db.batch([
        db
          .update(vendorSuspensions)
          .set({
            resolution: 'lifted',
            resolvedAt: now,
            resolvedBy: actor.actorId,
            resolutionReason: payload.reason,
            updatedAt: now,
          })
          .where(and(eq(vendorSuspensions.id, row.id), isNull(vendorSuspensions.resolvedAt))),
        ...seatRaceSentinels(db, vendorId, null),
        auditInsert(db, entry),
      ] as BatchTuple);
    } catch (error) {
      if (isSeatsChangedError(error)) throw seatsChangedError();
      throw error;
    }
    forwardAuditBatch(c, [entry], []);
    c.executionCtx.waitUntil(
      (async () => {
        const addresses = await ownerAndBillingAddresses(c, db, vendorId, fetchSeatEmails);
        for (const to of addresses) {
          await send(c, {
            to,
            vendorName: vendor.companyName,
            dedupeKey: `vendor-suspension-lifted:${row.id}:${await recipientHash(to)}`,
            entity: { type: 'vendor', id: vendorId },
          });
        }
      })().catch((error: unknown) => console.warn('vendor-suspension-lifted failed', error)),
    );
    return respondWith(c, db, row.id);
  };
}

// ─── Terminate ───────────────────────────────────────────────────────────────

export function createTerminateVendorHandler(
  dbFor: DbFactory = getDb,
  stripeFor: StripeClientFor = defaultStripeFor,
  fetchSeatEmails: FetchSeatEmails = fetchAuthUserEmails,
  send: SendVendorTerminated = sendVendorTerminatedEmail,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const vendorId = vendorIdParam(c);
    const payload = await parseJsonBody(c, TerminateVendorRequestSchema);
    const session = c.get('auth');
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const { db } = writeDb(c, dbFor);
    const vendor = await loadVendor(db, vendorId);
    const row = await requireOpenSuspension(db, vendorId);

    const refusal = terminateRefusal(row, Date.now());
    if (refusal) {
      throw new ApiError(409, ApiErrorCode.VENDOR_SUSPENSION_WINDOW_OPEN, refusal);
    }

    const now = new Date().toISOString();
    const [vendorLicenses, openProposalIds, stripeCustomerIds, costRows] = await Promise.all([
      loadVendorLicenses(db, vendorId),
      loadOpenProposalIds(db, vendorId),
      loadVendorStripeCustomerIds(db, vendorId),
      db
        .select()
        .from(vendorAbuseCostEntries)
        .where(
          and(
            eq(vendorAbuseCostEntries.suspensionId, row.id),
            isNull(vendorAbuseCostEntries.voidedAt),
          ),
        )
        .orderBy(asc(vendorAbuseCostEntries.loggedAt), asc(vendorAbuseCostEntries.id)),
    ]);

    // Every invoice-paid subscription needs its amount typed. Stripe cannot say.
    const manual = manualLicenses(vendorLicenses);
    const paidByLicense = new Map(payload.manual_payments.map((m) => [m.license_id, m.paid_cents]));
    const unknownId = payload.manual_payments.find(
      (m) => !manual.some((l) => l.id === m.license_id),
    );
    const missing = manual.find((l) => !paidByLicense.has(l.id));
    if (unknownId || missing) {
      throw new ApiError(
        422,
        'VALIDATION_FAILED',
        'manual_payments must name each live invoice subscription exactly',
        { field: 'manual_payments' },
      );
    }

    // No Stripe read means no refund amount, so nothing is written.
    const stripe = stripeFor(c.env);
    const suspendedAtSeconds = Math.floor(Date.parse(row.suspendedAt) / 1000);
    let read: Awaited<ReturnType<typeof readRefundablePayments>>;
    try {
      read = await readRefundablePayments(stripe, stripeCustomerIds, suspendedAtSeconds);
    } catch (error) {
      if (error instanceof StripePaymentsUnavailable) {
        throw new ApiError(
          503,
          ApiErrorCode.VENDOR_TERMINATION_STRIPE_UNAVAILABLE,
          "We could not read this vendor's payments from Stripe, so nothing was saved. Try again shortly.",
        );
      }
      throw error;
    }

    const stripeGross = read.payments.reduce(
      (sum, p) => sum + grossRefundCents(p, suspendedAtSeconds),
      0,
    );
    const costLog = costRows.map(toCostLine);
    if (
      stripeGross !== payload.expected_gross_cents ||
      costTotalCents(costLog) !== payload.expected_cost_cents
    ) {
      throw new ApiError(
        409,
        ApiErrorCode.VENDOR_TERMINATION_REFUND_CHANGED,
        'The refund or the cost changed since this page loaded, so nothing was saved. Reload and check the new numbers.',
      );
    }

    const { allocations, statement } = buildTerminationStatement({
      payments: [
        ...read.payments,
        ...manual.map((l) => manualPayment(l, paidByLicense.get(l.id) ?? 0)),
      ],
      costLog,
      suspendedAt: row.suspendedAt,
      currency: read.currency,
    });

    const ending = vendorLicenses.filter((l) => l.endedAt === null);
    const { termEndById, subscriptions } = await readTermEnds(c, stripe, vendorId, ending);
    const vendorPlan = licensePlanSnapshot(vendorLicenses, now);
    const plan = await planTermination(db, {
      vendor: {
        id: vendor.id,
        slug: vendor.slug,
        companyName: vendor.companyName,
        verified: vendor.verified,
      },
      suspensionId: row.id,
      actor,
      now,
      vendorLicenses,
      ownedAtBefore: vendor.ownedAt,
      termEndById,
      subscriptions,
      stripeCustomerIds,
      openProposalIds,
      allocations,
      statement,
      vendorPlan,
    });

    try {
      await db.batch(plan.stmts as BatchStmt[] as BatchTuple);
    } catch (error) {
      if (isSeatsChangedError(error)) {
        const current = await loadOpenProposalIds(db, vendorId);
        if (current.join() !== openProposalIds.join()) {
          throw new ApiError(
            409,
            ApiErrorCode.VENDOR_PROPOSALS_CHANGED,
            'A new product proposal for this vendor arrived while the request ran, so nothing was saved. Reload and try again.',
          );
        }
        throw seatsChangedError();
      }
      throw error;
    }

    forwardAuditBatch(c, plan.audits, plan.transitions);
    runTerminationFollowups(c, db, plan, {
      suspensionId: row.id,
      statement,
      actor,
      stripeFor,
      fetchSeatEmails,
      send,
    });
    return respondWith(c, db, row.id);
  };
}

/** Retries `failed` and stranded `pending` refunds, then re-sends the statement. */
export function createRetryTerminationRefundsHandler(
  dbFor: DbFactory = getDb,
  stripeFor: StripeClientFor = defaultStripeFor,
  fetchSeatEmails: FetchSeatEmails = fetchAuthUserEmails,
  send: SendVendorTerminated = sendVendorTerminatedEmail,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const vendorId = vendorIdParam(c);
    const session = c.get('auth');
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const { db } = writeDb(c, dbFor);
    const vendor = await loadVendor(db, vendorId);
    const row = await db.query.vendorSuspensions.findFirst({
      where: and(
        eq(vendorSuspensions.vendorId, vendorId),
        eq(vendorSuspensions.resolution, 'terminated'),
      ),
      orderBy: [desc(vendorSuspensions.resolvedAt)],
    });
    if (!row) {
      throw new ApiError(
        409,
        ApiErrorCode.VENDOR_SUSPENSION_STATE,
        'This vendor has no terminated suspension to retry.',
      );
    }
    await settleTerminationRefunds(c, db, stripeFor(c.env), {
      vendorId,
      suspensionId: row.id,
      actor,
    });
    const statement: TerminationStatement = TerminationStatementSchema.parse(row.statement);
    await holdThrough(
      c,
      emailAfterTermination(c, db, {
        vendorId,
        vendorName: vendor.companyName,
        suspensionId: row.id,
        statement,
        products: [],
        subscriptionOutcomes: [],
        fetchSeatEmails,
        send,
      }),
    );
    return respondWith(c, db, row.id);
  };
}

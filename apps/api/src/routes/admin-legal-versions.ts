/**
 * `/admin/legal` publish (AECI-1688). Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.22,
 * `docs/API_CONTRACTS.md` §6.10 "Legal versions", `STAGE_1_SPEC.md` §27.5, ADR 0054.
 *
 *   GET  /api/admin/legal-versions              every upcoming version, its published row
 *                                               and its notice's send counts
 *   POST /api/admin/legal-versions              publish one upcoming version
 *   POST /api/admin/legal-versions/:id/notice   send the change notice again (AECI-1620)
 *
 * All behind `requireAdmin()` in `index.ts`. The two POSTs also carry `rateLimit('write')`
 * after the guard (`waf-rate-limits.md` §6.2). The GET is a read: no audit row, no limiter.
 *
 * ─── The POST, in order ───────────────────────────────────────────────────────
 *
 *   0. `LEGAL_PUBLISH_ENABLED` is "true" on this tier, else 409 `LEGAL_PUBLISH_DISABLED`.
 *      Then the body (400 on a non-JSON body or a schema miss).
 *   1. The version is the document's entry in `LEGAL_AGREEMENT_UPCOMING_VERSIONS` or, for
 *      the Terms of Service and the Privacy Policy (AECI-1637), in
 *      `LEGAL_READER_UPCOMING_VERSIONS`, else 422 `LEGAL_VERSION_NOT_UPCOMING`. The
 *      effective moment comes from that entry. The body schema already refused
 *      `requires_acceptance` on a Privacy version and an expedited reason on anything but
 *      the Vendor Terms (400).
 *   2. No `legal_versions` row exists for it yet, else 409 `LEGAL_VERSION_EXISTS`.
 *   3. It takes effect at least 30 days from now, else 422 `LEGAL_NOTICE_WINDOW`. A
 *      Vendor Terms version with an expedited reason (`law` or `error`) only has to be
 *      in the future. The reason is recorded only when the window needed it.
 *      `details.reason` is `passed` (the moment is not in the future: move the date)
 *      or `too_soon` (inside 30 days: move it, or expedite a Vendor Terms change).
 *   4. The CI-built PDF is in `UPLOADS` at `legal/<slug>/v<version>.pdf`, starts with
 *      `%PDF-` and is at most 5 MB, else 409 `LEGAL_PDF_MISSING`. The key is built from
 *      the upcoming map's entry, never from the request. Its sha256 is recorded.
 *   5. ONE `db.batch`: the `legal_versions` insert and its `legal_version.published` audit
 *      row (§26.1). A lost race on the unique `(document, version)` index is the same 409.
 *   6. Post-commit: the audit forward. Then, for a MATERIAL version only, in `waitUntil`:
 *      the change-notice fan-out (`fanOutLegalNotice`, AECI-1620), one queue message per
 *      affected company, or for a Terms or Privacy version `fanOutReaderLegalNotice`
 *      (AECI-1637), one message per 25 accounts, and ONE `db.batch` that records its
 *      outcome on the row
 *      (`notice_enqueued_at`, `notice_vendor_count`) with a `legal_version.notice_queued`
 *      audit row. A non-material version enqueues nothing and both columns stay NULL. A
 *      failed audience read or queue send leaves `notice_enqueued_at` NULL with the count
 *      queued so far, which `/admin/legal` shows as "did not finish". No cache purge. Since
 *      AECI-1689 the legal pages read the row (`GET /api/legal/published`), but only from
 *      its effective moment, and a page's TTL already ends at that moment. A publish is
 *      refused once the moment has passed, so it can never change a cached page.
 *
 * ─── The re-send, in order ────────────────────────────────────────────────────
 *
 *   0. `LEGAL_PUBLISH_ENABLED`, as above (409 `LEGAL_PUBLISH_DISABLED`).
 *   1. The row exists (404 `NOT_FOUND`), is material (409 `LEGAL_NOTICE_NOT_MATERIAL`)
 *      and has not taken effect (422 `LEGAL_NOTICE_TOO_LATE`: the email says it has not).
 *   2. The fan-out, awaited, then ONE `db.batch`: the outcome columns and the
 *      `legal_version.notice_resent` audit row. Safe to repeat: each address's send is
 *      keyed with the company id (or, for a reader version, the account id) in
 *      `notification_sends`, so no address gets two, and `delivered` companies or
 *      accounts are skipped.
 *   3. An incomplete fan-out is recorded first, then answered 503
 *      `LEGAL_NOTICE_ENQUEUE_FAILED`. A complete one answers 200 with the row.
 */

import {
  AdminLegalVersionsResponseSchema,
  ApiErrorCode,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_AGREEMENT_UPCOMING_VERSIONS,
  LEGAL_NOTICE_WINDOW_DAYS,
  LEGAL_PUBLISHABLE_DOCUMENTS,
  LEGAL_READER_CURRENT_VERSIONS,
  LEGAL_READER_UPCOMING_VERSIONS,
  isLegalReaderDocument,
  PublishLegalVersionRequestSchema,
  PublishLegalVersionResponseSchema,
  ResendLegalNoticeResponseSchema,
  legalEffectiveAtMs,
  legalPdfKey,
  type AdminLegalUpcomingEntry,
  type AdminLegalVersionsResponse,
  type LegalAgreementUpcomingVersion,
  type LegalPublishableDocument,
  type LegalNoticeWindowReason,
  type PublishLegalVersionResponse,
  type ResendLegalNoticeResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import { legalVersions } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  fanOutLegalNotice,
  fanOutReaderLegalNotice,
  LEGAL_READER_NOTICE_NOTIFICATION_ID,
  loadNoticeDeliveries,
  loadNoticeSendCounts,
  loadReaderNoticeDeliveries,
  noticeOutcomeColumns,
  type LegalNoticeFanOut,
} from '../lib/legal-notice';
import {
  loadLegalVersion,
  loadLegalVersionById,
  readLegalPdf,
  toLegalVersion,
  type LegalPdfProblem,
  type LegalVersionRow,
} from '../lib/legal-versions';
import { forwardAuditBatch } from '../lib/moderation-forward';

type LegalContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** `audit_log.action` of a publish. */
export const LEGAL_VERSION_PUBLISHED_ACTION = 'legal_version.published';
/** `audit_log.entity_type` of a publish. */
export const LEGAL_VERSION_ENTITY_TYPE = 'legal_version';
/** `audit_log.action` of the publish's notice fan-out outcome (AECI-1620). */
export const LEGAL_VERSION_NOTICE_QUEUED_ACTION = 'legal_version.notice_queued';
/** `audit_log.action` of an admin re-send of the notice (AECI-1620). */
export const LEGAL_VERSION_NOTICE_RESENT_ACTION = 'legal_version.notice_resent';

const AUDIT_SOURCE = 'admin-legal-versions';
const DAY_MS = 86_400_000;

type UpcomingMap = Readonly<
  Partial<Record<LegalPublishableDocument, LegalAgreementUpcomingVersion>>
>;

/** The shared upcoming maps, agreements and (AECI-1637) the two reader documents. */
const SHARED_UPCOMING: UpcomingMap = {
  ...LEGAL_AGREEMENT_UPCOMING_VERSIONS,
  ...LEGAL_READER_UPCOMING_VERSIONS,
};

/** The build version an upcoming entry replaces. */
function currentVersionOf(document: LegalPublishableDocument): string {
  return isLegalReaderDocument(document)
    ? LEGAL_READER_CURRENT_VERSIONS[document]
    : LEGAL_AGREEMENT_CURRENT_VERSIONS[document];
}

/** "companies" for an agreement notice, "accounts" for a reader one (AECI-1637). */
function audienceNoun(document: string): string {
  return isLegalReaderDocument(document) ? 'accounts' : 'companies';
}

export interface AdminLegalVersionsDeps {
  now?: () => Date;
  /** The upcoming map. Injected so specs need not edit the shared constant. */
  upcoming?: UpcomingMap;
}

/** The tier's publish switch. Only `"true"` is on. */
export function legalPublishEnabled(env: Pick<Env, 'LEGAL_PUBLISH_ENABLED'>): boolean {
  return env.LEGAL_PUBLISH_ENABLED === 'true';
}

/** `GET /api/admin/legal-versions`. */
export function createAdminLegalVersionsHandler(
  dbFor: DbFactory = getDb,
  deps: AdminLegalVersionsDeps = {},
): (c: LegalContext) => Promise<Response> {
  const upcomingMap = deps.upcoming ?? SHARED_UPCOMING;
  return async (c) => {
    const entries = LEGAL_PUBLISHABLE_DOCUMENTS.flatMap((document) => {
      const u = upcomingMap[document];
      return u ? [{ document, upcoming: u }] : [];
    });
    const { db } = dbFor(c.env);
    const rows: LegalVersionRow[] =
      entries.length === 0
        ? []
        : await db
            .select()
            .from(legalVersions)
            .where(
              inArray(
                legalVersions.document,
                entries.map((e) => e.document),
              ),
            );
    const shown = entries.flatMap(({ document, upcoming: u }) => {
      const row = rows.find((r) => r.document === document && r.version === u.version);
      return row ? [row] : [];
    });
    // AECI-1637: a reader version's sends are `legal-account-change` and its delivery
    // record is per account, so the two audiences are counted from their own rows.
    const now = (deps.now ?? (() => new Date()))();
    const vendorShown = shown.filter((r) => !isLegalReaderDocument(r.document));
    const readerShown = shown.filter((r) => isLegalReaderDocument(r.document));
    const [vendorCounts, readerCounts, vendorDeliveries, readerDeliveries] = await Promise.all([
      loadNoticeSendCounts(
        db,
        vendorShown.map((r) => r.id),
      ),
      loadNoticeSendCounts(
        db,
        readerShown.map((r) => r.id),
        LEGAL_READER_NOTICE_NOTIFICATION_ID,
      ),
      loadNoticeDeliveries(db, vendorShown, now),
      loadReaderNoticeDeliveries(db, readerShown, now),
    ]);
    const counts = new Map([...vendorCounts, ...readerCounts]);
    const deliveries = new Map([...vendorDeliveries, ...readerDeliveries]);
    const upcoming: AdminLegalUpcomingEntry[] = entries.map(({ document, upcoming: u }) => {
      const row = shown.find((r) => r.document === document && r.version === u.version) ?? null;
      const at = legalEffectiveAtMs(u.effectiveOn);
      return {
        document,
        version: u.version,
        effective_on: u.effectiveOn,
        effective_at: Number.isNaN(at) ? '' : new Date(at).toISOString(),
        current_version: currentVersionOf(document),
        published: row ? toLegalVersion(row) : null,
        notice_sends: row ? (counts.get(row.id) ?? null) : null,
        notice_deliveries: row ? (deliveries.get(row.id) ?? null) : null,
      };
    });
    const body: AdminLegalVersionsResponse = {
      publish_enabled: legalPublishEnabled(c.env),
      upcoming,
    };
    validateResponseInDev(c.env, () => {
      AdminLegalVersionsResponseSchema.parse(body);
    });
    return json(body);
  };
}

/** The unique `(document, version)` index refused the insert: another publish won. */
export function isDuplicateVersionError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const message = String((current as { message?: unknown }).message ?? current);
    if (
      /legal_versions_document_version_key|UNIQUE constraint failed: legal_versions/i.test(message)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const PDF_PROBLEM_TEXT: Record<LegalPdfProblem, string> = {
  missing: 'No PDF is stored for this version. Run the legal-pdf workflow for it first.',
  not_pdf: 'The stored file is not a PDF.',
  too_large: 'The stored PDF is over 5 MB.',
  unbound: 'The UPLOADS bucket is not bound on this tier.',
};

/** `POST /api/admin/legal-versions`. */
export function createPublishLegalVersionHandler(
  dbFor: DbFactory = getDb,
  deps: AdminLegalVersionsDeps = {},
): (c: LegalContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  const upcomingMap = deps.upcoming ?? SHARED_UPCOMING;
  return async (c) => {
    // ── 0. The tier's switch, then the body ───────────────────────────────────
    if (!legalPublishEnabled(c.env)) {
      throw new ApiError(
        409,
        ApiErrorCode.LEGAL_PUBLISH_DISABLED,
        'Publishing a legal version is turned off on this tier (LEGAL_PUBLISH_ENABLED).',
      );
    }
    const session = c.get('auth');
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
    }
    const payload = PublishLegalVersionRequestSchema.parse(raw);
    const { document } = payload;
    const now = clock();

    // ── 1. Upcoming ──────────────────────────────────────────────────────────
    const upcoming = upcomingMap[document];
    const effectiveAt = upcoming ? legalEffectiveAtMs(upcoming.effectiveOn) : Number.NaN;
    if (!upcoming || upcoming.version !== payload.version || Number.isNaN(effectiveAt)) {
      throw new ApiError(
        422,
        ApiErrorCode.LEGAL_VERSION_NOT_UPCOMING,
        `That version of ${document} is not listed as upcoming.`,
        { field: 'version' },
      );
    }
    // From here on the version is the code constant's, never the request's.
    const version = upcoming.version;

    // ── 2. Not yet published ─────────────────────────────────────────────────
    const { db } = writeDb(c, dbFor);
    const duplicate = () =>
      new ApiError(
        409,
        ApiErrorCode.LEGAL_VERSION_EXISTS,
        `Version ${version} of ${document} is already published.`,
        { field: 'version' },
      );
    if (await loadLegalVersion(db, document, version)) throw duplicate();

    // ── 3. The notice window ─────────────────────────────────────────────────
    const nowMs = now.getTime();
    const windowMet = effectiveAt - nowMs >= LEGAL_NOTICE_WINDOW_DAYS * DAY_MS;
    const expedited = document === 'vendor_terms' ? (payload.expedited_reason ?? null) : null;
    if (!windowMet && !(expedited && effectiveAt > nowMs)) {
      // `details.reason` tells the page which advice to give: a date already passed is
      // only fixed by moving it, while a date inside the window may also be expedited.
      const reason: LegalNoticeWindowReason = effectiveAt <= nowMs ? 'passed' : 'too_soon';
      throw new ApiError(
        422,
        ApiErrorCode.LEGAL_NOTICE_WINDOW,
        reason === 'passed'
          ? `Version ${version} takes effect on ${upcoming.effectiveOn} at 12:00 UTC, which has already passed. Move the effective date; an expedited reason does not help.`
          : `Version ${version} takes effect on ${upcoming.effectiveOn} at 12:00 UTC, less than ${LEGAL_NOTICE_WINDOW_DAYS} days away. Move the effective date, or for the Vendor Terms give an expedited reason.`,
        { field: 'version', details: { reason } },
      );
    }

    // ── 4. The PDF ───────────────────────────────────────────────────────────
    const pdfKey = legalPdfKey(document, version);
    const pdf = await readLegalPdf(c.env.UPLOADS, pdfKey);
    if (!pdf.ok) {
      throw new ApiError(409, ApiErrorCode.LEGAL_PDF_MISSING, PDF_PROBLEM_TEXT[pdf.problem], {
        details: { pdf_key: pdfKey, problem: pdf.problem },
      });
    }

    // ── 5. ONE batch ─────────────────────────────────────────────────────────
    const row: LegalVersionRow = {
      id: crypto.randomUUID(),
      document,
      version,
      effectiveAt,
      summaryJson: JSON.stringify(payload.summary),
      material: payload.material,
      requiresAcceptance: payload.requires_acceptance,
      // Recorded only when the window needed it, so a later notice never calls a
      // version expedited that gave the full 30 days.
      expeditedReason: windowMet ? null : expedited,
      pdfKey,
      pdfSha256: pdf.sha256,
      pdfBytes: pdf.bytes,
      publishedBy: session.userId,
      publishedAt: now.toISOString(),
      noticeEnqueuedAt: null,
      noticeVendorCount: null,
    };
    const entry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: LEGAL_VERSION_PUBLISHED_ACTION,
      entityType: LEGAL_VERSION_ENTITY_TYPE,
      entityId: row.id,
      beforeState: null,
      afterState: {
        document,
        version,
        effective_at: new Date(effectiveAt).toISOString(),
        material: row.material,
        requires_acceptance: row.requiresAcceptance,
        summary: payload.summary,
        expedited_reason: row.expeditedReason,
        pdf_key: pdfKey,
        pdf_sha256: row.pdfSha256,
        pdf_bytes: row.pdfBytes,
      },
      metadata: { source: AUDIT_SOURCE },
    };
    try {
      await db.batch([db.insert(legalVersions).values(row), auditInsert(db, entry)] as BatchTuple);
    } catch (error) {
      if (isDuplicateVersionError(error)) throw duplicate();
      throw error;
    }

    // ── 6. Post-commit ───────────────────────────────────────────────────────
    forwardAuditBatch(c, [entry], [], AUDIT_SOURCE);
    if (row.material) {
      c.executionCtx.waitUntil(
        recordNoticeFanOut(c, db, row, LEGAL_VERSION_NOTICE_QUEUED_ACTION, clock).catch(
          (error: unknown) => {
            // The fan-out never throws; only the outcome batch can. The row then keeps
            // both columns NULL, which the page shows as "not recorded": send again.
            console.error(
              `admin-legal-versions: the notice outcome for ${row.id} was not recorded:`,
              error instanceof Error ? error.message : String(error),
            );
          },
        ),
      );
    }

    const body: PublishLegalVersionResponse = { legal_version: toLegalVersion(row) };
    validateResponseInDev(c.env, () => {
      PublishLegalVersionResponseSchema.parse(body);
    });
    return json(body, { status: 201 });
  };
}

// ─── The change notice (AECI-1620) ────────────────────────────────────────────

/**
 * Fan the notice out, then record the outcome on the row with its audit row in ONE
 * `db.batch`. The fan-out never throws. The batch can, and the caller decides what that
 * means. Returns the fan-out and the row as written.
 */
async function recordNoticeFanOut(
  c: LegalContext,
  db: Db,
  row: LegalVersionRow,
  action: typeof LEGAL_VERSION_NOTICE_QUEUED_ACTION | typeof LEGAL_VERSION_NOTICE_RESENT_ACTION,
  clock: () => Date,
): Promise<{ fan: LegalNoticeFanOut; updated: LegalVersionRow }> {
  const session = c.get('auth');
  const target = { env: c.env, ctx: c.executionCtx, request: c.req.raw };
  // AECI-1637: a Terms of Service or Privacy Policy version goes to every account.
  const fan = isLegalReaderDocument(row.document)
    ? await fanOutReaderLegalNotice(target, db, row, clock())
    : await fanOutLegalNotice(target, db, row, clock());
  const now = clock();
  const columns = noticeOutcomeColumns(fan, now);
  // A fan-out that ends after the effective moment must not stamp "queued" over the
  // consumer's expired mark. D1 has no transaction, so the guard is in the UPDATE itself
  // (`effective_at > now`); this flag only tells the audit row what was intended.
  const inEffect = now.getTime() >= row.effectiveAt;
  const entry: AuditLogEntry = {
    actorId: session.userId,
    actorType: auditActorType(session),
    action,
    entityType: LEGAL_VERSION_ENTITY_TYPE,
    entityId: row.id,
    beforeState: {
      notice_enqueued_at: row.noticeEnqueuedAt ?? null,
      notice_vendor_count: row.noticeVendorCount ?? null,
    },
    afterState: {
      notice_enqueued_at: columns.noticeEnqueuedAt,
      notice_vendor_count: columns.noticeVendorCount,
      audience: fan.total,
      complete: fan.complete,
      failure: fan.failure,
      outcome_written: !inEffect,
    },
    metadata: {
      source: AUDIT_SOURCE,
      document: row.document,
      version: row.version,
      guard: 'written only while effective_at > now',
    },
  };
  await db.batch([
    db
      .update(legalVersions)
      .set(columns)
      .where(and(eq(legalVersions.id, row.id), gt(legalVersions.effectiveAt, now.getTime()))),
    auditInsert(db, entry),
  ] as BatchTuple);
  forwardAuditBatch(c, [entry], [], AUDIT_SOURCE);
  return { fan, updated: inEffect ? row : { ...row, ...columns } };
}

/** `POST /api/admin/legal-versions/:id/notice`: send the change notice again. */
export function createResendLegalNoticeHandler(
  dbFor: DbFactory = getDb,
  deps: Pick<AdminLegalVersionsDeps, 'now'> = {},
): (c: LegalContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  return async (c) => {
    // ── 0. The tier's switch ──────────────────────────────────────────────────
    if (!legalPublishEnabled(c.env)) {
      throw new ApiError(
        409,
        ApiErrorCode.LEGAL_PUBLISH_DISABLED,
        'Sending a legal notice is turned off on this tier (LEGAL_PUBLISH_ENABLED).',
      );
    }
    // ── 1. A material version that has not taken effect ───────────────────────
    const id = c.req.param('id') ?? '';
    const { db } = writeDb(c, dbFor);
    const row = id ? await loadLegalVersionById(db, id) : null;
    if (!row) throw notFoundError('legal_version', { id });
    if (!row.material) {
      throw new ApiError(
        409,
        ApiErrorCode.LEGAL_NOTICE_NOT_MATERIAL,
        `Version ${row.version} of ${row.document} is not a material change, so it has no notice.`,
      );
    }
    if (row.effectiveAt <= clock().getTime()) {
      throw new ApiError(
        422,
        ApiErrorCode.LEGAL_NOTICE_TOO_LATE,
        `Version ${row.version} of ${row.document} has already taken effect.`,
      );
    }

    // ── 2. Fan out, then record ──────────────────────────────────────────────
    const { fan, updated } = await recordNoticeFanOut(
      c,
      db,
      row,
      LEGAL_VERSION_NOTICE_RESENT_ACTION,
      clock,
    );

    // ── 3. Answer ────────────────────────────────────────────────────────────
    if (!fan.complete) {
      throw new ApiError(
        503,
        ApiErrorCode.LEGAL_NOTICE_ENQUEUE_FAILED,
        `The notice was queued for ${fan.queued} of ${fan.total ?? 'an unknown number of'} ${audienceNoun(row.document)}. Send it again.`,
        { details: { queued: fan.queued, total: fan.total, failure: fan.failure } },
      );
    }
    const body: ResendLegalNoticeResponse = { legal_version: toLegalVersion(updated) };
    validateResponseInDev(c.env, () => {
      ResendLegalNoticeResponseSchema.parse(body);
    });
    return json(body);
  };
}

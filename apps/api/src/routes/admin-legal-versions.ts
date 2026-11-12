/**
 * `/admin/legal` publish (AECI-1688). Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.22,
 * `docs/API_CONTRACTS.md` §6.10 "Legal versions", `STAGE_1_SPEC.md` §27.5, ADR 0054.
 *
 *   GET  /api/admin/legal-versions   every upcoming version and its published row
 *   POST /api/admin/legal-versions   publish one upcoming version
 *
 * Both behind `requireAdmin()` in `index.ts`. The POST also carries `rateLimit('write')`
 * after the guard (`waf-rate-limits.md` §6.2). The GET is a read: no audit row, no limiter.
 *
 * ─── The POST, in order ───────────────────────────────────────────────────────
 *
 *   0. `LEGAL_PUBLISH_ENABLED` is "true" on this tier, else 409 `LEGAL_PUBLISH_DISABLED`.
 *      Then the body (400 on a non-JSON body or a schema miss).
 *   1. The version is the document's entry in `LEGAL_AGREEMENT_UPCOMING_VERSIONS`, else
 *      422 `LEGAL_VERSION_NOT_UPCOMING`. The effective moment comes from that entry.
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
 *   6. Post-commit, in `waitUntil`: the audit forward. Nothing else. The publish sends no
 *      email and enqueues nothing (AECI-1620 adds the notice). No cache purge: no public
 *      page reads `legal_versions`.
 */

import {
  AdminLegalVersionsResponseSchema,
  ApiErrorCode,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_AGREEMENT_DOCUMENTS,
  LEGAL_AGREEMENT_UPCOMING_VERSIONS,
  LEGAL_NOTICE_WINDOW_DAYS,
  PublishLegalVersionRequestSchema,
  PublishLegalVersionResponseSchema,
  legalEffectiveAtMs,
  legalPdfKey,
  type AdminLegalUpcomingEntry,
  type AdminLegalVersionsResponse,
  type LegalAgreementDocument,
  type LegalAgreementUpcomingVersion,
  type LegalNoticeWindowReason,
  type PublishLegalVersionResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { inArray } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { legalVersions } from '../db/schema';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  loadLegalVersion,
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

const AUDIT_SOURCE = 'admin-legal-versions';
const DAY_MS = 86_400_000;

type UpcomingMap = Readonly<Partial<Record<LegalAgreementDocument, LegalAgreementUpcomingVersion>>>;

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
  const upcomingMap = deps.upcoming ?? LEGAL_AGREEMENT_UPCOMING_VERSIONS;
  return async (c) => {
    const entries = LEGAL_AGREEMENT_DOCUMENTS.flatMap((document) => {
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
    const upcoming: AdminLegalUpcomingEntry[] = entries.map(({ document, upcoming: u }) => {
      const row = rows.find((r) => r.document === document && r.version === u.version) ?? null;
      const at = legalEffectiveAtMs(u.effectiveOn);
      return {
        document,
        version: u.version,
        effective_on: u.effectiveOn,
        effective_at: Number.isNaN(at) ? '' : new Date(at).toISOString(),
        current_version: LEGAL_AGREEMENT_CURRENT_VERSIONS[document],
        published: row ? toLegalVersion(row) : null,
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
  const upcomingMap = deps.upcoming ?? LEGAL_AGREEMENT_UPCOMING_VERSIONS;
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

    const body: PublishLegalVersionResponse = { legal_version: toLegalVersion(row) };
    validateResponseInDev(c.env, () => {
      PublishLegalVersionResponseSchema.parse(body);
    });
    return json(body, { status: 201 });
  };
}

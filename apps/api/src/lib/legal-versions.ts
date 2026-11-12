/**
 * Published legal versions (AECI-1688, `STAGE_1_SPEC.md` §27.5, `DATABASE_SCHEMA.md`
 * §8.6i, ADR 0054): the reads of `legal_versions` and the check of the CI-built PDF in
 * `UPLOADS`.
 *
 * The one writer is `routes/admin-legal-versions.ts`. The change-notice email
 * (AECI-1620) and the acceptance screen (AECI-1677) will read through here.
 *
 * ── THE PDF IS FIXED AT PUBLISH ──────────────────────────────────────────────────
 * `legal-pdf.yml` renders the version file and uploads it to `legal/<slug>/v<version>.pdf`,
 * and refuses to overwrite an object that exists. The publish reads the object once and
 * records the sha256 and size of the exact bytes it read. Any later reader (the AECI-1620
 * notice) must re-hash and compare, so a changed file is detected rather than sent.
 */

import {
  LEGAL_PDF_MAX_BYTES,
  type LegalAgreementDocument,
  type LegalExpeditedReason,
  type LegalVersion,
} from '@aeci/shared';
import { and, eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { legalVersions } from '../db/schema';
import { bytesToHex } from './hash';

export type LegalVersionRow = typeof legalVersions.$inferSelect;

/** The summary bullets of a row. A corrupt column reads as no bullets. */
export function summaryOf(row: Pick<LegalVersionRow, 'summaryJson'>): string[] {
  try {
    const parsed: unknown = JSON.parse(row.summaryJson);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/** A row as the API returns it. */
export function toLegalVersion(row: LegalVersionRow): LegalVersion {
  return {
    id: row.id,
    document: row.document as LegalAgreementDocument,
    version: row.version,
    effective_at: new Date(row.effectiveAt).toISOString(),
    material: row.material,
    requires_acceptance: row.requiresAcceptance,
    summary: summaryOf(row),
    expedited_reason: (row.expeditedReason as LegalExpeditedReason | null) ?? null,
    pdf_key: row.pdfKey,
    pdf_sha256: row.pdfSha256,
    pdf_bytes: row.pdfBytes,
    published_by: row.publishedBy,
    published_at: row.publishedAt,
    notice_enqueued_at: row.noticeEnqueuedAt ?? null,
    notice_vendor_count: row.noticeVendorCount ?? null,
  };
}

/** One published version, or null. */
export async function loadLegalVersion(
  db: Db,
  document: LegalAgreementDocument,
  version: string,
): Promise<LegalVersionRow | null> {
  const row = await db.query.legalVersions.findFirst({
    where: and(eq(legalVersions.document, document), eq(legalVersions.version, version)),
  });
  return row ?? null;
}

// ─── The PDF ───────────────────────────────────────────────────────────────────

/** SHA-256 of raw bytes, 64 lowercase hex characters. */
export async function sha256OfBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', bytes));
}

/** Why a stored PDF was refused. */
export type LegalPdfProblem = 'missing' | 'not_pdf' | 'too_large' | 'unbound';

export type LegalPdfRead =
  | { ok: true; bytes: number; sha256: string }
  | { ok: false; problem: LegalPdfProblem };

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** The R2 calls the check makes. `head` reads metadata only, so no body is opened. */
export type LegalPdfBucket = Pick<R2Bucket, 'head' | 'get'>;

/**
 * Read and check the PDF at `key`: present, at most `LEGAL_PDF_MAX_BYTES`, starts with
 * `%PDF-`. The size is checked on `head` first, so an oversized object is never
 * downloaded and no body is left unread. The hash and size are of the exact bytes read.
 * Throws only when R2 itself throws.
 */
export async function readLegalPdf(
  bucket: LegalPdfBucket | undefined,
  key: string,
): Promise<LegalPdfRead> {
  if (!bucket) return { ok: false, problem: 'unbound' };
  const head = await bucket.head(key);
  if (!head) return { ok: false, problem: 'missing' };
  if (head.size > LEGAL_PDF_MAX_BYTES) return { ok: false, problem: 'too_large' };
  const object = await bucket.get(key);
  if (!object) return { ok: false, problem: 'missing' };
  // Consumes the body whole.
  const bytes = new Uint8Array(await object.arrayBuffer());
  // The object may have been replaced between `head` and `get`.
  if (bytes.length > LEGAL_PDF_MAX_BYTES) return { ok: false, problem: 'too_large' };
  if (!PDF_MAGIC.every((b, i) => bytes[i] === b)) return { ok: false, problem: 'not_pdf' };
  return { ok: true, bytes: bytes.length, sha256: await sha256OfBytes(bytes) };
}

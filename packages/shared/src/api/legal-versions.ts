import { z } from 'zod';

import { LegalAgreementDocumentSchema, type LegalAgreementDocument } from './agreements';

/**
 * Published legal versions (AECI-1688). Source of truth: `STAGE_1_SPEC.md` §27.5,
 * `DATABASE_SCHEMA.md` §8.6i (`legal_versions`), `API_CONTRACTS.md` §6.10 "Legal
 * versions", `ADMIN_PANEL_SPEC.md` §5.22, ADR 0054.
 *
 *   GET  /api/admin/legal-versions             behind `requireAdmin()`. A read: never rate-limited.
 *   POST /api/admin/legal-versions             behind `requireAdmin()` then `rateLimit('write')`.
 *   POST /api/admin/legal-versions/:id/notice  the same guard and limiter (AECI-1620).
 *
 * Publishing records one version listed in `LEGAL_AGREEMENT_UPCOMING_VERSIONS`, with
 * its summary, its two operator-set flags and the hash of its CI-built PDF. After the
 * row commits, a material version enqueues its change notice (`legal-terms-change`,
 * AECI-1620), one message per affected company, and records the outcome on the row.
 * The `/notice` route sends it again. The acceptance screen (AECI-1677) and reader
 * accounts (AECI-1637) read the row later. The effective date is never typed: it comes
 * from the upcoming map.
 */

/** Bullets per summary. */
export const LEGAL_SUMMARY_MAX_BULLETS = 10;
/** Characters per bullet. */
export const LEGAL_SUMMARY_BULLET_MAX = 300;
/** The notice window: a version takes effect at least this many days after its publish. */
export const LEGAL_NOTICE_WINDOW_DAYS = 30;
/** The largest PDF a publish accepts. */
export const LEGAL_PDF_MAX_BYTES = 5 * 1024 * 1024;
/** The hour (UTC) of the effective day at which a version takes effect. */
export const LEGAL_EFFECTIVE_HOUR_UTC = 12;

/** document → the public route slug (`/legal/<slug>`). */
export const LEGAL_DOCUMENT_SLUGS = {
  vendor_terms: 'vendor-terms',
  managed_plan: 'managed-plan-agreement',
} as const satisfies Record<LegalAgreementDocument, string>;

/**
 * The R2 key `legal-pdf.yml` uploads to: `legal/<slug>/v<version>.pdf`. Callers pass a
 * version read from `LEGAL_AGREEMENT_UPCOMING_VERSIONS`, never a request field, so the
 * key is built from code constants only.
 */
export function legalPdfKey(document: LegalAgreementDocument, version: string): string {
  return `legal/${LEGAL_DOCUMENT_SLUGS[document]}/v${version}.pdf`;
}

/** document → its title, as the change-notice email names it (AECI-1620). */
export const LEGAL_DOCUMENT_TITLES = {
  vendor_terms: 'Vendor Terms',
  managed_plan: 'Managed plan agreement',
} as const satisfies Record<LegalAgreementDocument, string>;

/** `/legal/<slug>/v<version>`, site-relative: the version's own page. */
export function legalVersionPagePath(document: LegalAgreementDocument, version: string): string {
  return `/legal/${LEGAL_DOCUMENT_SLUGS[document]}/v${version}`;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The moment a version takes effect: 12:00 UTC on its `effectiveOn` day (`YYYY-MM-DD`),
 * in epoch ms. NaN when the day is not a real calendar day.
 *
 * Not midnight. 00:00 UTC is the evening before in the Americas, so a midnight moment
 * would start a version early there and shorten the 30-day notice. Noon UTC falls on the
 * named day from UTC-12 to UTC+11. The one helper for `legal_versions.effective_at` and
 * for the notice-window check (legal README "The effective moment").
 */
export function legalEffectiveAtMs(effectiveOn: string): number {
  const m = effectiveOn.match(DAY_RE);
  if (!m) return Number.NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d, LEGAL_EFFECTIVE_HOUR_UTC);
  const back = new Date(ms);
  // Date.UTC rolls 2027-02-30 into March; a rolled day is not a real day.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return Number.NaN;
  }
  return ms;
}

/**
 * `details.reason` on a `422 LEGAL_NOTICE_WINDOW`. `passed`: the effective moment is not in
 * the future, so only moving the date helps. `too_soon`: it is less than 30 days away, so
 * move the date or, for the Vendor Terms, give an expedited reason.
 */
export const LEGAL_NOTICE_WINDOW_REASONS = ['passed', 'too_soon'] as const;
export type LegalNoticeWindowReason = (typeof LEGAL_NOTICE_WINDOW_REASONS)[number];

/**
 * Why a Vendor Terms version may take effect inside the notice window
 * (`vendor-terms.md` "Changes"): a change the law requires, or a correction of an error.
 */
export const LEGAL_EXPEDITED_REASONS = ['law', 'error'] as const;
export const LegalExpeditedReasonSchema = z.enum(LEGAL_EXPEDITED_REASONS);
export type LegalExpeditedReason = z.infer<typeof LegalExpeditedReasonSchema>;

/**
 * Characters a bullet may not hold: every control character (`\p{Cc}`, which includes CR,
 * LF and tab), every format character (`\p{Cf}`: zero-width spaces and joiners, the bidi
 * overrides and isolates, the BOM) and the line and paragraph separators U+2028 and U+2029.
 * The summary is later rendered in emails and on a vendor screen, where any of these could
 * hide text, reorder it or break a line.
 */
export const LEGAL_SUMMARY_FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** Whether a bullet holds a character {@link LEGAL_SUMMARY_FORBIDDEN_CHARS} refuses. */
export function hasForbiddenSummaryChar(text: string): boolean {
  return LEGAL_SUMMARY_FORBIDDEN_CHARS.test(text);
}

/**
 * One bullet: trimmed, 1 to 300 characters (UTF-16 code units, as `String.length`
 * counts), one line of plain text. Stored and returned unescaped: every renderer escapes.
 */
export const LegalSummaryBulletSchema = z
  .string()
  .trim()
  .min(1)
  .max(LEGAL_SUMMARY_BULLET_MAX)
  .refine((s) => !hasForbiddenSummaryChar(s), {
    message:
      'A bullet is one line of plain text: no line breaks, control characters, invisible formatting characters or line separators',
  });

/** 1 to 10 bullets. The `/admin/legal` textarea validates with this same schema. */
export const LegalSummarySchema = z
  .array(LegalSummaryBulletSchema)
  .min(1)
  .max(LEGAL_SUMMARY_MAX_BULLETS);

/**
 * `POST /api/admin/legal-versions`. Strict.
 *
 * `material`: the change is summarised and noticed. `requires_acceptance`: an owner seat
 * must accept before the version applies to its company (Vendor Terms: a change to
 * liability, indemnity, disputes or the content license; Managed plan agreement: a
 * material change monthly customers click to accept). Both are the operator's call at
 * publish, and `requires_acceptance` needs `material`.
 */
export const PublishLegalVersionRequestSchema = z
  .object({
    document: LegalAgreementDocumentSchema,
    version: z.string().trim().min(1).max(20),
    material: z.boolean(),
    requires_acceptance: z.boolean(),
    summary: LegalSummarySchema,
    /** Vendor Terms only. Absent or null on a Managed plan version. */
    expedited_reason: LegalExpeditedReasonSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.material || !v.requires_acceptance, {
    message: 'A change that needs acceptance is a material change',
    path: ['requires_acceptance'],
  })
  .refine((v) => v.document === 'vendor_terms' || !v.expedited_reason, {
    message: 'Only a Vendor Terms version may be expedited',
    path: ['expedited_reason'],
  });
export type PublishLegalVersionRequest = z.infer<typeof PublishLegalVersionRequestSchema>;

/** One `legal_versions` row as the API returns it. */
export const LegalVersionSchema = z.object({
  id: z.string(),
  document: LegalAgreementDocumentSchema,
  version: z.string(),
  /** ISO timestamp, 12:00 UTC of the effective day. */
  effective_at: z.string(),
  material: z.boolean(),
  requires_acceptance: z.boolean(),
  summary: z.array(z.string()),
  expedited_reason: LegalExpeditedReasonSchema.nullable(),
  pdf_key: z.string(),
  pdf_sha256: z.string(),
  pdf_bytes: z.number().int().nonnegative(),
  published_by: z.string(),
  published_at: z.string(),
  /**
   * The change-notice fan-out (AECI-1620), as the last publish or re-send left it:
   *
   *   - both null: no fan-out recorded. A non-material version never has one. A material
   *     one is still queuing, or its outcome write failed: send it again.
   *   - `notice_enqueued_at` set: every affected company was queued at that time, and
   *     `notice_vendor_count` is how many (0 when there was no one to notify).
   *   - `notice_enqueued_at` null and `notice_vendor_count` set: the fan-out did NOT
   *     finish. The count is the companies queued before the audience read or a queue
   *     send failed (0 when nothing was queued). Send it again.
   */
  notice_enqueued_at: z.string().nullable(),
  notice_vendor_count: z.number().int().nonnegative().nullable(),
});
export type LegalVersion = z.infer<typeof LegalVersionSchema>;

/** `POST /api/admin/legal-versions` → 201. */
export const PublishLegalVersionResponseSchema = z.object({
  legal_version: LegalVersionSchema,
});
export type PublishLegalVersionResponse = z.infer<typeof PublishLegalVersionResponseSchema>;

/**
 * The change notice's addresses for one version (AECI-1620), each counted once, by the
 * outcome of its latest `notification_sends` row for that version. An address that failed
 * and then went counts as `sent` only, so no count grows on a retry. `duplicate` rows (a
 * re-send that found the address already reached) are ignored.
 */
export const LegalNoticeSendCountsSchema = z.object({
  sent: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Timed out or threw: the mail may have gone. The key stays held, so no retry. */
  unknown: z.number().int().nonnegative(),
  /** The tier delivery policy held it (an outside address off production). */
  suppressed: z.number().int().nonnegative(),
  /** No Resend key or sender on the tier. */
  skipped: z.number().int().nonnegative(),
});
export type LegalNoticeSendCounts = z.infer<typeof LegalNoticeSendCountsSchema>;

/**
 * `legal_notice_deliveries.status` (AECI-1620, `DATABASE_SCHEMA.md` §8.6j): where one
 * company's notice stands. `queued` until the consumer finishes it; `delivered` when every
 * recipient was sent or already sent; then three ways it was not reached:
 * `no_recipients` (no seat or billing address to send to), `dropped` (the last retry
 * failed, or it could not be queued) and `expired` (still queued when the version took
 * effect, so it was never sent).
 */
export const LEGAL_NOTICE_DELIVERY_STATUSES = [
  'queued',
  'delivered',
  'no_recipients',
  'dropped',
  'expired',
] as const;
export const LegalNoticeDeliveryStatusSchema = z.enum(LEGAL_NOTICE_DELIVERY_STATUSES);
export type LegalNoticeDeliveryStatus = z.infer<typeof LegalNoticeDeliveryStatusSchema>;

/** `legal_notice_deliveries.last_reason`: why the last attempt did not deliver. */
export const LEGAL_NOTICE_DELIVERY_REASONS = [
  'enqueue_failed',
  'send_failed',
  'email_not_configured',
  'pdf_refused',
  'no_site_url',
  'seats_unavailable',
  'read_failed',
  'in_effect',
] as const;
export const LegalNoticeDeliveryReasonSchema = z.enum(LEGAL_NOTICE_DELIVERY_REASONS);
export type LegalNoticeDeliveryReason = z.infer<typeof LegalNoticeDeliveryReasonSchema>;

/** One company the notice did not reach, for the list on `/admin/legal`. */
export const LegalNoticeNotReachedSchema = z.object({
  vendor_id: z.string(),
  /** `vendors.company_name`; null when the company row is gone. */
  name: z.string().nullable(),
  slug: z.string().nullable(),
  status: z.enum(['no_recipients', 'dropped', 'expired']),
  reason: LegalNoticeDeliveryReasonSchema.nullable(),
});
export type LegalNoticeNotReached = z.infer<typeof LegalNoticeNotReachedSchema>;

/** The per-company delivery record of one version, summarised. */
export const LegalNoticeDeliveriesSchema = z.object({
  /** Companies with a delivery row: every company any fan-out tried to queue. */
  total: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  /** Still `queued`: the consumer has not finished them. */
  pending: z.number().int().nonnegative(),
  /** `no_recipients` + `dropped` + `expired`. */
  not_reached: z.number().int().nonnegative(),
  /** The first 100 not reached, by company name. */
  not_reached_companies: z.array(LegalNoticeNotReachedSchema),
});
export type LegalNoticeDeliveries = z.infer<typeof LegalNoticeDeliveriesSchema>;

/** `POST /api/admin/legal-versions/:id/notice` → 200. The request has no body. */
export const ResendLegalNoticeResponseSchema = z.object({
  legal_version: LegalVersionSchema,
});
export type ResendLegalNoticeResponse = z.infer<typeof ResendLegalNoticeResponseSchema>;

/** One upcoming entry on `/admin/legal`, with its published row when there is one. */
export const AdminLegalUpcomingEntrySchema = z.object({
  document: LegalAgreementDocumentSchema,
  version: z.string(),
  /** `YYYY-MM-DD`, from the upcoming map. */
  effective_on: z.string(),
  /** ISO timestamp of the effective moment, 12:00 UTC of `effective_on`. */
  effective_at: z.string(),
  /** The current version it replaces. */
  current_version: z.string(),
  published: LegalVersionSchema.nullable(),
  /** The notice's addresses by their latest outcome. Null when nothing is published. */
  notice_sends: LegalNoticeSendCountsSchema.nullable(),
  /** The per-company delivery record. Null when nothing is published. */
  notice_deliveries: LegalNoticeDeliveriesSchema.nullable(),
});
export type AdminLegalUpcomingEntry = z.infer<typeof AdminLegalUpcomingEntrySchema>;

/** `GET /api/admin/legal-versions`. One entry per document with an upcoming version. */
export const AdminLegalVersionsResponseSchema = z.object({
  /** `LEGAL_PUBLISH_ENABLED === "true"` on this tier. Off, every POST is a 409. */
  publish_enabled: z.boolean(),
  upcoming: z.array(AdminLegalUpcomingEntrySchema),
});
export type AdminLegalVersionsResponse = z.infer<typeof AdminLegalVersionsResponseSchema>;

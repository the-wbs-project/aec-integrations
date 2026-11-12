import { z } from 'zod';

import { LegalAgreementDocumentSchema, type LegalAgreementDocument } from './agreements';

/**
 * Published legal versions (AECI-1688). Source of truth: `STAGE_1_SPEC.md` §27.5,
 * `DATABASE_SCHEMA.md` §8.6i (`legal_versions`), `API_CONTRACTS.md` §6.10 "Legal
 * versions", `ADMIN_PANEL_SPEC.md` §5.22, ADR 0054.
 *
 *   GET  /api/admin/legal-versions   behind `requireAdmin()`. A read: never rate-limited.
 *   POST /api/admin/legal-versions   behind `requireAdmin()` then `rateLimit('write')`.
 *
 * Publishing records one version listed in `LEGAL_AGREEMENT_UPCOMING_VERSIONS`, with
 * its summary, its two operator-set flags and the hash of its CI-built PDF. It sends
 * nothing and enqueues nothing. The change-notice email (AECI-1620), the acceptance
 * screen (AECI-1677) and reader accounts (AECI-1637) read the row later. The effective
 * date is never typed: it comes from the upcoming map.
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
 * Why a Vendor Terms version may take effect inside the notice window
 * (`vendor-terms.md` "Changes"): a change the law requires, or a correction of an error.
 */
export const LEGAL_EXPEDITED_REASONS = ['law', 'error'] as const;
export const LegalExpeditedReasonSchema = z.enum(LEGAL_EXPEDITED_REASONS);
export type LegalExpeditedReason = z.infer<typeof LegalExpeditedReasonSchema>;

/** One bullet: trimmed, 1 to 300 characters, one line. */
export const LegalSummaryBulletSchema = z
  .string()
  .trim()
  .min(1)
  .max(LEGAL_SUMMARY_BULLET_MAX)
  .refine((s) => !/[\r\n]/.test(s), { message: 'A bullet is one line' });

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
  /** Filled by the change-notice issue (AECI-1620). Null until then. */
  notice_enqueued_at: z.string().nullable(),
  notice_vendor_count: z.number().int().nonnegative().nullable(),
});
export type LegalVersion = z.infer<typeof LegalVersionSchema>;

/** `POST /api/admin/legal-versions` → 201. */
export const PublishLegalVersionResponseSchema = z.object({
  legal_version: LegalVersionSchema,
});
export type PublishLegalVersionResponse = z.infer<typeof PublishLegalVersionResponseSchema>;

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
});
export type AdminLegalUpcomingEntry = z.infer<typeof AdminLegalUpcomingEntrySchema>;

/** `GET /api/admin/legal-versions`. One entry per document with an upcoming version. */
export const AdminLegalVersionsResponseSchema = z.object({
  /** `LEGAL_PUBLISH_ENABLED === "true"` on this tier. Off, every POST is a 409. */
  publish_enabled: z.boolean(),
  upcoming: z.array(AdminLegalUpcomingEntrySchema),
});
export type AdminLegalVersionsResponse = z.infer<typeof AdminLegalVersionsResponseSchema>;

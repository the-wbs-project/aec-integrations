import type { LegalPublishableDocument } from './agreements';

/**
 * The legal route slugs and the effective-moment rule, with no Zod import (AECI-2033).
 *
 * They lived in `legal-versions.ts`, which builds the publish schemas at the top level.
 * Every public `/legal/*` page reads them, so that one import loaded the whole of zod on
 * those pages. Keep this file free of `zod` and `api/*` schema imports
 * (`eslint.config.mjs`), and never re-export it from a schema module.
 */

/** The hour (UTC) of the effective day at which a version takes effect. */
export const LEGAL_EFFECTIVE_HOUR_UTC = 12;

/** document → the public route slug (`/legal/<slug>`). Every publishable document. */
export const LEGAL_DOCUMENT_SLUGS = {
  vendor_terms: 'vendor-terms',
  managed_plan: 'managed-plan-agreement',
  terms: 'terms',
  privacy: 'privacy',
  listing_accuracy: 'listing-accuracy',
  review_guidelines: 'review-guidelines',
} as const satisfies Record<LegalPublishableDocument, string>;

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

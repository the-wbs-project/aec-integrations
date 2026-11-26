/**
 * Which documents' FIRST in-force version took effect at a moment (AECI-1870, counsel Q60,
 * ruling 28, ruling 68, `STAGE_1_SPEC.md` §27.4). The day-of notice
 * (`legal-first-effective`) reads it: one email per effective moment, listing every
 * document whose first in-force version took effect then.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────
 * A published `legal_versions` row is a first in-force version when:
 *
 *   - it is in force at its own moment. Either it is the document's upcoming version and
 *     {@link legalUpcomingInForce} switches it in at that moment (the row is the publish),
 *     or bump day already made it a committed version whose effective day is the row's
 *     day. A row whose date moved after the publish (`legalPublishedRowMismatched`) is in
 *     force nowhere, so it never counts;
 *   - it is not a draft. A version the committed `*_EFFECTIVE_ON` maps list as `null` was
 *     accepted as a draft, and never takes effect;
 *   - the document has no committed version dated before it, and no other published row
 *     with an earlier `effective_at`.
 *
 * `legal_versions` has no withdrawn or unpublished state: a row is a publish, for good.
 *
 * The two policies have no committed effective-day map. So a policy version counts only
 * while it is still the upcoming entry: after bump day nothing here tells a dated policy
 * version from a draft such as 1.0, and a draft must never count. The job runs at the
 * moment and bump day lands after it, so this costs nothing in practice. Only the
 * published rows say whether an earlier policy version was in force. That is enough: no
 * version switches in without a row (`legal-in-force.ts`), and nothing deletes one.
 *
 * Pure. Never reads the clock. No Zod (the `legal-moment.ts` rule).
 */

import {
  LEGAL_AGREEMENT_EFFECTIVE_ON,
  isLegalReaderDocument,
  type LegalAgreementDocument,
  type LegalReaderDocument,
} from './agreements';
import {
  LEGAL_IN_FORCE_MAPS,
  legalMomentReached,
  legalPublishableUpcomingOf,
  legalPublishedRowMismatched,
  legalReaderEffectiveOnOf,
  legalUpcomingInForce,
  type LegalInForceMaps,
  type LegalPublishedLite,
} from './legal-in-force';
import { legalEffectiveAtMs } from './legal-moment';

/** The committed effective day of every version of `document`, `null` for a draft. */
function committedEffectiveOn(
  document: string,
  maps: LegalInForceMaps,
): Readonly<Record<string, string | null>> | null {
  if (isLegalReaderDocument(document)) {
    return legalReaderEffectiveOnOf(maps)[document as LegalReaderDocument];
  }
  if (document === 'vendor_terms' || document === 'managed_plan') {
    return (maps.agreementEffectiveOn ?? LEGAL_AGREEMENT_EFFECTIVE_ON)[
      document as LegalAgreementDocument
    ];
  }
  return null;
}

/** Whether `row` is in force from its own moment, and is not a draft (module header). */
function inForceAtOwnMoment(row: LegalPublishedLite, maps: LegalInForceMaps): boolean {
  if (!Number.isFinite(row.effectiveAt)) return false;
  if (legalPublishedRowMismatched(row, maps)) return false;
  const dated = committedEffectiveOn(row.document, maps);
  if (dated && row.version in dated) {
    const day = dated[row.version];
    // A draft (null) never takes effect. A bumped version must keep the row's day.
    return day !== null && day !== undefined && legalEffectiveAtMs(day) === row.effectiveAt;
  }
  const upcoming = legalPublishableUpcomingOf(row.document, maps);
  return (
    upcoming !== undefined &&
    upcoming.version === row.version &&
    legalUpcomingInForce(row.document, upcoming, row.effectiveAt, [row])
  );
}

/** Whether the document had a version in force before `momentMs` (module header). */
function hadEarlierVersion(
  row: LegalPublishedLite,
  published: readonly LegalPublishedLite[],
  maps: LegalInForceMaps,
): boolean {
  const dated = committedEffectiveOn(row.document, maps);
  if (dated) {
    for (const [version, day] of Object.entries(dated)) {
      if (version === row.version || day === null) continue;
      const at = legalEffectiveAtMs(day);
      if (Number.isFinite(at) && at < row.effectiveAt) return true;
    }
  }
  return published.some(
    (other) =>
      other.document === row.document &&
      other.version !== row.version &&
      Number.isFinite(other.effectiveAt) &&
      other.effectiveAt < row.effectiveAt,
  );
}

/** Whether `row` is its document's first in-force version, given every published row. */
export function isLegalFirstInForceVersion(
  row: LegalPublishedLite,
  published: readonly LegalPublishedLite[],
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): boolean {
  return inForceAtOwnMoment(row, maps) && !hadEarlierVersion(row, published, maps);
}

/**
 * The published rows whose document's first in-force version takes effect at exactly
 * `momentMs`. `published` is every `legal_versions` row; extra fields ride through.
 */
export function legalFirstInForceAt<T extends LegalPublishedLite>(
  published: readonly T[],
  momentMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): T[] {
  return published.filter(
    (row) => row.effectiveAt === momentMs && isLegalFirstInForceVersion(row, published, maps),
  );
}

/** One effective moment and the first in-force versions that took effect at it. */
export interface LegalFirstInForceMoment<T extends LegalPublishedLite> {
  readonly effectiveAtMs: number;
  readonly rows: readonly T[];
}

/**
 * Every moment in `(sinceMs, nowMs]` at which some document's first in-force version took
 * effect, oldest first, with those rows. A moment after `nowMs` has not come
 * (`legalMomentReached`), and one at or before `sinceMs` is out of the window.
 */
export function legalFirstInForceMoments<T extends LegalPublishedLite>(
  published: readonly T[],
  window: { readonly sinceMs: number; readonly nowMs: number },
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): LegalFirstInForceMoment<T>[] {
  const byMoment = new Map<number, T[]>();
  for (const row of published) {
    if (!legalMomentReached(row.effectiveAt, window.nowMs)) continue;
    if (row.effectiveAt <= window.sinceMs) continue;
    if (!isLegalFirstInForceVersion(row, published, maps)) continue;
    byMoment.set(row.effectiveAt, [...(byMoment.get(row.effectiveAt) ?? []), row]);
  }
  return [...byMoment.entries()]
    .sort(([a], [b]) => a - b)
    .map(([effectiveAtMs, rows]) => ({ effectiveAtMs, rows }));
}

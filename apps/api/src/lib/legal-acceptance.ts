/**
 * What a company must or may accept on the portal's acceptance screen (AECI-1677,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.24, `VENDOR_SIGNUP_PROCESS.md` §4, ADR 0055).
 * Counsel Q42, rulings 24 and 25, counsel Q3.
 *
 * ── HOW "IN FORCE" IS KNOWN ──────────────────────────────────────────────────────
 * A version of an agreement is FINAL when it has an effective moment, from one of two
 * places, and is never a draft:
 *   1. `LEGAL_AGREEMENT_EFFECTIVE_ON` in `@aeci/shared`: the effective day of each
 *      version in code, mirrored from the Markdown frontmatter `effective_date` by a web
 *      spec. A version listed there as `null` is a draft, and is never final, even if
 *      a `legal_versions` row named it.
 *   2. `legal_versions.effective_at`, for a published version (AECI-1688). Publishing
 *      needs an upcoming file with its effective date filled, so a row is final text.
 * The effective moment is 12:00 UTC of the effective day (`legalEffectiveAtMs`). A final
 * version is IN FORCE once that moment has come (`legalMomentReached`, the one comparison
 * in `@aeci/shared/api/legal-in-force`, AECI-1689). An agreement is in force when any
 * version of it is. A published upcoming version is the same version the legal page and
 * a new acceptance switch to at that moment (`legalAgreementVersionInForce`): both need
 * its row and both use the one comparison. `legal-in-force.spec.ts` holds the two
 * together across the moment.
 *
 * ── THE INVARIANT: NOTHING IN FORCE, NOTHING PENDING ─────────────────────────────
 * While no version of an agreement is in force, nothing is pending for it, in either
 * mode, for any seat. Today every entry of the map is `null` and the manifest of
 * upcoming versions is empty, so `legal_versions` holds nothing either: the screen never
 * shows and the write guard never blocks. `legal-acceptance.spec.ts` pins this. A bug
 * here would lock every vendor out of the portal.
 *
 * ── WHAT COUNTS AS ACCEPTED ──────────────────────────────────────────────────────
 * An acceptance covers version V when it is of a FINAL version at or after V, whatever
 * its source. An acceptance of a draft covers nothing: it was given against a page that
 * said it was not in force (counsel Q42).
 *
 * ── THE TWO MODES ────────────────────────────────────────────────────────────────
 *   - `required` (ruling 24), Vendor Terms only: the Vendor Terms are in force and no
 *     acceptance covers the oldest version in force. The company is asked for the newest
 *     version in force. The portal opens only the screen, and the vendor write guard
 *     (`lib/authz.ts`) refuses every other write with `403 LEGAL_ACCEPTANCE_REQUIRED`.
 *   - `optional` (ruling 25, counsel Q3): the agreement is in force, the company is not
 *     blocked by it, and the newest published version with `requires_acceptance` is not
 *     covered. The item offered is the newest FINAL version, which is at or after that one,
 *     so an owner never accepts a text a later version already replaced. For the Managed plan agreement, only while the company holds a live
 *     monthly card subscription. This build only records the click: it never changes a
 *     subscription.
 */

import {
  compareLegalVersions,
  legalEffectiveAtMs,
  legalMomentReached,
  legalVersionPagePath,
  LEGAL_AGREEMENT_DOCUMENTS,
  LEGAL_AGREEMENT_EFFECTIVE_ON,
  LEGAL_IN_FORCE_MAPS,
  legalPublishedRowMismatched,
  type LegalAgreementDocument,
  type LegalInForceMaps,
  type VendorLegalPending,
} from '@aeci/shared';
import { and, eq, isNull } from 'drizzle-orm';

import type { Db } from '../db/client';
import { agreementAcceptances, billingAccounts, legalVersions, licenses } from '../db/schema';
import { acceptancesOfVendor } from './agreement-acceptances';
import { summaryOf } from './legal-versions';

/** The `legal_versions` columns this module reads. */
export interface PublishedVersionLite {
  document: string;
  version: string;
  effectiveAt: number;
  requiresAcceptance: boolean;
  summaryJson: string;
}

/** One acceptance as this module reads it. */
export interface AcceptedVersionLite {
  document: string;
  version: string;
}

/** What {@link pendingAcceptances} decides from. Every read is done by the caller. */
export interface LegalAcceptanceInputs {
  /** Every `legal_versions` row, both documents. */
  published: readonly PublishedVersionLite[];
  /** Every acceptance of the company (`acceptancesOfVendor`), both documents. */
  accepted: readonly AcceptedVersionLite[];
  /** The company holds a live monthly card subscription. */
  monthlyCard: boolean;
}

/** The code map of effective days (`LEGAL_AGREEMENT_EFFECTIVE_ON`, injectable by specs). */
function effectiveOnMap(
  document: LegalAgreementDocument,
  maps: LegalInForceMaps,
): Readonly<Record<string, string | null>> {
  return (maps.agreementEffectiveOn ?? LEGAL_AGREEMENT_EFFECTIVE_ON)[document];
}

/** Whether the code map lists `version` as a draft: present, and `null`. */
function isDraftInCode(
  document: LegalAgreementDocument,
  version: string,
  maps: LegalInForceMaps,
): boolean {
  const map = effectiveOnMap(document, maps);
  return Object.hasOwn(map, version) && map[version] === null;
}

/**
 * The effective moment of a final version, epoch ms, or `null` for a draft or a version
 * nothing dates. A `legal_versions` row wins over the code map: they agree once the bump
 * lands, and before it only the row knows.
 *
 * AECI-1689: a row for the document's UPCOMING version is final only when its moment is
 * the manifest's (`legalPublishedRowMismatched`). A date moved after the publish leaves a
 * row the legal page and every new stamp ignore, so this module ignores it too: nothing
 * becomes in force, nothing is required. `maps` is injected by specs only.
 */
export function effectiveAtMsOf(
  document: LegalAgreementDocument,
  version: string,
  published: readonly PublishedVersionLite[],
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): number | null {
  if (isDraftInCode(document, version, maps)) return null;
  const row = published.find((r) => r.document === document && r.version === version);
  if (row && legalPublishedRowMismatched(row, maps)) return null;
  if (row) return Number.isFinite(row.effectiveAt) ? row.effectiveAt : null;
  const day = effectiveOnMap(document, maps)[version] ?? null;
  if (!day) return null;
  const ms = legalEffectiveAtMs(day);
  return Number.isNaN(ms) ? null : ms;
}

/** Every final version of `document`, newest first, with its effective moment. */
export function finalVersions(
  document: LegalAgreementDocument,
  published: readonly PublishedVersionLite[],
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): { version: string; effectiveAt: number }[] {
  const versions = new Set<string>([
    ...Object.keys(effectiveOnMap(document, maps)),
    ...published.filter((r) => r.document === document).map((r) => r.version),
  ]);
  const out: { version: string; effectiveAt: number }[] = [];
  for (const version of versions) {
    const at = effectiveAtMsOf(document, version, published, maps);
    if (at !== null) out.push({ version, effectiveAt: at });
  }
  return out.sort((a, b) => compareLegalVersions(b.version, a.version));
}

/** The versions of `document` in force at `nowMs`, newest first. Empty: not in force. */
export function inForceVersions(
  document: LegalAgreementDocument,
  published: readonly PublishedVersionLite[],
  nowMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): string[] {
  return finalVersions(document, published, maps)
    .filter((v) => legalMomentReached(v.effectiveAt, nowMs))
    .map((v) => v.version);
}

/** Whether an acceptance of a FINAL version at or after `version` exists. */
export function acceptanceCovers(
  document: LegalAgreementDocument,
  version: string,
  accepted: readonly AcceptedVersionLite[],
  published: readonly PublishedVersionLite[],
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): boolean {
  return accepted.some(
    (a) =>
      a.document === document &&
      compareLegalVersions(a.version, version) >= 0 &&
      effectiveAtMsOf(document, a.version, published, maps) !== null,
  );
}

/**
 * The Vendor Terms version a blocked company must accept (ruling 24), or `null` when the
 * company is not blocked. Null whenever the Vendor Terms are not in force.
 */
export function requiredVendorTermsVersion(
  published: readonly PublishedVersionLite[],
  accepted: readonly AcceptedVersionLite[],
  nowMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): string | null {
  const inForce = inForceVersions('vendor_terms', published, nowMs, maps);
  const oldest = inForce.at(-1);
  const newest = inForce[0];
  if (oldest === undefined || newest === undefined) return null;
  return acceptanceCovers('vendor_terms', oldest, accepted, published, maps) ? null : newest;
}

function pendingItem(
  document: LegalAgreementDocument,
  version: string,
  mode: VendorLegalPending['mode'],
  published: readonly PublishedVersionLite[],
  nowMs: number,
  maps: LegalInForceMaps,
): VendorLegalPending {
  const at = effectiveAtMsOf(document, version, published, maps) ?? nowMs;
  const row = published.find((r) => r.document === document && r.version === version);
  return {
    document,
    version,
    mode,
    effective_at: new Date(at).toISOString(),
    in_force: legalMomentReached(at, nowMs),
    summary: row ? summaryOf(row) : [],
    page_path: legalVersionPagePath(document, version),
  };
}

/** The newest published, final version of `document` that needs acceptance, if any. */
function newestNeedingAcceptance(
  document: LegalAgreementDocument,
  published: readonly PublishedVersionLite[],
  maps: LegalInForceMaps,
): string | null {
  const rows = published
    .filter(
      (r) =>
        r.document === document &&
        r.requiresAcceptance &&
        effectiveAtMsOf(document, r.version, published, maps) !== null,
    )
    .sort((a, b) => compareLegalVersions(b.version, a.version));
  return rows[0]?.version ?? null;
}

/**
 * Everything this company must or may accept at `nowMs`: the `required` Vendor Terms item
 * first when there is one, then the `optional` items in document order. Pure. Empty
 * whenever no agreement is in force (module header).
 */
export function pendingAcceptances(
  input: LegalAcceptanceInputs,
  nowMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): VendorLegalPending[] {
  const { published, accepted } = input;
  const out: VendorLegalPending[] = [];
  for (const document of LEGAL_AGREEMENT_DOCUMENTS) {
    if (inForceVersions(document, published, nowMs, maps).length === 0) continue;
    if (document === 'vendor_terms') {
      const required = requiredVendorTermsVersion(published, accepted, nowMs, maps);
      if (required !== null) {
        out.unshift(pendingItem(document, required, 'required', published, nowMs, maps));
        continue;
      }
    }
    if (document === 'managed_plan' && !input.monthlyCard) continue;
    const needing = newestNeedingAcceptance(document, published, maps);
    if (needing !== null && !acceptanceCovers(document, needing, accepted, published, maps)) {
      // Offer the newest final version, which is at or after the one that needs acceptance:
      // a later version that needs none may already be in force, and accepting the
      // superseded text would leave the owner on a version nobody applies (AECI-1677 review).
      const offered = finalVersions(document, published, maps)[0]?.version ?? needing;
      out.push(pendingItem(document, offered, 'optional', published, nowMs, maps));
    }
  }
  return out;
}

// ─── Reads ─────────────────────────────────────────────────────────────────────

/** The `legal_versions` columns {@link PublishedVersionLite} names. */
export function publishedVersionsSelect(db: Db) {
  return db
    .select({
      document: legalVersions.document,
      version: legalVersions.version,
      effectiveAt: legalVersions.effectiveAt,
      requiresAcceptance: legalVersions.requiresAcceptance,
      summaryJson: legalVersions.summaryJson,
    })
    .from(legalVersions);
}

/**
 * A live monthly card subscription: a Stripe license with no scheduled and no stored end.
 * The same test as the change-notice email's `liveSubscriptionKinds` (`lib/legal-notice.ts`),
 * so the companies the email tells "an owner seat will be asked to accept" are the ones the
 * screen asks.
 */
export function liveMonthlyCardWhere() {
  return and(eq(licenses.source, 'stripe'), isNull(licenses.endsAt), isNull(licenses.endedAt));
}

/** Read everything {@link pendingAcceptances} needs for one vendor, in one batch. */
export async function loadLegalAcceptanceInputs(
  db: Db,
  vendorId: string,
): Promise<LegalAcceptanceInputs> {
  const [published, accepted, monthly] = await db.batch([
    publishedVersionsSelect(db),
    db
      .select({ document: agreementAcceptances.document, version: agreementAcceptances.version })
      .from(agreementAcceptances)
      .where(acceptancesOfVendor(db, vendorId)),
    db
      .select({ id: licenses.id })
      .from(licenses)
      .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
      .where(and(eq(billingAccounts.vendorId, vendorId), liveMonthlyCardWhere()))
      .limit(1),
  ]);
  return { published, accepted, monthlyCard: monthly.length > 0 };
}

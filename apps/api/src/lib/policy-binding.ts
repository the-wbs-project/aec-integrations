/**
 * Which policy version a claimed company is on (AECI-1969, counsel Q68, ruling 54). The
 * rule is `companyPolicyVersion` in `@aeci/shared`; this module supplies its two D1 inputs
 * and assembles the answer. Read by `GET /api/admin/vendors/:id/billing`
 * (`policy_versions`), never written: the Vendor Terms acceptance and the per-company delivery
 * row of each policy notice are the record.
 *
 *   1. The company's latest Vendor Terms acceptance that recorded the two policy versions
 *      (`agreement_acceptances`, source `claim`, or `portal` since AECI-1677), and when it
 *      was accepted. A claim older than the policy columns (migration 0118) recorded none,
 *      so it is skipped.
 *   2. Every published policy version (`legal_versions`, document `listing_accuracy` or
 *      `review_guidelines`) with this company's `delivered` row from
 *      `legal_notice_deliveries`, if any. A row whose effective moment disagrees with the
 *      manifest (`legalPublishedRowMismatched`) is in force nowhere, so it is left out.
 */

import {
  companyPolicyVersions,
  isLegalPolicyDocument,
  LEGAL_IN_FORCE_MAPS,
  LEGAL_POLICY_DOCUMENTS,
  legalPublishedRowMismatched,
  type CompanyPolicyVersion,
  type LegalInForceMaps,
  type LegalPolicyDocument,
  type PolicyNoticeStep,
} from '@aeci/shared';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

import type { Db } from '../db/client';
import { agreementAcceptances, legalNoticeDeliveries, legalVersions } from '../db/schema';
import { acceptancesOfVendor } from './agreement-acceptances';

/** The company's latest Vendor Terms acceptance that recorded the policies, at most one row. */
export function latestPolicyAcceptanceRowSelect(db: Db, vendorId: string) {
  return db
    .select({
      acceptedAt: agreementAcceptances.acceptedAt,
      listingAccuracyVersion: agreementAcceptances.listingAccuracyVersion,
      reviewGuidelinesVersion: agreementAcceptances.reviewGuidelinesVersion,
    })
    .from(agreementAcceptances)
    .where(
      and(
        acceptancesOfVendor(db, vendorId),
        inArray(agreementAcceptances.source, ['claim', 'portal']),
        eq(agreementAcceptances.document, 'vendor_terms'),
        isNotNull(agreementAcceptances.listingAccuracyVersion),
        isNotNull(agreementAcceptances.reviewGuidelinesVersion),
      ),
    )
    .orderBy(desc(agreementAcceptances.acceptedAt), desc(agreementAcceptances.id))
    .limit(1);
}

/** Every published policy version, with this company's delivery status and time. */
export function policyNoticeRowsSelect(db: Db, vendorId: string) {
  return db
    .select({
      document: legalVersions.document,
      version: legalVersions.version,
      effectiveAt: legalVersions.effectiveAt,
      status: legalNoticeDeliveries.status,
      updatedAt: legalNoticeDeliveries.updatedAt,
    })
    .from(legalVersions)
    .leftJoin(
      legalNoticeDeliveries,
      and(
        eq(legalNoticeDeliveries.legalVersionId, legalVersions.id),
        eq(legalNoticeDeliveries.vendorId, vendorId),
      ),
    )
    .where(inArray(legalVersions.document, [...LEGAL_POLICY_DOCUMENTS]));
}

export type LatestPolicyAcceptanceRow = Awaited<
  ReturnType<typeof latestPolicyAcceptanceRowSelect>
>[number];
export type PolicyNoticeRow = Awaited<ReturnType<typeof policyNoticeRowsSelect>>[number];

/** Assemble the answer from the two reads (pure). */
export function assembleCompanyPolicyVersions(
  claimRows: readonly LatestPolicyAcceptanceRow[],
  noticeRows: readonly PolicyNoticeRow[],
  nowMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): CompanyPolicyVersion[] {
  const claim = claimRows[0];
  const steps: Partial<Record<LegalPolicyDocument, PolicyNoticeStep[]>> = {};
  for (const row of noticeRows) {
    if (!isLegalPolicyDocument(row.document)) continue;
    if (legalPublishedRowMismatched(row, maps)) continue;
    (steps[row.document] ??= []).push({
      version: row.version,
      effectiveAt: row.effectiveAt,
      deliveredAt: row.status === 'delivered' ? (row.updatedAt ?? null) : null,
    });
  }
  return companyPolicyVersions(
    claim
      ? {
          acceptedAt: claim.acceptedAt,
          versions: {
            listing_accuracy: claim.listingAccuracyVersion,
            review_guidelines: claim.reviewGuidelinesVersion,
          },
        }
      : null,
    steps,
    nowMs,
  );
}

/**
 * Company facts and their provenance (AECI-1310, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.23).
 *
 * Promote writes a fact with the page it was read from. A vendor save or an AECi
 * correction replaces that value, so it clears the source URL and stamps the date.
 */

import type { OwnershipType } from '@aeci/shared';

import type { vendors } from '../db/schema';

type VendorRow = typeof vendors.$inferSelect;
type VendorColumn = keyof VendorRow;

/** Each fact's Drizzle column → its provenance columns. */
const FACT_PROVENANCE: Readonly<
  Record<string, { readonly sourceUrl: VendorColumn; readonly checkedAt: VendorColumn }>
> = {
  headquarters: { sourceUrl: 'headquartersSourceUrl', checkedAt: 'headquartersCheckedAt' },
  foundedYear: { sourceUrl: 'foundedYearSourceUrl', checkedAt: 'foundedYearCheckedAt' },
  companySize: { sourceUrl: 'companySizeSourceUrl', checkedAt: 'companySizeCheckedAt' },
  ownershipType: { sourceUrl: 'publicPrivateSourceUrl', checkedAt: 'publicPrivateCheckedAt' },
  parentCompany: { sourceUrl: 'parentCompanySourceUrl', checkedAt: 'parentCompanyCheckedAt' },
  fundingStage: { sourceUrl: 'fundingSourceUrl', checkedAt: 'fundingCheckedAt' },
};

/** The two-value `public_private` an ownership type implies. */
export function publicPrivateFor(type: OwnershipType | null): 'public' | 'private' | null {
  if (type === null) return null;
  return type === 'public' ? 'public' : 'private';
}

/**
 * The ownership to read. Rows written before AECI-1310 hold only `public_private`,
 * whose two values are both valid ownership types.
 */
export function effectiveOwnershipType(
  row: Pick<VendorRow, 'ownershipType' | 'publicPrivate'>,
): OwnershipType | null {
  return (row.ownershipType ?? row.publicPrivate) as OwnershipType | null;
}

/**
 * The provenance columns for a vendor save. Only a fact whose value changed moves: a
 * re-save of the stored value leaves AECi's source standing, because it is still true.
 */
export function companyFactProvenanceWrites(
  before: Readonly<Record<string, unknown>>,
  columns: Readonly<Record<string, unknown>>,
  now: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(columns)) {
    const provenance = FACT_PROVENANCE[column];
    if (!provenance) continue;
    const stored =
      column === 'ownershipType' ? (before.ownershipType ?? before.publicPrivate) : before[column];
    if ((stored ?? null) === (value ?? null)) continue;
    out[provenance.sourceUrl] = null;
    out[provenance.checkedAt] = now;
  }
  return out;
}

/** The extra columns an AECi correction of one vendor field writes. */
export function companyFactCorrectionColumns(
  column: string,
  value: unknown,
  now: string,
): Record<string, unknown> {
  const provenance = FACT_PROVENANCE[column];
  if (!provenance) return {};
  return {
    [provenance.sourceUrl]: null,
    [provenance.checkedAt]: now,
    ...(column === 'ownershipType'
      ? { publicPrivate: publicPrivateFor(value as OwnershipType | null) }
      : {}),
  };
}

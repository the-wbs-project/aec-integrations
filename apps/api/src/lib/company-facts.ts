/**
 * Company facts and their provenance (AECI-1310, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.23).
 *
 * Promote writes a fact with the page it was read from. A vendor save or an AECi
 * correction replaces that value, so it clears the source URL and stamps the date.
 */

import type {
  CompanyFactSource,
  CompanyFacts,
  CompanySizeBand,
  FundingStage,
  LockedField,
  OwnershipType,
} from '@aeci/shared';

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

/** A stored date as ISO-8601, or null. The promote wire is loose about its format. */
function isoOrNull(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const parsed = new Date(stored);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function httpUrlOrNull(stored: string | null | undefined): string | null {
  return stored && /^https?:\/\//i.test(stored) ? stored : null;
}

/**
 * The display rule (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.23): who a visitor is told set
 * this value, or null when the value must not show. A value with no source on a
 * vendor that does not own its record may predate the AECI-1588 cleanup.
 */
export function companyFactSource(input: {
  value: unknown;
  sourceUrl: string | null | undefined;
  checkedAt: string | null | undefined;
  ownedAt: string | null | undefined;
  lock?: LockedField | undefined;
}): CompanyFactSource | null {
  if (input.value === null || input.value === undefined) return null;
  if (input.lock) return { set_by: 'aeci', date: isoOrNull(input.lock.set_at), url: null };
  const url = httpUrlOrNull(input.sourceUrl);
  if (url) return { set_by: 'aeci', date: isoOrNull(input.checkedAt), url };
  if (input.ownedAt) return { set_by: 'vendor', date: isoOrNull(input.checkedAt), url: null };
  return null;
}

/** The vendor columns the public facts read. */
export const companyFactColumns = {
  headquarters: true,
  foundedYear: true,
  companySize: true,
  publicPrivate: true,
  ownershipType: true,
  parentCompany: true,
  fundingStage: true,
  headquartersSourceUrl: true,
  headquartersCheckedAt: true,
  foundedYearSourceUrl: true,
  foundedYearCheckedAt: true,
  companySizeSourceUrl: true,
  companySizeCheckedAt: true,
  publicPrivateSourceUrl: true,
  publicPrivateCheckedAt: true,
  parentCompanySourceUrl: true,
  parentCompanyCheckedAt: true,
  fundingSourceUrl: true,
  fundingCheckedAt: true,
  ownedAt: true,
} as const;

export type CompanyFactRow = Pick<VendorRow, keyof typeof companyFactColumns>;

/** A vendor's public company facts. */
export function toCompanyFacts(
  row: CompanyFactRow,
  locks: readonly LockedField[] = [],
): CompanyFacts {
  const fact = <T>(
    field: string,
    value: T | null,
    sourceUrl: string | null,
    checkedAt: string | null,
  ): { value: T; source: CompanyFactSource } | null => {
    const source = companyFactSource({
      value,
      sourceUrl,
      checkedAt,
      ownedAt: row.ownedAt,
      lock: locks.find((l) => l.field === field),
    });
    return source && value !== null ? { value, source } : null;
  };
  return {
    headquarters: fact(
      'headquarters',
      row.headquarters,
      row.headquartersSourceUrl,
      row.headquartersCheckedAt,
    ),
    founded_year: fact(
      'founded_year',
      row.foundedYear,
      row.foundedYearSourceUrl,
      row.foundedYearCheckedAt,
    ),
    company_size: fact(
      'company_size',
      row.companySize as CompanySizeBand | null,
      row.companySizeSourceUrl,
      row.companySizeCheckedAt,
    ),
    ownership_type: fact(
      'ownership_type',
      effectiveOwnershipType(row),
      row.publicPrivateSourceUrl,
      row.publicPrivateCheckedAt,
    ),
    parent_company: fact(
      'parent_company',
      row.parentCompany,
      row.parentCompanySourceUrl,
      row.parentCompanyCheckedAt,
    ),
    funding_stage: fact(
      'funding_stage',
      row.fundingStage as FundingStage | null,
      row.fundingSourceUrl,
      row.fundingCheckedAt,
    ),
  };
}

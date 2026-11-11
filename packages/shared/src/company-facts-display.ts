/**
 * The public display rule for company facts (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.23).
 *
 * Pure, and shared so every writer of a public surface applies one copy: the vendor
 * page's Company facts panel, `VendorListItem`, the Worker's Algolia vendor transform
 * and the datatool full reindex (AECI-1635). Type-only imports keep zod out of the
 * datatool and browser graphs.
 */

import type { FieldCorrection } from './api/field-captions';
import type { CompanyFactSource } from './api/vendors';

/** A stored date as ISO-8601, or null. The promote wire is loose about its format. */
function isoOrNull(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const parsed = new Date(stored);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function httpUrlOrNull(stored: string | null | undefined): string | null {
  return stored && /^https?:\/\//i.test(stored) ? stored : null;
}

/** The provenance a fact's display rule reads, beside its value. */
export interface CompanyFactProvenance {
  sourceUrl: string | null | undefined;
  checkedAt: string | null | undefined;
  ownedAt: string | null | undefined;
  /** AECi's correction on this field, when it still holds. */
  correction?: FieldCorrection | undefined;
}

/**
 * The display rule: who a visitor is told set this value, or null when the value must
 * not show. An AECi correction comes first. A value with no source on a vendor that
 * does not own its record shows nowhere.
 */
export function companyFactSource(
  input: CompanyFactProvenance & { value: unknown },
): CompanyFactSource | null {
  if (input.value === null || input.value === undefined) return null;
  if (input.correction) {
    return {
      set_by: 'aeci',
      date: isoOrNull(input.correction.date),
      url: httpUrlOrNull(input.correction.source_url),
    };
  }
  const url = httpUrlOrNull(input.sourceUrl);
  if (url) return { set_by: 'aeci', date: isoOrNull(input.checkedAt), url };
  if (input.ownedAt) return { set_by: 'vendor', date: isoOrNull(input.checkedAt), url: null };
  return null;
}

/** The value a public surface may show, or null. The bare-value form of the rule. */
export function publicCompanyFact<T>(
  value: T | null | undefined,
  provenance: CompanyFactProvenance,
): T | null {
  if (value === null || value === undefined) return null;
  return companyFactSource({ ...provenance, value }) ? value : null;
}

/** One stored correction, as either reader selects it. */
export interface StoredCorrection {
  id: string;
  field: string;
  value: unknown;
  sourceUrl: string | null;
  setAt: string;
}

/** Whether `a` supersedes `b`: the later `setAt`, then the larger id. */
export function isNewerCorrection(
  a: Pick<StoredCorrection, 'id' | 'setAt'>,
  b: Pick<StoredCorrection, 'id' | 'setAt'>,
): boolean {
  return a.setAt > b.setAt || (a.setAt === b.setAt && a.id > b.id);
}

/** A scalar correction holds while its value is still the live value. */
export function scalarCorrectionHolds(value: unknown, live: unknown): boolean {
  if (Array.isArray(value)) return false;
  return (value ?? null) === (live ?? null);
}

/**
 * AECi's correction on one scalar field, when the newest one still holds. The same
 * rule `toFieldCorrections` applies to a scalar field on a public read.
 */
export function correctionFor(
  rows: readonly StoredCorrection[],
  field: string,
  live: unknown,
): FieldCorrection | undefined {
  let newest: StoredCorrection | undefined;
  for (const row of rows) {
    if (row.field !== field) continue;
    if (!newest || isNewerCorrection(row, newest)) newest = row;
  }
  if (!newest || !scalarCorrectionHolds(newest.value, live)) return undefined;
  const value = newest.value;
  return {
    field,
    date: newest.setAt,
    source_url: newest.sourceUrl,
    cleared: value === null || value === undefined,
  };
}

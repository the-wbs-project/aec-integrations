/**
 * The company-fact vocabularies (AECI-1310). A file of their own because public read
 * schemas use them, and importing `promote.ts` would pull its whole schema into the
 * web app's initial bundle.
 */

/** The employee bands AECi publishes (AECI-1310). Never an exact headcount. */
export const COMPANY_SIZE_BANDS = ['1-10', '11-50', '51-200', '201-1000', '1001+'] as const;
export type CompanySizeBand = (typeof COMPANY_SIZE_BANDS)[number];

/** Funding rounds (AECI-1310). An acquisition is a parent company, not a stage. */
export const FUNDING_STAGES = [
  'Bootstrapped',
  'Pre-seed',
  'Seed',
  'Series A',
  'Series B',
  'Series C',
  'Series D+',
  'Public',
] as const;
export type FundingStage = (typeof FUNDING_STAGES)[number];

/** Who owns the company (AECI-1310). Venture or PE backing is a funding stage or a parent. */
export const OWNERSHIP_TYPES = ['public', 'private', 'subsidiary', 'nonprofit'] as const;
export type OwnershipType = (typeof OWNERSHIP_TYPES)[number];

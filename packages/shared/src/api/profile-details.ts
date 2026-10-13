import { z } from 'zod';

/**
 * Account onboarding vocabularies (AECI-1296, `docs/ACCOUNT_ONBOARDING_SPEC.md`).
 *
 * The "About you" answers live in `profile_details` and `profile_audiences`,
 * which carry no CHECK constraints. These enums ARE the allowed values, so a
 * list can change without a D1 migration. Stored values are stable slugs. The
 * Angular form owns the localized labels.
 *
 * Its own module, not `account.ts`: `reviews.ts` reuses `PrimaryRoleSchema` and
 * `account.ts` already imports from `reviews.ts`, so defining it in either would
 * make an import cycle.
 */

/**
 * The explicit "I'd rather not say" answer on the profile's single choices. It is
 * a stored answer, not the absence of one: `null` means the question was never
 * answered. Review pre-fill treats it as empty.
 */
export const UNDISCLOSED = 'undisclosed';

/**
 * "Where do you work?" One answer, shown in three groups: AEC firms, software
 * companies, then "Other" and "I'd rather not say". Any software company type
 * takes the software branch: the company questions are hidden and the role list
 * is `SOFTWARE_COMPANY_ROLES`.
 *
 * `software_vendor` is the AEC software answer. It keeps the slug it shipped
 * with, so stored answers need no migration. The form labels it "AEC software".
 */
export const AEC_FIRM_TYPES = [
  'general_contractor',
  'trade_contractor',
  'architect',
  'engineer',
  'owner_developer',
  'construction_manager',
  'consultant',
] as const;
export const SOFTWARE_COMPANY_TYPES = [
  'software_vendor',
  'backoffice_software',
  'integration_platform',
  'other_software',
  'software_partner',
] as const;
export const COMPANY_TYPES = [
  ...AEC_FIRM_TYPES,
  ...SOFTWARE_COMPANY_TYPES,
  'other',
  'undisclosed',
] as const;
export const CompanyTypeSchema = z.enum(COMPANY_TYPES);
export type CompanyType = z.infer<typeof CompanyTypeSchema>;
export type SoftwareCompanyType = (typeof SOFTWARE_COMPANY_TYPES)[number];

/** True when the answer is one of the software company types. */
export function isSoftwareCompanyType(value: string | null | undefined): boolean {
  return (SOFTWARE_COMPANY_TYPES as readonly string[]).includes(value ?? '');
}

/** Head-count bands. Never asked of a software company (`SOFTWARE_COMPANY_TYPES`). */
export const COMPANY_SIZES = [
  '1-10',
  '11-50',
  '51-200',
  '201-1000',
  '1001-5000',
  '5000+',
  'undisclosed',
] as const;
export const CompanySizeSchema = z.enum(COMPANY_SIZES);
export type CompanySize = z.infer<typeof CompanySizeSchema>;

/**
 * The person's role. ONE list for onboarding and for `reviews.role_at_company`
 * (`SubmitReviewSchema`), so the review form's pre-fill maps one to one and the
 * two lists cannot drift.
 */
export const PRIMARY_ROLES = ['practitioner', 'manager', 'IT', 'exec', 'other'] as const;
export const PrimaryRoleSchema = z.enum(PRIMARY_ROLES);
export type PrimaryRole = z.infer<typeof PrimaryRoleSchema>;

/**
 * The roles offered to someone at a software company. Profile only: a review
 * is written by a software user, so `reviews.role_at_company` never takes these.
 * Prefixed `vendor_` so none can collide with a review role.
 */
export const SOFTWARE_COMPANY_ROLES = [
  'vendor_exec',
  'vendor_product',
  'vendor_engineering',
  'vendor_partnerships',
  'vendor_sales',
  'vendor_marketing',
  'vendor_customer_success',
  'vendor_services',
] as const;
export type SoftwareCompanyRole = (typeof SOFTWARE_COMPANY_ROLES)[number];

/**
 * The profile's role answer: the shared role list, the software company roles,
 * and `undisclosed`. Profile only. `reviews.role_at_company` keeps
 * `PrimaryRoleSchema`, so a review can never carry a software company role or
 * `undisclosed`. Which list the form offers follows the company type.
 */
export const PROFILE_PRIMARY_ROLES = [
  ...PRIMARY_ROLES,
  ...SOFTWARE_COMPANY_ROLES,
  UNDISCLOSED,
] as const;
export const ProfilePrimaryRoleSchema = z.enum(PROFILE_PRIMARY_ROLES);
export type ProfilePrimaryRole = z.infer<typeof ProfilePrimaryRoleSchema>;

/** Most audience terms one person may pick. Mirrors the per-facet cap vendors
 *  get on a product. */
export const MAX_PROFILE_AUDIENCES = 10;

/** The longest firm name we keep. Same cap as `reviews.reviewer_firm`. */
export const MAX_FIRM_NAME_LENGTH = 100;

/**
 * `<scheme>://` is optional on input, so a pasted `linkedin.com/in/jane` passes.
 * The host is `linkedin.com` or `www.linkedin.com`, any case. The path is
 * exactly `/in/<handle>` with an optional trailing slash. A query string or a
 * fragment is allowed on input and dropped by normalization.
 */
const LINKEDIN_PROFILE_RE =
  /^(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([A-Za-z0-9_%-]{2,100})\/?(?:[?#].*)?$/i;

/**
 * The canonical form of a LinkedIn profile URL, or `null` when `raw` is not
 * one. Canonical is `https://www.linkedin.com/in/<handle>`: https, lowercase
 * `www` host, no trailing slash, no query, no fragment. The handle keeps its
 * case, because LinkedIn serves it as typed.
 */
export function normalizeLinkedInProfileUrl(raw: string): string | null {
  const handle = raw.trim().match(LINKEDIN_PROFILE_RE)?.[1];
  return handle ? `https://www.linkedin.com/in/${handle}` : null;
}

/**
 * The LinkedIn field on `PATCH /api/account`. A blank string clears it (stored
 * as `null`), like an explicit `null`. Anything else must be a profile URL and
 * is normalized before it reaches the handler.
 */
export const LinkedInProfileUrlSchema = z
  .string()
  .trim()
  .max(200, 'Keep the LinkedIn URL under 200 characters.')
  .refine(
    (value) => value === '' || normalizeLinkedInProfileUrl(value) !== null,
    'Enter a LinkedIn profile URL (https://www.linkedin.com/in/…).',
  )
  .transform((value) => (value === '' ? null : normalizeLinkedInProfileUrl(value)));

/** Where a person stands with the onboarding form. `pending` = no answer yet. */
export const OnboardingStateSchema = z.enum(['pending', 'completed', 'skipped']);
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

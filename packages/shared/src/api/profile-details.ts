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

/** "Where do you work?" One answer. `software_vendor` routes the user to the
 *  vendor claim flow and hides the company questions. */
export const COMPANY_TYPES = [
  'general_contractor',
  'trade_contractor',
  'architect',
  'engineer',
  'owner_developer',
  'construction_manager',
  'consultant',
  'software_vendor',
  'other',
] as const;
export const CompanyTypeSchema = z.enum(COMPANY_TYPES);
export type CompanyType = z.infer<typeof CompanyTypeSchema>;

/** Head-count bands. Never asked of a software vendor. */
export const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-1000', '1001-5000', '5000+'] as const;
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

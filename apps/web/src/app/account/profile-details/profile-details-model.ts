/**
 * The "About you" draft and its labels (AECI-1296, `docs/ACCOUNT_ONBOARDING_SPEC.md`).
 *
 * Shared by `ProfileDetailsForm` (the questions), `/welcome`, `/account` and the
 * admin user screens, so a stored value reads the same everywhere. Stored values
 * are the `@aeci/shared` slugs. Every label here is `$localize`.
 */
import {
  normalizeLinkedInProfileUrl,
  type AccountProfileDetails,
  type CompanySize,
  type CompanyType,
  type PrimaryRole,
  type UpdateAccountInput,
} from '@aeci/shared';

/** The editable answers, as the form holds them. Text fields are never null. */
export interface ProfileDetailsDraft {
  readonly company_type: CompanyType | null;
  readonly company_size: CompanySize | null;
  readonly primary_role: PrimaryRole | null;
  readonly firm_name: string;
  readonly linkedin_url: string;
  readonly audience_ids: readonly string[];
}

export interface Labelled<V extends string> {
  readonly value: V;
  readonly label: string;
}

export const COMPANY_TYPE_OPTIONS: ReadonlyArray<Labelled<CompanyType>> = [
  {
    value: 'general_contractor',
    label: $localize`:@@profileDetails.companyType.generalContractor:General contractor`,
  },
  {
    value: 'trade_contractor',
    label: $localize`:@@profileDetails.companyType.tradeContractor:Trade contractor`,
  },
  { value: 'architect', label: $localize`:@@profileDetails.companyType.architect:Architect` },
  { value: 'engineer', label: $localize`:@@profileDetails.companyType.engineer:Engineer` },
  {
    value: 'owner_developer',
    label: $localize`:@@profileDetails.companyType.ownerDeveloper:Owner or developer`,
  },
  {
    value: 'construction_manager',
    label: $localize`:@@profileDetails.companyType.constructionManager:Construction manager`,
  },
  { value: 'consultant', label: $localize`:@@profileDetails.companyType.consultant:Consultant` },
  {
    value: 'software_vendor',
    label: $localize`:@@profileDetails.companyType.softwareVendor:Software vendor`,
  },
  { value: 'other', label: $localize`:@@profileDetails.companyType.other:Other` },
];

export const COMPANY_SIZE_OPTIONS: ReadonlyArray<Labelled<CompanySize>> = [
  { value: '1-10', label: $localize`:@@profileDetails.companySize.1to10:1 to 10 people` },
  { value: '11-50', label: $localize`:@@profileDetails.companySize.11to50:11 to 50 people` },
  { value: '51-200', label: $localize`:@@profileDetails.companySize.51to200:51 to 200 people` },
  {
    value: '201-1000',
    label: $localize`:@@profileDetails.companySize.201to1000:201 to 1,000 people`,
  },
  {
    value: '1001-5000',
    label: $localize`:@@profileDetails.companySize.1001to5000:1,001 to 5,000 people`,
  },
  {
    value: '5000+',
    label: $localize`:@@profileDetails.companySize.over5000:More than 5,000 people`,
  },
];

/** Plain-word labels for the shared role list. The stored values match the
 *  review form's `role_at_company`, so pre-fill maps one to one. */
export const PRIMARY_ROLE_OPTIONS: ReadonlyArray<Labelled<PrimaryRole>> = [
  {
    value: 'practitioner',
    label: $localize`:@@profileDetails.role.practitioner:Hands-on user`,
  },
  { value: 'manager', label: $localize`:@@profileDetails.role.manager:Manager or team lead` },
  { value: 'IT', label: $localize`:@@profileDetails.role.it:IT or systems` },
  { value: 'exec', label: $localize`:@@profileDetails.role.exec:Executive` },
  { value: 'other', label: $localize`:@@profileDetails.role.other:Other` },
];

/** The label for a stored value, or the raw value when this build does not
 *  know it (the admin screens show strings the API passes through). */
export function labelFor(
  options: ReadonlyArray<Labelled<string>>,
  value: string | null,
): string | null {
  if (value === null) return null;
  return options.find((o) => o.value === value)?.label ?? value;
}

export const EMPTY_DRAFT: ProfileDetailsDraft = {
  company_type: null,
  company_size: null,
  primary_role: null,
  firm_name: '',
  linkedin_url: '',
  audience_ids: [],
};

/** Seed a draft from the account read shape. Absent details (an older API)
 *  read as an empty draft. */
export function draftFromDetails(details: AccountProfileDetails | undefined): ProfileDetailsDraft {
  if (!details) return EMPTY_DRAFT;
  return {
    company_type: details.company_type,
    company_size: details.company_size,
    primary_role: details.primary_role,
    firm_name: details.firm_name ?? '',
    linkedin_url: details.linkedin_url ?? '',
    audience_ids: [...details.audience_ids],
  };
}

/** True when the draft answers "Where do you work?" with software vendor. */
export function isVendorDraft(draft: ProfileDetailsDraft): boolean {
  return draft.company_type === 'software_vendor';
}

/** True when the LinkedIn field holds something that is not a profile URL. An
 *  empty field is valid: the question is optional. */
export function linkedInInvalid(draft: ProfileDetailsDraft): boolean {
  const value = draft.linkedin_url.trim();
  return value !== '' && normalizeLinkedInProfileUrl(value) === null;
}

/**
 * The `PATCH /api/account` fields for a draft. Every answer is sent, so a save
 * writes the form as the user sees it. A software vendor never sees the size,
 * audience and firm questions, so those are cleared rather than left holding an
 * answer given under a different company type.
 */
export function draftToPatch(
  draft: ProfileDetailsDraft,
): Pick<
  UpdateAccountInput,
  'company_type' | 'company_size' | 'primary_role' | 'firm_name' | 'linkedin_url' | 'audience_ids'
> {
  const vendor = isVendorDraft(draft);
  return {
    company_type: draft.company_type,
    company_size: vendor ? null : draft.company_size,
    primary_role: draft.primary_role,
    firm_name: vendor ? null : draft.firm_name.trim() || null,
    linkedin_url: draft.linkedin_url.trim() || null,
    audience_ids: vendor ? [] : [...draft.audience_ids],
  };
}

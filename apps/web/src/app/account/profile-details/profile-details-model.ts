/**
 * The "About you" draft and its labels (AECI-1296, `docs/ACCOUNT_ONBOARDING_SPEC.md`).
 *
 * Shared by `ProfileDetailsForm` (the questions), `/welcome`, `/account` and the
 * admin user screens, so a stored value reads the same everywhere. Stored values
 * are the `@aeci/shared` slugs. Every label here is `$localize`.
 */
import {
  isSoftwareCompanyType,
  normalizeLinkedInProfileUrl,
  type AccountProfileDetails,
  type CompanySize,
  type CompanyType,
  type ProfilePrimaryRole,
  type UpdateAccountInput,
} from '@aeci/shared';

/** The editable answers, as the form holds them. Text fields are never null. */
export interface ProfileDetailsDraft {
  readonly company_type: CompanyType | null;
  readonly company_size: CompanySize | null;
  readonly primary_role: ProfilePrimaryRole | null;
  readonly firm_name: string;
  readonly linkedin_url: string;
  readonly audience_ids: readonly string[];
}

export interface Labelled<V extends string> {
  readonly value: V;
  readonly label: string;
  /** The heading of the group this option sits under, when the list is grouped. */
  readonly group?: string;
}

/**
 * The explicit "I'd rather not say" row. It is a stored answer (`undisclosed`),
 * not the unanswered state: an unanswered question shows the "Choose one"
 * placeholder. It sits last in every list, after "Other".
 */
const UNDISCLOSED_LABEL = $localize`:@@profileDetails.undisclosed:I'd rather not say`;

const AEC_FIRMS_GROUP = $localize`:@@profileDetails.companyType.group.aec:AEC firms`;
const SOFTWARE_GROUP = $localize`:@@profileDetails.companyType.group.software:Software companies`;
const OTHER_GROUP = $localize`:@@profileDetails.companyType.group.other:Other options`;

/**
 * Three groups: AEC firms, software companies, then "Other" and "I'd rather not
 * say". Alphabetical by label inside the first two. `software_vendor` is the
 * shipped slug for AEC software.
 */
export const COMPANY_TYPE_OPTIONS: ReadonlyArray<Labelled<CompanyType>> = [
  {
    value: 'architect',
    label: $localize`:@@profileDetails.companyType.architect:Architect`,
    group: AEC_FIRMS_GROUP,
  },
  {
    value: 'construction_manager',
    label: $localize`:@@profileDetails.companyType.constructionManager:Construction manager`,
    group: AEC_FIRMS_GROUP,
  },
  {
    value: 'consultant',
    label: $localize`:@@profileDetails.companyType.consultant:Consultant`,
    group: AEC_FIRMS_GROUP,
  },
  {
    value: 'engineer',
    label: $localize`:@@profileDetails.companyType.engineer:Engineer`,
    group: AEC_FIRMS_GROUP,
  },
  {
    value: 'general_contractor',
    label: $localize`:@@profileDetails.companyType.generalContractor:General contractor`,
    group: AEC_FIRMS_GROUP,
  },
  {
    value: 'owner_developer',
    label: $localize`:@@profileDetails.companyType.ownerDeveloper:Owner or developer`,
    group: AEC_FIRMS_GROUP,
  },
  {
    value: 'trade_contractor',
    label: $localize`:@@profileDetails.companyType.tradeContractor:Trade contractor`,
    group: AEC_FIRMS_GROUP,
  },
  {
    value: 'software_vendor',
    label: $localize`:@@profileDetails.companyType.softwareVendor:AEC software`,
    group: SOFTWARE_GROUP,
  },
  {
    value: 'backoffice_software',
    label: $localize`:@@profileDetails.companyType.backofficeSoftware:Back-office software, like ERP, accounting or HR`,
    group: SOFTWARE_GROUP,
  },
  {
    value: 'integration_platform',
    label: $localize`:@@profileDetails.companyType.integrationPlatform:Integration platform`,
    group: SOFTWARE_GROUP,
  },
  {
    value: 'other_software',
    label: $localize`:@@profileDetails.companyType.otherSoftware:Other software`,
    group: SOFTWARE_GROUP,
  },
  {
    value: 'software_partner',
    label: $localize`:@@profileDetails.companyType.softwarePartner:Reseller or implementation partner`,
    group: SOFTWARE_GROUP,
  },
  {
    value: 'other',
    label: $localize`:@@profileDetails.companyType.other:Other`,
    group: OTHER_GROUP,
  },
  { value: 'undisclosed', label: UNDISCLOSED_LABEL, group: OTHER_GROUP },
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
  { value: 'undisclosed', label: UNDISCLOSED_LABEL },
];

const OTHER_ROLE: Labelled<ProfilePrimaryRole> = {
  value: 'other',
  label: $localize`:@@profileDetails.role.other:Other`,
};
const UNDISCLOSED_ROLE: Labelled<ProfilePrimaryRole> = {
  value: 'undisclosed',
  label: UNDISCLOSED_LABEL,
};

/** Plain-word labels for the role list, alphabetical, then "Other", then "I'd
 *  rather not say". Every value but `undisclosed` matches the review form's
 *  `role_at_company`, so pre-fill maps one to one and skips `undisclosed`. */
export const PRIMARY_ROLE_OPTIONS: ReadonlyArray<Labelled<ProfilePrimaryRole>> = [
  { value: 'exec', label: $localize`:@@profileDetails.role.exec:Executive` },
  {
    value: 'practitioner',
    label: $localize`:@@profileDetails.role.practitioner:Hands-on user`,
  },
  { value: 'IT', label: $localize`:@@profileDetails.role.it:IT or systems` },
  { value: 'manager', label: $localize`:@@profileDetails.role.manager:Manager or team lead` },
  OTHER_ROLE,
  UNDISCLOSED_ROLE,
];

/**
 * The role list for someone at a software company, alphabetical, then "Other",
 * then "I'd rather not say". Profile only: none of these is a review role, so
 * review pre-fill leaves the role control empty for them.
 */
export const SOFTWARE_COMPANY_ROLE_OPTIONS: ReadonlyArray<Labelled<ProfilePrimaryRole>> = [
  {
    value: 'vendor_customer_success',
    label: $localize`:@@profileDetails.role.vendorCustomerSuccess:Customer success or support`,
  },
  {
    value: 'vendor_engineering',
    label: $localize`:@@profileDetails.role.vendorEngineering:Engineering`,
  },
  {
    value: 'vendor_exec',
    label: $localize`:@@profileDetails.role.vendorExec:Founder or executive`,
  },
  {
    value: 'vendor_services',
    label: $localize`:@@profileDetails.role.vendorServices:Implementation or professional services`,
  },
  {
    value: 'vendor_marketing',
    label: $localize`:@@profileDetails.role.vendorMarketing:Marketing`,
  },
  {
    value: 'vendor_partnerships',
    label: $localize`:@@profileDetails.role.vendorPartnerships:Partnerships or integrations`,
  },
  {
    value: 'vendor_product',
    label: $localize`:@@profileDetails.role.vendorProduct:Product management`,
  },
  {
    value: 'vendor_sales',
    label: $localize`:@@profileDetails.role.vendorSales:Sales or business development`,
  },
  OTHER_ROLE,
  UNDISCLOSED_ROLE,
];

/** Every role label, for screens that show a stored role whatever the company
 *  type (the admin user detail). */
export const ALL_ROLE_OPTIONS: ReadonlyArray<Labelled<ProfilePrimaryRole>> = [
  ...PRIMARY_ROLE_OPTIONS,
  ...SOFTWARE_COMPANY_ROLE_OPTIONS.filter((o) => o !== OTHER_ROLE && o !== UNDISCLOSED_ROLE),
];

/** The role list offered for a company type. */
export function roleOptionsFor(
  companyType: CompanyType | null,
): ReadonlyArray<Labelled<ProfilePrimaryRole>> {
  return isSoftwareCompanyType(companyType) ? SOFTWARE_COMPANY_ROLE_OPTIONS : PRIMARY_ROLE_OPTIONS;
}

/** The role, or `null` when it is not on the list offered for the company type.
 *  "Other" and "I'd rather not say" are on both lists, so they survive a switch. */
export function roleForCompanyType(
  role: ProfilePrimaryRole | null,
  companyType: CompanyType | null,
): ProfilePrimaryRole | null {
  if (role === null) return null;
  return roleOptionsFor(companyType).some((o) => o.value === role) ? role : null;
}

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

/** True when the draft answers "Where do you work?" with any software company
 *  type. That takes the software branch: no company questions, software roles. */
export function isVendorDraft(draft: ProfileDetailsDraft): boolean {
  return isSoftwareCompanyType(draft.company_type);
}

/** True when the LinkedIn field holds something that is not a profile URL. An
 *  empty field is valid: the question is optional. */
export function linkedInInvalid(draft: ProfileDetailsDraft): boolean {
  const value = draft.linkedin_url.trim();
  return value !== '' && normalizeLinkedInProfileUrl(value) === null;
}

/**
 * The `PATCH /api/account` fields for a draft. Every answer is sent, so a save
 * writes the form as the user sees it. A software company never sees the size,
 * audience and firm questions, so those are cleared rather than left holding an
 * answer given under a different company type. A role from the other group's
 * list is cleared for the same reason.
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
    primary_role: roleForCompanyType(draft.primary_role, draft.company_type),
    firm_name: vendor ? null : draft.firm_name.trim() || null,
    linkedin_url: draft.linkedin_url.trim() || null,
    audience_ids: vendor ? [] : [...draft.audience_ids],
  };
}

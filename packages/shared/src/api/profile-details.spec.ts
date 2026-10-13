/**
 * AECI-1296: the "About you" vocabularies. Pins `undisclosed` as a stored
 * profile answer that a review can never carry, and the LinkedIn normalizer.
 */
import { describe, expect, it } from 'vitest';

import { UpdateAccountSchema } from './account';
import {
  CompanySizeSchema,
  CompanyTypeSchema,
  PRIMARY_ROLES,
  PrimaryRoleSchema,
  ProfilePrimaryRoleSchema,
  SOFTWARE_COMPANY_ROLES,
  SOFTWARE_COMPANY_TYPES,
  isSoftwareCompanyType,
  normalizeLinkedInProfileUrl,
} from './profile-details';
import { SubmitReviewSchema } from './reviews';

describe('software companies', () => {
  it('keeps the shipped software_vendor slug and adds the other software types', () => {
    for (const type of SOFTWARE_COMPANY_TYPES) {
      expect(CompanyTypeSchema.parse(type)).toBe(type);
      expect(isSoftwareCompanyType(type)).toBe(true);
    }
    expect(SOFTWARE_COMPANY_TYPES).toContain('software_vendor');
    expect(isSoftwareCompanyType('architect')).toBe(false);
    expect(isSoftwareCompanyType('other')).toBe(false);
    expect(isSoftwareCompanyType(null)).toBe(false);
  });

  it('stores a software company role on the profile, never on a review', () => {
    const roleField = SubmitReviewSchema.shape.role_at_company;
    for (const role of SOFTWARE_COMPANY_ROLES) {
      expect(ProfilePrimaryRoleSchema.parse(role)).toBe(role);
      expect(PrimaryRoleSchema.safeParse(role).success).toBe(false);
      expect(roleField.safeParse(role).success).toBe(false);
    }
  });
});

describe('undisclosed', () => {
  it('is a stored answer for company type, size and the profile role', () => {
    expect(CompanyTypeSchema.parse('undisclosed')).toBe('undisclosed');
    expect(CompanySizeSchema.parse('undisclosed')).toBe('undisclosed');
    expect(ProfilePrimaryRoleSchema.parse('undisclosed')).toBe('undisclosed');
    expect(
      UpdateAccountSchema.parse({
        company_type: 'undisclosed',
        company_size: 'undisclosed',
        primary_role: 'undisclosed',
      }),
    ).toMatchObject({
      company_type: 'undisclosed',
      company_size: 'undisclosed',
      primary_role: 'undisclosed',
    });
  });

  it('is never a review role', () => {
    expect(PrimaryRoleSchema.safeParse('undisclosed').success).toBe(false);
    expect(PRIMARY_ROLES).not.toContain('undisclosed');
    const roleField = SubmitReviewSchema.shape.role_at_company;
    expect(roleField.safeParse('undisclosed').success).toBe(false);
    expect(roleField.safeParse('manager').success).toBe(true);
  });

  it('keeps every review role valid on the profile', () => {
    for (const role of PRIMARY_ROLES) {
      expect(ProfilePrimaryRoleSchema.safeParse(role).success, role).toBe(true);
    }
  });
});

describe('normalizeLinkedInProfileUrl', () => {
  it('accepts a scheme-less profile path and canonicalizes it', () => {
    expect(normalizeLinkedInProfileUrl('linkedin.com/in/your-name')).toBe(
      'https://www.linkedin.com/in/your-name',
    );
    expect(normalizeLinkedInProfileUrl('HTTPS://WWW.LinkedIn.com/in/Ada/?x=1')).toBe(
      'https://www.linkedin.com/in/Ada',
    );
  });

  it('refuses a company page and a lookalike host', () => {
    expect(normalizeLinkedInProfileUrl('linkedin.com/company/acme')).toBeNull();
    expect(normalizeLinkedInProfileUrl('linkedin.com.evil.io/in/ada')).toBeNull();
  });
});

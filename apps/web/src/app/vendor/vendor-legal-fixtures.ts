import type { VendorLegalAcceptanceResponse } from '@aeci/shared';

// ─── AECI-1677: the acceptance screen ─────────────────────────────────────────
// The preview's versions are the current drafts, 1.3 and 1.1, because their fixed copies
// (`/legal/<slug>/v<version>`) are real pages, so "Read version" resolves in the preview.
// In production a draft is never in force (`LEGAL_AGREEMENT_EFFECTIVE_ON`).

const LEGAL_SIGNER = {
  name: 'Priya Raman',
  title: 'Head of Partnerships',
  legal_name: 'Northwind Software, Inc.',
};

/** Blocking mode, owner seat (ruling 24). */
export const LEGAL_REQUIRED_OWNER_FIXTURE: VendorLegalAcceptanceResponse = {
  blocked: true,
  can_accept: true,
  pending: [
    {
      document: 'vendor_terms',
      version: '1.3',
      mode: 'required',
      effective_at: '2026-12-15T12:00:00.000Z',
      in_force: true,
      summary: [
        'The liability cap counts the fees you paid in the 12 months before a claim.',
        'Disputes go to the courts named in the terms, with a jury waiver.',
      ],
      page_path: '/legal/vendor-terms/v1.3',
    },
  ],
  owner_names: [],
  signer: LEGAL_SIGNER,
  stripe_billing: true,
};

/** Blocking mode, member seat: nothing to accept, the owners named. */
export const LEGAL_REQUIRED_MEMBER_FIXTURE: VendorLegalAcceptanceResponse = {
  ...LEGAL_REQUIRED_OWNER_FIXTURE,
  can_accept: false,
  owner_names: ['Priya Raman', 'Sam Okafor'],
  signer: null,
  stripe_billing: false,
};

/** Optional mode, a Vendor Terms version that needs acceptance (ruling 25). */
export const LEGAL_OPTIONAL_TERMS_FIXTURE: VendorLegalAcceptanceResponse = {
  blocked: false,
  can_accept: true,
  pending: [
    {
      document: 'vendor_terms',
      version: '1.3',
      mode: 'optional',
      effective_at: '2027-01-31T12:00:00.000Z',
      in_force: false,
      summary: ['The indemnity now covers content you upload, not content we write.'],
      page_path: '/legal/vendor-terms/v1.3',
    },
  ],
  owner_names: [],
  signer: LEGAL_SIGNER,
  stripe_billing: true,
};

/** Optional mode, the Managed plan click for a monthly card subscription (counsel Q3). */
export const LEGAL_OPTIONAL_MANAGED_FIXTURE: VendorLegalAcceptanceResponse = {
  blocked: false,
  can_accept: true,
  pending: [
    {
      document: 'managed_plan',
      version: '1.1',
      mode: 'optional',
      effective_at: '2027-01-31T12:00:00.000Z',
      in_force: false,
      summary: ['Refunds for an annual subscription are pro rata for unused whole months.'],
      page_path: '/legal/managed-plan-agreement/v1.1',
    },
  ],
  owner_names: [],
  // An invited owner with no name, title or legal name on file: the screen asks for all three.
  signer: { name: null, title: null, legal_name: null },
  stripe_billing: true,
};

/** Nothing pending: the state after an accept, and the state of every vendor today. */
export const LEGAL_NOTHING_PENDING_FIXTURE: VendorLegalAcceptanceResponse = {
  blocked: false,
  can_accept: true,
  pending: [],
  owner_names: [],
  signer: null,
  stripe_billing: false,
};

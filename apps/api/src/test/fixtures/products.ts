/**
 * Hand-curated product fixtures. Two products, both linked to Procore as the
 * primary vendor, used to exercise list pagination, detail hydration, taxonomy
 * filtering, and `related_products`.
 */

import { Prisma } from '@prisma/client/edge';

import type { RawProductDetailRow, RawProductListRow } from '../../lib/prisma-helpers';
import { PROCORE_VENDOR_ID } from './vendors';

export const PROCORE_PRODUCT_ID = '00000000-0000-4000-8000-000000020001';
export const REVIZTO_PRODUCT_ID = '00000000-0000-4000-8000-000000020002';

const procoreVendorLink = {
  id: PROCORE_VENDOR_ID,
  companyName: 'Procore Technologies',
  slug: 'procore',
  logoUrl: 'https://example.com/logos/procore.png' as string | null,
};

const projectManagementCategoryWithOrder = {
  id: '00000000-0000-4000-8000-000000030001',
  name: 'Project Management',
  slug: 'project-management',
  displayOrder: 1 as number | null,
};

/**
 * Null-displayOrder category — exercises the `pickPrimaryCategory()` rule
 * that treats `null` as `Infinity` so the explicitly-ordered category wins.
 */
const fieldManagementCategoryWithOrder = {
  id: '00000000-0000-4000-8000-000000030002',
  name: 'Field Management',
  slug: 'field-management',
  displayOrder: null as number | null,
};

export const procoreProductRow: RawProductListRow = {
  id: PROCORE_PRODUCT_ID,
  slug: 'procore',
  name: 'Procore',
  logoUrl: 'https://example.com/logos/procore-product.png',
  productRole: 'application',
  integrationCount: 12,
  reviewCount: 3,
  ratingOverallAvg: new Prisma.Decimal(4.5),
  ratingOnboardingAvg: new Prisma.Decimal(4.2),
  createdAt: new Date('2024-03-01T00:00:00Z'),
  updatedAt: new Date('2024-06-15T00:00:00Z'),
  productVendors: [{ isPrimary: true, vendor: procoreVendorLink }],
  productCategories: [
    { category: fieldManagementCategoryWithOrder },
    { category: projectManagementCategoryWithOrder },
  ],
};

export const reviztoProductRow: RawProductListRow = {
  id: REVIZTO_PRODUCT_ID,
  slug: 'revizto',
  name: 'Revizto',
  logoUrl: null,
  productRole: 'application',
  integrationCount: 5,
  reviewCount: 0,
  ratingOverallAvg: null,
  ratingOnboardingAvg: null,
  createdAt: new Date('2024-04-15T00:00:00Z'),
  updatedAt: new Date('2024-04-15T00:00:00Z'),
  productVendors: [{ isPrimary: true, vendor: procoreVendorLink }],
  productCategories: [],
};

export const procoreProductDetailRow: RawProductDetailRow = {
  ...procoreProductRow,
  description: 'A construction management platform.',
  website: 'https://www.procore.com',
  toolIntegrationsUrl: 'https://www.procore.com/integrations',
  apiDocsUrl: 'https://developers.procore.com',
  hasApiDocs: true,
  productAudiences: [
    {
      audience: {
        id: '00000000-0000-4000-8000-000000040001',
        name: 'Construction',
        slug: 'construction',
      },
    },
  ],
  productPhases: [
    {
      phase: {
        id: '00000000-0000-4000-8000-000000050001',
        name: 'Construction',
        slug: 'construction-phase',
      },
    },
  ],
  sourceIntegrations: [],
  targetIntegrations: [],
  // Narrative "how teams use it" jsonb (AECI-171/-173). Slug-based groups keyed by
  // the same taxonomy terms this product is tagged with; `points` are free-form prose.
  usefulness: {
    audiences: [
      {
        slug: 'construction',
        name: 'Construction',
        points: ['Track RFIs and submittals across every job.', 'Standardize daily logs.'],
      },
    ],
    phases: [
      {
        slug: 'construction-phase',
        name: 'Construction',
        points: ['Keep field and office on one schedule of record.'],
      },
    ],
  },
};

export const allProductRows: RawProductListRow[] = [procoreProductRow, reviztoProductRow];

/**
 * Hand-curated vendor fixtures for AECI-54 route specs. Deterministic; small
 * enough to enumerate. UUIDs follow the same family (`...vendor-N`) so
 * cross-referencing across product/integration fixtures is grep-able.
 *
 * Two vendors:
 *   - Procore (verified, has products)
 *   - Autodesk (verified, no products in this fixture set — exercises empty
 *     `products` array on VendorDetail)
 */

import type { RawVendorDetailRow, RawVendorListRow } from '../../lib/prisma-helpers';

export const PROCORE_VENDOR_ID = '00000000-0000-4000-8000-000000010001';
export const AUTODESK_VENDOR_ID = '00000000-0000-4000-8000-000000010002';

export const procoreVendorRow: RawVendorListRow = {
  id: PROCORE_VENDOR_ID,
  slug: 'procore',
  companyName: 'Procore Technologies',
  logoUrl: 'https://example.com/logos/procore.png',
  verified: true,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-06-01T00:00:00Z'),
  _count: { productVendors: 1, builtIntegrations: 2 },
};

export const autodeskVendorRow: RawVendorListRow = {
  id: AUTODESK_VENDOR_ID,
  slug: 'autodesk',
  companyName: 'Autodesk',
  logoUrl: null,
  verified: true,
  createdAt: new Date('2024-02-01T00:00:00Z'),
  updatedAt: new Date('2024-05-01T00:00:00Z'),
  _count: { productVendors: 0, builtIntegrations: 0 },
};

export const procoreVendorDetailRow: RawVendorDetailRow = {
  ...procoreVendorRow,
  description: 'Construction management platform.',
  website: 'https://www.procore.com',
  headquarters: 'Carpinteria, CA',
  foundedYear: 2002,
  productVendors: [], // Filled in via a deep merge in the spec — keeps this file circular-import-free.
};

export const allVendorRows: RawVendorListRow[] = [procoreVendorRow, autodeskVendorRow];

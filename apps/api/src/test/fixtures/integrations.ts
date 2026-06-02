/**
 * Hand-curated integration fixtures covering:
 *   - Fully populated row (name, mechanism_kind, direction all set).
 *   - Null-name row (exercises the synthesised "Source → Target" rule).
 *   - Null-mechanism row (exercises the AECI-115 null passthrough — the mapper
 *     surfaces `mechanism_kind: null`, no longer coercing to 'native').
 */

import type { RawIntegrationDetailRow, RawIntegrationListRow } from '../../lib/prisma-helpers';
import { PROCORE_PRODUCT_ID, REVIZTO_PRODUCT_ID } from './products';

export const PROCORE_REVIZTO_INTEGRATION_ID = '00000000-0000-4000-8000-000000060001';
export const NULL_NAME_INTEGRATION_ID = '00000000-0000-4000-8000-000000060002';

const procoreLink = {
  id: PROCORE_PRODUCT_ID,
  name: 'Procore',
  slug: 'procore',
  logoUrl: 'https://example.com/logos/procore-product.png' as string | null,
};

const reviztoLink = {
  id: REVIZTO_PRODUCT_ID,
  name: 'Revizto',
  slug: 'revizto',
  logoUrl: null as string | null,
};

export const procoreReviztoIntegrationRow: RawIntegrationListRow = {
  id: PROCORE_REVIZTO_INTEGRATION_ID,
  name: 'Procore <> Revizto sync',
  mechanismKind: 'native',
  mechanismName: 'Built-in connector',
  direction: 'bidirectional',
  sourceProduct: procoreLink,
  targetProduct: reviztoLink,
  createdAt: new Date('2024-05-01T00:00:00Z'),
  updatedAt: new Date('2024-05-15T00:00:00Z'),
};

/**
 * Null name + null mechanismKind row. The mapper must synthesise the name as
 * `${source.name} → ${target.name}` and surface `mechanism_kind: null`
 * (AECI-115 passthrough — no longer defaulted to 'native').
 */
export const nullNameIntegrationRow: RawIntegrationListRow = {
  id: NULL_NAME_INTEGRATION_ID,
  name: null,
  mechanismKind: null,
  mechanismName: null,
  direction: null,
  sourceProduct: procoreLink,
  targetProduct: reviztoLink,
  createdAt: new Date('2024-06-01T00:00:00Z'),
  updatedAt: new Date('2024-06-01T00:00:00Z'),
};

export const procoreReviztoIntegrationDetailRow: RawIntegrationDetailRow = {
  ...procoreReviztoIntegrationRow,
  description: 'Sync issues between Procore and Revizto.',
  listingUrl: 'https://www.procore.com/marketplace/revizto',
  docsUrl: 'https://docs.revizto.com/procore',
  mechanismUrl: null,
  pricingModel: 'free',
  maturity: 'production',
  builtByVendor: null,
  poweredByProduct: null,
};

export const allIntegrationRows: RawIntegrationListRow[] = [
  procoreReviztoIntegrationRow,
  nullNameIntegrationRow,
];

/**
 * Hand-curated taxonomy fixtures. Two categories — one with a `displayOrder`
 * set, one with `null` so the mapper's coalesce-to-0 rule is exercised.
 */

import type { RawTaxonomyDetailRow, RawTaxonomyTermRow } from '../../lib/prisma-helpers';
import { procoreProductRow } from './products';

export const PROJECT_MGMT_CATEGORY_ID = '00000000-0000-4000-8000-000000030001';
export const FIELD_MGMT_CATEGORY_ID = '00000000-0000-4000-8000-000000030002';
export const CONSTRUCTION_AUDIENCE_ID = '00000000-0000-4000-8000-000000040001';
export const CONSTRUCTION_PHASE_ID = '00000000-0000-4000-8000-000000050001';

export const projectManagementCategoryRow: RawTaxonomyTermRow = {
  id: PROJECT_MGMT_CATEGORY_ID,
  slug: 'project-management',
  name: 'Project Management',
  description: 'Tools for managing construction projects.',
  displayOrder: 1,
  _count: { productCategories: 5 },
};

/**
 * `displayOrder: null` row. Mapper coalesces to 0 — schema requires non-null
 * `display_order`.
 */
export const fieldManagementCategoryRow: RawTaxonomyTermRow = {
  id: FIELD_MGMT_CATEGORY_ID,
  slug: 'field-management',
  name: 'Field Management',
  description: null,
  displayOrder: null,
  _count: { productCategories: 0 },
};

export const constructionAudienceRow: RawTaxonomyTermRow = {
  id: CONSTRUCTION_AUDIENCE_ID,
  slug: 'construction',
  name: 'Construction',
  description: 'Building and erecting structures.',
  displayOrder: 1,
  _count: { productAudiences: 7 },
};

export const constructionPhaseRow: RawTaxonomyTermRow = {
  id: CONSTRUCTION_PHASE_ID,
  slug: 'construction-phase',
  name: 'Construction',
  description: 'On-site construction phase.',
  displayOrder: 3,
  _count: { productPhases: 4 },
};

export const projectManagementCategoryDetailRow: RawTaxonomyDetailRow = {
  ...projectManagementCategoryRow,
  productCategories: [{ product: procoreProductRow }],
};

export const constructionAudienceDetailRow: RawTaxonomyDetailRow = {
  ...constructionAudienceRow,
  productAudiences: [{ product: procoreProductRow }],
};

export const constructionPhaseDetailRow: RawTaxonomyDetailRow = {
  ...constructionPhaseRow,
  productPhases: [{ product: procoreProductRow }],
};

export const allCategoryRows: RawTaxonomyTermRow[] = [
  projectManagementCategoryRow,
  fieldManagementCategoryRow,
];

export const allAudienceRows: RawTaxonomyTermRow[] = [constructionAudienceRow];

export const allPhaseRows: RawTaxonomyTermRow[] = [constructionPhaseRow];

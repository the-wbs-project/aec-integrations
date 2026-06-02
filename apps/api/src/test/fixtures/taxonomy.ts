/**
 * Hand-curated taxonomy fixtures. Two categories — one with a `displayOrder`
 * set, one with `null` so the mapper's coalesce-to-0 rule is exercised.
 */

import type {
  RawCategoryDetailRow,
  RawCategoryTermRow,
  RawDisciplineDetailRow,
  RawDisciplineTermRow,
  RawPhaseDetailRow,
  RawPhaseTermRow,
} from '../../lib/prisma-helpers';
import { procoreProductRow } from './products';

export const PROJECT_MGMT_CATEGORY_ID = '00000000-0000-4000-8000-000000030001';
export const FIELD_MGMT_CATEGORY_ID = '00000000-0000-4000-8000-000000030002';
export const CONSTRUCTION_DISCIPLINE_ID = '00000000-0000-4000-8000-000000040001';
export const CONSTRUCTION_PHASE_ID = '00000000-0000-4000-8000-000000050001';

export const projectManagementCategoryRow: RawCategoryTermRow = {
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
export const fieldManagementCategoryRow: RawCategoryTermRow = {
  id: FIELD_MGMT_CATEGORY_ID,
  slug: 'field-management',
  name: 'Field Management',
  description: null,
  displayOrder: null,
  _count: { productCategories: 0 },
};

export const constructionDisciplineRow: RawDisciplineTermRow = {
  id: CONSTRUCTION_DISCIPLINE_ID,
  slug: 'construction',
  name: 'Construction',
  description: 'Building and erecting structures.',
  displayOrder: 1,
  _count: { productDisciplines: 7 },
};

export const constructionPhaseRow: RawPhaseTermRow = {
  id: CONSTRUCTION_PHASE_ID,
  slug: 'construction-phase',
  name: 'Construction',
  description: 'On-site construction phase.',
  displayOrder: 3,
  _count: { productPhases: 4 },
};

export const projectManagementCategoryDetailRow: RawCategoryDetailRow = {
  ...projectManagementCategoryRow,
  productCategories: [{ product: procoreProductRow }],
};

export const constructionDisciplineDetailRow: RawDisciplineDetailRow = {
  ...constructionDisciplineRow,
  productDisciplines: [{ product: procoreProductRow }],
};

export const constructionPhaseDetailRow: RawPhaseDetailRow = {
  ...constructionPhaseRow,
  productPhases: [{ product: procoreProductRow }],
};

export const allCategoryRows: RawCategoryTermRow[] = [
  projectManagementCategoryRow,
  fieldManagementCategoryRow,
];

export const allDisciplineRows: RawDisciplineTermRow[] = [constructionDisciplineRow];

export const allPhaseRows: RawPhaseTermRow[] = [constructionPhaseRow];

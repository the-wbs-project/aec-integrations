import type { AecIconName } from './icon-registry';

/**
 * AECI-1753 - which icon stands for which vocabulary term.
 *
 * The registry names drawings. This file says what each drawing is used for, so a
 * rename of a use never touches a drawing. Both maps are typed over the full
 * vocabulary, so a term with no entry fails to compile. `null` means no drawing
 * exists yet for that term: the surface shows no icon, never a stand-in. A spec
 * (`icon-maps.spec.ts`) checks the data-object slugs against the vocabulary's
 * JSON mirror in `docs/`.
 */

/**
 * Every `data_object` slug in `docs/DATA_OBJECT_VOCABULARY.md` section 4 and its
 * JSON mirror. Add a slug here in the same change that adds it to the vocabulary.
 */
export const DATA_OBJECT_SLUGS = [
  'projects',
  'models',
  'drawings',
  'specifications',
  'bids-tenders',
  'commitments',
  'prime-contracts',
  'budgets',
  'cost-codes',
  'change-orders',
  'job-costs',
  'invoices-payments',
  'general-ledger',
  'schedules',
  'rfis',
  'submittals',
  'meetings',
  'daily-logs',
  'photos',
  'inspections',
  'punch-lists',
  'time-labor',
  'equipment',
  'documents',
  'directory-contacts',
  'employees',
  'compliance-documents',
] as const;

export type DataObjectSlug = (typeof DATA_OBJECT_SLUGS)[number];

/**
 * The mock-ups drew 15 data-object icons (17 names, two of which, markups and
 * observations, are not vocabulary terms). The other 12 terms have no drawing.
 */
export const DATA_OBJECT_ICONS: Record<DataObjectSlug, AecIconName | null> = {
  projects: null,
  models: 'cube',
  drawings: 'sheet-grid',
  specifications: null,
  'bids-tenders': null,
  commitments: 'clasped-hands',
  'prime-contracts': null,
  budgets: 'pie-chart',
  'cost-codes': 'hash',
  'change-orders': 'file-swap',
  'job-costs': null,
  'invoices-payments': 'receipt',
  'general-ledger': null,
  schedules: 'gantt',
  rfis: 'chat-question',
  submittals: 'layers-triple',
  meetings: null,
  'daily-logs': 'calendar-lines',
  photos: null,
  inspections: null,
  'punch-lists': 'checklist',
  'time-labor': 'stopwatch',
  equipment: 'wrench',
  documents: null,
  'directory-contacts': 'contact-card',
  employees: null,
  'compliance-documents': null,
};

/**
 * Taxonomy facets the mock-ups gave a heading icon. `category` and `data_object`
 * have none here. A data object takes its own term's icon from `DATA_OBJECT_ICONS`.
 * Categories are not a static vocabulary in the app, so no typed map exists yet:
 * the mock-ups' `CAT_IC` mapping (10 categories) is recorded on the product page
 * issue.
 */
export type FacetIconKey = 'phase' | 'audience' | 'trade';

export const FACET_ICONS: Record<FacetIconKey, AecIconName> = {
  phase: 'nodes-row',
  audience: 'users',
  trade: 'hard-hat',
};

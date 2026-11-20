/**
 * AECI-1875: the one list of surfaces the accessibility nightly visits.
 *
 * Every check the AECI-1874 sub-issues add (axe, keyboard, focus, reflow and the
 * rest) iterates this list. Add a surface here, not in a spec.
 *
 * Sources. The entries come from two lists, and each entry names which:
 *   - `manual-checklist-1`: `docs/a11y-manual-testing-checklist.md` §1. That list
 *     and this one must change together.
 *   - `phase2-a11y`: the 14 URLs `e2e/phase2-a11y.spec.ts` scans on every PR.
 *     That spec keeps its own copy, so the PR job is untouched.
 *
 * Fixtures. `phase2` rows come from `apps/api/seed/phase2-fixtures.sql` and
 * `auth` rows from `apps/api/seed/auth-fixtures.sql`. `dev:bound` seeds both
 * into the local D1. A signed-in persona always needs its `auth` profile row too.
 *
 * Redesign. `underRedesign` marks the pages `docs/design/mockups/redesign-2026-11/PLAN.md`
 * (AECI-1571) is rebuilding: the product page and the pair page. A check that
 * fails there may be waiting on the redesign rather than a fix.
 */
import type { SessionPersona } from '../e2e/auth-session';

export type Persona = 'anonymous' | 'reviewer' | 'admin' | 'vendor';

/** The seed a surface needs beyond the base taxonomy. */
export type Fixture = 'none' | 'phase2' | 'auth';

export type SurfaceSource = 'manual-checklist-1' | 'phase2-a11y';

export interface A11ySurface {
  /** Stable kebab-case key. Reports and the summary artifact use it. */
  readonly id: string;
  readonly name: string;
  readonly route: string;
  readonly fixture: Fixture;
  readonly persona: Persona;
  readonly underRedesign: boolean;
  /** The 404 surface answers 404 on purpose. Every other surface answers 200. */
  readonly expectStatus: 200 | 404;
  readonly sources: readonly SurfaceSource[];
}

/**
 * Fixture identities. The source of truth is `apps/api/seed/phase2-fixtures.sql`.
 * The taxonomy slugs are reference data from `apps/api/seed/taxonomy.sql`. The
 * same values appear in `e2e/phase2-a11y.spec.ts` and `.lighthouserc.cjs`.
 */
export const FIXTURE = {
  productSlug: 'fixture-procore',
  vendorSlug: 'fixture-procore-technologies',
  integrationId: '00000000-0000-4000-8000-000000000065',
  /** The fixture integration's other product, the second half of the pair. */
  otherProductSlug: 'fixture-acme-connector',
  categorySlug: 'project-management',
  audienceSlug: 'general-contracting',
  phaseSlug: 'construction',
} as const;

/**
 * Which test account signs in for a persona. `null` means no session.
 *
 * TODO(AECI-1874): the reviewer persona signs in as the admin test user until a
 * plain reviewer account exists. Change it here and nowhere else.
 */
export function personaCredentials(persona: Persona): SessionPersona | null {
  switch (persona) {
    case 'anonymous':
      return null;
    case 'reviewer':
      return 'admin';
    case 'admin':
      return 'admin';
    case 'vendor':
      return 'vendor';
  }
}

const PUBLIC = { persona: 'anonymous', underRedesign: false, expectStatus: 200 } as const;
const PHASE2_ONLY: readonly SurfaceSource[] = ['phase2-a11y'];
const CHECKLIST_ONLY: readonly SurfaceSource[] = ['manual-checklist-1'];

const SURFACE_LIST: readonly A11ySurface[] = [
  // --- docs/a11y-manual-testing-checklist.md §1 --------------------------------
  { ...PUBLIC, id: 'home', name: 'Home', route: '/', fixture: 'none', sources: CHECKLIST_ONLY },
  {
    ...PUBLIC,
    id: 'product-detail',
    name: 'Product detail',
    route: `/products/${FIXTURE.productSlug}`,
    fixture: 'phase2',
    underRedesign: true,
    sources: ['manual-checklist-1', 'phase2-a11y'],
  },
  {
    id: 'review-submission',
    name: 'Review submission',
    route: `/products/${FIXTURE.productSlug}/review`,
    fixture: 'phase2',
    persona: 'reviewer',
    underRedesign: false,
    expectStatus: 200,
    sources: CHECKLIST_ONLY,
  },
  {
    ...PUBLIC,
    id: 'login',
    name: 'Login',
    route: '/auth/login',
    fixture: 'none',
    sources: CHECKLIST_ONLY,
  },
  {
    id: 'account',
    name: 'Account',
    route: '/account',
    fixture: 'auth',
    persona: 'reviewer',
    underRedesign: false,
    expectStatus: 200,
    sources: CHECKLIST_ONLY,
  },
  {
    id: 'admin-reviews',
    name: 'Admin moderation queue',
    route: '/admin/reviews',
    fixture: 'auth',
    persona: 'admin',
    underRedesign: false,
    expectStatus: 200,
    sources: CHECKLIST_ONLY,
  },
  {
    id: 'admin-requests',
    name: 'Admin requests queue',
    route: '/admin/requests',
    fixture: 'auth',
    persona: 'admin',
    underRedesign: false,
    expectStatus: 200,
    sources: CHECKLIST_ONLY,
  },
  {
    id: 'vendor-products',
    name: 'Vendor portal products',
    route: `/vendor/${FIXTURE.vendorSlug}/products`,
    fixture: 'phase2',
    persona: 'vendor',
    underRedesign: false,
    expectStatus: 200,
    sources: CHECKLIST_ONLY,
  },
  {
    id: 'vendor-integrations',
    name: 'Vendor portal integrations',
    // Integrations are per product in the portal (vendor.routes.ts
    // `products/:productSlug/integrations`). The vendor persona owns fixture-procore.
    route: `/vendor/${FIXTURE.vendorSlug}/products/${FIXTURE.productSlug}/integrations`,
    fixture: 'phase2',
    persona: 'vendor',
    underRedesign: false,
    expectStatus: 200,
    sources: CHECKLIST_ONLY,
  },

  // --- e2e/phase2-a11y.spec.ts (product detail is above) -----------------------
  {
    ...PUBLIC,
    id: 'product-index',
    name: 'Product index',
    route: '/products',
    fixture: 'none',
    sources: PHASE2_ONLY,
  },
  {
    ...PUBLIC,
    id: 'vendor-index',
    name: 'Vendor index',
    route: '/vendors',
    fixture: 'none',
    sources: PHASE2_ONLY,
  },
  {
    ...PUBLIC,
    id: 'vendor-detail',
    name: 'Vendor detail',
    route: `/vendors/${FIXTURE.vendorSlug}`,
    fixture: 'phase2',
    sources: PHASE2_ONLY,
  },
  {
    ...PUBLIC,
    id: 'integration-index',
    name: 'Integration index',
    route: '/integrations',
    fixture: 'none',
    sources: PHASE2_ONLY,
  },
  {
    ...PUBLIC,
    id: 'integration-detail',
    name: 'Integration detail',
    route: `/integrations/${FIXTURE.integrationId}`,
    fixture: 'phase2',
    sources: PHASE2_ONLY,
  },
  {
    ...PUBLIC,
    id: 'product-pair',
    name: 'Product pair',
    route: `/products/${FIXTURE.productSlug}/integrations/${FIXTURE.otherProductSlug}`,
    fixture: 'phase2',
    underRedesign: true,
    sources: PHASE2_ONLY,
  },
  {
    ...PUBLIC,
    id: 'category-browse',
    name: 'Category browse',
    route: `/categories/${FIXTURE.categorySlug}`,
    fixture: 'none',
    sources: PHASE2_ONLY,
  },
  {
    ...PUBLIC,
    id: 'audience-browse',
    name: 'Audience browse',
    route: `/audiences/${FIXTURE.audienceSlug}`,
    fixture: 'none',
    sources: PHASE2_ONLY,
  },
  {
    ...PUBLIC,
    id: 'phase-browse',
    name: 'Phase browse',
    route: `/phases/${FIXTURE.phaseSlug}`,
    fixture: 'none',
    sources: PHASE2_ONLY,
  },
  {
    ...PUBLIC,
    id: 'categories-index',
    name: 'Categories index',
    route: '/categories',
    fixture: 'none',
    sources: PHASE2_ONLY,
  },
  {
    ...PUBLIC,
    id: 'audiences-index',
    name: 'Audiences index',
    route: '/audiences',
    fixture: 'none',
    sources: PHASE2_ONLY,
  },
  {
    ...PUBLIC,
    id: 'phases-index',
    name: 'Phases index',
    route: '/phases',
    fixture: 'none',
    sources: PHASE2_ONLY,
  },
  {
    ...PUBLIC,
    id: 'not-found',
    name: 'Not found',
    route: '/aeci-65-no-such-page',
    fixture: 'none',
    expectStatus: 404,
    sources: PHASE2_ONLY,
  },
];

/** The manifest, frozen so a check cannot edit it for the checks after it. */
export const SURFACES: readonly A11ySurface[] = Object.freeze(
  SURFACE_LIST.map((s) => Object.freeze({ ...s, sources: Object.freeze([...s.sources]) })),
);

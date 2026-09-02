import { describe, expect, it } from 'vitest';

import { MECHANISM_RANK, mechanismRank } from '../algolia';
import {
  IntegrationDetailSchema,
  IntegrationListItemSchema,
  IntegrationMechanismKindSchema,
  IntegrationSortSchema,
  IntegrationsListQuerySchema,
  IntegrationsListResponseSchema,
} from './integrations';
import { MECHANISM_KINDS } from './promote';
import { registerSchemaStructuralCases } from './schema-suite.harness';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const productLink = (n: number, name: string, slug: string) => ({
  id: uuid(n),
  name,
  slug,
  logo_url: null,
});

const validListItem = {
  id: uuid(10),
  name: 'Procore → BIM 360',
  mechanism_kind: 'native' as const,
  mechanism_name: null,
  direction: 'one-way' as const,
  source: productLink(1, 'Procore', 'procore'),
  target: productLink(2, 'BIM 360', 'bim-360'),
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

// Structural cases (sort defaults/unknown-key, pagination defaults + perPage cap,
// response page-wrap) are shared via the harness (AECI-113).
registerSchemaStructuralCases({
  entity: 'integrations',
  sortSchema: IntegrationSortSchema,
  sortDefault: 'name',
  listQuerySchema: IntegrationsListQuerySchema,
  listResponseSchema: IntegrationsListResponseSchema,
  validListItem,
});

describe('IntegrationListItemSchema', () => {
  it('parses a valid list item', () => {
    const parsed = IntegrationListItemSchema.parse(validListItem);
    expect(parsed.source.slug).toBe('procore');
    expect(parsed.target.slug).toBe('bim-360');
  });

  it('accepts a null direction', () => {
    const parsed = IntegrationListItemSchema.parse({
      ...validListItem,
      direction: null,
    });
    expect(parsed.direction).toBeNull();
  });

  it('accepts a null mechanism_kind (column unset — AECI-115)', () => {
    const parsed = IntegrationListItemSchema.parse({
      ...validListItem,
      mechanism_kind: null,
    });
    expect(parsed.mechanism_kind).toBeNull();
  });

  it('rejects an unknown mechanism_kind', () => {
    const result = IntegrationListItemSchema.safeParse({
      ...validListItem,
      mechanism_kind: 'rpa',
    });
    expect(result.success).toBe(false);
  });
});

describe('IntegrationDetailSchema', () => {
  it('parses a detail with all optional fields filled in', () => {
    const parsed = IntegrationDetailSchema.parse({
      ...validListItem,
      description: 'Pushes RFIs from Procore to BIM 360.',
      listing_url: 'https://procore.com/marketplace/bim-360',
      docs_url: 'https://developers.procore.com/bim-360',
      mechanism_url: null,
      built_by_vendor: {
        id: uuid(20),
        name: 'Procore',
        slug: 'procore',
        logo_url: null,
        verified: false,
      },
      powered_by_product: null,
      pricing_model: 'free',
      maturity: 'GA',
    });
    expect(parsed.built_by_vendor?.slug).toBe('procore');
    expect(parsed.powered_by_product).toBeNull();
  });

  it('rejects a non-URL docs_url', () => {
    const result = IntegrationDetailSchema.safeParse({
      ...validListItem,
      description: null,
      listing_url: null,
      docs_url: 'not a url',
      mechanism_url: null,
      built_by_vendor: null,
      powered_by_product: null,
      pricing_model: null,
      maturity: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('IntegrationsListQuerySchema', () => {
  it('validates sourceProductId and targetProductId as UUIDs', () => {
    const parsed = IntegrationsListQuerySchema.parse({
      sourceProductId: uuid(1),
      targetProductId: uuid(2),
    });
    expect(parsed.sourceProductId).toBe(uuid(1));
    expect(parsed.targetProductId).toBe(uuid(2));
  });

  it('rejects a non-UUID sourceProductId', () => {
    const result = IntegrationsListQuerySchema.safeParse({ sourceProductId: 'nope' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown mechanism_kind', () => {
    const result = IntegrationsListQuerySchema.safeParse({ mechanism_kind: 'rpa' });
    expect(result.success).toBe(false);
  });
});

// ─── The mechanism-vocabulary lockstep (AECI-735) ────────────────────────────
//
// Five independent lists spell out the same vocabulary and NOTHING derives one
// from another:
//
//   1. `IntegrationMechanismKindSchema` — here
//   2. `MECHANISM_KINDS`                — `./promote` (the promote wire enum)
//   3. `MECHANISM_RANK`                 — `../algolia` (Algolia ranking weights)
//   4. `VALID_MECHANISM_KINDS`          — `apps/api/src/lib/drizzle-helpers.ts`
//   5. `MECHANISM_ORDER`                — `apps/web/.../powered-hub-grouping.ts`
//
// plus the D1 `integrations_mechanism_kind_check`. This file pins the canonical
// set and covers the three that live in this package; (4) and (5) assert against
// `IntegrationMechanismKindSchema.options` in their own packages, and the CHECK is
// covered in `apps/api/src/test/d1.spec.ts`.
//
// Drift is not uniformly loud. A value missing from (2) 400s a whole promote
// payload (`PromotePayloadSchema` is parsed whole before the Workflow starts); one
// missing from (4) throws on read (`toMechanismKind` is fail-loud). But (3) falls
// through to rank `0` and (5) is used as a FILTER — both degrade SILENTLY, which is
// what this suite exists to catch.
describe('mechanism vocabulary lockstep', () => {
  // The canonical set. Changing it means a hand-assembled D1 migration (a CHECK
  // change is a destructive table recreate) plus every list above, in one commit.
  //
  // `iPaaS` and `partner` are BOTH still here on purpose, and for different
  // reasons — AECI-735. `iPaaS` is permanent: it is the marker behind
  // `isConnectorPoweredEdge` (AECI-705's attestation gate), `routeIntegrationLane`
  // clause (c) (the Via lane) and `MECHANISM_ORDER`, over a population AECI-700
  // parks indefinitely. `partner` is pending AECI-712's upstream re-key.
  const MECHANISM_VOCABULARY = [
    'native',
    'iPaaS',
    'marketplace-app',
    'api',
    'webhook',
    'partner',
    'integrator',
  ] as const;

  const sorted = (values: readonly string[]) => [...values].sort();

  it('pins the vocabulary', () => {
    expect(sorted(IntegrationMechanismKindSchema.options)).toEqual(sorted(MECHANISM_VOCABULARY));
  });

  it('matches the promote wire enum — a missing value 400s a whole payload', () => {
    expect(sorted(MECHANISM_KINDS)).toEqual(sorted(MECHANISM_VOCABULARY));
  });

  it('matches MECHANISM_RANK — an absent key SILENTLY ranks 0', () => {
    expect(sorted(Object.keys(MECHANISM_RANK))).toEqual(sorted(MECHANISM_VOCABULARY));
    // …and every weight is a real one, not the unknown-kind sentinel.
    for (const kind of MECHANISM_VOCABULARY) {
      expect(mechanismRank(kind)).toBeGreaterThan(0);
    }
  });
});

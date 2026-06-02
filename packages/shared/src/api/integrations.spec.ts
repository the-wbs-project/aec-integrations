import { describe, expect, it } from 'vitest';

import {
  IntegrationDetailSchema,
  IntegrationListItemSchema,
  IntegrationSortSchema,
  IntegrationsListQuerySchema,
  IntegrationsListResponseSchema,
} from './integrations';
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
      built_by_vendor: { id: uuid(20), name: 'Procore', slug: 'procore', logo_url: null },
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

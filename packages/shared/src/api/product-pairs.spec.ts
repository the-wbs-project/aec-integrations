import { describe, expect, it } from 'vitest';

import { ContextDirectionSchema } from './integrations';
import { ProductPairMechanismSchema, ProductPairResponseSchema } from './product-pairs';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const productListItem = (n: number, slug: string, name: string) => ({
  id: uuid(n),
  slug,
  name,
  logo_url: null,
  product_role: 'application' as const,
  vendor: { id: uuid(n + 100), name: `${name} Inc`, slug: `${slug}-inc`, logo_url: null },
  primary_category: null,
  integration_count: 1,
  review_count: 0,
  rating_overall_avg: null,
  rating_onboarding_avg: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
});

const validMechanism = {
  id: uuid(10),
  mechanism_kind: 'marketplace-app' as const,
  mechanism_name: 'Procore + Autodesk Construction Cloud',
  direction: 'outbound' as const,
  description: 'The marketplace connector.',
  listing_url: 'https://example.com/listing',
  docs_url: null,
  built_by_vendor: null,
  powered_by_product: null,
};

describe('ContextDirectionSchema', () => {
  it('accepts the three context-relative directions', () => {
    expect(ContextDirectionSchema.parse('outbound')).toBe('outbound');
    expect(ContextDirectionSchema.parse('inbound')).toBe('inbound');
    expect(ContextDirectionSchema.parse('both')).toBe('both');
  });

  it('rejects the stored (endpoint-relative) direction values', () => {
    expect(ContextDirectionSchema.safeParse('a_to_b').success).toBe(false);
    expect(ContextDirectionSchema.safeParse('one-way').success).toBe(false);
  });
});

describe('ProductPairMechanismSchema', () => {
  it('parses a mechanism', () => {
    const parsed = ProductPairMechanismSchema.parse(validMechanism);
    expect(parsed.direction).toBe('outbound');
  });

  it('accepts a null direction and null mechanism_kind', () => {
    const parsed = ProductPairMechanismSchema.parse({
      ...validMechanism,
      direction: null,
      mechanism_kind: null,
    });
    expect(parsed.direction).toBeNull();
    expect(parsed.mechanism_kind).toBeNull();
  });
});

describe('ProductPairResponseSchema', () => {
  it('parses a populated pair', () => {
    const parsed = ProductPairResponseSchema.parse({
      context_product: productListItem(1, 'procore', 'Procore'),
      other_product: productListItem(2, 'revit', 'Revit'),
      mechanisms: [validMechanism],
      sync_headline: { total: 0, confirmed: 0 },
    });
    expect(parsed.context_product.slug).toBe('procore');
    expect(parsed.mechanisms).toHaveLength(1);
    expect(parsed.sync_headline.total).toBe(0);
  });

  it('parses an empty pair (both products exist, no integrations → mechanisms: [])', () => {
    const parsed = ProductPairResponseSchema.parse({
      context_product: productListItem(1, 'procore', 'Procore'),
      other_product: productListItem(2, 'revit', 'Revit'),
      mechanisms: [],
      sync_headline: { total: 0, confirmed: 0 },
    });
    expect(parsed.mechanisms).toEqual([]);
  });

  it('rejects a negative sync_headline count', () => {
    const result = ProductPairResponseSchema.safeParse({
      context_product: productListItem(1, 'procore', 'Procore'),
      other_product: productListItem(2, 'revit', 'Revit'),
      mechanisms: [],
      sync_headline: { total: -1, confirmed: 0 },
    });
    expect(result.success).toBe(false);
  });
});

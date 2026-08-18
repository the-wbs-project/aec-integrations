import { describe, expect, it } from 'vitest';

import { ContextDirectionSchema } from './integrations';
import {
  PairTimelineResponseSchema,
  PairVersionDiffSchema,
  ProductPairMechanismSchema,
  ProductPairResponseSchema,
} from './product-pairs';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const productListItem = (n: number, slug: string, name: string) => ({
  id: uuid(n),
  slug,
  name,
  logo_url: null,
  product_role: 'application' as const,
  vendor: {
    id: uuid(n + 100),
    name: `${name} Inc`,
    slug: `${slug}-inc`,
    logo_url: null,
    verified: false,
  },
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

  it('defaults version_diff to null — an API Worker predating AECI-303 still parses', () => {
    // The SSR and API Workers deploy per-commit but not atomically, and `null` is
    // also the live spelling of "the diff does not apply", so one value covers both.
    const parsed = ProductPairResponseSchema.parse({
      context_product: productListItem(1, 'procore', 'Procore'),
      other_product: productListItem(2, 'revit', 'Revit'),
      mechanisms: [],
      sync_headline: { total: 0, confirmed: 0 },
    });
    expect(parsed.version_diff).toBeNull();
  });
});

// ─── The version selectors (AECI-303 / §9) ───────────────────────────────────

const validDiff = {
  context_versions: [{ label: '2026.1', released_at: null }],
  other_versions: [{ label: 'v5', released_at: '2026-01-15' }],
  selected: { context: '2026.1', other: 'v5' },
  previous: null,
  is_default: true,
};

describe('PairVersionDiffSchema', () => {
  it('parses a minimal diff and defaults the optional halves', () => {
    const parsed = PairVersionDiffSchema.parse(validDiff);
    expect(parsed.previous).toBeNull();
    expect(parsed.counts).toEqual({ added: 0, removed: 0 });
    // An API that predates the seam had no gate, so `full` is the honest default.
    expect(parsed.diff_access).toBe('full');
  });

  it('requires is_default — the resolver reads it to decide noindex', () => {
    const { is_default: _omitted, ...withoutDefault } = validDiff;
    expect(PairVersionDiffSchema.safeParse(withoutDefault).success).toBe(false);
  });

  it('accepts a null side on selected and previous (a product with no releases)', () => {
    const parsed = PairVersionDiffSchema.parse({
      ...validDiff,
      selected: { context: '2026.1', other: null },
      previous: { context: null, other: null },
    });
    expect(parsed.selected.other).toBeNull();
  });

  it('rejects an unknown diff_access — the render path switches on this enum', () => {
    expect(PairVersionDiffSchema.safeParse({ ...validDiff, diff_access: 'premium' }).success).toBe(
      false,
    );
  });

  it('rejects negative counts', () => {
    expect(
      PairVersionDiffSchema.safeParse({ ...validDiff, counts: { added: -1, removed: 0 } }).success,
    ).toBe(false);
  });

  it('rejects a version carrying a sort_key — ordering must not reach the browser', () => {
    // Strict-object rejection is the structural half of the §8.2 rule that the API
    // never exposes an ordering the client could re-derive.
    const result = PairVersionDiffSchema.safeParse({
      ...validDiff,
      context_versions: [{ label: '2026.1', released_at: null, sort_key: 1 }],
    });
    expect(result.success).toBe(true);
    // zod strips unknown keys rather than failing, so assert the STRIPPING: a stray
    // sort_key cannot survive onto the parsed value the browser reads.
    if (result.success) {
      expect(result.data.context_versions[0]).toEqual({ label: '2026.1', released_at: null });
    }
  });
});

describe('PairTimelineResponseSchema', () => {
  it('defaults an empty gated response', () => {
    const parsed = PairTimelineResponseSchema.parse({});
    expect(parsed.claims).toEqual([]);
    expect(parsed.diff_access).toBe('full');
  });

  it('parses an entry with a retraction and omitted version stamps', () => {
    const parsed = PairTimelineResponseSchema.parse({
      claims: [
        {
          claim_id: uuid(30),
          entries: [
            {
              attestor: 'context',
              asserted: true,
              note: null,
              created_at: '2026-01-01T00:00:00.000Z',
              retracted_at: '2026-02-01T00:00:00.000Z',
            },
          ],
        },
      ],
    });
    // A non-null `retracted_at` is what makes the row history rather than state.
    expect(parsed.claims[0]!.entries[0]!.retracted_at).toBe('2026-02-01T00:00:00.000Z');
    expect(parsed.claims[0]!.entries[0]).not.toHaveProperty('introduced_version');
  });

  it('requires retracted_at to be present (nullable, not optional)', () => {
    // Absent would be ambiguous with "still live"; the timeline's whole job is
    // distinguishing the two.
    const result = PairTimelineResponseSchema.safeParse({
      claims: [
        {
          claim_id: uuid(30),
          entries: [
            {
              attestor: 'aeci',
              asserted: true,
              note: null,
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

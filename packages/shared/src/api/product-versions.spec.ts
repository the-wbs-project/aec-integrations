/**
 * Wire-contract coverage for the product-version schemas (AECI-607 / §8).
 *
 * The cases that matter are the guard-rails, not the happy path: the allow-list
 * (no `product_id`, no `id`, nothing AECi-owned), the date-only discipline on the
 * release stamps, and the `sort_key` bound that keeps a hand-set key inside the
 * safe-integer range the derived ones occupy.
 */

import { describe, expect, it } from 'vitest';

import { MAX_VERSION_SORT_KEY } from '../version-sort';
import {
  CreateProductVersionSchema,
  ListProductVersionsResponseSchema,
  ProductVersionResponseSchema,
  ProductVersionSchema,
  UpdateProductVersionSchema,
} from './product-versions';

const VERSION = {
  id: '00000000-0000-4000-8000-000000000001',
  product_id: '00000000-0000-4000-8000-000000000010',
  label: '2026.1',
  released_at: '2026-01-15',
  sunset_at: null,
  sort_key: 20_260_000_100_000,
  created_at: '2026-01-15T00:00:00.000Z',
  updated_at: '2026-01-15T00:00:00.000Z',
};

describe('ProductVersionSchema', () => {
  it('parses a version row', () => {
    expect(ProductVersionSchema.parse(VERSION)).toEqual(VERSION);
  });

  it('allows null release/sunset stamps — a version need not have dates', () => {
    const parsed = ProductVersionSchema.parse({
      ...VERSION,
      released_at: null,
      sunset_at: null,
    });
    expect(parsed.released_at).toBeNull();
  });

  it('requires sort_key — ordering can never fall back to the label', () => {
    const { sort_key: _omitted, ...withoutSortKey } = VERSION;
    expect(ProductVersionSchema.safeParse(withoutSortKey).success).toBe(false);
  });
});

describe('ListProductVersionsResponseSchema', () => {
  it('wraps the ordered list', () => {
    const parsed = ListProductVersionsResponseSchema.parse({ versions: [VERSION] });
    expect(parsed.versions).toHaveLength(1);
  });

  it('accepts an empty list — a product with no declared versions is normal', () => {
    expect(ListProductVersionsResponseSchema.parse({ versions: [] }).versions).toEqual([]);
  });
});

describe('ProductVersionResponseSchema', () => {
  it('wraps the single version POST and PATCH echo', () => {
    expect(ProductVersionResponseSchema.parse({ version: VERSION }).version.label).toBe('2026.1');
  });
});

describe('CreateProductVersionSchema', () => {
  it('accepts a label alone — sort_key is derived server-side', () => {
    const parsed = CreateProductVersionSchema.parse({ label: '2026.1' });
    expect(parsed.label).toBe('2026.1');
    expect(parsed.sort_key).toBeUndefined();
  });

  it('accepts an explicit sort_key override', () => {
    expect(CreateProductVersionSchema.parse({ label: 'LTS', sort_key: 42 }).sort_key).toBe(42);
  });

  it('trims the label and rejects an empty one', () => {
    expect(CreateProductVersionSchema.parse({ label: '  v5.2  ' }).label).toBe('v5.2');
    expect(CreateProductVersionSchema.safeParse({ label: '   ' }).success).toBe(false);
  });

  it('rejects a label over 60 characters', () => {
    expect(CreateProductVersionSchema.safeParse({ label: 'v'.repeat(61) }).success).toBe(false);
  });

  it('requires a label', () => {
    expect(CreateProductVersionSchema.safeParse({ sort_key: 1 }).success).toBe(false);
  });

  it('takes date-only release stamps and rejects an instant', () => {
    expect(
      CreateProductVersionSchema.parse({ label: 'v1', released_at: '2026-01-15' }).released_at,
    ).toBe('2026-01-15');
    expect(
      CreateProductVersionSchema.safeParse({ label: 'v1', released_at: '2026-01-15T00:00:00.000Z' })
        .success,
    ).toBe(false);
    expect(
      CreateProductVersionSchema.safeParse({ label: 'v1', released_at: 'January' }).success,
    ).toBe(false);
  });

  it('bounds sort_key to a non-negative safe integer', () => {
    expect(CreateProductVersionSchema.safeParse({ label: 'v1', sort_key: -1 }).success).toBe(false);
    expect(CreateProductVersionSchema.safeParse({ label: 'v1', sort_key: 1.5 }).success).toBe(
      false,
    );
    expect(
      CreateProductVersionSchema.safeParse({ label: 'v1', sort_key: MAX_VERSION_SORT_KEY }).success,
    ).toBe(true);
    expect(
      CreateProductVersionSchema.safeParse({ label: 'v1', sort_key: MAX_VERSION_SORT_KEY + 1 })
        .success,
    ).toBe(false);
  });

  it('strips AECi-owned and path-derived keys — the allow-list IS the guard-rail', () => {
    const parsed = CreateProductVersionSchema.parse({
      label: 'v1',
      id: 'attacker-chosen',
      product_id: '00000000-0000-4000-8000-000000000099',
      created_at: '2000-01-01T00:00:00.000Z',
    }) as Record<string, unknown>;
    expect(parsed).toEqual({ label: 'v1' });
  });
});

describe('UpdateProductVersionSchema', () => {
  it('accepts a single field', () => {
    expect(UpdateProductVersionSchema.parse({ label: '2026.2' }).label).toBe('2026.2');
  });

  it('rejects an empty body', () => {
    expect(UpdateProductVersionSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a body whose only keys are non-allow-listed', () => {
    // Zod strips them, so the object is empty by the time superRefine runs — the
    // vendor gets a clear 400 rather than a silent no-op 200.
    expect(UpdateProductVersionSchema.safeParse({ product_id: 'x' }).success).toBe(false);
  });

  it('distinguishes absent from null on the date stamps', () => {
    expect(UpdateProductVersionSchema.parse({ sunset_at: null }).sunset_at).toBeNull();
    expect('sunset_at' in UpdateProductVersionSchema.parse({ label: 'v2' })).toBe(false);
  });

  it('accepts sort_key: null — the explicit "re-derive from the label" instruction', () => {
    const parsed = UpdateProductVersionSchema.parse({ label: '2026.2', sort_key: null });
    expect(parsed.sort_key).toBeNull();
    // Absent is different: it means "leave the key exactly where it is".
    expect('sort_key' in UpdateProductVersionSchema.parse({ label: '2026.2' })).toBe(false);
  });
});

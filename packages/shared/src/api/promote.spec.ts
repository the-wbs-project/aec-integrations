import { describe, expect, it } from 'vitest';

import { EntityRefSchema, PromotePayloadSchema } from './promote';

const uuid = '00000001-0000-4000-8000-000000000000';

describe('EntityRefSchema', () => {
  it('accepts exactly one of ref or supabaseId', () => {
    expect(EntityRefSchema.safeParse({ ref: 'p1' }).success).toBe(true);
    expect(EntityRefSchema.safeParse({ supabaseId: uuid }).success).toBe(true);
  });

  it('rejects zero or both', () => {
    expect(EntityRefSchema.safeParse({}).success).toBe(false);
    expect(EntityRefSchema.safeParse({ ref: 'p1', supabaseId: uuid }).success).toBe(false);
  });

  it('rejects a non-uuid supabaseId', () => {
    expect(EntityRefSchema.safeParse({ supabaseId: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('PromotePayloadSchema', () => {
  const minimal = { product: { ref: 'p1', name: 'Revit' } };

  it('applies defaults (productRole, empty arrays)', () => {
    const parsed = PromotePayloadSchema.parse(minimal);
    expect(parsed.product?.productRole).toBe('application');
    expect(parsed.product?.categories).toEqual([]);
    expect(parsed.vendors).toEqual([]);
    expect(parsed.integrations).toEqual([]);
  });

  it('accepts a vendor-only push (no product)', () => {
    const vendorOnly = { vendors: [{ ref: 'v1', supabaseId: uuid, companyName: 'Autodesk' }] };
    const result = PromotePayloadSchema.safeParse(vendorOnly);
    expect(result.success).toBe(true);
    expect(result.success && result.data.product).toBeUndefined();
  });

  it('rejects a completely empty payload', () => {
    expect(PromotePayloadSchema.safeParse({}).success).toBe(false);
    expect(PromotePayloadSchema.safeParse({ vendors: [] }).success).toBe(false);
  });

  it('rejects an integration endpoint ref when no product is present', () => {
    const bad = {
      integrations: [
        { ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: uuid } },
      ],
    };
    expect(PromotePayloadSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an invalid productRole enum', () => {
    const bad = { product: { ref: 'p1', name: 'Revit', productRole: 'plugin' } };
    expect(PromotePayloadSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects duplicate refs across the payload', () => {
    const dup = {
      vendors: [{ ref: 'x', companyName: 'A' }],
      product: { ref: 'x', name: 'Revit' },
    };
    const result = PromotePayloadSchema.safeParse(dup);
    expect(result.success).toBe(false);
  });

  it('rejects an integration endpoint ref that is not the product', () => {
    const bad = {
      product: { ref: 'p1', name: 'Revit' },
      integrations: [{ ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { ref: 'other' } }],
    };
    expect(PromotePayloadSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects builtByVendor ref that is not a declared vendor', () => {
    const bad = {
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: uuid },
          builtByVendor: { ref: 'ghost' },
        },
      ],
    };
    expect(PromotePayloadSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects extensionOf referenced by ref (must use supabaseId)', () => {
    const bad = {
      product: { ref: 'p1', name: 'Revit', extensionOf: [{ ref: 'p1' }] },
    };
    expect(PromotePayloadSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a full valid bundle', () => {
    const ok = {
      vendors: [{ ref: 'v1', companyName: 'Autodesk', isPrimary: true }],
      product: {
        ref: 'p1',
        name: 'Revit',
        categories: ['BIM'],
        extensionOf: [{ supabaseId: uuid }],
      },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: uuid },
          builtByVendor: { ref: 'v1' },
        },
      ],
    };
    expect(PromotePayloadSchema.safeParse(ok).success).toBe(true);
  });
});

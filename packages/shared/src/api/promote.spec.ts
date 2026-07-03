import { describe, expect, it } from 'vitest';

import {
  EntityRefSchema,
  PromoteAttestationSchema,
  PromoteClaimSchema,
  PromotePayloadSchema,
} from './promote';

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

describe('PromoteAttestationSchema', () => {
  it('accepts each attestation source and requires asserted', () => {
    for (const source of ['aeci', 'vendor_a', 'vendor_b'] as const) {
      expect(PromoteAttestationSchema.safeParse({ source, asserted: true }).success).toBe(true);
    }
    // `asserted` is required and must be a boolean.
    expect(PromoteAttestationSchema.safeParse({ source: 'aeci' }).success).toBe(false);
    expect(PromoteAttestationSchema.safeParse({ source: 'aeci', asserted: 'yes' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown source', () => {
    expect(PromoteAttestationSchema.safeParse({ source: 'curator', asserted: true }).success).toBe(
      false,
    );
  });

  it('accepts the dormant introducedAt / deprecatedAt / note fields', () => {
    const parsed = PromoteAttestationSchema.parse({
      source: 'aeci',
      asserted: true,
      introducedAt: '2026-01-01',
      deprecatedAt: null,
      note: 'seeded by AECi',
    });
    expect(parsed.introducedAt).toBe('2026-01-01');
    expect(parsed.note).toBe('seeded by AECi');
  });
});

describe('PromoteClaimSchema', () => {
  it('accepts each stored direction', () => {
    for (const direction of ['a_to_b', 'b_to_a', 'both'] as const) {
      expect(PromoteClaimSchema.safeParse({ dataObject: 'rfis', direction }).success).toBe(true);
    }
  });

  it('rejects an invalid direction (not the context-relative view)', () => {
    // `inbound`/`outbound` are the *translated* view — never accepted on the wire.
    expect(PromoteClaimSchema.safeParse({ dataObject: 'rfis', direction: 'inbound' }).success).toBe(
      false,
    );
    expect(PromoteClaimSchema.safeParse({ dataObject: 'rfis', direction: 'a2b' }).success).toBe(
      false,
    );
  });

  it('requires a non-empty dataObject', () => {
    expect(PromoteClaimSchema.safeParse({ dataObject: '', direction: 'both' }).success).toBe(false);
    expect(PromoteClaimSchema.safeParse({ direction: 'both' }).success).toBe(false);
  });

  it('defaults attestations to an empty array when omitted', () => {
    const parsed = PromoteClaimSchema.parse({ dataObject: 'Models', direction: 'a_to_b' });
    expect(parsed.attestations).toEqual([]);
  });
});

describe('PromotePayloadSchema — claims[] round-trip', () => {
  it('preserves nested claims through a parse round-trip', () => {
    const payload = {
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: uuid },
          claims: [
            {
              dataObject: 'rfis',
              direction: 'a_to_b',
              attestations: [{ source: 'aeci', asserted: true, note: 'seeded' }],
            },
            { dataObject: 'Models', direction: 'both' },
          ],
        },
      ],
    };
    const parsed = PromotePayloadSchema.parse(payload);
    const claims = parsed.integrations[0].claims;
    expect(claims).toHaveLength(2);
    expect(claims[0]).toEqual({
      dataObject: 'rfis',
      direction: 'a_to_b',
      attestations: [{ source: 'aeci', asserted: true, note: 'seeded' }],
    });
    // Second claim's attestations defaulted to [].
    expect(claims[1].attestations).toEqual([]);
  });

  it('defaults claims to [] for an integration that omits them (backwards compat)', () => {
    const parsed = PromotePayloadSchema.parse({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        { ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: uuid } },
      ],
    });
    expect(parsed.integrations[0].claims).toEqual([]);
  });

  it('rejects a claim carrying an invalid direction inside the payload', () => {
    const bad = {
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: uuid },
          claims: [{ dataObject: 'rfis', direction: 'sideways' }],
        },
      ],
    };
    expect(PromotePayloadSchema.safeParse(bad).success).toBe(false);
  });
});

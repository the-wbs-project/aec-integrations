import { describe, expect, it } from 'vitest';

import {
  EntityRefSchema,
  PromoteAttestationSchema,
  PromoteClaimSchema,
  PromoteJobIdSchema,
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

  // AECI-542: `trades` is additive and OPTIONAL — the API side deploys before the
  // review app starts sending it, so a payload written against the pre-trades
  // contract must keep parsing unchanged.
  it('defaults trades to [] for a product that omits the key (backwards compat)', () => {
    const parsed = PromotePayloadSchema.parse(minimal);
    expect(parsed.product?.trades).toEqual([]);
  });

  it('preserves trades (slugs, names, or aliases) through a parse round-trip', () => {
    const parsed = PromotePayloadSchema.parse({
      product: { ref: 'p1', name: 'Revit', trades: ['electrical', 'HVAC', 'Mechanical'] },
    });
    expect(parsed.product?.trades).toEqual(['electrical', 'HVAC', 'Mechanical']);
  });

  it('rejects an empty-string trade', () => {
    expect(
      PromotePayloadSchema.safeParse({ product: { ref: 'p1', name: 'Revit', trades: [''] } })
        .success,
    ).toBe(false);
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

describe('PromoteJobIdSchema (AECI-563)', () => {
  it('accepts the shapes a caller realistically supplies', () => {
    for (const id of ['job-abc123', 'recAbC123XyZ', 'a'.repeat(100), 'A_b-9'.repeat(2)]) {
      expect(PromoteJobIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it('rejects an id the Workflows platform would refuse', () => {
    // Instance ids cap at 100 characters, and the charset excludes anything that would
    // need escaping in a path segment (the poll URL is `/api/promote/jobs/:id`).
    expect(PromoteJobIdSchema.safeParse('a'.repeat(101)).success).toBe(false);
    expect(PromoteJobIdSchema.safeParse('job/with/slashes').success).toBe(false);
    expect(PromoteJobIdSchema.safeParse('job with spaces').success).toBe(false);
    expect(PromoteJobIdSchema.safeParse('job:colon').success).toBe(false);
    // The instance-id pattern is `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` — the first character
    // cannot be a hyphen, or `create({ id })` throws and the kick-off degrades a clean
    // 400 into an opaque 500. Reject it here instead.
    expect(PromoteJobIdSchema.safeParse('-eadingdash').success).toBe(false);
  });

  it('rejects an id short enough to be a caller bug', () => {
    // A 1–2 character id is almost certainly a loop index or a truthiness accident, and
    // would silently fold two different products' promotes onto one Workflow instance.
    expect(PromoteJobIdSchema.safeParse('1').success).toBe(false);
    expect(PromoteJobIdSchema.safeParse('abc').success).toBe(false);
    expect(PromoteJobIdSchema.safeParse('12345678').success).toBe(true);
  });
});

describe('PromotePayloadSchema — jobId (AECI-563)', () => {
  const minimal = { product: { ref: 'p1', name: 'Revit' } };

  it('is optional, so a caller that omits it still validates', () => {
    const parsed = PromotePayloadSchema.parse(minimal);
    expect(parsed.jobId).toBeUndefined();
  });

  it('round-trips a supplied id (the kick-off idempotency key)', () => {
    const parsed = PromotePayloadSchema.parse({ ...minimal, jobId: 'job-abc123' });
    expect(parsed.jobId).toBe('job-abc123');
  });

  it('rejects an invalid id rather than silently generating one', () => {
    const result = PromotePayloadSchema.safeParse({ ...minimal, jobId: 'no' });
    expect(result.success).toBe(false);
  });

  it('still rejects a payload that carries nothing but a jobId', () => {
    expect(PromotePayloadSchema.safeParse({ jobId: 'job-abc123' }).success).toBe(false);
  });
});

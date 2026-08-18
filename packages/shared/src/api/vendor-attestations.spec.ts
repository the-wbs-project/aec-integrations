/**
 * Wire-contract coverage for the vendor attestation schemas (AECI-301 / §5).
 *
 * The cases that matter are the guard-rails, not the happy path: that no write
 * shape can carry a `slot` or a vendor id (authority is derived server-side from
 * product ownership, §2.1), that direction on the wire is the caller-relative
 * vocabulary and never the DB's `a_to_b`/`b_to_a`, and that `agreement` /
 * `origin` are read-only echoes a client cannot assert.
 */

import { describe, expect, it } from 'vitest';

import {
  CreateVendorClaimSchema,
  DataObjectOptionSchema,
  ListDataObjectsResponseSchema,
  ListVendorIntegrationsResponseSchema,
  UpsertVendorAttestationSchema,
  VendorAttestationSlotSchema,
  VendorClaimResponseSchema,
  VendorClaimSchema,
  VendorIntegrationSchema,
  VENDOR_ATTESTATION_SLOTS,
} from './vendor-attestations';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const OWN_ATTESTATION = {
  slot: 'vendor_a' as const,
  asserted: true,
  note: 'Only RFIs created after 2025.',
  introduced_version_id: uuid(30),
  deprecated_version_id: null,
  updated_at: '2026-08-17T00:00:00.000Z',
};

const CLAIM = {
  id: uuid(1),
  integration_id: uuid(2),
  data_object_slug: 'rfis',
  data_object_name: 'RFIs',
  direction: 'outbound' as const,
  agreement: 'single_source' as const,
  origin: 'vendor' as const,
  mine: [OWN_ATTESTATION],
  counterparty: null,
};

const INTEGRATION = {
  id: uuid(2),
  name: 'Revit ↔ MicroStation',
  mechanism_kind: 'native' as const,
  mechanism_name: 'Native connector',
  context_product: { id: uuid(10), slug: 'revit', name: 'Revit', logo_url: null },
  other_product: { id: uuid(11), slug: 'microstation', name: 'MicroStation', logo_url: null },
  slots: ['vendor_a' as const],
  claims: [CLAIM],
};

describe('VENDOR_ATTESTATION_SLOTS', () => {
  it('is the vendor-writable subset of the attestation sources — `aeci` is never one', () => {
    expect(VENDOR_ATTESTATION_SLOTS).toEqual(['vendor_a', 'vendor_b']);
    expect(VendorAttestationSlotSchema.safeParse('aeci').success).toBe(false);
  });
});

describe('VendorClaimSchema', () => {
  it('parses a claim the caller has affirmed', () => {
    expect(VendorClaimSchema.parse(CLAIM)).toEqual(CLAIM);
  });

  it('carries two entries in `mine` when the caller owns both endpoints', () => {
    const parsed = VendorClaimSchema.parse({
      ...CLAIM,
      mine: [OWN_ATTESTATION, { ...OWN_ATTESTATION, slot: 'vendor_b' }],
    });
    expect(parsed.mine.map((a) => a.slot)).toEqual(['vendor_a', 'vendor_b']);
  });

  it('accepts an empty `mine` — an AECi-seeded claim the vendor has not voted on', () => {
    expect(VendorClaimSchema.parse({ ...CLAIM, mine: [], origin: 'aeci' }).mine).toEqual([]);
  });

  it('accepts a null counterparty — silence is the point of single_source', () => {
    expect(VendorClaimSchema.parse(CLAIM).counterparty).toBeNull();
  });

  it('reduces the counterparty to stance + note, dropping its version stamps', () => {
    const parsed = VendorClaimSchema.parse({
      ...CLAIM,
      agreement: 'conflict',
      counterparty: {
        asserted: false,
        note: 'We do not expose RFIs here.',
        introduced_version_id: uuid(31),
        attested_by_vendor_id: uuid(99),
      },
    }) as { counterparty: Record<string, unknown> };
    expect(parsed.counterparty).toEqual({
      asserted: false,
      note: 'We do not expose RFIs here.',
    });
  });

  it('speaks the caller-relative direction vocabulary, never the stored one', () => {
    for (const direction of ['inbound', 'outbound', 'both']) {
      expect(VendorClaimSchema.safeParse({ ...CLAIM, direction }).success).toBe(true);
    }
    for (const direction of ['a_to_b', 'b_to_a']) {
      expect(VendorClaimSchema.safeParse({ ...CLAIM, direction }).success).toBe(false);
    }
  });

  it('accepts every agreement state, including the ones only vendor writes reach', () => {
    for (const agreement of ['unverified', 'single_source', 'confirmed', 'conflict']) {
      expect(VendorClaimSchema.safeParse({ ...CLAIM, agreement }).success).toBe(true);
    }
  });
});

describe('VendorIntegrationSchema', () => {
  it('parses an integration with the caller in the vendor_a slot', () => {
    expect(VendorIntegrationSchema.parse(INTEGRATION)).toEqual(INTEGRATION);
  });

  it('carries both slots when the caller owns both endpoints', () => {
    const parsed = VendorIntegrationSchema.parse({
      ...INTEGRATION,
      slots: ['vendor_a', 'vendor_b'],
    });
    expect(parsed.slots).toEqual(['vendor_a', 'vendor_b']);
  });

  it('rejects an empty slot list — an integration only appears if a slot is owned', () => {
    expect(VendorIntegrationSchema.safeParse({ ...INTEGRATION, slots: [] }).success).toBe(false);
  });

  it('accepts an integration with no claims yet', () => {
    expect(VendorIntegrationSchema.parse({ ...INTEGRATION, claims: [] }).claims).toEqual([]);
  });
});

describe('ListVendorIntegrationsResponseSchema', () => {
  it('wraps the attestable surface, unpaginated', () => {
    const parsed = ListVendorIntegrationsResponseSchema.parse({ integrations: [INTEGRATION] });
    expect(parsed.integrations).toHaveLength(1);
    expect(parsed).not.toHaveProperty('pagination');
  });

  it('accepts an empty surface — a vendor whose products have no integrations', () => {
    expect(ListVendorIntegrationsResponseSchema.parse({ integrations: [] }).integrations).toEqual(
      [],
    );
  });
});

describe('CreateVendorClaimSchema', () => {
  const MINIMAL = { integration_id: uuid(2), data_object: 'rfis', direction: 'outbound' as const };

  it('accepts the minimal body', () => {
    expect(CreateVendorClaimSchema.parse(MINIMAL)).toEqual(MINIMAL);
  });

  it('requires the integration id to be a uuid', () => {
    expect(CreateVendorClaimSchema.safeParse({ ...MINIMAL, integration_id: 'revit' }).success).toBe(
      false,
    );
  });

  it('trims the data_object and rejects an empty one', () => {
    expect(CreateVendorClaimSchema.parse({ ...MINIMAL, data_object: '  RFIs  ' }).data_object).toBe(
      'RFIs',
    );
    expect(CreateVendorClaimSchema.safeParse({ ...MINIMAL, data_object: '  ' }).success).toBe(
      false,
    );
  });

  it('takes the caller-relative direction and rejects the stored vocabulary', () => {
    expect(CreateVendorClaimSchema.safeParse({ ...MINIMAL, direction: 'inbound' }).success).toBe(
      true,
    );
    expect(CreateVendorClaimSchema.safeParse({ ...MINIMAL, direction: 'a_to_b' }).success).toBe(
      false,
    );
  });

  it('strips slot, vendor id, asserted and every derived field — the allow-list IS the guard-rail', () => {
    const parsed = CreateVendorClaimSchema.parse({
      ...MINIMAL,
      slot: 'vendor_b',
      source: 'vendor_b',
      attested_by_vendor_id: uuid(99),
      vendor_id: uuid(99),
      origin: 'aeci',
      agreement: 'confirmed',
      asserted: false,
      id: 'attacker-chosen',
    }) as Record<string, unknown>;
    expect(parsed).toEqual(MINIMAL);
  });

  it('bounds the note and rejects a non-uuid version stamp', () => {
    expect(CreateVendorClaimSchema.safeParse({ ...MINIMAL, note: 'x'.repeat(2001) }).success).toBe(
      false,
    );
    expect(
      CreateVendorClaimSchema.safeParse({ ...MINIMAL, introduced_version_id: '2026.1' }).success,
    ).toBe(false);
  });
});

describe('UpsertVendorAttestationSchema', () => {
  it('takes a bare stance', () => {
    expect(UpsertVendorAttestationSchema.parse({ asserted: false })).toEqual({ asserted: false });
  });

  it('requires `asserted` — a PUT always states a position', () => {
    expect(UpsertVendorAttestationSchema.safeParse({ note: 'hmm' }).success).toBe(false);
  });

  it('strips the slot — the caller never chooses which one it fills', () => {
    const parsed = UpsertVendorAttestationSchema.parse({
      asserted: true,
      slot: 'vendor_b',
      source: 'vendor_b',
    }) as Record<string, unknown>;
    expect(parsed).toEqual({ asserted: true });
  });

  it('treats an omitted note as absent — the handler writes null, PUT replaces', () => {
    expect('note' in UpsertVendorAttestationSchema.parse({ asserted: true })).toBe(false);
    expect(UpsertVendorAttestationSchema.parse({ asserted: true, note: null }).note).toBeNull();
  });
});

describe('VendorClaimResponseSchema', () => {
  it('wraps the POST and PUT echo, agreement included', () => {
    expect(VendorClaimResponseSchema.parse({ claim: CLAIM }).claim.agreement).toBe('single_source');
  });
});

describe('DataObjectOptionSchema', () => {
  const OPTION = { slug: 'rfis', name: 'RFIs', description: 'Requests for information.' };

  it('parses a picker option', () => {
    expect(DataObjectOptionSchema.parse(OPTION)).toEqual(OPTION);
  });

  it('accepts a null description', () => {
    expect(DataObjectOptionSchema.parse({ ...OPTION, description: null }).description).toBeNull();
  });

  it('strips `aliases` — the exclusion is contractual, not just a handler column list', () => {
    // A client-side alias match would have to reimplement `safeSlugify`, and a
    // second matcher is the drift `lib/data-object-vocabulary.ts` exists to
    // prevent. Enforcing it here means a handler that starts selecting the
    // column still cannot put it on the wire.
    const parsed = DataObjectOptionSchema.parse({ ...OPTION, aliases: ['RFI', 'Request'] });

    expect(parsed).not.toHaveProperty('aliases');
    expect(parsed).toEqual(OPTION);
  });

  it('strips `id` and `display_order`', () => {
    const parsed = DataObjectOptionSchema.parse({
      ...OPTION,
      id: '00000000-0000-4000-8000-000000000001',
      display_order: 110,
    });

    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('display_order');
  });

  it('requires slug and name', () => {
    expect(DataObjectOptionSchema.safeParse({ name: 'RFIs', description: null }).success).toBe(
      false,
    );
    expect(DataObjectOptionSchema.safeParse({ slug: 'rfis', description: null }).success).toBe(
      false,
    );
  });
});

describe('ListDataObjectsResponseSchema', () => {
  it('parses an empty vocabulary — an unseeded table is a 200, not an error', () => {
    expect(ListDataObjectsResponseSchema.parse({ data_objects: [] })).toEqual({ data_objects: [] });
  });

  it('rejects a bare array — the envelope key is part of the contract', () => {
    expect(ListDataObjectsResponseSchema.safeParse([]).success).toBe(false);
  });
});

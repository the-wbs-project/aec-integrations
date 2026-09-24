import { describe, expect, it } from 'vitest';

import {
  VendorConnectorCatalogQuerySchema,
  connectorDeciderKind,
  toVendorConnectorMapping,
} from './vendor-connector-catalog';

describe('connectorDeciderKind (AECI-1083)', () => {
  it.each([
    [null, null],
    ['', null],
    ['auto-name-match', 'automatic'],
    ['vendor:agave-inc', 'vendor'],
    ['aeci-operator', 'aeci'],
    // A review-app reviewer's name never crosses to the vendor: it is AECi's decision.
    ['Chris Walton', 'aeci'],
  ] as const)('%s → %s', (raw, kind) => {
    expect(connectorDeciderKind(raw)).toBe(kind);
  });
});

describe('toVendorConnectorMapping', () => {
  it('drops notes, checked_at and the raw decider', () => {
    const out = toVendorConnectorMapping({
      id: 'm1',
      status: 'mapped',
      product: { id: '00000000-0000-4000-8000-000000000001', name: 'Procore', slug: 'procore' },
      confidence: 'high',
      evidence_url: 'https://example.com',
      decided_by: 'vendor:agave-inc',
      decided_at: '2026-09-24T00:00:00.000Z',
      checked_at: '2026-09-24T00:00:00.000Z',
      notes: 'internal',
      publishable: true,
    });
    expect(out).toEqual({
      id: 'm1',
      status: 'mapped',
      product: { id: '00000000-0000-4000-8000-000000000001', name: 'Procore', slug: 'procore' },
      confidence: 'high',
      evidence_url: 'https://example.com',
      decided_by: 'vendor',
      decided_at: '2026-09-24T00:00:00.000Z',
      publishable: true,
    });
  });
});

describe('VendorConnectorCatalogQuerySchema', () => {
  it('defaults to page 1 of 25', () => {
    expect(VendorConnectorCatalogQuerySchema.parse({})).toEqual({ page: 1, perPage: 25 });
  });

  it('caps perPage at 50', () => {
    expect(VendorConnectorCatalogQuerySchema.safeParse({ perPage: '51' }).success).toBe(false);
  });

  it('accepts the undecided anti-join and every stored status', () => {
    for (const state of [
      'undecided',
      'mapped',
      'ruled_out',
      'out_of_scope',
      'no_record',
      'ambiguous_parked',
    ]) {
      expect(VendorConnectorCatalogQuerySchema.safeParse({ state }).success).toBe(true);
    }
    expect(VendorConnectorCatalogQuerySchema.safeParse({ state: 'pending' }).success).toBe(false);
  });
});

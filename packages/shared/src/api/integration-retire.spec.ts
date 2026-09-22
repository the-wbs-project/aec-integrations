import { describe, expect, it } from 'vitest';

import {
  AdminRetireIntegrationBodySchema,
  VendorIntegrationRetireNotificationSchema,
  effectiveRetiredBy,
} from './integration-retire';

describe('effectiveRetiredBy (AECI-1046)', () => {
  it('is null while the row is live', () => {
    expect(effectiveRetiredBy({ retired_at: null, retired_by: null })).toBeNull();
  });

  it('reports the stored value', () => {
    expect(effectiveRetiredBy({ retired_at: '2026-09-22', retired_by: 'aeci' })).toBe('aeci');
    expect(effectiveRetiredBy({ retired_at: '2026-09-22', retired_by: 'owner' })).toBe('owner');
  });

  it('reads a pre-0046 retire (NULL) as the owner', () => {
    expect(effectiveRetiredBy({ retired_at: '2026-09-20', retired_by: null })).toBe('owner');
  });
});

describe('AdminRetireIntegrationBodySchema', () => {
  it('trims and requires a reason of at most 1000 characters', () => {
    expect(AdminRetireIntegrationBodySchema.parse({ reason: '  abuse  ' })).toEqual({
      reason: 'abuse',
    });
    expect(() => AdminRetireIntegrationBodySchema.parse({ reason: '   ' })).toThrow();
    expect(() => AdminRetireIntegrationBodySchema.parse({})).toThrow();
    expect(() => AdminRetireIntegrationBodySchema.parse({ reason: 'x'.repeat(1001) })).toThrow();
    expect(() => AdminRetireIntegrationBodySchema.parse({ reason: 'ok', extra: 1 })).toThrow();
  });
});

describe('VendorIntegrationRetireNotificationSchema', () => {
  it('defaults retired_by to owner for a row written before AECI-1046', () => {
    const parsed = VendorIntegrationRetireNotificationSchema.parse({
      kind: 'integration_retire',
      id: '00000000-0000-4000-8000-000000000001',
      event: 'retired',
      integration_id: '00000000-0000-4000-8000-000000000002',
      integration_name: null,
      owner_name: null,
      pair_path: null,
      created_at: '2026-09-21T00:00:00.000Z',
    });
    expect(parsed.retired_by).toBe('owner');
  });
});

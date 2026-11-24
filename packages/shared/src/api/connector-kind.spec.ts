import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_KINDS,
  connectorKindFor,
  isConnectorKind,
  isSyncService,
  roleTakesConnectorKind,
} from './connector-kind';
import { AdminSetConnectorKindSchema, ConnectorKindSchema } from './connector-kind-schema';
import { ProductListItemSchema } from './products';
import { VendorProductSchema } from './vendor';

describe('connector kind vocabulary (AECI-2036)', () => {
  it('stores two snake_case values', () => {
    expect(CONNECTOR_KINDS).toEqual(['integration_platform', 'sync_service']);
    expect(isConnectorKind('sync_service')).toBe(true);
    expect(isConnectorKind('Sync Service')).toBe(false);
    expect(isConnectorKind(null)).toBe(false);
  });

  it('takes a kind on connector and hybrid only', () => {
    expect(roleTakesConnectorKind('connector')).toBe(true);
    expect(roleTakesConnectorKind('hybrid')).toBe(true);
    expect(roleTakesConnectorKind('application')).toBe(false);
    expect(roleTakesConnectorKind(null)).toBe(false);
  });

  it.each([
    ['connector', 'sync_service', 'sync_service'],
    ['hybrid', 'integration_platform', 'integration_platform'],
    ['connector', null, null],
    ['application', 'sync_service', null],
    ['connector', 'ipaas', null],
  ] as const)('connectorKindFor(%s, %s) is %s', (role, kind, expected) => {
    expect(connectorKindFor(role, kind)).toBe(expected);
  });

  it.each([
    ['connector', 'sync_service', true],
    ['hybrid', 'sync_service', true],
    ['connector', 'integration_platform', false],
    ['connector', null, false],
    ['application', 'sync_service', false],
  ] as const)('isSyncService(%s, %s) is %s', (role, kind, expected) => {
    expect(isSyncService(role, kind)).toBe(expected);
  });
});

describe('connector kind schemas (AECI-2036)', () => {
  it('accepts only the stored values', () => {
    expect(ConnectorKindSchema.safeParse('sync_service').success).toBe(true);
    expect(ConnectorKindSchema.safeParse('Sync Service').success).toBe(false);
  });

  it('takes a kind or null, and refuses a missing value or an extra key', () => {
    expect(AdminSetConnectorKindSchema.parse({ connector_kind: null })).toEqual({
      connector_kind: null,
    });
    expect(AdminSetConnectorKindSchema.safeParse({}).success).toBe(false);
    expect(
      AdminSetConnectorKindSchema.safeParse({ connector_kind: 'sync_service', reason: 'x' })
        .success,
    ).toBe(false);
  });

  it('defaults the read field to null so an older payload still parses', () => {
    const item = ProductListItemSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      slug: 'rivets-sync',
      name: 'Rivets Sync',
      logo_url: null,
      product_role: 'connector',
      vendor: null,
      integration_count: 0,
      review_count: 0,
      rating_overall_avg: null,
      rating_onboarding_avg: null,
      created_at: '2026-11-24T00:00:00.000Z',
      updated_at: '2026-11-24T00:00:00.000Z',
    });
    expect(item.connector_kind).toBeNull();
    expect(VendorProductSchema.shape.connector_kind.parse(undefined)).toBeNull();
  });
});

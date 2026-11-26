import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_KINDS,
  connectorKindFor,
  isConnectorKind,
  isSyncService,
  productTakesSubscription,
  roleTakesConnectorKind,
} from './connector-kind';
import {
  AdminSetConnectorKindSchema,
  ConnectorKindSchema,
  connectorKindList,
} from './connector-kind-schema';
import { ProductListItemSchema, ProductsListQuerySchema } from './products';
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

describe('productTakesSubscription (AECI-2044, ruling 6)', () => {
  it('lets an application and a hybrid hold a subscription, whatever the kind', () => {
    expect(productTakesSubscription('application', null)).toBe(true);
    expect(productTakesSubscription('hybrid', null)).toBe(true);
    expect(productTakesSubscription('hybrid', 'integration_platform')).toBe(true);
    expect(productTakesSubscription('hybrid', 'sync_service')).toBe(true);
  });

  it('lets a connector hold one only when it is a Sync Service', () => {
    expect(productTakesSubscription('connector', 'sync_service')).toBe(true);
    expect(productTakesSubscription('connector', 'integration_platform')).toBe(false);
    expect(productTakesSubscription('connector', null)).toBe(false);
    expect(productTakesSubscription('connector', 'something-else')).toBe(false);
  });

  it('fails closed on an unknown or missing role', () => {
    expect(productTakesSubscription('platform', 'sync_service')).toBe(false);
    expect(productTakesSubscription(null, null)).toBe(false);
    expect(productTakesSubscription(undefined, 'sync_service')).toBe(false);
  });
});

describe('the connector_kind listing filter (AECI-1662)', () => {
  it('reads a comma-separated list into vocabulary order, deduped', () => {
    expect(connectorKindList.parse('sync_service')).toEqual(['sync_service']);
    expect(connectorKindList.parse('sync_service, integration_platform,sync_service')).toEqual([
      'integration_platform',
      'sync_service',
    ]);
  });

  it('refuses an empty list or an unknown kind', () => {
    for (const raw of ['', ',', 'ipaas', 'sync_service,Sync Service']) {
      expect(connectorKindList.safeParse(raw).success).toBe(false);
    }
  });

  it('is an optional param on the products listing query, reported at its key', () => {
    expect(ProductsListQuerySchema.parse({}).connector_kind).toBeUndefined();
    const bad = ProductsListQuerySchema.safeParse({ connector_kind: 'ipaas' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['connector_kind']);
  });
});

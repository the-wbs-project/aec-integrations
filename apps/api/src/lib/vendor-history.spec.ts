/**
 * AECI-1194 — the change-history projection is an allow-list. These cells feed it
 * rows stuffed with everything a vendor must never see and assert none of it
 * reaches the wire shape.
 */

import { VendorHistoryItemSchema } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import {
  actorKindFor,
  afterStateFields,
  historyActions,
  historyActorTypes,
  projectVendorHistoryRow,
  type VendorHistoryRawRow,
} from './vendor-history';

function row(overrides: Partial<VendorHistoryRawRow> = {}): VendorHistoryRawRow {
  return {
    id: 'row-1',
    createdAt: '2026-10-04T10:00:00.000Z',
    actorType: 'admin',
    action: 'product.updated',
    entityType: 'product',
    entityId: 'prod-1',
    afterStateKeys: '["description","website"]',
    reasonVisibility: 'vendor',
    reason: 'Your logo failed our contrast check.',
    vendorTier: 'verified',
    vendorEntitlementStatus: 'active',
    ...overrides,
  };
}

describe('projectVendorHistoryRow — redaction', () => {
  it('copies only allow-listed keys', () => {
    const item = projectVendorHistoryRow(row(), 'Revit');
    expect(Object.keys(item).sort()).toEqual(
      [
        'action',
        'actor_kind',
        'at',
        'entity_id',
        'entity_name',
        'entity_type',
        'fields',
        'id',
        'plan',
        'reason',
      ].sort(),
    );
    expect(VendorHistoryItemSchema.strict().parse(item)).toEqual(item);
    expect(item.fields).toEqual(['description', 'website']);
  });

  it('returns the reason only behind reasonVisibility = vendor', () => {
    expect(projectVendorHistoryRow(row(), null).reason).toBe(
      'Your logo failed our contrast check.',
    );
    for (const reasonVisibility of [undefined, null, 'internal', 'VENDOR', 1, '["vendor"]']) {
      const item = projectVendorHistoryRow(
        row({ reason: 'Hidden reason', reasonVisibility }),
        null,
      );
      expect('reason' in item).toBe(false);
    }
  });

  it('omits a marked reason that is not a non-empty string', () => {
    for (const reason of [42, '', '   ', null]) {
      const item = projectVendorHistoryRow(row({ reason }), null);
      expect('reason' in item).toBe(false);
    }
  });

  it('builds plan from the snapshot columns, or null without one', () => {
    expect(projectVendorHistoryRow(row(), null).plan).toEqual({
      tier: 'verified',
      status: 'active',
    });
    expect(
      projectVendorHistoryRow(row({ vendorTier: null, vendorEntitlementStatus: null }), null).plan,
    ).toBeNull();
  });
});

describe('afterStateFields', () => {
  it('returns the names in the SQL key list', () => {
    expect(afterStateFields('["description","logo_url"]')).toEqual(['description', 'logo_url']);
  });

  it('returns nothing for null, malformed text or a non-array', () => {
    expect(afterStateFields(null)).toEqual([]);
    expect(afterStateFields(undefined)).toEqual([]);
    expect(afterStateFields('not json')).toEqual([]);
    expect(afterStateFields('{"a":1}')).toEqual([]);
    expect(afterStateFields('[]')).toEqual([]);
  });

  it('drops keys that look like data rather than field names', () => {
    expect(
      afterStateFields(
        JSON.stringify([
          'someone@example.com',
          '00000000-0000-4000-8000-000000000001',
          'status',
          7,
        ]),
      ),
    ).toEqual(['status']);
  });
});

describe('actorKindFor', () => {
  it('maps actor_type onto the reader’s three kinds', () => {
    expect(actorKindFor('user')).toBe('your_team');
    expect(actorKindFor('admin')).toBe('aeci');
    expect(actorKindFor('system')).toBe('system');
    expect(actorKindFor('workflow')).toBe('system');
  });
});

describe('historyActions', () => {
  it('never includes a non-receipt action', () => {
    const all = historyActions();
    expect(all).not.toContain('notification.sent');
    expect(all).not.toContain('notification_preferences.updated');
    expect(all).not.toContain('vendor.deleted');
  });

  it('stays under the D1 bound-parameter cap with room for the other clauses', () => {
    expect(historyActions().length).toBeLessThan(90);
  });
});

describe('historyActorTypes', () => {
  it('all keeps every actor', () => {
    expect(historyActorTypes('all')).toBeNull();
  });

  it('agrees with actorKindFor for every actor type', () => {
    for (const actorType of ['user', 'admin', 'system', 'workflow', 'something-new']) {
      const kind = actorKindFor(actorType);
      expect(historyActorTypes('vendor')!.includes(actorType)).toBe(kind === 'your_team');
      expect(historyActorTypes('aeci')!.includes(actorType)).toBe(kind === 'aeci');
    }
  });
});

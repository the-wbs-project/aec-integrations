/**
 * AECI-1194 — the change-history projection is an allow-list. These cells feed it
 * rows stuffed with everything a vendor must never see and assert none of it
 * reaches the wire shape.
 */

import { VendorHistoryItemSchema } from '@aeci/shared';
import { AUDIT_VENDOR_ACTIONS } from '@aeci/shared/audit-vendor-actions';
import { describe, expect, it } from 'vitest';

import {
  actorKindFor,
  afterStateFields,
  historyActions,
  projectVendorHistoryRow,
  type VendorHistoryRawRow,
} from './vendor-history';

const ACTOR = '00000000-0000-4000-8000-000000000099';

function row(overrides: Partial<VendorHistoryRawRow> = {}): VendorHistoryRawRow {
  return {
    id: 'row-1',
    createdAt: '2026-10-04T10:00:00.000Z',
    actorType: 'admin',
    action: 'product.updated',
    entityType: 'product',
    entityId: 'prod-1',
    afterState: { description: 'secret new value', website: 'https://x.test' },
    metadata: {
      source: 'admin-logo-override',
      actorEmail: 'ops@aecintegrations.com',
      actorId: ACTOR,
      reason: 'Your logo failed our contrast check.',
      reasonVisibility: 'vendor',
      internalNote: 'Vendor was rude on the phone; watch them.',
      otherVendorNote: 'Bentley asked us to do this.',
    },
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
  });

  it('never leaks the internal note, an email, an actor id or a raw value', () => {
    const wire = JSON.stringify(projectVendorHistoryRow(row(), 'Revit'));
    expect(wire).not.toContain('rude');
    expect(wire).not.toContain('internalNote');
    expect(wire).not.toContain('@aecintegrations.com');
    expect(wire).not.toContain(ACTOR);
    expect(wire).not.toContain('secret new value');
    expect(wire).not.toContain('https://x.test');
    expect(wire).not.toContain('Bentley');
  });

  it('returns the reason only behind reasonVisibility = vendor', () => {
    expect(projectVendorHistoryRow(row(), null).reason).toBe(
      'Your logo failed our contrast check.',
    );
    for (const reasonVisibility of [undefined, 'internal', 'VENDOR', true]) {
      const item = projectVendorHistoryRow(
        row({ metadata: { reason: 'Hidden reason', reasonVisibility } }),
        null,
      );
      expect('reason' in item).toBe(false);
    }
  });

  it('omits a marked reason that is not a non-empty string', () => {
    for (const reason of [42, '', '   ', null]) {
      const item = projectVendorHistoryRow(
        row({ metadata: { reason, reasonVisibility: 'vendor' } }),
        null,
      );
      expect('reason' in item).toBe(false);
    }
  });

  it('survives a metadata value that is not an object', () => {
    for (const metadata of [null, 'text', 3, ['reasonVisibility']]) {
      expect('reason' in projectVendorHistoryRow(row({ metadata }), null)).toBe(false);
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
  it('returns the key names of an object', () => {
    expect(afterStateFields({ description: 'x', logo_url: null })).toEqual([
      'description',
      'logo_url',
    ]);
  });

  it('parses a JSON string defensively', () => {
    expect(afterStateFields('{"name":"x"}')).toEqual(['name']);
    expect(afterStateFields('not json')).toEqual([]);
  });

  it('returns nothing for an array, a scalar or null', () => {
    expect(afterStateFields(['a', 'b'])).toEqual([]);
    expect(afterStateFields(7)).toEqual([]);
    expect(afterStateFields(null)).toEqual([]);
    expect(afterStateFields(undefined)).toEqual([]);
  });

  it('drops keys that look like data rather than field names', () => {
    expect(
      afterStateFields({
        'someone@example.com': true,
        '00000000-0000-4000-8000-000000000001': 'x',
        status: 'active',
      }),
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
    const all = historyActions('all');
    expect(all).not.toContain('notification.sent');
    expect(all).not.toContain('notification_preferences.updated');
    expect(all).not.toContain('vendor.deleted');
  });

  it('splits by registry kind', () => {
    for (const a of historyActions('vendor')) {
      expect(AUDIT_VENDOR_ACTIONS[a as keyof typeof AUDIT_VENDOR_ACTIONS].kind).toBe('vendor-edit');
    }
    for (const a of historyActions('aeci')) {
      expect(AUDIT_VENDOR_ACTIONS[a as keyof typeof AUDIT_VENDOR_ACTIONS].kind).toBe(
        'aeci-override',
      );
    }
  });

  it('stays under the D1 bound-parameter cap with room for the other clauses', () => {
    expect(historyActions('all').length).toBeLessThan(90);
  });
});

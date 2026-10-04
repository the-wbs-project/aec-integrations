import { describe, expect, it } from 'vitest';

import {
  AdminSetFieldOverrideSchema,
  PRODUCT_OVERRIDE_FIELDS,
  VENDOR_OVERRIDE_FIELDS,
  fieldOverrideFieldsFor,
  isFieldOverrideField,
  lockedField,
  parseFieldOverrideValue,
} from './field-overrides';
import { UpdateVendorProductSchema, UpdateVendorProfileSchema } from './vendor';

const ID = '00000000-0000-4000-8000-000000000001';

describe('field override allow-list (AECI-1237)', () => {
  it('is cut from the vendor PATCH fields, never wider', () => {
    for (const field of VENDOR_OVERRIDE_FIELDS) {
      expect(Object.keys(UpdateVendorProfileSchema.shape)).toContain(field);
    }
    for (const field of PRODUCT_OVERRIDE_FIELDS) {
      expect(Object.keys(UpdateVendorProductSchema.shape)).toContain(field);
    }
  });

  it('leaves out the logo, the descriptions, usefulness and the facets', () => {
    for (const field of ['logo_url', 'description']) {
      expect(isFieldOverrideField('vendor', field)).toBe(false);
      expect(isFieldOverrideField('product', field)).toBe(false);
    }
    for (const field of ['usefulness', 'category_slugs', 'trade_slugs']) {
      expect(isFieldOverrideField('product', field)).toBe(false);
    }
  });

  it('freezes mechanism_kind on a connector-powered row and a pair', () => {
    expect(isFieldOverrideField('integration', 'mechanism_kind')).toBe(true);
    expect(isFieldOverrideField('integration', 'mechanism_kind', { connectorPowered: true })).toBe(
      false,
    );
    expect(fieldOverrideFieldsFor('connector_evidenced_pair')).not.toContain('mechanism_kind');
  });
});

describe('parseFieldOverrideValue', () => {
  it('normalizes with the vendor rule and refuses what a vendor could not store', () => {
    expect(parseFieldOverrideValue('vendor', 'contact_email', ' Ops@Example.COM ')).toEqual({
      ok: true,
      value: 'ops@example.com',
    });
    expect(parseFieldOverrideValue('vendor', 'founded_year', 1700).ok).toBe(false);
    expect(parseFieldOverrideValue('product', 'website', 'not a url').ok).toBe(false);
    expect(parseFieldOverrideValue('vendor', 'phone_number', '  ')).toEqual({
      ok: true,
      value: null,
    });
  });

  it('takes direction in the stored frame and keeps the required fields filled', () => {
    expect(parseFieldOverrideValue('integration', 'direction', 'b_to_a')).toEqual({
      ok: true,
      value: 'b_to_a',
    });
    expect(parseFieldOverrideValue('integration', 'direction', 'inbound').ok).toBe(false);
    expect(parseFieldOverrideValue('integration', 'name', null).ok).toBe(false);
    expect(parseFieldOverrideValue('integration', 'mechanism_kind', 'iPaaS').ok).toBe(false);
  });
});

describe('AdminSetFieldOverrideSchema', () => {
  const body = {
    entityType: 'vendor',
    entityId: ID,
    field: 'phone_number',
    value: '+1 555 0100',
    reason: 'The number on file reaches a different company.',
  };

  it('requires a vendor reason and a field on the allow-list', () => {
    expect(AdminSetFieldOverrideSchema.safeParse(body).success).toBe(true);
    expect(AdminSetFieldOverrideSchema.safeParse({ ...body, reason: '  ' }).success).toBe(false);
    const wrong = AdminSetFieldOverrideSchema.safeParse({ ...body, field: 'description' });
    expect(wrong.success).toBe(false);
    expect(wrong.error?.issues[0]?.path).toEqual(['field']);
  });

  it('drops a blank internal note', () => {
    const parsed = AdminSetFieldOverrideSchema.parse({ ...body, internalNote: ' ' });
    expect(parsed.internalNote).toBeUndefined();
  });
});

describe('lockedField', () => {
  it('reads an absent list as nothing locked', () => {
    expect(lockedField(undefined, 'website')).toBeUndefined();
    const lock = { field: 'website', reason: 'r', set_at: '2026-10-04T00:00:00.000Z' };
    expect(lockedField([lock], 'website')).toBe(lock);
  });
});

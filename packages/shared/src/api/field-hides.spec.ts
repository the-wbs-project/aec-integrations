import { describe, expect, it } from 'vitest';

import {
  AdminSetFieldHideSchema,
  CONNECTOR_POWERED_HIDE_FIELDS,
  INTEGRATION_HIDE_FIELDS,
  PRODUCT_HIDE_FIELDS,
  VENDOR_HIDE_FIELDS,
  fieldHideFieldsFor,
  hiddenField,
  isFieldHideField,
} from './field-hides';
import { VENDOR_OVERRIDE_FIELDS } from './field-overrides';

const base = {
  entityType: 'vendor',
  entityId: '00000000-0000-4000-8000-000000000001',
  field: 'description',
  sourceUrl: 'https://example.com/source',
  receivedAt: '2026-11-06',
  reason: 'A reader says the description is out of date.',
};

describe('the hideable fields', () => {
  it('takes every lockable company field plus the description', () => {
    expect(VENDOR_HIDE_FIELDS).toEqual([...VENDOR_OVERRIDE_FIELDS, 'description']);
  });

  it('takes the product links and description, never a taxonomy facet', () => {
    expect(PRODUCT_HIDE_FIELDS).toEqual([
      'website',
      'tool_integrations_url',
      'api_docs_url',
      'description',
    ]);
    expect(isFieldHideField('product', 'category_slugs')).toBe(false);
  });

  it('leaves out the three fields a pair page cannot render blank', () => {
    for (const field of ['name', 'mechanism_kind', 'direction']) {
      expect(INTEGRATION_HIDE_FIELDS).not.toContain(field);
      expect(CONNECTOR_POWERED_HIDE_FIELDS).not.toContain(field);
    }
    expect(INTEGRATION_HIDE_FIELDS).toContain('description');
    expect(fieldHideFieldsFor('connector_evidenced_pair')).toContain('docs_url');
  });
});

describe('AdminSetFieldHideSchema', () => {
  it('accepts a complete body', () => {
    expect(AdminSetFieldHideSchema.safeParse(base).success).toBe(true);
  });

  it('requires an https source', () => {
    expect(AdminSetFieldHideSchema.safeParse({ ...base, sourceUrl: undefined }).success).toBe(
      false,
    );
    expect(
      AdminSetFieldHideSchema.safeParse({ ...base, sourceUrl: 'http://example.com' }).success,
    ).toBe(false);
  });

  it('refuses a field off the allow-list, naming field', () => {
    const parsed = AdminSetFieldHideSchema.safeParse({ ...base, field: 'company_name' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['field']);
  });

  it('refuses a received date in the future', () => {
    expect(AdminSetFieldHideSchema.safeParse({ ...base, receivedAt: '2999-01-01' }).success).toBe(
      false,
    );
  });

  it('refuses unknown keys', () => {
    expect(AdminSetFieldHideSchema.safeParse({ ...base, value: 'x' }).success).toBe(false);
  });
});

describe('hiddenField', () => {
  it('finds the hide on a field and tolerates an absent list', () => {
    const list = [{ field: 'website', reason: 'r', set_at: 't', source_url: 'https://s' }];
    expect(hiddenField(list, 'website')?.reason).toBe('r');
    expect(hiddenField(list, 'description')).toBeUndefined();
    expect(hiddenField(undefined, 'website')).toBeUndefined();
  });
});

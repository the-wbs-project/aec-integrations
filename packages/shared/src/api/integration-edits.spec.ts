import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_DELIVERED_MECHANISM_KINDS,
  INTEGRATION_EDIT_FIELDS,
  OWNER_EDITABLE_MECHANISM_KINDS,
  UpdateVendorIntegrationSchema,
  VendorIntegrationUpdateNotificationSchema,
  integrationEditValueProblem,
} from './integration-edits';
import { INTEGRATION_CONTEST_FIELDS } from './integration-contests';

describe('INTEGRATION_EDIT_FIELDS', () => {
  it('is the contestable set minus owner, in the same order', () => {
    expect(INTEGRATION_EDIT_FIELDS).toEqual(
      INTEGRATION_CONTEST_FIELDS.filter((f) => f !== 'owner'),
    );
    expect(INTEGRATION_EDIT_FIELDS).toHaveLength(11);
    expect(INTEGRATION_EDIT_FIELDS).not.toContain('owner');
  });
});

describe('OWNER_EDITABLE_MECHANISM_KINDS', () => {
  it('leaves out the connector-delivered kinds and nothing else', () => {
    expect([...CONNECTOR_DELIVERED_MECHANISM_KINDS].sort()).toEqual(['iPaaS', 'integrator']);
    expect(OWNER_EDITABLE_MECHANISM_KINDS).toEqual([
      'native',
      'marketplace-app',
      'api',
      'webhook',
      'partner',
    ]);
  });
});

describe('integrationEditValueProblem', () => {
  it('lets an optional field be cleared and refuses a clear on name, type and direction', () => {
    expect(integrationEditValueProblem('website', null)).toBeNull();
    expect(integrationEditValueProblem('description', null)).toBeNull();
    expect(integrationEditValueProblem('name', null)).not.toBeNull();
    expect(integrationEditValueProblem('mechanism_kind', null)).not.toBeNull();
    expect(integrationEditValueProblem('direction', null)).not.toBeNull();
  });

  it('applies the contest rules to a value', () => {
    expect(integrationEditValueProblem('website', 'https://example.com')).toBeNull();
    expect(integrationEditValueProblem('website', 'example.com')).not.toBeNull();
    expect(integrationEditValueProblem('direction', 'outbound')).toBeNull();
    expect(integrationEditValueProblem('direction', 'a_to_b')).not.toBeNull();
  });

  it('refuses the connector-delivered kinds', () => {
    expect(integrationEditValueProblem('mechanism_kind', 'native')).toBeNull();
    expect(integrationEditValueProblem('mechanism_kind', 'iPaaS')).not.toBeNull();
    expect(integrationEditValueProblem('mechanism_kind', 'integrator')).not.toBeNull();
  });
});

describe('UpdateVendorIntegrationSchema', () => {
  it('takes any subset of the eleven fields, trimmed', () => {
    expect(UpdateVendorIntegrationSchema.parse({ name: '  Link  ' })).toEqual({ name: 'Link' });
  });

  it('reads an empty string as a clear', () => {
    expect(UpdateVendorIntegrationSchema.parse({ website: '   ' })).toEqual({ website: null });
  });

  it('requires at least one field', () => {
    expect(UpdateVendorIntegrationSchema.safeParse({}).success).toBe(false);
    expect(
      UpdateVendorIntegrationSchema.safeParse({
        context_product_id: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
  });

  it('refuses owner, notes and any other key rather than dropping them', () => {
    for (const key of ['owner', 'notes', 'built_by_vendor_id', 'claimed_at']) {
      expect(UpdateVendorIntegrationSchema.safeParse({ name: 'x', [key]: 'y' }).success).toBe(
        false,
      );
    }
  });

  it('caps each field at its contest length', () => {
    expect(UpdateVendorIntegrationSchema.safeParse({ name: 'x'.repeat(200) }).success).toBe(true);
    expect(UpdateVendorIntegrationSchema.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('VendorIntegrationUpdateNotificationSchema', () => {
  it('parses a feed row', () => {
    const row = {
      kind: 'integration_update' as const,
      id: '00000000-0000-4000-8000-000000000001',
      integration_id: '00000000-0000-4000-8000-000000000002',
      integration_name: 'Link',
      owner_name: 'Bentley',
      fields: ['name', 'website'],
      pair_path: '/products/a/integrations/b',
      created_at: '2026-09-22T00:00:00.000Z',
    };
    expect(VendorIntegrationUpdateNotificationSchema.parse(row)).toEqual(row);
  });
});

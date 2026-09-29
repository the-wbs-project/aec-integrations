import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_DELIVERED_MECHANISM_KINDS,
  CONNECTOR_POWERED_EDIT_FIELDS,
  INTEGRATION_EDIT_FIELDS,
  OWNER_EDITABLE_MECHANISM_KINDS,
  UpdateVendorIntegrationSchema,
  VendorIntegrationUpdateNotificationSchema,
  integrationEditValueProblem,
} from './integration-edits';
import {
  INTEGRATION_CONTEST_FIELDS,
  INTEGRATION_OFFERED_CONTEST_FIELDS,
} from './integration-contests';

describe('INTEGRATION_EDIT_FIELDS (AECI-1154, AECI-1155)', () => {
  it('is the offered contest set minus owner, then the edit-only pricing_url', () => {
    expect(INTEGRATION_EDIT_FIELDS).toEqual([
      ...INTEGRATION_OFFERED_CONTEST_FIELDS.filter((f) => f !== 'owner'),
      'pricing_url',
    ]);
    expect(INTEGRATION_EDIT_FIELDS).toEqual([
      'name',
      'mechanism_kind',
      'mechanism_name',
      'direction',
      'description',
      'listing_url',
      'docs_url',
      'pricing_model',
      'maturity',
      'pricing_url',
    ]);
    expect(INTEGRATION_EDIT_FIELDS).not.toContain('owner');
  });

  it('drops website and mechanism_url, and keeps pricing_url out of the stored contest list', () => {
    expect(INTEGRATION_EDIT_FIELDS).not.toContain('website');
    expect(INTEGRATION_EDIT_FIELDS).not.toContain('mechanism_url');
    expect(INTEGRATION_CONTEST_FIELDS as readonly string[]).not.toContain('pricing_url');
  });

  it('gives a connector-powered row every field but mechanism_kind, pricing_url included', () => {
    expect(CONNECTOR_POWERED_EDIT_FIELDS).toEqual(
      INTEGRATION_EDIT_FIELDS.filter((f) => f !== 'mechanism_kind'),
    );
    expect(CONNECTOR_POWERED_EDIT_FIELDS).toContain('pricing_url');
    expect(CONNECTOR_POWERED_EDIT_FIELDS).not.toContain('website');
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
    expect(integrationEditValueProblem('docs_url', null)).toBeNull();
    expect(integrationEditValueProblem('pricing_url', null)).toBeNull();
    expect(integrationEditValueProblem('description', null)).toBeNull();
    expect(integrationEditValueProblem('name', null)).not.toBeNull();
    expect(integrationEditValueProblem('mechanism_kind', null)).not.toBeNull();
    expect(integrationEditValueProblem('direction', null)).not.toBeNull();
  });

  it('applies the contest rules to a value', () => {
    expect(integrationEditValueProblem('docs_url', 'https://example.com')).toBeNull();
    expect(integrationEditValueProblem('docs_url', 'example.com')).not.toBeNull();
    expect(integrationEditValueProblem('direction', 'outbound')).toBeNull();
    expect(integrationEditValueProblem('direction', 'a_to_b')).not.toBeNull();
  });

  it('takes an absolute http(s) pricing_url of at most 2,048 characters (AECI-1154)', () => {
    expect(integrationEditValueProblem('pricing_url', 'https://example.com/pricing')).toBeNull();
    expect(integrationEditValueProblem('pricing_url', 'http://example.com/pricing')).toBeNull();
    expect(integrationEditValueProblem('pricing_url', 'example.com/pricing')).not.toBeNull();
    expect(integrationEditValueProblem('pricing_url', 'ftp://example.com/p')).not.toBeNull();
    expect(integrationEditValueProblem('pricing_url', 'javascript:alert(1)')).not.toBeNull();
    const long = `https://example.com/${'x'.repeat(2048)}`;
    expect(integrationEditValueProblem('pricing_url', long)).not.toBeNull();
  });

  it('refuses the connector-delivered kinds', () => {
    expect(integrationEditValueProblem('mechanism_kind', 'native')).toBeNull();
    expect(integrationEditValueProblem('mechanism_kind', 'iPaaS')).not.toBeNull();
    expect(integrationEditValueProblem('mechanism_kind', 'integrator')).not.toBeNull();
  });
});

describe('UpdateVendorIntegrationSchema', () => {
  it('takes any subset of the ten fields, trimmed', () => {
    expect(UpdateVendorIntegrationSchema.parse({ name: '  Link  ' })).toEqual({ name: 'Link' });
  });

  it('reads an empty string as a clear', () => {
    expect(UpdateVendorIntegrationSchema.parse({ docs_url: '   ' })).toEqual({ docs_url: null });
    expect(UpdateVendorIntegrationSchema.parse({ pricing_url: '' })).toEqual({ pricing_url: null });
  });

  it('takes pricing_url and refuses website and mechanism_url (AECI-1154, AECI-1155)', () => {
    expect(
      UpdateVendorIntegrationSchema.parse({ pricing_url: 'https://example.com/pricing' }),
    ).toEqual({ pricing_url: 'https://example.com/pricing' });
    for (const key of ['website', 'mechanism_url']) {
      const result = UpdateVendorIntegrationSchema.safeParse({ [key]: 'https://example.com' });
      expect(result.success).toBe(false);
    }
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

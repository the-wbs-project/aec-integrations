/**
 * AECI-1007 — the per-side link wire shapes and the shared https rule.
 */
import { describe, expect, it } from 'vitest';

import { HTTPS_URL_MAX_LENGTH, HttpsUrlSchema, isHttpsUrl } from './https-url';
import {
  IntegrationLinkKindSchema,
  PairVendorLinksSchema,
  PutIntegrationLinkSchema,
} from './integration-vendor-links';
import { LogoUrlSchema } from './logos';
import { ProductPairMechanismSchema } from './product-pairs';

describe('HttpsUrlSchema', () => {
  it.each([
    ['https://example.com/integrations/procore', true],
    ['  https://example.com/a  ', true],
    ['http://example.com/a', false],
    ['javascript:alert(1)', false],
    ['data:text/html,hi', false],
    ['https://user:pass@example.com/a', false],
    ['/relative', false],
    ['example.com', false],
    [`https://example.com/${'a'.repeat(HTTPS_URL_MAX_LENGTH)}`, false],
  ])('%s → %s', (value, ok) => {
    expect(HttpsUrlSchema.safeParse(value).success).toBe(ok);
  });

  it('trims what it accepts', () => {
    expect(HttpsUrlSchema.parse('  https://example.com/a ')).toBe('https://example.com/a');
  });

  it('is the same rule the logo schema applies to its URL arm', () => {
    expect(isHttpsUrl('https://example.com/logo.png')).toBe(true);
    expect(LogoUrlSchema.safeParse('https://example.com/logo.png').success).toBe(true);
    expect(LogoUrlSchema.safeParse('http://example.com/logo.png').success).toBe(false);
    expect(LogoUrlSchema.safeParse('https://u:p@example.com/logo.png').success).toBe(false);
  });
});

describe('per-side link schemas', () => {
  it('has exactly two kinds', () => {
    expect(IntegrationLinkKindSchema.options).toEqual(['listing', 'docs']);
  });

  it('refuses a stray field on the PUT body', () => {
    expect(
      PutIntegrationLinkSchema.safeParse({ url: 'https://example.com/a', kind: 'docs' }).success,
    ).toBe(false);
  });

  it('defaults vendor_links on a mechanism from an API that predates the field', () => {
    const mechanism = ProductPairMechanismSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      mechanism_kind: 'native',
      mechanism_name: null,
      direction: null,
      description: null,
      listing_url: null,
      docs_url: null,
      built_by_vendor: null,
      powered_by_product: null,
    });
    expect(mechanism.vendor_links).toEqual({ context: null, other: null });
    expect(
      PairVendorLinksSchema.safeParse({
        context: { listing_url: 'https://a.example/l', docs_url: null },
        other: null,
      }).success,
    ).toBe(true);
  });
});

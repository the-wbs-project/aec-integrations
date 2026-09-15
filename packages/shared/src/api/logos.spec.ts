import { describe, expect, it } from 'vitest';
import { LogoReadUrlSchema, LogoUrlSchema, UpdateLogoSchema } from './logos';
import { ProductLinkSchema, VendorLinkSchema } from './common';

describe('logo contracts', () => {
  const path = `/api/logos/${'a'.repeat(64)}`;
  it.each(['https://example.com/logo.png', path])('accepts %s', (url) =>
    expect(LogoUrlSchema.parse(url)).toBe(url),
  );
  it.each([
    'http://example.com/logo.png',
    '//example.com/logo.png',
    '/api/logos/../x',
    `${path}?x=1`,
    `${path}/x`,
    'javascript:alert(1)',
    'data:image/png;base64,AA==',
    'https://user:pass@example.com/logo.png',
    'bad',
  ])('rejects %s without throwing from safeParse', (url) =>
    expect(LogoUrlSchema.safeParse(url).success).toBe(false),
  );
  it('permits explicit clear but rejects empty/missing and extra fields', () => {
    expect(UpdateLogoSchema.parse({ logo_url: null })).toEqual({ logo_url: null });
    for (const data of [{}, { logo_url: '' }, { logo_url: path, logo_source: 'admin' }])
      expect(UpdateLogoSchema.safeParse(data).success).toBe(false);
  });
  it('preserves legacy reads and accepts uploaded paths on nested links', () => {
    expect(LogoReadUrlSchema.parse('http://example.com/old.png')).toContain('http:');
    const row = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Example',
      slug: 'example',
      logo_url: path,
    };
    expect(ProductLinkSchema.parse(row).logo_url).toBe(path);
    expect(VendorLinkSchema.parse({ ...row, verified: false }).logo_url).toBe(path);
  });
});

import { describe, expect, it } from 'vitest';

import { resolveIntegrationSort, resolveProductSort, resolveVendorSort } from './sort';

describe('resolveProductSort (§7.4 default-direction rule)', () => {
  it('maps `created` to `{ createdAt: "desc" }`', () => {
    expect(resolveProductSort('created')).toEqual({ createdAt: 'desc' });
  });
  it('maps `name` to `{ name: "asc" }`', () => {
    expect(resolveProductSort('name')).toEqual({ name: 'asc' });
  });
  it('maps `updated` to `{ updatedAt: "desc" }`', () => {
    expect(resolveProductSort('updated')).toEqual({ updatedAt: 'desc' });
  });
});

describe('resolveVendorSort (§"Sort & direction": name → company_name)', () => {
  it('maps `name` to `{ companyName: "asc" }` (vendors have no `name` column)', () => {
    expect(resolveVendorSort('name')).toEqual({ companyName: 'asc' });
  });
  it('maps `created` to `{ createdAt: "desc" }`', () => {
    expect(resolveVendorSort('created')).toEqual({ createdAt: 'desc' });
  });
  it('maps `updated` to `{ updatedAt: "desc" }`', () => {
    expect(resolveVendorSort('updated')).toEqual({ updatedAt: 'desc' });
  });
});

describe('resolveIntegrationSort', () => {
  it('maps `name` to `{ name: "asc" }` (default per §7.4)', () => {
    expect(resolveIntegrationSort('name')).toEqual({ name: 'asc' });
  });
  it('maps `created` to `{ createdAt: "desc" }`', () => {
    expect(resolveIntegrationSort('created')).toEqual({ createdAt: 'desc' });
  });
});

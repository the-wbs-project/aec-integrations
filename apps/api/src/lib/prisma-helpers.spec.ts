/**
 * Unit tests for the AECI-54 mapper functions. Focus is on the three known
 * DB↔Zod nullability gaps + the Decimal/Date conversions — the route specs
 * already cover the happy path through `findMany`/`findUnique`.
 */

import { describe, expect, it } from 'vitest';

import { procoreProductRow, reviztoProductRow } from '../test/fixtures/products';
import {
  nullNameIntegrationRow,
  procoreReviztoIntegrationDetailRow,
  procoreReviztoIntegrationRow,
} from '../test/fixtures/integrations';
import {
  fieldManagementCategoryRow,
  projectManagementCategoryRow,
} from '../test/fixtures/taxonomy';
import { autodeskVendorRow, procoreVendorRow } from '../test/fixtures/vendors';
import {
  toIntegrationDetail,
  toIntegrationListItem,
  toProductListItem,
  toTaxonomyTermWithCount,
  toVendorListItem,
} from './prisma-helpers';

describe('toIntegrationListItem', () => {
  it('returns the row name verbatim when set', () => {
    const out = toIntegrationListItem(procoreReviztoIntegrationRow);
    expect(out.name).toBe('Procore <> Revizto sync');
  });

  it('synthesizes `${source.name} → ${target.name}` when `name` is null', () => {
    const out = toIntegrationListItem(nullNameIntegrationRow);
    expect(out.name).toBe('Procore → Revizto');
  });

  it('passes through `mechanismKind: null` as null (AECI-115 — no longer coerced to native)', () => {
    const out = toIntegrationListItem(nullNameIntegrationRow);
    expect(out.mechanism_kind).toBeNull();
  });

  it('throws on an out-of-enum mechanism_kind (data-integrity violation)', () => {
    const corrupt = { ...procoreReviztoIntegrationRow, mechanismKind: 'telepathy' };
    expect(() => toIntegrationListItem(corrupt)).toThrow(/unknown mechanism_kind/);
  });

  it('passes through `direction: null` (schema permits null)', () => {
    const out = toIntegrationListItem(nullNameIntegrationRow);
    expect(out.direction).toBeNull();
  });

  it('converts Date timestamps to ISO strings', () => {
    const out = toIntegrationListItem(procoreReviztoIntegrationRow);
    expect(out.created_at).toBe('2024-05-01T00:00:00.000Z');
  });

  it('maps source/target Prisma fields to ProductLink (logoUrl → logo_url)', () => {
    const out = toIntegrationListItem(procoreReviztoIntegrationRow);
    expect(out.source).toEqual({
      id: procoreReviztoIntegrationRow.sourceProduct.id,
      name: 'Procore',
      slug: 'procore',
      logo_url: procoreReviztoIntegrationRow.sourceProduct.logoUrl,
    });
  });
});

describe('toIntegrationDetail', () => {
  it('extends the list item with description/links and null built_by_vendor', () => {
    const out = toIntegrationDetail(procoreReviztoIntegrationDetailRow);
    expect(out.description).toBe('Sync issues between Procore and Revizto.');
    expect(out.built_by_vendor).toBeNull();
    expect(out.powered_by_product).toBeNull();
  });
});

describe('toProductListItem', () => {
  it('hydrates `vendor` from the primary ProductVendor link', () => {
    const out = toProductListItem(procoreProductRow);
    expect(out.vendor).toMatchObject({
      slug: 'procore',
      name: 'Procore Technologies',
    });
  });

  it('returns `vendor: null` when the product has no vendor links (AECI-115 — no sentinel)', () => {
    const out = toProductListItem({ ...reviztoProductRow, productVendors: [] });
    expect(out.vendor).toBeNull();
  });

  it('throws on an out-of-enum product_role (data-integrity violation)', () => {
    const corrupt = { ...reviztoProductRow, productRole: 'middleware' };
    expect(() => toProductListItem(corrupt)).toThrow(/unknown product_role/);
  });

  it('converts Decimal rating fields to plain numbers', () => {
    const out = toProductListItem(procoreProductRow);
    expect(out.rating_overall_avg).toBe(4.5);
    expect(out.rating_onboarding_avg).toBe(4.2);
  });

  it('keeps null rating fields as null', () => {
    const out = toProductListItem(reviztoProductRow);
    expect(out.rating_overall_avg).toBeNull();
    expect(out.rating_onboarding_avg).toBeNull();
  });

  it('picks the lowest-displayOrder linked category as primary_category', () => {
    // procore links to Project Management (order=1) and Field Management
    // (order=null). The null-order entry is treated as Infinity so the
    // explicit "1" wins regardless of join order.
    const out = toProductListItem(procoreProductRow);
    expect(out.primary_category).toEqual({
      id: '00000000-0000-4000-8000-000000030001',
      name: 'Project Management',
      slug: 'project-management',
    });
  });

  it('returns null primary_category when no categories are linked', () => {
    const out = toProductListItem(reviztoProductRow);
    expect(out.primary_category).toBeNull();
  });
});

describe('toVendorListItem', () => {
  it('exposes _count.productVendors as product_count and _count.builtIntegrations as integration_count', () => {
    const out = toVendorListItem(procoreVendorRow);
    expect(out.product_count).toBe(1);
    expect(out.integration_count).toBe(2);
  });

  it('maps companyName → company_name', () => {
    const out = toVendorListItem(procoreVendorRow);
    expect(out.company_name).toBe('Procore Technologies');
  });

  it('surfaces headquarters and foundedYear on the list shape', () => {
    const out = toVendorListItem(procoreVendorRow);
    expect(out.headquarters).toBe('Carpinteria, CA');
    expect(out.founded_year).toBe(2002);
  });

  it('keeps null headquarters and foundedYear as null', () => {
    const out = toVendorListItem(autodeskVendorRow);
    expect(out.headquarters).toBeNull();
    expect(out.founded_year).toBeNull();
  });
});

describe('toTaxonomyTermWithCount', () => {
  it('passes through `displayOrder` when set', () => {
    const out = toTaxonomyTermWithCount(projectManagementCategoryRow, 'productCategories');
    expect(out.display_order).toBe(1);
    expect(out.product_count).toBe(5);
  });

  it('coalesces `displayOrder: null` to 0', () => {
    const out = toTaxonomyTermWithCount(fieldManagementCategoryRow, 'productCategories');
    expect(out.display_order).toBe(0);
  });
});

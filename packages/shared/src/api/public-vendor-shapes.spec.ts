/**
 * AECI-1266 regression guard: no public vendor shape carries `verified`.
 *
 * `vendors.verified` mirrors an active paid plan (`STAGE_2_PAID_TIERS_SPEC.md`
 * §2.1). Publishing it tells every visitor which vendors pay, so it was removed
 * from every public payload and from the Algolia vendor record. This spec fails
 * if a later change adds the key back to any of them. Admin and vendor portal
 * schemas keep the field and are not checked here.
 */
import { describe, expect, it } from 'vitest';

import { AlgoliaVendorRecordSchema } from '../algolia-records';

import { VendorLinkSchema } from './common';
import { VendorDetailSchema, VendorListItemSchema } from './vendors';

const PUBLIC_VENDOR_SHAPES = {
  VendorLinkSchema,
  VendorListItemSchema,
  VendorDetailSchema,
  AlgoliaVendorRecordSchema,
} as const;

describe('public vendor shapes carry no plan mirror (AECI-1266)', () => {
  it.each(Object.entries(PUBLIC_VENDOR_SHAPES))('%s has no `verified` key', (_name, schema) => {
    expect(Object.keys(schema.shape)).not.toContain('verified');
  });
});

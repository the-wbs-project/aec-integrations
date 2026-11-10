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
import {
  FieldCaptionSchema,
  FieldCorrectionSchema,
  ProductFieldCaptionsSchema,
} from './field-captions';
import { ProductIntegrationItemSchema } from './integrations';
import { ProductPairMechanismSchema } from './product-pairs';
import { ProductDetailSchema } from './products';
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

/**
 * AECI-1614: a public caption says who, when and from where, and nothing else. The
 * correction's private columns and the raw plan mirrors stay off every public shape.
 */
const PRIVATE_CORRECTION_KEYS = [
  'reason',
  'internal_note',
  'lift_reason',
  'lifted_by',
  'lifted_at',
  'set_by',
  'vendor_id',
  'value',
];
const RAW_MIRROR_KEYS = [
  'managed_ended_at',
  'plan_ended_at',
  'description_edited_at',
  'profile_edited_at',
  'usefulness_edited_at',
  'managed_edited_at',
  'vendor_edited_at',
];

describe('public caption shapes carry no private field (AECI-1614)', () => {
  const CAPTION_SHAPES = {
    FieldCaptionSchema,
    FieldCorrectionSchema,
    ProductFieldCaptionsSchema,
  } as const;

  it.each(Object.entries(CAPTION_SHAPES))('%s has no private key', (_name, schema) => {
    const keys = Object.keys(schema.shape);
    for (const key of [...PRIVATE_CORRECTION_KEYS, ...RAW_MIRROR_KEYS]) {
      expect(keys).not.toContain(key);
    }
  });

  const CARRIERS = {
    ProductDetailSchema,
    ProductIntegrationItemSchema,
    ProductPairMechanismSchema,
    VendorDetailSchema,
    VendorListItemSchema,
    VendorLinkSchema,
  } as const;

  it.each(Object.entries(CARRIERS))('%s has no raw mirror or stamp', (_name, schema) => {
    const keys = Object.keys(schema.shape);
    for (const key of RAW_MIRROR_KEYS) expect(keys).not.toContain(key);
  });
});

/**
 * AECI-1238 (§11d.7): a value hide is public only as a field name in `under_review`.
 * The hide row's reason, note, source and clocks stay off every public shape, and
 * `under_review` is a list of strings, so no hide object can ride inside it. `source_url`
 * is a legitimate public key (a correction's source), so the hide's own source is
 * proven absent by value in `apps/api/src/routes/field-hide-public-reads.spec.ts`.
 */
describe('public shapes carry no value-hide detail (AECI-1238)', () => {
  const PRIVATE_HIDE_KEYS = [
    'hidden_fields',
    'field_hides',
    'internal_note',
    'received_at',
    'hide_due',
    'decide_due',
    'clear_kind',
    'clear_reason',
    'cleared_by',
    'status_reply',
  ];
  const CARRIERS = {
    ProductDetailSchema,
    ProductIntegrationItemSchema,
    ProductPairMechanismSchema,
    VendorDetailSchema,
    VendorListItemSchema,
    VendorLinkSchema,
    AlgoliaVendorRecordSchema,
  } as const;

  it.each(Object.entries(CARRIERS))('%s has no hide key', (_name, schema) => {
    const keys = Object.keys(schema.shape);
    for (const key of PRIVATE_HIDE_KEYS) expect(keys).not.toContain(key);
  });

  it.each([
    ['ProductDetailSchema', ProductDetailSchema],
    ['ProductIntegrationItemSchema', ProductIntegrationItemSchema],
    ['ProductPairMechanismSchema', ProductPairMechanismSchema],
    ['VendorDetailSchema', VendorDetailSchema],
  ] as const)('%s.under_review is a list of field names only', (_name, schema) => {
    const underReview = schema.shape.under_review;
    expect(underReview.safeParse(['description']).success).toBe(true);
    expect(underReview.safeParse(undefined).success).toBe(true);
    expect(underReview.safeParse([{ field: 'description', reason: 'A complaint.' }]).success).toBe(
      false,
    );
  });
});

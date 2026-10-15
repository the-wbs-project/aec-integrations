/**
 * Product request contracts (AECI-1377, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.6).
 */

import { describe, expect, it } from 'vitest';

import {
  CreateProductRequestSchema,
  DecideProductRequestSchema,
  ListProductRequestsQuerySchema,
  VendorProductRequestSchema,
} from './product-requests';
import {
  isAttestationNotification,
  VendorNotificationSchema,
  VendorProductRequestNotificationSchema,
} from './vendor-notifications';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const valid = {
  context_product_id: uuid(1),
  name: '  Field Notes ',
  maker: 'Field Notes Inc',
  website: 'https://fieldnotes.example.com',
  body: 'A note.',
};

describe('CreateProductRequestSchema', () => {
  it('trims and accepts a full body', () => {
    expect(CreateProductRequestSchema.parse(valid)).toEqual({ ...valid, name: 'Field Notes' });
  });

  it('makes website and body optional, and reads an empty website as not supplied', () => {
    expect(
      CreateProductRequestSchema.parse({ context_product_id: uuid(1), name: 'A', maker: 'B' }),
    ).toEqual({ context_product_id: uuid(1), name: 'A', maker: 'B' });
    expect(CreateProductRequestSchema.parse({ ...valid, website: '  ' }).website).toBe('');
  });

  it.each([
    ['an unknown key', { ...valid, vendor_id: uuid(2) }],
    ['a blank name', { ...valid, name: '   ' }],
    ['a name over 200', { ...valid, name: 'x'.repeat(201) }],
    ['a blank maker', { ...valid, maker: '' }],
    ['a maker over 200', { ...valid, maker: 'x'.repeat(201) }],
    ['an http website', { ...valid, website: 'http://fieldnotes.example.com' }],
    ['a javascript: website', { ...valid, website: 'javascript:alert(1)' }],
    ['a website with credentials', { ...valid, website: 'https://u:p@example.com' }],
    ['a website over 500', { ...valid, website: `https://example.com/${'x'.repeat(490)}` }],
    ['a note over 2000', { ...valid, body: 'x'.repeat(2001) }],
    ['a non-uuid product id', { ...valid, context_product_id: 'revit' }],
  ])('refuses %s', (_label, body) => {
    expect(CreateProductRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('DecideProductRequestSchema', () => {
  it('accepts the three outcomes', () => {
    expect(DecideProductRequestSchema.parse({ outcome: 'added', product_id: uuid(3) })).toEqual({
      outcome: 'added',
      product_id: uuid(3),
    });
    expect(
      DecideProductRequestSchema.parse({ outcome: 'already_listed', product_id: uuid(3) }).outcome,
    ).toBe('already_listed');
    expect(DecideProductRequestSchema.parse({ outcome: 'declined', reason: ' Scope. ' })).toEqual({
      outcome: 'declined',
      reason: 'Scope.',
    });
  });

  it.each([
    ['declined with no reason', { outcome: 'declined' }],
    ['a reason over 1000', { outcome: 'declined', reason: 'x'.repeat(1001) }],
    ['added with no product', { outcome: 'added' }],
    ['added with a reason', { outcome: 'added', product_id: uuid(3), reason: 'x' }],
    ['declined with a product', { outcome: 'declined', reason: 'x', product_id: uuid(3) }],
    ['an unknown outcome', { outcome: 'resolve' }],
  ])('refuses %s', (_label, body) => {
    expect(DecideProductRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('ListProductRequestsQuerySchema', () => {
  it('defaults to the open queue and accepts every status', () => {
    expect(ListProductRequestsQuerySchema.parse({}).status).toBe('open');
    for (const status of ['open', 'added', 'already_listed', 'declined']) {
      expect(ListProductRequestsQuerySchema.parse({ status }).status).toBe(status);
    }
    expect(ListProductRequestsQuerySchema.safeParse({ status: 'resolved' }).success).toBe(false);
  });
});

describe('VendorProductRequestSchema', () => {
  it('parses a decided request with its linked product', () => {
    const row = {
      id: uuid(4),
      status: 'added',
      context_product_id: uuid(1),
      name: 'Field Notes',
      maker: 'Field Notes Inc',
      website: null,
      body: '',
      created_at: '2026-10-15T08:00:00.000Z',
      resolved_at: '2026-10-15T09:00:00.000Z',
      decline_reason: null,
      resolved_product: { id: uuid(5), slug: 'field-notes', name: 'Field Notes', logo_url: null },
    };
    expect(VendorProductRequestSchema.parse(row)).toEqual(row);
  });
});

describe('VendorProductRequestNotificationSchema', () => {
  const ROW = {
    kind: 'product_request' as const,
    id: uuid(6),
    event: 'declined' as const,
    request_id: uuid(4),
    request_name: 'Field Notes',
    product: null,
    context_product: { slug: 'microstation', name: 'MicroStation' },
    reason: 'Not AEC software.',
    created_at: '2026-10-15T09:00:00.000Z',
  };

  it('parses through the feed union and keeps its kind', () => {
    expect(VendorProductRequestNotificationSchema.parse(ROW)).toEqual(ROW);
    expect(VendorNotificationSchema.parse(ROW).kind).toBe('product_request');
  });

  it('is not read as an attestation row', () => {
    expect(isAttestationNotification(VendorNotificationSchema.parse(ROW))).toBe(false);
  });

  it('refuses an unknown event', () => {
    expect(
      VendorProductRequestNotificationSchema.safeParse({ ...ROW, event: 'approved' }).success,
    ).toBe(false);
  });
});

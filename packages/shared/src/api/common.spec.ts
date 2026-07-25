import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  ApiErrorSchema,
  LinkRefSchema,
  PageQuerySchema,
  paginatedResponseSchema,
  ProductLinkSchema,
  SortOrderSchema,
  uuidList,
  VendorLinkSchema,
} from './common';

const validUuid = '11111111-2222-4333-8444-555555555555';
const uuidB = '22222222-3333-4444-8555-666666666666';

describe('ApiErrorSchema', () => {
  it('parses a minimal valid envelope', () => {
    const parsed = ApiErrorSchema.parse({
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
      trace_id: 'abc-123',
    });

    expect(parsed.error.code).toBe('NOT_FOUND');
    expect(parsed.error.message).toBe('Resource not found');
    expect(parsed.error.field).toBeUndefined();
    expect(parsed.trace_id).toBe('abc-123');
  });

  it('parses an envelope with optional field and structured details', () => {
    const parsed = ApiErrorSchema.parse({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Invalid input',
        field: 'email',
        details: { issues: [{ path: ['email'], code: 'invalid_string' }] },
      },
      trace_id: 'trace-xyz',
    });

    expect(parsed.error.field).toBe('email');
    expect(parsed.error.details).toEqual({
      issues: [{ path: ['email'], code: 'invalid_string' }],
    });
  });

  it('rejects when trace_id is missing', () => {
    const result = ApiErrorSchema.safeParse({
      error: { code: 'INTERNAL_ERROR', message: 'boom' },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('trace_id');
    }
  });

  it('rejects when error.code is not a string', () => {
    const result = ApiErrorSchema.safeParse({
      error: { code: 500, message: 'boom' },
      trace_id: 't-1',
    });

    expect(result.success).toBe(false);
  });
});

describe('LinkRefSchema', () => {
  it('parses a valid id/name/slug triple', () => {
    const parsed = LinkRefSchema.parse({
      id: validUuid,
      name: 'Procore',
      slug: 'procore',
    });
    expect(parsed.name).toBe('Procore');
  });

  it('rejects a non-UUID id', () => {
    const result = LinkRefSchema.safeParse({
      id: 'not-a-uuid',
      name: 'Procore',
      slug: 'procore',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty name', () => {
    const result = LinkRefSchema.safeParse({
      id: validUuid,
      name: '',
      slug: 'procore',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty slug', () => {
    const result = LinkRefSchema.safeParse({
      id: validUuid,
      name: 'Procore',
      slug: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('VendorLinkSchema / ProductLinkSchema', () => {
  it('accepts a logo URL', () => {
    const parsed = VendorLinkSchema.parse({
      id: validUuid,
      name: 'Procore',
      slug: 'procore',
      logo_url: 'https://cdn.brandfetch.io/procore.png',
      verified: true,
    });
    expect(parsed.logo_url).toBe('https://cdn.brandfetch.io/procore.png');
    expect(parsed.verified).toBe(true);
  });

  it('accepts a null logo URL', () => {
    const parsed = ProductLinkSchema.parse({
      id: validUuid,
      name: 'Procore',
      slug: 'procore',
      logo_url: null,
    });
    expect(parsed.logo_url).toBeNull();
  });

  it('rejects a logo_url that is not a URL', () => {
    const result = VendorLinkSchema.safeParse({
      id: validUuid,
      name: 'Procore',
      slug: 'procore',
      logo_url: 'not a url',
      verified: false,
    });
    expect(result.success).toBe(false);
  });

  it('requires the verified bit on a vendor link', () => {
    const result = VendorLinkSchema.safeParse({
      id: validUuid,
      name: 'Procore',
      slug: 'procore',
      logo_url: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('PageQuerySchema', () => {
  it('applies defaults when no params given', () => {
    const parsed = PageQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.perPage).toBe(24);
  });

  it('coerces string query params', () => {
    const parsed = PageQuerySchema.parse({ page: '3', perPage: '50' });
    expect(parsed.page).toBe(3);
    expect(parsed.perPage).toBe(50);
  });

  it('accepts perPage at the cap', () => {
    const parsed = PageQuerySchema.parse({ perPage: 100 });
    expect(parsed.perPage).toBe(100);
  });

  it('rejects perPage > 100', () => {
    const result = PageQuerySchema.safeParse({ perPage: 200 });
    expect(result.success).toBe(false);
  });

  it('rejects perPage < 1', () => {
    const result = PageQuerySchema.safeParse({ perPage: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects page < 1', () => {
    const result = PageQuerySchema.safeParse({ page: 0 });
    expect(result.success).toBe(false);
  });
});

describe('paginatedResponseSchema', () => {
  const itemSchema = z.object({ id: z.string() });
  const wrapped = paginatedResponseSchema(itemSchema);

  it('parses a valid wrapped page', () => {
    const parsed = wrapped.parse({
      data: [{ id: 'a' }, { id: 'b' }],
      page: 1,
      perPage: 24,
      total: 2,
    });
    expect(parsed.data).toHaveLength(2);
    expect(parsed.total).toBe(2);
  });

  it('rejects a negative total', () => {
    const result = wrapped.safeParse({
      data: [],
      page: 1,
      perPage: 24,
      total: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects items that fail the inner schema', () => {
    const result = wrapped.safeParse({
      data: [{ id: 123 }],
      page: 1,
      perPage: 24,
      total: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('SortOrderSchema', () => {
  it('accepts asc and desc', () => {
    expect(SortOrderSchema.parse('asc')).toBe('asc');
    expect(SortOrderSchema.parse('desc')).toBe('desc');
  });

  it('rejects uppercase variants', () => {
    expect(SortOrderSchema.safeParse('DESC').success).toBe(false);
  });
});

describe('uuidList (AECI-223)', () => {
  it('decodes a single UUID to a one-element array', () => {
    expect(uuidList.parse(validUuid)).toEqual([validUuid]);
  });

  it('decodes a comma-separated list, preserving order', () => {
    expect(uuidList.parse(`${validUuid},${uuidB}`)).toEqual([validUuid, uuidB]);
  });

  it('trims surrounding whitespace and drops empty segments', () => {
    expect(uuidList.parse(` ${validUuid} , ${uuidB} ,`)).toEqual([validUuid, uuidB]);
  });

  it('rejects when any element is not a UUID', () => {
    expect(uuidList.safeParse(`${validUuid},not-a-uuid`).success).toBe(false);
    expect(uuidList.safeParse('not-a-uuid').success).toBe(false);
  });

  it('rejects an empty / all-separator value (no ids)', () => {
    expect(uuidList.safeParse('').success).toBe(false);
    expect(uuidList.safeParse(',').success).toBe(false);
  });

  it('reports the issue at the param key, not a nested array index', () => {
    // The transform raises issues on the input, so when nested under a key the
    // ZodError path stays at that key — `errors.ts` reports a clean `field`.
    const schema = z.object({ category_id: uuidList });
    const result = schema.safeParse({ category_id: `${validUuid},nope` });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['category_id']);
    }
  });
});

import { describe, expect, it } from 'vitest';

import { PageViewPayloadSchema } from './page-views';

describe('PageViewPayloadSchema', () => {
  it('parses a route-only payload', () => {
    const parsed = PageViewPayloadSchema.parse({ route: '/products/procore' });
    expect(parsed.route).toBe('/products/procore');
    expect(parsed.entity_type).toBeUndefined();
    expect(parsed.entity_id).toBeUndefined();
  });

  it('parses a payload with optional entity reference', () => {
    const parsed = PageViewPayloadSchema.parse({
      route: '/products/procore',
      entity_type: 'product',
      entity_id: 'procore',
    });
    expect(parsed.entity_type).toBe('product');
    expect(parsed.entity_id).toBe('procore');
  });

  it('rejects an empty route', () => {
    const result = PageViewPayloadSchema.safeParse({ route: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing route', () => {
    const result = PageViewPayloadSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

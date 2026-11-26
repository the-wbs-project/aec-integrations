import { describe, expect, it } from 'vitest';

import { PromoteProductSchema } from './promote';
import { PRODUCT_SUMMARY_MAX, ProductSummarySchema, normalizeSummary } from './summary';
import { CreateVendorProductSchema, UpdateVendorProductSchema } from './vendor';

describe('the summary (AECI-2198)', () => {
  it('caps at the meta-description length', () => {
    expect(PRODUCT_SUMMARY_MAX).toBe(155);
  });

  it('trims, collapses every whitespace run to one space and reads empty as null', () => {
    expect(normalizeSummary('  One\n\tline   here.  ')).toBe('One line here.');
    expect(normalizeSummary(' \n ')).toBeNull();
    expect(normalizeSummary('')).toBeNull();
    expect(normalizeSummary(null)).toBeNull();
    expect(normalizeSummary(undefined)).toBeNull();
  });

  it('accepts exactly the cap after normalizing and refuses one more, never truncating', () => {
    const exact = 'a'.repeat(PRODUCT_SUMMARY_MAX);
    expect(ProductSummarySchema.parse(`  ${exact}\n`)).toBe(exact);
    expect(ProductSummarySchema.safeParse(`${exact}b`).success).toBe(false);
    // Collapsing brings a padded value under the cap, so it passes.
    const padded = `${'a'.repeat(100)}\n\n\n${'b'.repeat(54)}`;
    expect(ProductSummarySchema.parse(padded)).toHaveLength(155);
  });

  it('is optional on promote: omitted stays absent, null clears, over the cap refuses', () => {
    const base = { ref: 'p', name: 'P' };
    expect('summary' in PromoteProductSchema.parse(base)).toBe(false);
    expect(PromoteProductSchema.parse({ ...base, summary: null }).summary).toBe(null);
    expect(PromoteProductSchema.parse({ ...base, summary: ' x ' }).summary).toBe('x');
    expect(PromoteProductSchema.safeParse({ ...base, summary: 'a'.repeat(156) }).success).toBe(
      false,
    );
  });

  it('is on both vendor write bodies, normalized the same way', () => {
    expect(UpdateVendorProductSchema.parse({ summary: ' a\nb ' })).toEqual({
      summary: 'a b',
    });
    expect(UpdateVendorProductSchema.parse({ summary: '   ' })).toEqual({
      summary: null,
    });
    expect(CreateVendorProductSchema.parse({ name: 'N', summary: 'One line.' }).summary).toBe(
      'One line.',
    );
    expect(
      CreateVendorProductSchema.safeParse({ name: 'N', summary: 'a'.repeat(156) }).success,
    ).toBe(false);
  });
});

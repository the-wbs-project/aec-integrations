import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  FOUND_VIA,
  FOUND_VIA_DETAIL_MAX,
  FOUND_VIA_FOLLOW_UP,
  FoundViaSchema,
  foundViaFields,
  normalizeFoundVia,
} from './found-via';
import { FeedbackSubmitSchema, SubscribeSubmitSchema } from './landing';
import { ClaimFormSchema } from './requests';

const Fields = z.object(foundViaFields);

describe('FoundViaSchema', () => {
  it('accepts every wire value and nothing else', () => {
    expect(FOUND_VIA).toEqual([
      'search',
      'ai_tool',
      'linkedin',
      'colleague',
      'vendor',
      'event',
      'other',
    ]);
    for (const value of FOUND_VIA) expect(FoundViaSchema.parse(value)).toBe(value);
    expect(FoundViaSchema.safeParse('google').success).toBe(false);
  });

  it('gives a follow-up to ai_tool, search, vendor, event and other only', () => {
    expect([...FOUND_VIA_FOLLOW_UP].sort()).toEqual(
      ['ai_tool', 'event', 'other', 'search', 'vendor'].sort(),
    );
    expect(FOUND_VIA_FOLLOW_UP.has('linkedin')).toBe(false);
    expect(FOUND_VIA_FOLLOW_UP.has('colleague')).toBe(false);
  });
});

describe('foundViaFields', () => {
  it("defaults both keys to '' when omitted", () => {
    expect(Fields.parse({})).toEqual({ found_via: '', found_via_detail: '' });
  });

  it('rejects an unknown channel', () => {
    expect(Fields.safeParse({ found_via: 'tiktok' }).success).toBe(false);
  });

  it('trims the detail and caps it at 200 characters', () => {
    expect(
      Fields.parse({ found_via: 'ai_tool', found_via_detail: '  hi  ' }).found_via_detail,
    ).toBe('hi');
    const max = 'x'.repeat(FOUND_VIA_DETAIL_MAX);
    expect(Fields.safeParse({ found_via_detail: `  ${max}  ` }).success).toBe(true);
    expect(Fields.safeParse({ found_via_detail: `${max}x` }).success).toBe(false);
  });

  it('is spread into the claim, subscribe and feedback schemas', () => {
    const claim = ClaimFormSchema.parse({
      submitter_name: 'Ada',
      submitter_email: 'ada@example.com',
      submitter_role: 'PM',
      accepted_terms: true,
      found_via: 'search',
      found_via_detail: 'aec integrations',
    });
    expect(claim.found_via).toBe('search');
    expect(SubscribeSubmitSchema.parse({ email: 'a@example.com' }).found_via).toBe('');
    const feedback = FeedbackSubmitSchema.parse({ features: 'x', found_via: 'event' });
    expect(feedback.found_via).toBe('event');
    expect(feedback.found_via_detail).toBe('');
  });
});

describe('normalizeFoundVia', () => {
  it('stores nulls for an empty answer, and drops a detail sent with no choice', () => {
    expect(normalizeFoundVia({ found_via: '', found_via_detail: '' })).toEqual({
      foundVia: null,
      foundViaDetail: null,
    });
    expect(normalizeFoundVia({ found_via: '', found_via_detail: 'stray' })).toEqual({
      foundVia: null,
      foundViaDetail: null,
    });
    expect(normalizeFoundVia({})).toEqual({ foundVia: null, foundViaDetail: null });
  });

  it('keeps the detail for a follow-up choice', () => {
    expect(
      normalizeFoundVia({
        found_via: 'ai_tool',
        found_via_detail: 'best AEC integration directory',
      }),
    ).toEqual({ foundVia: 'ai_tool', foundViaDetail: 'best AEC integration directory' });
  });

  it('stores a null detail when a follow-up choice has a blank answer', () => {
    expect(normalizeFoundVia({ found_via: 'other', found_via_detail: '   ' })).toEqual({
      foundVia: 'other',
      foundViaDetail: null,
    });
  });

  it('drops the detail for linkedin and colleague instead of rejecting', () => {
    for (const choice of ['linkedin', 'colleague'] as const) {
      expect(normalizeFoundVia({ found_via: choice, found_via_detail: 'ignored' })).toEqual({
        foundVia: choice,
        foundViaDetail: null,
      });
    }
  });
});

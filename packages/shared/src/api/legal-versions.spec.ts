import { describe, expect, it } from 'vitest';

import {
  LEGAL_SUMMARY_BULLET_MAX,
  LEGAL_SUMMARY_MAX_BULLETS,
  PublishLegalVersionRequestSchema,
  hasForbiddenSummaryChar,
  legalEffectiveAtMs,
  legalPdfKey,
  legalVersionPagePath,
} from './legal-versions';

/** AECI-1688: the publish request the `/admin/legal` form sends. */
describe('PublishLegalVersionRequestSchema', () => {
  const base = {
    document: 'vendor_terms',
    version: '1.4',
    material: true,
    requires_acceptance: false,
    summary: ['One change.'],
  };

  it('accepts 1 to 10 one-line bullets of up to 300 characters, trimmed', () => {
    const out = PublishLegalVersionRequestSchema.parse({
      ...base,
      summary: ['  padded  ', 'x'.repeat(LEGAL_SUMMARY_BULLET_MAX)],
    });
    expect(out.summary).toEqual(['padded', 'x'.repeat(LEGAL_SUMMARY_BULLET_MAX)]);
    expect(
      PublishLegalVersionRequestSchema.safeParse({
        ...base,
        summary: Array.from({ length: LEGAL_SUMMARY_MAX_BULLETS }, (_, i) => `b${i}`),
      }).success,
    ).toBe(true);
  });

  it.each([
    ['no bullet', []],
    ['eleven bullets', Array.from({ length: 11 }, (_, i) => `b${i}`)],
    ['a long bullet', ['x'.repeat(LEGAL_SUMMARY_BULLET_MAX + 1)]],
    ['a two-line bullet', ['a\nb']],
    ['a blank bullet', ['  ']],
  ])('refuses %s', (_label, summary) => {
    expect(PublishLegalVersionRequestSchema.safeParse({ ...base, summary }).success).toBe(false);
  });

  it.each([
    ['a tab', 'a\tb'],
    ['a lone carriage return', 'a\rb'],
    ['a NUL', 'a\u0000b'],
    ['a zero-width space', 'a\u200Bb'],
    ['a zero-width joiner', 'a\u200Db'],
    ['a right-to-left override', 'a\u202Eb'],
    ['a left-to-right isolate', 'a\u2066b'],
    ['a byte-order mark', 'a\uFEFFb'],
    ['a line separator', 'a\u2028b'],
    ['a paragraph separator', 'a\u2029b'],
  ])('refuses a bullet holding %s, with a plain-text message', (_label, bullet) => {
    const r = PublishLegalVersionRequestSchema.safeParse({ ...base, summary: [bullet] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/one line of plain text/);
    expect(hasForbiddenSummaryChar(bullet)).toBe(true);
  });

  it('keeps ordinary punctuation, accents and symbols, unescaped', () => {
    const bullet = 'Fees < $250 & “Managed” café, 100% — no change to § 4.';
    expect(hasForbiddenSummaryChar(bullet)).toBe(false);
    expect(PublishLegalVersionRequestSchema.parse({ ...base, summary: [bullet] }).summary).toEqual([
      bullet,
    ]);
  });

  it('needs both flags answered: neither has a default', () => {
    const { material: _m, ...noMaterial } = base;
    const { requires_acceptance: _r, ...noAcceptance } = base;
    expect(PublishLegalVersionRequestSchema.safeParse(noMaterial).success).toBe(false);
    expect(PublishLegalVersionRequestSchema.safeParse(noAcceptance).success).toBe(false);
  });

  it('refuses requires_acceptance without material', () => {
    const r = PublishLegalVersionRequestSchema.safeParse({
      ...base,
      material: false,
      requires_acceptance: true,
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['requires_acceptance']);
    for (const material of [true, false]) {
      expect(
        PublishLegalVersionRequestSchema.safeParse({
          ...base,
          material,
          requires_acceptance: false,
        }).success,
      ).toBe(true);
    }
    expect(
      PublishLegalVersionRequestSchema.safeParse({ ...base, requires_acceptance: true }).success,
    ).toBe(true);
  });

  it('takes an expedited reason on a Vendor Terms version only', () => {
    expect(
      PublishLegalVersionRequestSchema.safeParse({ ...base, expedited_reason: 'law' }).success,
    ).toBe(true);
    expect(
      PublishLegalVersionRequestSchema.safeParse({
        ...base,
        document: 'managed_plan',
        expedited_reason: 'error',
      }).success,
    ).toBe(false);
    expect(
      PublishLegalVersionRequestSchema.safeParse({
        ...base,
        document: 'managed_plan',
        expedited_reason: null,
      }).success,
    ).toBe(true);
  });

  // AECI-1637: the Terms of Service and the Privacy Policy are publishable too.
  it('takes the two reader documents, and refuses requires_acceptance for Privacy only', () => {
    for (const document of ['terms', 'privacy']) {
      expect(PublishLegalVersionRequestSchema.safeParse({ ...base, document }).success).toBe(true);
    }
    expect(
      PublishLegalVersionRequestSchema.safeParse({
        ...base,
        document: 'terms',
        requires_acceptance: true,
      }).success,
    ).toBe(true);
    const privacy = PublishLegalVersionRequestSchema.safeParse({
      ...base,
      document: 'privacy',
      requires_acceptance: true,
    });
    expect(privacy.success).toBe(false);
    expect(privacy.error?.issues.map((i) => i.path.join('.'))).toEqual(['requires_acceptance']);
    for (const document of ['terms', 'privacy']) {
      expect(
        PublishLegalVersionRequestSchema.safeParse({ ...base, document, expedited_reason: 'law' })
          .success,
      ).toBe(false);
    }
    expect(
      PublishLegalVersionRequestSchema.safeParse({ ...base, document: 'review_guidelines' })
        .success,
    ).toBe(false);
  });

  it('is strict: an extra field such as effective_at is refused', () => {
    expect(
      PublishLegalVersionRequestSchema.safeParse({ ...base, effective_at: '2027-01-01' }).success,
    ).toBe(false);
  });
});

describe('legalEffectiveAtMs: 12:00 UTC of the effective day', () => {
  it('is noon UTC, not midnight', () => {
    expect(new Date(legalEffectiveAtMs('2027-03-31')).toISOString()).toBe(
      '2027-03-31T12:00:00.000Z',
    );
  });

  it('falls on the named day in New York, Los Angeles and Honolulu', () => {
    const at = new Date(legalEffectiveAtMs('2027-03-31'));
    for (const timeZone of ['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu']) {
      const day = new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);
      expect(day, timeZone).toBe('2027-03-31');
    }
  });

  it.each(['2027-02-30', '2027-13-01', '27-03-31', '2027-3-31', '', 'March 31, 2027'])(
    'is NaN for %j',
    (day) => {
      expect(Number.isNaN(legalEffectiveAtMs(day))).toBe(true);
    },
  );
});

describe('legalPdfKey and legalVersionPagePath', () => {
  it('build the R2 key and the page path from the document slug', () => {
    expect(legalPdfKey('vendor_terms', '1.4')).toBe('legal/vendor-terms/v1.4.pdf');
    expect(legalPdfKey('managed_plan', '1.2')).toBe('legal/managed-plan-agreement/v1.2.pdf');
    expect(legalVersionPagePath('managed_plan', '1.2')).toBe('/legal/managed-plan-agreement/v1.2');
    expect(legalPdfKey('terms', '1.2')).toBe('legal/terms/v1.2.pdf');
    expect(legalVersionPagePath('privacy', '1.2')).toBe('/legal/privacy/v1.2');
  });
});

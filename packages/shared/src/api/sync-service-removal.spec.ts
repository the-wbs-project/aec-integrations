/** AECI-2192 (ruling 66): the fixed removal lists and their schemas. */
import { describe, expect, it } from 'vitest';

import {
  AdminDecideVetoObjectionSchema,
  AdminLiftVetoSchema,
  FileVetoObjectionSchema,
  FileVetoSchema,
} from './sync-service-pair-rights';
import {
  OBJECTION_GROUNDS,
  OBJECTION_GROUND_LABELS,
  REMOVAL_END_REASONS,
  REMOVAL_REASON_CODES,
  REMOVAL_REASON_LABELS,
  REMOVAL_REASON_UNRECOGNISED,
  REMOVAL_REASON_UNRECOGNISED_LABEL,
  removalReasonEnglish,
  removalReasonWireCode,
} from './sync-service-removal';

describe('the fixed removal lists', () => {
  it('has three reasons, three grounds, and five end reasons that start with the grounds', () => {
    expect(REMOVAL_REASON_CODES).toEqual([
      'not_supported',
      'not_authorised',
      'no_longer_work_with',
    ]);
    expect(REMOVAL_REASON_LABELS).toEqual({
      not_supported: 'We do not support this integration',
      not_authorised: 'We have not authorised it for our product',
      no_longer_work_with: 'We no longer work with this company',
    });
    expect(OBJECTION_GROUNDS).toEqual([
      'unauthorised_account',
      'wrong_product',
      'reason_plainly_false',
    ]);
    expect(REMOVAL_END_REASONS).toEqual([
      ...OBJECTION_GROUNDS,
      'claim_ended_or_suspended',
      'law_requires',
    ]);
  });

  it('labels every code, each a plain statement with no semicolon or dash', () => {
    for (const code of REMOVAL_REASON_CODES) {
      expect(REMOVAL_REASON_LABELS[code]).toMatch(/^[A-Z][^;—–]+[^.]$/);
    }
    for (const ground of OBJECTION_GROUNDS) expect(OBJECTION_GROUND_LABELS[ground]).toBeTruthy();
  });

  it('reads a stored code outside the list as unrecognised, and no code as null', () => {
    expect(removalReasonWireCode('not_authorised')).toBe('not_authorised');
    expect(removalReasonWireCode('not_offered_for_product')).toBe(REMOVAL_REASON_UNRECOGNISED);
    expect(removalReasonWireCode('ended')).toBe(REMOVAL_REASON_UNRECOGNISED);
    expect(removalReasonWireCode(null)).toBeNull();
    expect(removalReasonEnglish('ended')).toBe(REMOVAL_REASON_UNRECOGNISED_LABEL);
    expect(removalReasonEnglish('not_supported')).toBe('We do not support this integration');
    expect(removalReasonEnglish(null)).toBeNull();
  });
});

describe('the schemas', () => {
  it('a removal takes one code and refuses free text', () => {
    expect(FileVetoSchema.safeParse({ reason_code: 'no_longer_work_with' }).success).toBe(true);
    expect(FileVetoSchema.safeParse({ reason_code: 'ended' }).success).toBe(false);
    expect(FileVetoSchema.safeParse({ reason_code: 'not_offered_for_product' }).success).toBe(
      false,
    );
    expect(FileVetoSchema.safeParse({ reason_code: REMOVAL_REASON_UNRECOGNISED }).success).toBe(
      false,
    );
    expect(FileVetoSchema.safeParse({ reason: 'We never authorised it.' }).success).toBe(false);
    expect(FileVetoSchema.safeParse({ reason_code: 'not_supported', reason: 'x' }).success).toBe(
      false,
    );
    expect(FileVetoSchema.safeParse({ reason_code: 'other' }).success).toBe(false);
  });

  it('an objection names one ground, an explanation, and a https link only for plainly false', () => {
    const ok = (body: unknown) => FileVetoObjectionSchema.safeParse(body).success;
    expect(ok({ ground: 'wrong_product', explanation: 'Wrong.' })).toBe(true);
    expect(ok({ ground: 'reason_plainly_false', explanation: 'Listed.' })).toBe(false);
    expect(
      ok({ ground: 'reason_plainly_false', explanation: 'Listed.', source_url: 'http://x.test' }),
    ).toBe(false);
    expect(
      ok({
        ground: 'reason_plainly_false',
        explanation: 'Listed.',
        source_url: 'https://x.test/a',
      }),
    ).toBe(true);
    expect(ok({ ground: 'we_disagree', explanation: 'No.' })).toBe(false);
    expect(ok({ ground: 'wrong_product', explanation: '  ' })).toBe(false);
  });

  it('a lift and a decision need their reason and note', () => {
    expect(AdminLiftVetoSchema.safeParse({ note: 'x' }).success).toBe(false);
    expect(
      AdminLiftVetoSchema.safeParse({ end_reason: 'law_requires', note: 'Court order.' }).success,
    ).toBe(true);
    expect(AdminDecideVetoObjectionSchema.safeParse({ decision: 'accept' }).success).toBe(false);
  });
});

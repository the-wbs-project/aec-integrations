/**
 * The copyright notice log's request contract (AECI-1665). Source of truth:
 * `docs/API_CONTRACTS.md` "Copyright notices", `docs/DATABASE_SCHEMA.md` §8.14.
 *
 * Every notice is logged on receipt, complete or not. The one completeness rule: a
 * `removed` or `disabled` row names the material it took down.
 */
import { describe, expect, it } from 'vitest';

import {
  CreateDmcaNoticeRequestSchema,
  DmcaNoticeSchema,
  UpdateDmcaNoticeRequestSchema,
  dmcaTakedownLacksContent,
} from './dmca-notices';

const RECEIVED = '2026-11-20T12:00:00.000Z';

describe('CreateDmcaNoticeRequestSchema', () => {
  it('accepts an incomplete notice: no name, contact or material', () => {
    const parsed = CreateDmcaNoticeRequestSchema.parse({
      kind: 'notice',
      received_at: RECEIVED,
      action: 'no_action',
    });
    expect(parsed.submitter_name).toBeUndefined();
    expect(parsed.content_identified).toBeUndefined();
  });

  it('accepts null for the name, contact and material', () => {
    expect(
      CreateDmcaNoticeRequestSchema.safeParse({
        kind: 'notice',
        received_at: RECEIVED,
        submitter_name: null,
        submitter_contact: null,
        content_identified: null,
      }).success,
    ).toBe(true);
  });

  it('still refuses a blank string, which is not the same as not given', () => {
    expect(
      CreateDmcaNoticeRequestSchema.safeParse({
        kind: 'notice',
        received_at: RECEIVED,
        submitter_name: '   ',
      }).success,
    ).toBe(false);
  });

  it.each(['removed', 'disabled'] as const)(
    'refuses a %s notice with no material, on content_identified',
    (action) => {
      const result = CreateDmcaNoticeRequestSchema.safeParse({
        kind: 'notice',
        received_at: RECEIVED,
        action,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['content_identified']);
    },
  );

  it('accepts a takedown that names its material', () => {
    expect(
      CreateDmcaNoticeRequestSchema.safeParse({
        kind: 'notice',
        received_at: RECEIVED,
        action: 'removed',
        content_identified: 'https://www.aecintegrations.com/vendors/acme logo',
      }).success,
    ).toBe(true);
  });
});

describe('UpdateDmcaNoticeRequestSchema', () => {
  it('lets null clear the name, contact and material', () => {
    expect(
      UpdateDmcaNoticeRequestSchema.parse({
        expected_updated_at: RECEIVED,
        submitter_name: null,
        submitter_contact: null,
        content_identified: null,
      }),
    ).toMatchObject({ submitter_name: null, submitter_contact: null, content_identified: null });
  });
});

describe('dmcaTakedownLacksContent', () => {
  it('is true only for a takedown with no material', () => {
    expect(dmcaTakedownLacksContent({ action: 'removed', content_identified: null })).toBe(true);
    expect(dmcaTakedownLacksContent({ action: 'disabled', content_identified: '' })).toBe(true);
    expect(dmcaTakedownLacksContent({ action: 'removed', content_identified: 'x' })).toBe(false);
    expect(dmcaTakedownLacksContent({ action: 'pending', content_identified: null })).toBe(false);
    expect(dmcaTakedownLacksContent({ action: 'no_action' })).toBe(false);
    expect(dmcaTakedownLacksContent({})).toBe(false);
  });
});

describe('DmcaNoticeSchema', () => {
  it('reads a row with no name, contact or material', () => {
    const shape = DmcaNoticeSchema.shape;
    expect(shape.submitter_name.safeParse(null).success).toBe(true);
    expect(shape.submitter_contact.safeParse(null).success).toBe(true);
    expect(shape.content_identified.safeParse(null).success).toBe(true);
  });
});

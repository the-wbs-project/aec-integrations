/**
 * The delivery-event classifier (AECI-1222): which tier records an event. One Resend
 * account serves every tier, so each tier's webhook sees every tier's events.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyEvent,
  eventTags,
  isSupabaseSignInEmail,
  metricTier,
  SIGN_IN_SUBJECT,
} from './delivery-events';

const tagged = (tier: string, id = 'review-submitted') => ({
  email_id: 'em_1',
  to: ['r@example.com'],
  tags: { tier, notification_id: id },
});

const signIn = (over: Record<string, unknown> = {}) => ({
  email_id: 'em_2',
  from: 'AEC Integrations <notifications@aecintegrations.com>',
  to: ['someone@gmail.com'],
  subject: SIGN_IN_SUBJECT,
  ...over,
});

describe('classifyEvent', () => {
  it('records an event tagged with this tier, naming the registry id', () => {
    expect(classifyEvent({ ENV: 'production' }, tagged('production'))).toEqual({
      kind: 'record',
      tier: 'production',
      taggedNotificationId: 'review-submitted',
      signIn: false,
    });
    expect(classifyEvent({ ENV: 'staging' }, tagged('staging'))).toMatchObject({
      kind: 'record',
      tier: 'staging',
    });
  });

  it('drops an event tagged with another tier', () => {
    expect(classifyEvent({ ENV: 'production' }, tagged('staging'))).toEqual({
      kind: 'drop',
      reason: 'other_tier',
      tier: 'staging',
    });
    expect(classifyEvent({ ENV: 'staging' }, tagged('production'))).toMatchObject({
      kind: 'drop',
      reason: 'other_tier',
    });
  });

  it('fails closed on a missing ENV: only a non-production tag matches', () => {
    expect(classifyEvent({}, tagged('production'))).toMatchObject({ kind: 'drop' });
    expect(classifyEvent({}, tagged('non-production'))).toMatchObject({ kind: 'record' });
  });

  it('records a tagged event whose notification_id is not a registry id, with no id', () => {
    expect(classifyEvent({ ENV: 'production' }, tagged('production', 'made-up'))).toMatchObject({
      kind: 'record',
      taggedNotificationId: null,
    });
  });

  it('reads tags in the array shape too', () => {
    const data = {
      email_id: 'em_1',
      tags: [
        { name: 'tier', value: 'demo' },
        { name: 'notification_id', value: 'review-submitted' },
      ],
    };
    expect(eventTags(data).get('tier')).toBe('demo');
    expect(classifyEvent({ ENV: 'demo' }, data)).toMatchObject({ kind: 'record', tier: 'demo' });
  });

  it('records the untagged sign-in stream on production only, as tier auth', () => {
    expect(classifyEvent({ ENV: 'production' }, signIn())).toEqual({
      kind: 'record',
      tier: 'auth',
      taggedNotificationId: null,
      signIn: true,
    });
    for (const ENV of ['staging', 'demo', 'preview', undefined]) {
      expect(classifyEvent({ ENV }, signIn())).toMatchObject({ kind: 'drop', reason: 'untagged' });
    }
  });

  it('drops any other untagged event, on production too', () => {
    expect(
      classifyEvent({ ENV: 'production' }, signIn({ subject: 'Something else' })),
    ).toMatchObject({ kind: 'drop', reason: 'untagged', tier: 'production' });
  });

  it('a tagged sign-in-looking event follows its tag, not the subject', () => {
    expect(
      classifyEvent({ ENV: 'production' }, { ...signIn(), tags: { tier: 'staging' } }),
    ).toMatchObject({ kind: 'drop', reason: 'other_tier' });
  });
});

describe('isSupabaseSignInEmail', () => {
  it('matches the subject exactly and a sender on aecintegrations.com or a subdomain', () => {
    expect(isSupabaseSignInEmail(signIn())).toBe(true);
    expect(isSupabaseSignInEmail(signIn({ from: 'auth@mail.aecintegrations.com' }))).toBe(true);
    expect(isSupabaseSignInEmail(signIn({ subject: `  ${SIGN_IN_SUBJECT} ` }))).toBe(true);
  });

  it('rejects a lookalike sender or a different subject', () => {
    expect(isSupabaseSignInEmail(signIn({ from: 'x@evilaecintegrations.com' }))).toBe(false);
    expect(isSupabaseSignInEmail(signIn({ from: 'x@aecintegrations.com.evil.io' }))).toBe(false);
    expect(isSupabaseSignInEmail(signIn({ from: undefined }))).toBe(false);
    expect(isSupabaseSignInEmail(signIn({ subject: 'Sign in to AEC Integrations!' }))).toBe(false);
    expect(isSupabaseSignInEmail(signIn({ subject: undefined }))).toBe(false);
  });
});

describe('metricTier', () => {
  it('keeps known tier labels and folds anything else to other', () => {
    expect(metricTier('production')).toBe('production');
    expect(metricTier('auth')).toBe('auth');
    expect(metricTier('some-forged-tier')).toBe('other');
  });
});

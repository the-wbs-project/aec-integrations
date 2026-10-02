import type { CaptureResult } from 'posthog-js';
import { describe, expect, it } from 'vitest';

import { sanitizePostHogEvent, stripTokenParam } from './posthog-url-sanitizer';

/**
 * Plain-Vitest (node) coverage for the PostHog `before_send` URL sanitizer.
 * The `?token=` on `/unsubscribe` and `/notifications/mute` is a bearer secret
 * and must never reach PostHog.
 */

const ORIGIN = 'https://www.aecintegrations.com';

describe('stripTokenParam', () => {
  it('drops the only parameter and the trailing ?', () => {
    expect(stripTokenParam(`${ORIGIN}/unsubscribe?token=abc123`)).toBe(`${ORIGIN}/unsubscribe`);
  });

  it('keeps every other parameter in its original order and spelling', () => {
    expect(
      stripTokenParam(`${ORIGIN}/notifications/mute?utm_source=email&token=abc&b=1%202&flag`),
    ).toBe(`${ORIGIN}/notifications/mute?utm_source=email&b=1%202&flag`);
  });

  it('removes every token parameter, including repeats and an encoded key', () => {
    expect(stripTokenParam('/x?token=a&q=1&%74oken=b&token')).toBe('/x?q=1');
  });

  it('keeps the fragment', () => {
    expect(stripTokenParam(`${ORIGIN}/unsubscribe?token=abc#top`)).toBe(
      `${ORIGIN}/unsubscribe#top`,
    );
    expect(stripTokenParam('/a?x=1&token=abc#frag?token=z')).toBe('/a?x=1#frag?token=z');
  });

  it('handles relative URLs', () => {
    expect(stripTokenParam('/unsubscribe?token=abc')).toBe('/unsubscribe');
    expect(stripTokenParam('?token=abc&a=1')).toBe('?a=1');
  });

  it('does not touch look-alike parameter names', () => {
    const url = `${ORIGIN}/p?tokens=1&my_token=2&token_type=3`;
    expect(stripTokenParam(url)).toBe(url);
  });

  it('returns URLs with no query or no token unchanged', () => {
    expect(stripTokenParam(`${ORIGIN}/products/foo`)).toBe(`${ORIGIN}/products/foo`);
    expect(stripTokenParam(`${ORIGIN}/search?q=revit`)).toBe(`${ORIGIN}/search?q=revit`);
    expect(stripTokenParam('')).toBe('');
  });

  it('does not throw on malformed input', () => {
    expect(() => stripTokenParam('%E0%A4%A?token=x&%zz=1')).not.toThrow();
    expect(stripTokenParam('%E0%A4%A?token=x&%zz=1')).toBe('%E0%A4%A?%zz=1');
    expect(stripTokenParam('/a?%E0%A4%A=1&token=x')).toBe('/a?%E0%A4%A=1');
    expect(stripTokenParam('::not a url::?token=1')).toBe('::not a url::');
  });
});

function event(partial: Partial<CaptureResult>): CaptureResult {
  return { uuid: 'u', event: '$pageview', properties: {}, ...partial };
}

describe('sanitizePostHogEvent', () => {
  it('scrubs $current_url, $referrer and $pathname on the event', () => {
    const out = sanitizePostHogEvent(
      event({
        properties: {
          $current_url: `${ORIGIN}/notifications/mute?token=abc`,
          $referrer: `${ORIGIN}/unsubscribe?token=def&utm_medium=email`,
          $pathname: '/unsubscribe?token=ghi',
          $host: 'www.aecintegrations.com',
          other: `${ORIGIN}/?token=left-alone`,
        },
      }),
    );
    expect(out?.properties).toEqual({
      $current_url: `${ORIGIN}/notifications/mute`,
      $referrer: `${ORIGIN}/unsubscribe?utm_medium=email`,
      $pathname: '/unsubscribe',
      $host: 'www.aecintegrations.com',
      other: `${ORIGIN}/?token=left-alone`,
    });
  });

  it('scrubs the first-touch copies in $set and $set_once', () => {
    const out = sanitizePostHogEvent(
      event({
        $set: { $current_url: `${ORIGIN}/unsubscribe?token=a` },
        $set_once: {
          $initial_current_url: `${ORIGIN}/unsubscribe?token=a`,
          $initial_referrer: `${ORIGIN}/notifications/mute?token=b`,
          $initial_pathname: '/unsubscribe',
        },
      }),
    );
    expect(out?.$set).toEqual({ $current_url: `${ORIGIN}/unsubscribe` });
    expect(out?.$set_once).toEqual({
      $initial_current_url: `${ORIGIN}/unsubscribe`,
      $initial_referrer: `${ORIGIN}/notifications/mute`,
      $initial_pathname: '/unsubscribe',
    });
  });

  it('scrubs the $session_entry_* copies the SDK puts on every event of a session', () => {
    const out = sanitizePostHogEvent(
      event({
        event: '$web_vitals',
        properties: {
          $session_entry_url: `${ORIGIN}/unsubscribe?token=a&utm_source=email`,
          $session_entry_referrer: `${ORIGIN}/notifications/mute?token=b`,
          $session_entry_pathname: '/notifications/mute?token=c',
        },
      }),
    );
    expect(out?.properties).toEqual({
      $session_entry_url: `${ORIGIN}/unsubscribe?utm_source=email`,
      $session_entry_referrer: `${ORIGIN}/notifications/mute`,
      $session_entry_pathname: '/notifications/mute',
    });
  });

  it('passes null through and ignores non-string URL properties', () => {
    expect(sanitizePostHogEvent(null)).toBeNull();
    const out = sanitizePostHogEvent(
      event({ properties: { $current_url: 42, $referrer: null, $pathname: undefined } }),
    );
    expect(out?.properties).toEqual({ $current_url: 42, $referrer: null, $pathname: undefined });
  });
});

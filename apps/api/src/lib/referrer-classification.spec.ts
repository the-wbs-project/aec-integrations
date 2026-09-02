/**
 * Unit tests for `classifyReferrer` (AECI-526 follow-up) — the traffic-source label
 * derived from each page view's `Referer` header.
 */

import { describe, expect, it } from 'vitest';

import { classifyReferrer, NAMED_REFERRER_SOURCES } from './referrer-classification';

const SELF = ['aecintegrations.com', 'aec-integrations.workers.dev'];

describe('classifyReferrer', () => {
  it('names common social + search referrers by host', () => {
    expect(classifyReferrer('https://www.linkedin.com/feed/', SELF)).toEqual({
      source: 'LinkedIn',
      host: 'www.linkedin.com',
    });
    expect(classifyReferrer('https://lnkd.in/abc', SELF)).toEqual({
      source: 'LinkedIn',
      host: 'lnkd.in',
    });
    expect(classifyReferrer('https://t.co/xyz', SELF)).toEqual({
      source: 'Twitter/X',
      host: 't.co',
    });
    expect(classifyReferrer('https://x.com/someone/status/1', SELF)).toEqual({
      source: 'Twitter/X',
      host: 'x.com',
    });
    expect(classifyReferrer('https://www.google.com/search?q=aec', SELF).source).toBe('Google');
    expect(classifyReferrer('https://news.google.com/', SELF).source).toBe('Google');
    expect(classifyReferrer('https://www.bing.com/search?q=x', SELF).source).toBe('Bing');
    expect(classifyReferrer('https://duckduckgo.com/', SELF).source).toBe('DuckDuckGo');
    expect(classifyReferrer('https://www.reddit.com/r/aec', SELF).source).toBe('Reddit');
  });

  it('treats no / malformed referrer as Direct', () => {
    expect(classifyReferrer(null, SELF)).toEqual({ source: 'Direct', host: null });
    expect(classifyReferrer('', SELF)).toEqual({ source: 'Direct', host: null });
    expect(classifyReferrer('not a url', SELF)).toEqual({ source: 'Direct', host: null });
  });

  it('treats same-origin / self hosts as Direct (in-app navigation)', () => {
    expect(classifyReferrer('https://www.aecintegrations.com/products', SELF)).toEqual({
      source: 'Direct',
      host: null,
    });
    expect(classifyReferrer('https://aecintegrations.com/', SELF)).toEqual({
      source: 'Direct',
      host: null,
    });
    expect(classifyReferrer('https://aeci-web.aec-integrations.workers.dev/', SELF)).toEqual({
      source: 'Direct',
      host: null,
    });
  });

  it('labels an unknown external host as Other, keeping the host', () => {
    expect(classifyReferrer('https://some-blog.example.com/post', SELF)).toEqual({
      source: 'Other',
      host: 'some-blog.example.com',
    });
  });
});

describe('NAMED_REFERRER_SOURCES (AECI-683)', () => {
  const SELF = ['aecintegrations.com'];

  it('contains every label the classifier can produce for a known host', () => {
    // Derived from the SOURCES table rather than restated, so a source added to
    // the classifier joins the corroborated population automatically. This test
    // is the guard on that: a hand-maintained copy would silently fall behind.
    const hosts = [
      'https://www.google.com/search?q=x',
      'https://www.bing.com/',
      'https://duckduckgo.com/',
      'https://search.yahoo.com/',
      'https://www.ecosia.org/',
      'https://search.brave.com/',
      'https://yandex.ru/',
      'https://www.baidu.com/',
      'https://www.linkedin.com/',
      'https://t.co/abc',
      'https://www.facebook.com/',
      'https://www.instagram.com/',
      'https://www.youtube.com/',
      'https://www.reddit.com/',
      'https://news.ycombinator.com/',
      'https://github.com/',
      'https://t.me/x',
      'https://bsky.app/',
    ];
    for (const h of hosts) {
      expect(NAMED_REFERRER_SOURCES).toContain(classifyReferrer(h, SELF).source);
    }
  });

  it('excludes Direct and Other — the two buckets that corroborate nothing', () => {
    // `Direct` is where every stripped referral lands, and `Other` is an open
    // bucket a forger controls entirely. Counting either would turn the
    // corroborated figure back into the headline it exists to qualify.
    expect(classifyReferrer(null, SELF).source).toBe('Direct');
    expect(classifyReferrer('https://example.invalid/', SELF).source).toBe('Other');
    expect(NAMED_REFERRER_SOURCES).not.toContain('Direct');
    expect(NAMED_REFERRER_SOURCES).not.toContain('Other');
  });

  it('is deduplicated — several hosts share one label', () => {
    expect(new Set(NAMED_REFERRER_SOURCES).size).toBe(NAMED_REFERRER_SOURCES.length);
  });
});

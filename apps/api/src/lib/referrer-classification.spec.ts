/**
 * Unit tests for `classifyReferrer` (AECI-526 follow-up) — the traffic-source label
 * derived from each page view's `Referer` header.
 */

import { describe, expect, it } from 'vitest';

import { classifyReferrer } from './referrer-classification';

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

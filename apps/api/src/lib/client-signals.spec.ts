/**
 * Unit tests for `classifyClientSignals` (AECI-658) — the request-shape
 * annotation stored on each `page_views` row.
 *
 * The most important cases here are the FALSE-POSITIVE guards. This column is
 * meant to expose automated traffic, and the failure mode that actually costs
 * something is labelling a real Safari or Firefox visitor `inconsistent`, so
 * those two browsers get explicit tests rather than being assumed.
 */

import { describe, expect, it } from 'vitest';

import { claimsChromium, classifyClientSignals } from './client-signals';

/** A real Chrome 128 top-level navigation. */
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
/** Real desktop Safari 17 — carries `Safari/` and `Version/`, never `sec-ch-ua`. */
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
/** Real Firefox 128. */
const FIREFOX_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0';

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

/** The header set a real browser sends on a document navigation. */
function navigationHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'user-agent': CHROME_UA,
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'accept-language': 'en-US,en;q=0.9',
    accept: HTML_ACCEPT,
    'sec-ch-ua': '"Chromium";v="128", "Not(A:Brand";v="24"',
    ...extra,
  };
}

describe('claimsChromium', () => {
  it('is true for Chrome and Edge, false for Safari and Firefox', () => {
    expect(claimsChromium(CHROME_UA)).toBe(true);
    expect(claimsChromium('Mozilla/5.0 … Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0')).toBe(true);
    // Safari's UA contains the literal token `Safari/`, and some builds carry a
    // `Chrome/` token too. Matching naively here would demand `sec-ch-ua` from a
    // browser that never sends it, flagging every Safari visitor.
    expect(claimsChromium(SAFARI_UA)).toBe(false);
    expect(claimsChromium(FIREFOX_UA)).toBe(false);
  });

  it('is false for a null or empty user agent', () => {
    expect(claimsChromium(null)).toBe(false);
    expect(claimsChromium('')).toBe(false);
  });
});

describe('classifyClientSignals — real browsers must not be flagged', () => {
  it('calls a complete Chrome navigation a browser', () => {
    const result = classifyClientSignals(headers(navigationHeaders()), CHROME_UA, 'arrival');
    expect(result.verdict).toBe('browser');
    expect(result.secFetchDest).toBe('document');
    expect(result.hasAcceptLanguage).toBe(true);
    expect(result.hasSecChUa).toBe(true);
  });

  it('calls Safari a browser even though it never sends sec-ch-ua', () => {
    const h = navigationHeaders({ 'user-agent': SAFARI_UA });
    delete h['sec-ch-ua'];
    const result = classifyClientSignals(headers(h), SAFARI_UA, 'arrival');
    expect(result.verdict).toBe('browser');
    expect(result.hasSecChUa).toBe(false);
  });

  it('calls Firefox a browser even though it never sends sec-ch-ua', () => {
    const h = navigationHeaders({ 'user-agent': FIREFOX_UA });
    delete h['sec-ch-ua'];
    const result = classifyClientSignals(headers(h), FIREFOX_UA, 'arrival');
    expect(result.verdict).toBe('browser');
  });
});

describe('classifyClientSignals — automation', () => {
  it('flags a Chromium UA that omits Chromium own client hint', () => {
    const h = navigationHeaders();
    delete h['sec-ch-ua'];
    expect(classifyClientSignals(headers(h), CHROME_UA, 'arrival').verdict).toBe('inconsistent');
  });

  it('flags a browser-shaped UA that sends no navigation headers', () => {
    // The 2026-08-23 swarm shape: a plausible UA, nothing else.
    const result = classifyClientSignals(
      headers({ 'user-agent': FIREFOX_UA, accept: HTML_ACCEPT }),
      FIREFOX_UA,
      'arrival',
    );
    expect(result.verdict).toBe('inconsistent');
  });

  it('calls a bare HTTP client non-browser', () => {
    const result = classifyClientSignals(
      headers({ 'user-agent': 'python-requests/2.31.0', accept: '*/*' }),
      'python-requests/2.31.0',
      'arrival',
    );
    expect(result.verdict).toBe('non-browser');
  });

  it('flags a navigation missing Accept-Language', () => {
    const h = navigationHeaders();
    delete h['accept-language'];
    expect(classifyClientSignals(headers(h), CHROME_UA, 'arrival').verdict).toBe('inconsistent');
  });
});

describe('classifyClientSignals — navigation awareness', () => {
  it('treats an SPA hop as a browser without applying arrival rules', () => {
    // The tracker's own fetch: `Sec-Fetch-Dest: empty`, no HTML `Accept`. Judged
    // by arrival rules it would fail every check, yet reaching this code path at
    // all means our JavaScript ran.
    const result = classifyClientSignals(
      headers({
        'user-agent': CHROME_UA,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        accept: '*/*',
      }),
      CHROME_UA,
      'spa',
    );
    expect(result.verdict).toBe('browser');
    expect(result.secFetchDest).toBe('empty');
  });

  it('treats a null navigation as an arrival', () => {
    // Every row written before AECI-585 has a null `navigation`, and the SSR path
    // is always an arrival, so the arrival rules are the right default.
    const result = classifyClientSignals(headers(navigationHeaders()), CHROME_UA, null);
    expect(result.verdict).toBe('browser');
  });
});

describe('classifyClientSignals — absent information is not a verdict', () => {
  it('reports unknown when nothing at all was forwarded', () => {
    // A writer that forwards no headers must not manufacture a bot verdict out
    // of its own omission.
    expect(classifyClientSignals(headers({}), null, 'arrival').verdict).toBe('unknown');
  });

  it('carries the connection facts through verbatim', () => {
    const result = classifyClientSignals(headers(navigationHeaders()), CHROME_UA, 'arrival', {
      tlsVersion: 'TLSv1.3',
      httpProtocol: 'HTTP/2',
    });
    expect(result.tlsVersion).toBe('TLSv1.3');
    expect(result.httpProtocol).toBe('HTTP/2');
  });

  it('normalizes absent connection facts to null rather than empty string', () => {
    const result = classifyClientSignals(headers(navigationHeaders()), CHROME_UA, 'arrival', {
      tlsVersion: '',
      httpProtocol: undefined,
    });
    expect(result.tlsVersion).toBeNull();
    expect(result.httpProtocol).toBeNull();
  });
});

/**
 * Unit tests for `classifyClientSignals` (AECI-658) — the request-shape
 * annotation stored on each `page_views` row.
 *
 * The most important cases here are the FALSE-POSITIVE guards. This column is
 * meant to expose automated traffic, and the failure mode that actually costs
 * something is labelling a real Safari or Firefox visitor `inconsistent`, so
 * those two browsers get explicit tests rather than being assumed.
 */

import { PAGE_VIEW_WRITER_HEADER, PAGE_VIEW_WRITERS } from '@aeci/shared';
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

/**
 * The header set the browser tracker's POST arrives with, after the SSR Worker's
 * passthrough has stamped provenance on it (AECI-871). Angular's `HttpClient` sends
 * a JSON `Accept`, deliberately unlike the document `Accept` above.
 */
function spaHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'user-agent': CHROME_UA,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'accept-language': 'en-US,en;q=0.9',
    accept: 'application/json, text/plain, */*',
    [PAGE_VIEW_WRITER_HEADER]: PAGE_VIEW_WRITERS.browserSpa,
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

describe('classifyClientSignals — writer awareness (AECI-871)', () => {
  it('treats a PROVENANCED SPA hop as a browser without applying arrival rules', () => {
    // The tracker's own fetch: `Sec-Fetch-Dest: empty`, no HTML `Accept`. Judged
    // by arrival rules it would fail every check — so the same-origin shape, plus
    // the SSR Worker's own stamp, is what earns the verdict instead.
    const result = classifyClientSignals(headers(spaHeaders()), CHROME_UA, 'spa');
    expect(result.verdict).toBe('browser');
    expect(result.secFetchDest).toBe('empty');
    expect(result.writerProvenance).toBe('browser-spa');
  });

  it('does NOT trust the body: navigation spa with no provenance is unknown', () => {
    // THE defect AECI-871 closes. `navigation` is a body field, so any HTTP client
    // could POST it and collect the strongest verdict the system issues while
    // skipping every header check. `unknown`, not `non-browser`: we were told
    // nothing we can act on, which is not the same as being told it is a bot.
    const h = spaHeaders();
    delete h[PAGE_VIEW_WRITER_HEADER];
    const result = classifyClientSignals(headers(h), CHROME_UA, 'spa');
    expect(result.verdict).toBe('unknown');
    expect(result.writerProvenance).toBeNull();
  });

  it('refuses a provenance value outside the closed vocabulary', () => {
    // A forged header that survived some future hole in the strip must not read as
    // "some writer". Unknown value and absent header are the same statement.
    const result = classifyClientSignals(
      headers(spaHeaders({ [PAGE_VIEW_WRITER_HEADER]: 'browser-spa-but-trust-me' })),
      CHROME_UA,
      'spa',
    );
    expect(result.verdict).toBe('unknown');
    expect(result.writerProvenance).toBeNull();
  });

  it('requires the same-origin fetch headers, not provenance alone', () => {
    // Provenance says our Worker proxied a POST. It does not say a browser issued
    // one — `curl` through the passthrough gets the stamp too.
    const bare = classifyClientSignals(
      headers({
        'user-agent': CHROME_UA,
        [PAGE_VIEW_WRITER_HEADER]: PAGE_VIEW_WRITERS.browserSpa,
      }),
      CHROME_UA,
      'spa',
    );
    expect(bare.verdict).toBe('unknown');
    expect(bare.writerProvenance).toBe('browser-spa');
  });

  it.each([
    ['a cross-site Sec-Fetch-Site', { 'sec-fetch-site': 'cross-site' }],
    ['no Accept-Language', { 'accept-language': undefined }],
    [
      'neither a fetch dest nor a cors mode',
      { 'sec-fetch-dest': undefined, 'sec-fetch-mode': undefined },
    ],
  ])('downgrades a provenanced hop with %s to unknown', (_name, patch) => {
    const h = spaHeaders();
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete h[k];
      else h[k] = v;
    }
    expect(classifyClientSignals(headers(h), CHROME_UA, 'spa').verdict).toBe('unknown');
  });

  it('accepts either half of the fetch shape — dest empty OR mode cors', () => {
    const destOnly = spaHeaders();
    delete destOnly['sec-fetch-mode'];
    expect(classifyClientSignals(headers(destOnly), CHROME_UA, 'spa').verdict).toBe('browser');

    const modeOnly = spaHeaders();
    delete modeOnly['sec-fetch-dest'];
    expect(classifyClientSignals(headers(modeOnly), CHROME_UA, 'spa').verdict).toBe('browser');
  });

  it('never judges a provenanced hop non-browser or inconsistent', () => {
    // The two disqualifying verdicts (AECI-744 / §13 D16) must stay out of reach on
    // this path: an in-app hop that lost its headers is an absence of evidence.
    const result = classifyClientSignals(
      headers({ [PAGE_VIEW_WRITER_HEADER]: PAGE_VIEW_WRITERS.browserSpa }),
      null,
      'spa',
    );
    expect(result.verdict).toBe('unknown');
  });

  it('leaves the arrival rules untouched under ssr-arrival provenance', () => {
    const good = navigationHeaders({
      [PAGE_VIEW_WRITER_HEADER]: PAGE_VIEW_WRITERS.ssrArrival,
    });
    expect(classifyClientSignals(headers(good), CHROME_UA, 'arrival').verdict).toBe('browser');
    expect(classifyClientSignals(headers(good), CHROME_UA, 'arrival').writerProvenance).toBe(
      'ssr-arrival',
    );

    const bad = { ...good };
    delete bad['accept-language'];
    expect(classifyClientSignals(headers(bad), CHROME_UA, 'arrival').verdict).toBe('inconsistent');
  });

  it('applies the arrival rules to an ssr-arrival write even if the body says spa', () => {
    // Cannot happen today — `firePageView` stamps both — but the trusted header is
    // the authority, so a contradicting body must not redirect the rule set.
    const result = classifyClientSignals(
      headers(navigationHeaders({ [PAGE_VIEW_WRITER_HEADER]: PAGE_VIEW_WRITERS.ssrArrival })),
      CHROME_UA,
      'spa',
    );
    expect(result.verdict).toBe('browser');
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

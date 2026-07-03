import { LANDING_CF_HEADERS } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { applyLandingCfHeaders, withForwardedLandingCf } from './server-runtime';

/**
 * AECI-275 — the SSR `/api/*` proxy enriches the unified-home island's
 * `POST /api/subscribe` + `/api/feedback` with trusted Cloudflare geo on
 * `LANDING_CF_HEADERS` (the browser can't read `request.cf`, and it doesn't
 * survive the service binding). The SSR Worker is the SOLE writer: it strips any
 * client-supplied copies first (anti-spoof) before setting fresh values. This is
 * the unit proof of that header set, mirroring the page-view enrichment proxy.
 */

interface Cf {
  country?: string;
  city?: string;
  region?: string;
  timezone?: string;
  asOrganization?: string;
  asn?: number;
  metroCode?: number;
}

function reqWithCf(cf: Cf | undefined, headers: Record<string, string> = {}): Request {
  const req = new Request('https://api/api/subscribe', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: 'a@b.com' }),
  });
  if (cf) Object.defineProperty(req, 'cf', { value: cf, configurable: true });
  return req;
}

const FULL_CF: Cf = {
  country: 'GB',
  city: 'London',
  region: 'England',
  timezone: 'Europe/London',
  asOrganization: 'BT',
  asn: 2856,
  metroCode: 826,
};

describe('applyLandingCfHeaders', () => {
  it('copies every present request.cf geo field onto its trusted header', () => {
    const headers = new Headers();
    applyLandingCfHeaders(headers, reqWithCf(FULL_CF));

    expect(headers.get(LANDING_CF_HEADERS.country)).toBe('GB');
    expect(headers.get(LANDING_CF_HEADERS.city)).toBe('London');
    expect(headers.get(LANDING_CF_HEADERS.region)).toBe('England');
    expect(headers.get(LANDING_CF_HEADERS.timezone)).toBe('Europe/London');
    expect(headers.get(LANDING_CF_HEADERS.asOrganization)).toBe('BT');
    expect(headers.get(LANDING_CF_HEADERS.asn)).toBe('2856');
    expect(headers.get(LANDING_CF_HEADERS.metroCode)).toBe('826');
  });

  it('is a no-op when request.cf is absent (geo stays null in local dev / tests)', () => {
    const headers = new Headers();
    applyLandingCfHeaders(headers, reqWithCf(undefined));
    for (const name of Object.values(LANDING_CF_HEADERS)) {
      expect(headers.get(name)).toBeNull();
    }
  });

  it('sets only the fields that are present', () => {
    const headers = new Headers();
    applyLandingCfHeaders(headers, reqWithCf({ country: 'US' }));
    expect(headers.get(LANDING_CF_HEADERS.country)).toBe('US');
    expect(headers.get(LANDING_CF_HEADERS.city)).toBeNull();
    expect(headers.get(LANDING_CF_HEADERS.asn)).toBeNull();
  });
});

describe('withForwardedLandingCf', () => {
  it('forwards CF geo on the trusted headers and keeps the POST', () => {
    const out = withForwardedLandingCf(reqWithCf(FULL_CF));
    expect(out.method).toBe('POST');
    expect(out.headers.get(LANDING_CF_HEADERS.country)).toBe('GB');
    expect(out.headers.get(LANDING_CF_HEADERS.metroCode)).toBe('826');
  });

  it('strips client-supplied copies before setting fresh values (anti-spoof)', () => {
    const out = withForwardedLandingCf(
      reqWithCf(FULL_CF, {
        [LANDING_CF_HEADERS.country]: 'ZZ',
        [LANDING_CF_HEADERS.city]: 'Spoofville',
      }),
    );
    // The trusted request.cf value replaces the spoofed one.
    expect(out.headers.get(LANDING_CF_HEADERS.country)).toBe('GB');
    expect(out.headers.get(LANDING_CF_HEADERS.city)).toBe('London');
  });

  it('strips a client-supplied header even when request.cf is absent', () => {
    const out = withForwardedLandingCf(
      reqWithCf(undefined, { [LANDING_CF_HEADERS.country]: 'ZZ' }),
    );
    expect(out.headers.get(LANDING_CF_HEADERS.country)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import {
  buildRawEnvelope,
  decodeCfRaw,
  emptyRawPageViewDerived,
  encodeCfRaw,
  stripSecretQueryParams,
  type BuildRawEnvelopeInput,
} from './page-view-raw';
import { PAGE_VIEW_IP_HEADERS, PAGE_VIEW_RAW_HEADERS } from './page-views';

describe('stripSecretQueryParams', () => {
  it('removes every named secret parameter and keeps the rest', () => {
    const out = stripSecretQueryParams(
      'https://www.aecintegrations.com/auth/callback?code=abc&state=xyz&utm_source=g&token=t&access_token=a&refresh_token=r&key=k&api_key=k2&session=s',
    );
    expect(out).toBe('https://www.aecintegrations.com/auth/callback?utm_source=g');
  });

  it('matches names case-insensitively and by secret/password/auth substring', () => {
    const out = stripSecretQueryParams(
      'https://x.test/p?Token=1&client_secret=2&PASSWORD_hint=3&oauth_verifier=4&q=keep',
    );
    expect(out).toBe('https://x.test/p?q=keep');
  });

  it('leaves a URL with no secrets unchanged', () => {
    expect(stripSecretQueryParams('https://x.test/products/procore?ref=waitlist')).toBe(
      'https://x.test/products/procore?ref=waitlist',
    );
  });

  it('returns null for empty or unparseable input', () => {
    expect(stripSecretQueryParams(null)).toBeNull();
    expect(stripSecretQueryParams('')).toBeNull();
    expect(stripSecretQueryParams('/relative/path?token=1')).toBeNull();
  });
});

describe('encodeCfRaw / decodeCfRaw', () => {
  it('round-trips an object with non-Latin-1 text', () => {
    const cf = { city: 'São Paulo', region: 'Tōkyō', asn: 13335, botManagement: { score: 99 } };
    const encoded = encodeCfRaw(cf);
    expect(encoded).not.toBeNull();
    // A header value must be a ByteString; base64 is plain ASCII.
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(() => new Headers({ 'x-test': encoded as string })).not.toThrow();
    expect(decodeCfRaw(encoded)).toEqual(cf);
  });

  it('encodes null for a missing object', () => {
    expect(encodeCfRaw(undefined)).toBeNull();
    expect(encodeCfRaw(null)).toBeNull();
    expect(encodeCfRaw('string')).toBeNull();
  });

  it('decodes null for garbage, non-objects and oversize input', () => {
    expect(decodeCfRaw(null)).toBeNull();
    expect(decodeCfRaw('not base64 !!')).toBeNull();
    expect(decodeCfRaw(btoa('[1,2]'))).toBeNull();
    expect(decodeCfRaw(btoa('"str"'))).toBeNull();
    expect(decodeCfRaw('A'.repeat(20_000))).toBeNull();
  });
});

function input(overrides: Partial<BuildRawEnvelopeInput> = {}): BuildRawEnvelopeInput {
  return {
    capturedAt: new Date('2026-10-16T12:00:00.000Z'),
    env: 'staging',
    pageViewId: 42,
    outcome: 'inserted',
    outcomeDetail: null,
    body: { route: '/products/procore' },
    headers: new Headers(),
    ipHash: 'abc',
    derived: emptyRawPageViewDerived(),
    ...overrides,
  };
}

describe('buildRawEnvelope', () => {
  it('never carries cookie, authorization or any IP header, whatever the casing', () => {
    const headers = new Headers();
    headers.set('Cookie', 'sb-access-token=secret');
    headers.set('AUTHORIZATION', 'Bearer secret');
    for (const name of PAGE_VIEW_IP_HEADERS) headers.set(name.toUpperCase(), '203.0.113.9');
    headers.set('user-agent', 'Mozilla/5.0');

    const envelope = buildRawEnvelope(input({ headers }));
    const serialized = JSON.stringify(envelope);

    expect(Object.keys(envelope.headers)).toEqual(['user-agent']);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('203.0.113.9');
  });

  it('never carries a Cloudflare Access header, whatever the casing', () => {
    const headers = new Headers();
    headers.set('Cf-Access-Jwt-Assertion', 'eyJ.secret.jwt');
    headers.set('cf-access-authenticated-user-email', 'operator@example.com');
    headers.set('CF-Access-Client-Id', 'id.secret');
    headers.set('CF-Access-Client-Secret', 'secret');
    headers.set('user-agent', 'Mozilla/5.0');

    const envelope = buildRawEnvelope(input({ headers }));
    const serialized = JSON.stringify(envelope);

    expect(Object.keys(envelope.headers)).toEqual(['user-agent']);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('operator@example.com');
  });

  it('moves cf and eyeball URL into their own fields and strips URL secrets', () => {
    const headers = new Headers({
      [PAGE_VIEW_RAW_HEADERS.cfRaw]: encodeCfRaw({ ray: 'r', city: 'Zürich' }) as string,
      [PAGE_VIEW_RAW_HEADERS.eyeballUrl]: 'https://x.test/p?token=t&q=1',
      referer: 'https://google.com/?code=c&q=aec',
      'x-aeci-writer': 'ssr-arrival',
      'x-aeci-cf-asn': '13335',
    });

    const envelope = buildRawEnvelope(input({ headers }));

    expect(envelope.cf).toEqual({ ray: 'r', city: 'Zürich' });
    expect(envelope.eyeball_url).toBe('https://x.test/p?q=1');
    expect(envelope.writer).toBe('ssr-arrival');
    expect(envelope.headers['referer']).toBe('https://google.com/?q=aec');
    expect(envelope.headers['x-aeci-cf-asn']).toBe('13335');
    expect(envelope.headers[PAGE_VIEW_RAW_HEADERS.cfRaw]).toBeUndefined();
    expect(envelope.headers[PAGE_VIEW_RAW_HEADERS.eyeballUrl]).toBeUndefined();
  });

  it('drops an unparseable referer rather than storing it unstripped', () => {
    const envelope = buildRawEnvelope(
      input({ headers: new Headers({ referer: 'not a url?token=x' }) }),
    );
    expect(envelope.headers['referer']).toBeUndefined();
  });

  it('records outcome fields and truncates outcome_detail', () => {
    const envelope = buildRawEnvelope(
      input({ outcome: 'failed', pageViewId: null, outcomeDetail: 'x'.repeat(900) }),
    );
    expect(envelope.schema_version).toBe(1);
    expect(envelope.captured_at).toBe('2026-10-16T12:00:00.000Z');
    expect(envelope.outcome).toBe('failed');
    expect(envelope.page_view_id).toBeNull();
    expect(envelope.outcome_detail).toHaveLength(500);
    expect(envelope.eyeball_url).toBeNull();
    expect(envelope.cf).toBeNull();
    expect(envelope.writer).toBeNull();
  });
});

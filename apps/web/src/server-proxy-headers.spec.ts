import { describe, expect, it } from 'vitest';

import { isProxyHeader, stripProxyHeaders } from './server-proxy-headers';

// AECI-1477: `AngularAppEngine.handle()` warns once per `forwarded` /
// `x-forwarded-*` header it drops. The renderer strips them first, so a
// stripped request must carry none of them and keep everything else.

describe('stripProxyHeaders', () => {
  it('removes the headers the Cloudflare edge adds, plus every other proxy header', () => {
    const request = new Request('https://www.aecintegrations.com/products?page=2', {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '198.51.100.1',
        'X-Forwarded-Host': 'evil.example',
        forwarded: 'for=198.51.100.1;proto=https',
        cookie: 'sb-auth=1',
        'cf-connecting-ip': '203.0.113.9',
        'accept-language': 'en-US',
      },
    });

    const stripped = stripProxyHeaders(request);

    expect([...stripped.headers.keys()].filter(isProxyHeader)).toEqual([]);
    expect(stripped.headers.get('cookie')).toBe('sb-auth=1');
    expect(stripped.headers.get('cf-connecting-ip')).toBe('203.0.113.9');
    expect(stripped.headers.get('accept-language')).toBe('en-US');
    expect(stripped.url).toBe(request.url);
    expect(stripped.method).toBe('GET');
  });

  it('returns the same instance when there is no proxy header', () => {
    const request = new Request('https://www.aecintegrations.com/', {
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(stripProxyHeaders(request)).toBe(request);
  });
});

describe('isProxyHeader', () => {
  // Mirrors `@angular/ssr` `sanitizeRequestHeaders`. A header this misses is one
  // Angular would still drop and warn about.
  it('matches `forwarded` and the `x-forwarded-` prefix, case-insensitively', () => {
    expect(isProxyHeader('Forwarded')).toBe(true);
    expect(isProxyHeader('x-forwarded-prefix')).toBe(true);
    expect(isProxyHeader('X-FORWARDED-PORT')).toBe(true);
  });

  it('leaves look-alikes alone', () => {
    expect(isProxyHeader('x-forwarded')).toBe(false);
    expect(isProxyHeader('cf-connecting-ip')).toBe(false);
    expect(isProxyHeader('x-real-ip')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { CONTENT_SECURITY_POLICY, applySeoHeaders } from './seo-headers';

describe('applySeoHeaders', () => {
  it('sets Vary: Accept-Language, stripping any upstream Vary first', () => {
    const headers = new Headers({ vary: 'Cookie' });
    applySeoHeaders(headers);
    expect(headers.get('vary')).toBe('Accept-Language');
  });

  it('never emits the forbidden Vary values (Cookie / User-Agent)', () => {
    // Seed BOTH forbidden values upstream — delete-then-set must drop them.
    const headers = new Headers();
    headers.append('vary', 'Cookie');
    headers.append('vary', 'User-Agent');
    applySeoHeaders(headers);
    const vary = headers.get('vary') ?? '';
    expect(vary).toBe('Accept-Language');
    expect(vary).not.toMatch(/cookie/i);
    expect(vary).not.toMatch(/user-agent/i);
  });

  it('appends the sitemap Link, preserving an upstream preload Link', () => {
    const headers = new Headers({ link: '</main.js>; rel=preload; as=script' });
    applySeoHeaders(headers);
    const link = headers.get('link') ?? '';
    expect(link).toContain('</sitemap.xml>; rel=sitemap');
    expect(link).toContain('</main.js>; rel=preload; as=script');
  });

  it('emits the sitemap Link when there is no upstream Link', () => {
    const headers = new Headers();
    applySeoHeaders(headers);
    expect(headers.get('link')).toBe('</sitemap.xml>; rel=sitemap');
  });

  it('sets the Content-Security-Policy header', () => {
    const headers = new Headers();
    applySeoHeaders(headers);
    expect(headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
  });
});

describe('CONTENT_SECURITY_POLICY', () => {
  it('allows inline scripts (cache-safe theme + Datadog + Angular event-replay)', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self' 'unsafe-inline'");
  });

  it('allows the Google Fonts stylesheet + woff2 origins', () => {
    expect(CONTENT_SECURITY_POLICY).toContain('https://fonts.googleapis.com');
    expect(CONTENT_SECURITY_POLICY).toContain('https://fonts.gstatic.com');
  });

  it('allows the Datadog RUM intake host on connect-src', () => {
    // The v7 browser SDK beacons to browser-intake-datadoghq.com, a separate
    // registrable domain — a `*.datadoghq.com` wildcard would NOT match it.
    expect(CONTENT_SECURITY_POLICY).toContain(
      "connect-src 'self' https://browser-intake-datadoghq.com",
    );
    expect(CONTENT_SECURITY_POLICY).not.toContain('*.datadoghq.com');
  });

  it('allows the Algolia search origins on connect-src (AECI-136)', () => {
    // InstantSearch resolves the query host as `{appId}-dsn.algolia.net` with
    // `{appId}-{1,2,3}.algolianet.com` retry fallbacks — the two wildcards cover
    // every search XHR. Without these, /search (Phase 3.9) would be CSP-blocked.
    expect(CONTENT_SECURITY_POLICY).toContain('https://*.algolia.net');
    expect(CONTENT_SECURITY_POLICY).toContain('https://*.algolianet.com');
  });

  it('allows the Cloudflare Web Analytics beacon (script + report hosts)', () => {
    // Cloudflare auto-injects beacon.min.js from static.cloudflareinsights.com
    // at the edge; it then POSTs RUM data to cloudflareinsights.com/cdn-cgi/rum.
    // Both hosts must be allowlisted or the injected <script> is CSP-refused.
    expect(CONTENT_SECURITY_POLICY).toContain('https://static.cloudflareinsights.com');
    expect(CONTENT_SECURITY_POLICY).toMatch(
      /script-src[^;]*https:\/\/static\.cloudflareinsights\.com/,
    );
    expect(CONTENT_SECURITY_POLICY).toMatch(/connect-src[^;]*https:\/\/cloudflareinsights\.com/);
  });

  it('locks down the hardening directives', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("form-action 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  });
});

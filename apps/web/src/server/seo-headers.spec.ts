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

  it('allows the Datadog RUM intake hosts (US1 + US5) on connect-src', () => {
    // The v7 browser SDK beacons to a per-DD_SITE browser-intake-* host, each a
    // separate registrable domain — a `*.datadoghq.com` wildcard would NOT match.
    // US1 (browser-intake-datadoghq.com) is the local .dev.vars default; US5
    // (browser-intake-us5-datadoghq.com) is the deployed preview/staging/prod
    // site (DD_SITE=us5.datadoghq.com in wrangler.jsonc). AECI-162 caught the
    // missing US5 host — RUM was CSP-blocked in every deployed env.
    expect(CONTENT_SECURITY_POLICY).toContain(
      "connect-src 'self' https://browser-intake-datadoghq.com",
    );
    expect(CONTENT_SECURITY_POLICY).toContain('https://browser-intake-us5-datadoghq.com');
    expect(CONTENT_SECURITY_POLICY).not.toContain('*.datadoghq.com');
  });

  it('allows the Algolia search origins on connect-src (AECI-136)', () => {
    // InstantSearch resolves the query host as `{appId}-dsn.algolia.net` with
    // `{appId}-{1,2,3}.algolianet.com` retry fallbacks — the two wildcards cover
    // every search XHR. Without these, /search (Phase 3.9) would be CSP-blocked.
    expect(CONTENT_SECURITY_POLICY).toContain('https://*.algolia.net');
    expect(CONTENT_SECURITY_POLICY).toContain('https://*.algolianet.com');
  });

  it('allows the PostHog US ingestion + assets hosts on connect-src (AECI-239)', () => {
    // The browser PostHog client POSTs events to us.i.posthog.com and fetches
    // remote config from us-assets.i.posthog.com. With
    // disable_external_dependency_loading the SDK never injects a remote script,
    // so these live on connect-src only and script-src is untouched. Region is
    // pinned to US — EU would need the eu.* hosts swapped in here.
    expect(CONTENT_SECURITY_POLICY).toMatch(/connect-src[^;]*https:\/\/us\.i\.posthog\.com/);
    expect(CONTENT_SECURITY_POLICY).toMatch(/connect-src[^;]*https:\/\/us-assets\.i\.posthog\.com/);
    // Must NOT leak into script-src — that's the whole point of bundling + no
    // external dependency loading.
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*posthog/);
  });

  it('allows both Supabase project origins on connect-src (browser auth, AECI-194)', () => {
    // The @supabase/ssr browser client XHRs to https://<ref>.supabase.co/auth/v1/*
    // (getSession/token-refresh, magic-link OTP, sign-out). The CSP is static
    // but SUPABASE_URL is per-env, so BOTH known project refs are allowlisted
    // explicitly: dmbygwupskttzsvfzluq (dev/preview/staging) + jgxebjufabtwkcgxjqvk
    // (production). Missing the origin makes every signed-in page CSP-refuse its
    // SessionStatus probe in a refresh-retry loop (the staging regression).
    expect(CONTENT_SECURITY_POLICY).toMatch(
      /connect-src[^;]*https:\/\/dmbygwupskttzsvfzluq\.supabase\.co/,
    );
    expect(CONTENT_SECURITY_POLICY).toMatch(
      /connect-src[^;]*https:\/\/jgxebjufabtwkcgxjqvk\.supabase\.co/,
    );
    // Auth is REST-only (no realtime subscriptions) and OAuth is a top-level
    // navigation — neither needs script-src, so Supabase stays out of it.
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*supabase/);
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

import { afterEach, describe, expect, it, vi } from 'vitest';

import app from './index';
import type { Env } from './types';

type CfProps = Record<string, unknown>;

function makeEnv(assetsResponse: () => Response): Env {
  return {
    ASSETS: { fetch: vi.fn(async () => assetsResponse()) } as unknown as Fetcher,
    ANALYTICS: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
    API: {} as Fetcher,
    RESEND_API_KEY: '',
    NOTIFICATION_FROM: '',
    NOTIFICATION_TO: '',
  };
}

function fakeExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  };
}

function get(env: Env, url: string) {
  const req = new Request(url);
  (req as unknown as { cf: CfProps }).cf = {};
  return app.request(req, undefined, env, fakeExecutionContext());
}

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apex → www redirect', () => {
  it('301-redirects the apex domain to www and never hits ASSETS', async () => {
    // Guards: SEO canonicalization — apex traffic is permanently redirected to
    // www before any asset is served.
    const env = makeEnv(() => htmlResponse('<html></html>'));
    const res = await get(env, 'https://aecintegrations.com/pricing?x=1');

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://www.aecintegrations.com/pricing?x=1');
    expect(env.ASSETS.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('serves www requests normally (no redirect)', async () => {
    const env = makeEnv(() => htmlResponse('<html></html>'));
    const res = await get(env, 'https://www.aecintegrations.com/');
    expect(res.status).toBe(200);
  });
});

describe('security headers', () => {
  it('sets the full hardening header set on every response', async () => {
    // Guards: the security posture — HSTS, nosniff, framing, referrer,
    // permissions and cross-origin isolation headers must all be present.
    const env = makeEnv(() => htmlResponse('<html></html>'));
    const res = await get(env, 'https://www.aecintegrations.com/');

    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Permissions-Policy')).toContain('camera=()');
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(res.headers.get('X-Permitted-Cross-Domain-Policies')).toBe('none');
  });
});

describe('cache-control', () => {
  it('caches static assets for a day', async () => {
    // Guards: the static allowlist — hashed/static paths get a 1-day public TTL.
    const env = makeEnv(
      () => new Response('body', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }),
    );
    const res = await get(env, 'https://www.aecintegrations.com/assets/logo.svg');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
  });

  it.each(['/robots.txt', '/sitemap.xml', '/manifest.json', '/favicon-i.svg', '/favicon-i.ico'])(
    'treats %s as static',
    async (path) => {
      const env = makeEnv(
        () => new Response('body', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
      );
      const res = await get(env, `https://www.aecintegrations.com${path}`);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
    },
  );

  it('marks HTML pages as no-cache', async () => {
    // Guards: pre-launch HTML must stay fresh — content changes ship instantly.
    const env = makeEnv(() => htmlResponse('<html></html>'));
    const res = await get(env, 'https://www.aecintegrations.com/');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });
});

describe('CSP nonce injection', () => {
  it('injects a per-request nonce into executable <script> tags and emits a matching CSP', async () => {
    // Guards: the nonce contract — every executable script gets the nonce, and
    // the CSP script-src references the same nonce so the page actually runs.
    const env = makeEnv(() =>
      htmlResponse('<html><head><script src="/app.js"></script></head></html>'),
    );
    const res = await get(env, 'https://www.aecintegrations.com/');

    const html = await res.text();
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    const match = csp.match(/script-src 'nonce-([^']+)' 'strict-dynamic'/);
    expect(match).not.toBeNull();
    const nonce = match![1];

    expect(html).toContain(`<script nonce="${nonce}" src="/app.js">`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self' https://us.i.posthog.com");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('does NOT add a nonce to JSON-LD (non-executable) script tags', async () => {
    // Guards: the negative-lookahead in injectNonce — adding a nonce to a
    // application/ld+json block is pointless and risks breaking the JSON.
    const env = makeEnv(() =>
      htmlResponse(
        '<script type="application/ld+json">{"@context":"x"}</script><script src="/a.js"></script>',
      ),
    );
    const res = await get(env, 'https://www.aecintegrations.com/');
    const html = await res.text();

    expect(html).toContain('<script type="application/ld+json">');
    expect(html).not.toMatch(/<script nonce="[^"]+" type="application\/ld\+json"/);
    // The real executable script still gets noticed.
    expect(html).toMatch(/<script nonce="[^"]+" src="\/a\.js">/);
  });

  it('uses a fresh nonce on each request', async () => {
    // Guards: nonce reuse across requests defeats the whole point of a nonce —
    // generateNonce must pull fresh entropy per response.
    const env = makeEnv(() => htmlResponse('<script src="/a.js"></script>'));
    const cspOf = async () =>
      (await get(env, 'https://www.aecintegrations.com/')).headers.get('Content-Security-Policy');

    expect(await cspOf()).not.toBe(await cspOf());
  });

  it('passes non-HTML responses through untouched (no nonce, no CSP rewrite of body)', async () => {
    // Guards: the content-type gate — only text/html is rewritten; JS/JSON/img
    // assets are streamed back as-is.
    const env = makeEnv(
      () =>
        new Response('console.log(1)', {
          status: 200,
          headers: { 'Content-Type': 'application/javascript' },
        }),
    );
    const res = await get(env, 'https://www.aecintegrations.com/assets/app.js');
    expect(await res.text()).toBe('console.log(1)');
  });
});

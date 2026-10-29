import { describe, expect, it } from 'vitest';

import type { WebEnv } from './env';
import {
  buildTurnstileBootstrapScript,
  buildTurnstilePublicConfig,
  injectTurnstileBootstrap,
} from './turnstile-bootstrap-inject';

// Cloudflare's always-passes Invisible test site key.
const SITE_KEY = '1x00000000000000000000BB';

function makeEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    ASSETS: {} as Fetcher,
    API: {} as Fetcher,
    TURNSTILE_SITE_KEY: SITE_KEY,
    ENV: 'staging',
    ...overrides,
  };
}

describe('buildTurnstilePublicConfig', () => {
  it('returns null when TURNSTILE_SITE_KEY is missing (the shipped, dark state)', () => {
    expect(buildTurnstilePublicConfig(makeEnv({ TURNSTILE_SITE_KEY: undefined }))).toBeNull();
  });

  it('returns null when TURNSTILE_SITE_KEY is an empty string', () => {
    expect(buildTurnstilePublicConfig(makeEnv({ TURNSTILE_SITE_KEY: '' }))).toBeNull();
  });

  it('carries the site key and nothing else', () => {
    expect(buildTurnstilePublicConfig(makeEnv())).toEqual({ siteKey: SITE_KEY });
  });
});

describe('buildTurnstileBootstrapScript', () => {
  it('emits a script tag assigning the config to window.__AECI_TURNSTILE__', () => {
    expect(buildTurnstileBootstrapScript(makeEnv())).toBe(
      `<script>window.__AECI_TURNSTILE__={"siteKey":"${SITE_KEY}"};</script>`,
    );
  });

  it('returns null when the key is missing', () => {
    expect(buildTurnstileBootstrapScript(makeEnv({ TURNSTILE_SITE_KEY: '' }))).toBeNull();
  });

  it('escapes "<" so a stray key value cannot break out of the script', () => {
    const script = buildTurnstileBootstrapScript(makeEnv({ TURNSTILE_SITE_KEY: 'a</script>b' }));
    expect(script).not.toBeNull();
    expect(script).not.toContain('</script>b');
    expect(script).toContain('\\u003c/script>b');
  });
});

describe('injectTurnstileBootstrap', () => {
  function htmlResponse(body: string, status = 200): Response {
    return new Response(body, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  it('splices the script tag immediately before </head>', async () => {
    const res = htmlResponse('<html><head><title>x</title></head><body>hi</body></html>');
    const out = await injectTurnstileBootstrap(res, makeEnv());
    expect(await out.text()).toBe(
      `<html><head><title>x</title><script>window.__AECI_TURNSTILE__={"siteKey":"${SITE_KEY}"};</script></head><body>hi</body></html>`,
    );
  });

  it('returns the original response when the site key is missing', async () => {
    const res = htmlResponse('<html><head></head><body/></html>');
    const out = await injectTurnstileBootstrap(res, makeEnv({ TURNSTILE_SITE_KEY: undefined }));
    expect(out).toBe(res);
  });

  it('returns the original response for non-HTML content types', async () => {
    const json = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const out = await injectTurnstileBootstrap(json, makeEnv());
    expect(out).toBe(json);
  });

  it('returns the original response for non-2xx status', async () => {
    const res = htmlResponse('<html><head></head></html>', 404);
    const out = await injectTurnstileBootstrap(res, makeEnv());
    expect(out).toBe(res);
  });

  it('returns the original response when the HTML has no </head> sentinel', async () => {
    const res = htmlResponse('not really html');
    const out = await injectTurnstileBootstrap(res, makeEnv());
    expect(out).toBe(res);
  });

  it('strips content-length so the runtime recomputes after splicing', async () => {
    const res = new Response('<html><head></head><body/></html>', {
      status: 200,
      headers: { 'content-type': 'text/html', 'content-length': '34' },
    });
    const out = await injectTurnstileBootstrap(res, makeEnv());
    expect(out.headers.get('content-length')).toBeNull();
  });
});

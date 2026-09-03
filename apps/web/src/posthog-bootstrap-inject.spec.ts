import { describe, expect, it } from 'vitest';

import type { WebEnv } from './env';
import {
  buildPostHogBootstrapScript,
  buildPostHogPublicConfig,
  injectPostHogBootstrap,
} from './posthog-bootstrap-inject';

function makeEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    ASSETS: {} as Fetcher,
    API: {} as Fetcher,
    POSTHOG_PROJECT_KEY: 'phc_abc',
    POSTHOG_HOST: 'https://us.i.posthog.com',
    ENV: 'preview',
    ...overrides,
  };
}

describe('buildPostHogPublicConfig', () => {
  it('returns null when POSTHOG_PROJECT_KEY is missing', () => {
    expect(buildPostHogPublicConfig(makeEnv({ POSTHOG_PROJECT_KEY: undefined }))).toBeNull();
  });

  it('returns null when POSTHOG_PROJECT_KEY is an empty string', () => {
    expect(buildPostHogPublicConfig(makeEnv({ POSTHOG_PROJECT_KEY: '' }))).toBeNull();
  });

  it('defaults host to US Cloud when POSTHOG_HOST is absent', () => {
    expect(buildPostHogPublicConfig(makeEnv({ POSTHOG_HOST: undefined }))).toEqual({
      key: 'phc_abc',
      host: 'https://us.i.posthog.com',
    });
  });

  it('honors an explicit POSTHOG_HOST', () => {
    expect(
      buildPostHogPublicConfig(makeEnv({ POSTHOG_HOST: 'https://eu.i.posthog.com' })).host,
    ).toBe('https://eu.i.posthog.com');
  });
});

describe('buildPostHogBootstrapScript', () => {
  it('emits a script tag assigning the config to window.__AECI_POSTHOG__', () => {
    expect(buildPostHogBootstrapScript(makeEnv())).toBe(
      '<script>window.__AECI_POSTHOG__={"key":"phc_abc","host":"https://us.i.posthog.com"};</script>',
    );
  });

  it('returns null when the key is missing', () => {
    expect(buildPostHogBootstrapScript(makeEnv({ POSTHOG_PROJECT_KEY: '' }))).toBeNull();
  });

  it('escapes "<" so a stray key value cannot break out of the script', () => {
    const script = buildPostHogBootstrapScript(makeEnv({ POSTHOG_PROJECT_KEY: 'a</script>b' }));
    expect(script).not.toBeNull();
    expect(script).not.toContain('</script>b');
    expect(script).toContain('\\u003c/script>b');
  });
});

describe('injectPostHogBootstrap', () => {
  function htmlResponse(body: string, status = 200): Response {
    return new Response(body, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  it('splices the script tag immediately before </head>', async () => {
    const res = htmlResponse('<html><head><title>x</title></head><body>hi</body></html>');
    const out = await injectPostHogBootstrap(res, makeEnv());
    expect(await out.text()).toBe(
      '<html><head><title>x</title><script>window.__AECI_POSTHOG__={"key":"phc_abc","host":"https://us.i.posthog.com"};</script></head><body>hi</body></html>',
    );
  });

  it('returns the original response when config is missing', async () => {
    const res = htmlResponse('<html><head></head><body/></html>');
    const out = await injectPostHogBootstrap(res, makeEnv({ POSTHOG_PROJECT_KEY: '' }));
    expect(out).toBe(res);
  });

  it('returns the original response for non-HTML content types', async () => {
    const json = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const out = await injectPostHogBootstrap(json, makeEnv());
    expect(out).toBe(json);
  });

  it('returns the original response for non-2xx status', async () => {
    const res = htmlResponse('<html><head></head></html>', 500);
    const out = await injectPostHogBootstrap(res, makeEnv());
    expect(out).toBe(res);
  });

  it('returns the original response when the HTML has no </head> sentinel', async () => {
    const res = htmlResponse('not really html');
    const out = await injectPostHogBootstrap(res, makeEnv());
    expect(out).toBe(res);
  });

  it('strips content-length so the runtime recomputes after splicing', async () => {
    const res = new Response('<html><head></head><body/></html>', {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'content-length': '34',
      },
    });
    const out = await injectPostHogBootstrap(res, makeEnv());
    expect(out.headers.get('content-length')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import type { WebEnv } from './env';
import {
  buildDatadogBootstrapScript,
  buildDatadogPublicConfig,
  injectDatadogBootstrap,
} from './server-bootstrap-inject';

function makeEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    ASSETS: {} as Fetcher,
    API: {} as Fetcher,
    DD_APPLICATION_ID: 'app-abc',
    DD_CLIENT_TOKEN: 'token-xyz',
    DD_SITE: 'datadoghq.com',
    ENV: 'preview',
    ...overrides,
  };
}

describe('buildDatadogPublicConfig', () => {
  it('returns null when DD_APPLICATION_ID is missing', () => {
    expect(buildDatadogPublicConfig(makeEnv({ DD_APPLICATION_ID: undefined }))).toBeNull();
  });

  it('returns null when DD_CLIENT_TOKEN is missing', () => {
    expect(buildDatadogPublicConfig(makeEnv({ DD_CLIENT_TOKEN: undefined }))).toBeNull();
  });

  it('defaults site to datadoghq.com when DD_SITE is absent', () => {
    expect(buildDatadogPublicConfig(makeEnv({ DD_SITE: undefined }))).toEqual({
      applicationId: 'app-abc',
      clientToken: 'token-xyz',
      site: 'datadoghq.com',
      env: 'preview',
    });
  });

  it('defaults env to "preview" when ENV is absent', () => {
    expect(buildDatadogPublicConfig(makeEnv({ ENV: undefined })).env).toBe('preview');
  });
});

describe('buildDatadogBootstrapScript', () => {
  it('emits a script tag assigning the config to window.__AECI_DD__', () => {
    expect(buildDatadogBootstrapScript(makeEnv())).toBe(
      '<script>window.__AECI_DD__={"applicationId":"app-abc","clientToken":"token-xyz","site":"datadoghq.com","env":"preview"};</script>',
    );
  });

  it('returns null when public config is incomplete', () => {
    expect(buildDatadogBootstrapScript(makeEnv({ DD_CLIENT_TOKEN: '' }))).toBeNull();
  });

  it('escapes "<" so a stray token value cannot break out of the script', () => {
    const script = buildDatadogBootstrapScript(
      makeEnv({ DD_APPLICATION_ID: 'a</script>b' }),
    );
    expect(script).not.toBeNull();
    expect(script).not.toContain('</script>b');
    expect(script).toContain('\\u003c/script>b');
  });
});

describe('injectDatadogBootstrap', () => {
  function htmlResponse(body: string, status = 200): Response {
    return new Response(body, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  it('splices the script tag immediately before </head>', async () => {
    const res = htmlResponse('<html><head><title>x</title></head><body>hi</body></html>');
    const out = await injectDatadogBootstrap(res, makeEnv());
    expect(await out.text()).toBe(
      '<html><head><title>x</title><script>window.__AECI_DD__={"applicationId":"app-abc","clientToken":"token-xyz","site":"datadoghq.com","env":"preview"};</script></head><body>hi</body></html>',
    );
  });

  it('returns the original response when config is incomplete', async () => {
    const res = htmlResponse('<html><head></head><body/></html>');
    const out = await injectDatadogBootstrap(res, makeEnv({ DD_APPLICATION_ID: '' }));
    expect(out).toBe(res);
  });

  it('returns the original response for non-HTML content types', async () => {
    const json = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const out = await injectDatadogBootstrap(json, makeEnv());
    expect(out).toBe(json);
  });

  it('returns the original response for non-2xx status (no point mutating error bodies)', async () => {
    const res = htmlResponse('<html><head></head></html>', 500);
    const out = await injectDatadogBootstrap(res, makeEnv());
    expect(out).toBe(res);
  });

  it('returns the original response when the HTML has no </head> sentinel', async () => {
    const res = htmlResponse('not really html');
    const out = await injectDatadogBootstrap(res, makeEnv());
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
    const out = await injectDatadogBootstrap(res, makeEnv());
    expect(out.headers.get('content-length')).toBeNull();
  });
});
